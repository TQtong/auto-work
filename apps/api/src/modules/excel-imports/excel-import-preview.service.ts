import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, sha256 } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { SessionService } from '../session/session.service.js';
import { ExcelContainerGuardService } from './excel-container-guard.service.js';
import type { ExcelDiagnostic, ParsedExcelRow } from './excel-import.types.js';
import { ExcelWorkbookParserService, normalizeMatchText } from './excel-workbook-parser.service.js';

const PARSER_VERSION = 'excel-preview-v1';

@Injectable()
export class ExcelImportPreviewService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly guard: ExcelContainerGuardService,
    private readonly parser: ExcelWorkbookParserService,
  ) {}

  public async preview(input: { buffer: Buffer; fileName: string; mimeType: string }) {
    const fileSha256 = sha256(input.buffer);
    const existing = await this.prisma.excelImport.findUnique({
      where: {
        fileSha256_parserVersion: { fileSha256, parserVersion: PARSER_VERSION },
      },
    });
    if (existing) {
      if (existing.status === 'failed') {
        throw new DomainError(existing.errorCode ?? 'EXCEL_PREVIEW_FAILED', 'Excel 预检失败', {
          httpStatus: 422,
          details: { importId: existing.id, reason: existing.errorSummary },
        });
      }
      return { import: this.publicImport(existing), replayed: true };
    }

    try {
      const facts = await this.guard.inspect(input);
      const profile = await this.prisma.userProfile.findUniqueOrThrow({
        where: { id: this.sessions.currentProfileId },
        include: { aliases: { where: { enabled: true } } },
      });
      const parsed = await this.parser.parse(input.buffer, profile.workdayHours);
      const currentAliases = new Set([
        normalizeMatchText(profile.displayName),
        ...profile.aliases.map((alias) => normalizeMatchText(alias.value)),
      ]);
      const parentKeys = [
        ...new Set(parsed.rows.map((row) => row.normalized.parentIssueKey).filter(Boolean)),
      ] as string[];
      const jiraTasks = await this.prisma.task.findMany({
        where: { primarySource: 'jira', parentIssueKey: { in: parentKeys } },
        select: {
          id: true,
          issueKey: true,
          parentIssueKey: true,
          title: true,
          assigneeName: true,
          plannedStartDate: true,
          dueDate: true,
          originalEstimateSeconds: true,
        },
      });
      const preparedRows = parsed.rows.map((row) =>
        this.prepareRow(row, jiraTasks, currentAliases),
      );
      const importDiagnostics = [
        ...parsed.sheetSummaries.flatMap((sheet) => sheet.diagnostics),
        ...(facts.hasExternalLinks
          ? [
              {
                severity: 'warning' as const,
                code: 'EXCEL_EXTERNAL_LINKS_IGNORED',
                message: '工作簿包含外部链接；系统不会加载或刷新外部内容',
              },
            ]
          : []),
        ...(facts.hasConnections
          ? [
              {
                severity: 'warning' as const,
                code: 'EXCEL_CONNECTIONS_IGNORED',
                message: '工作簿包含数据连接；系统不会执行或刷新连接',
              },
            ]
          : []),
      ];
      const allDiagnostics = [
        ...preparedRows.flatMap((row) => row.diagnostics),
        ...importDiagnostics,
      ];
      const count = (severity: ExcelDiagnostic['severity']) =>
        allDiagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
      const importId = newId();
      const created = await this.prisma.$transaction(async (tx) => {
        const excelImport = await tx.excelImport.create({
          data: {
            id: importId,
            fileName: facts.fileName,
            fileSha256,
            fileSizeBytes: input.buffer.length,
            parserVersion: PARSER_VERSION,
            dateSystem: parsed.dateSystem,
            workdayHours: profile.workdayHours,
            status: 'preview_ready',
            sheetSummaryJson: JSON.stringify(parsed.sheetSummaries),
            ignoredColumnsJson: JSON.stringify(parsed.ignoredColumns),
            diagnosticsJson: JSON.stringify(importDiagnostics),
            blockingCount: count('blocking'),
            conflictCount: count('conflict'),
            warningCount: count('warning'),
            infoCount: count('info'),
            taskRowCount: preparedRows.filter((row) => row.rowKind === 'task').length,
            containerRowCount: preparedRows.filter((row) => row.rowKind === 'container').length,
            createdBy: this.sessions.currentProfileId,
          },
        });
        for (let start = 0; start < preparedRows.length; start += 500) {
          await tx.excelImportRow.createMany({
            data: preparedRows.slice(start, start + 500).map((row) => ({
              id: newId(),
              importId,
              sheetName: row.sheetName,
              rowNumber: row.rowNumber,
              rowKind: row.rowKind,
              rowFingerprint: row.fingerprint,
              rawJson: JSON.stringify(row.raw),
              normalizedJson: JSON.stringify(row.normalized),
              diagnosticsJson: JSON.stringify(row.diagnostics),
              candidatesJson: JSON.stringify(row.candidates),
              proposedAction: row.proposedAction,
              matchedTaskId: row.matchedTaskId,
            })),
          });
        }
        return excelImport;
      });
      return { import: this.publicImport(created), replayed: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.prisma.excelImport.findUniqueOrThrow({
          where: { fileSha256_parserVersion: { fileSha256, parserVersion: PARSER_VERSION } },
        });
        return { import: this.publicImport(replay), replayed: true };
      }
      const domainError = error instanceof DomainError ? error : null;
      const failed = await this.prisma.excelImport.create({
        data: {
          id: newId(),
          fileName: this.failureFileName(input.fileName),
          fileSha256,
          fileSizeBytes: input.buffer.length,
          parserVersion: PARSER_VERSION,
          dateSystem: '1900',
          status: 'failed',
          errorCode: domainError?.code ?? 'EXCEL_PREVIEW_FAILED',
          errorSummary: (error instanceof Error ? error.message : 'Excel 预检失败').slice(0, 1_000),
          createdBy: this.sessions.currentProfileId,
        },
      });
      throw new DomainError(domainError?.code ?? 'EXCEL_PREVIEW_FAILED', 'Excel 预检失败', {
        httpStatus: domainError?.options.httpStatus ?? 422,
        details: { importId: failed.id, reason: failed.errorSummary },
      });
    }
  }

  public async list() {
    const imports = await this.prisma.excelImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return imports.map((item) => this.publicImport(item));
  }

  public async detail(id: string) {
    const excelImport = await this.prisma.excelImport.findUnique({
      where: { id },
      include: {
        rows: {
          orderBy: [{ sheetName: 'asc' }, { rowNumber: 'asc' }],
          include: {
            matchedTask: {
              select: { id: true, issueKey: true, title: true, primarySource: true },
            },
          },
        },
      },
    });
    if (!excelImport)
      throw new DomainError(errorCodes.notFound, 'Excel 导入预检不存在', { httpStatus: 404 });
    return {
      ...this.publicImport(excelImport),
      rows: excelImport.rows.map((row) => ({
        id: row.id,
        sheetName: row.sheetName,
        rowNumber: row.rowNumber,
        rowKind: row.rowKind,
        fingerprint: row.rowFingerprint,
        raw: JSON.parse(row.rawJson) as unknown,
        normalized: JSON.parse(row.normalizedJson) as unknown,
        diagnostics: JSON.parse(row.diagnosticsJson) as unknown,
        candidates: JSON.parse(row.candidatesJson) as unknown,
        resolution: JSON.parse(row.resolutionJson) as unknown,
        proposedAction: row.proposedAction,
        commitStatus: row.commitStatus,
        matchedTask: row.matchedTask,
        committedTaskId: row.committedTaskId,
        version: row.version,
      })),
    };
  }

  private prepareRow(
    row: ParsedExcelRow,
    jiraTasks: Array<{
      id: string;
      issueKey: string | null;
      parentIssueKey: string | null;
      title: string;
      assigneeName: string | null;
      plannedStartDate: string | null;
      dueDate: string | null;
      originalEstimateSeconds: number | null;
    }>,
    currentAliases: Set<string>,
  ) {
    const diagnostics = [...row.diagnostics];
    const normalized = {
      ...row.normalized,
      isCurrentUser:
        Boolean(row.normalized.assigneeName) &&
        currentAliases.has(normalizeMatchText(row.normalized.assigneeName)),
    };
    if (normalized.assigneeName && !normalized.isCurrentUser) {
      diagnostics.push({
        severity: 'warning' as const,
        code: 'EXCEL_ASSIGNEE_NOT_CURRENT_USER',
        message: '经办人未匹配已确认的当前用户别名，该任务不会进入个人报告',
        suggestedAction: '在设置中确认身份别名，或保留为其他人员任务',
      });
    }
    const titleCandidates =
      row.rowKind === 'task' && normalized.title
        ? jiraTasks.filter(
            (task) =>
              task.parentIssueKey === normalized.parentIssueKey &&
              normalizeMatchText(task.title) === normalizeMatchText(normalized.title),
          )
        : [];
    const exactCandidates = titleCandidates.filter(
      (task) =>
        normalizeMatchText(task.assigneeName) === normalizeMatchText(normalized.assigneeName),
    );
    const candidates = titleCandidates.map((task) => ({
      id: task.id,
      issueKey: task.issueKey,
      title: task.title,
      assigneeName: task.assigneeName,
      jiraValues: {
        plannedStartDate: task.plannedStartDate,
        dueDate: task.dueDate,
        estimateHours:
          task.originalEstimateSeconds === null ? null : task.originalEstimateSeconds / 3_600,
      },
    }));
    if (
      exactCandidates.length > 1 ||
      (exactCandidates.length === 0 && titleCandidates.length > 0)
    ) {
      diagnostics.push({
        severity: 'conflict' as const,
        code: 'EXCEL_JIRA_MATCH_AMBIGUOUS',
        message: '存在 Jira 候选但不能唯一精确匹配，禁止自动合并',
        suggestedAction: '在预检选择 Jira 任务或保留为 Excel 补充任务',
      });
    }
    const hasBlocking = diagnostics.some((item) => item.severity === 'blocking');
    const hasConflict = diagnostics.some((item) => item.severity === 'conflict');
    const matchedTaskId = exactCandidates.length === 1 ? exactCandidates[0]!.id : null;
    return {
      ...row,
      normalized,
      diagnostics,
      candidates,
      matchedTaskId,
      proposedAction: hasBlocking
        ? 'blocked'
        : hasConflict
          ? 'conflict'
          : row.rowKind === 'container'
            ? 'skip'
            : matchedTaskId
              ? 'link_jira'
              : 'create_excel',
    };
  }

  private publicImport(item: {
    id: string;
    fileName: string;
    fileSha256: string;
    fileSizeBytes: number;
    parserVersion: string;
    dateSystem: string;
    workdayHours: number;
    status: string;
    sheetSummaryJson: string;
    ignoredColumnsJson: string;
    diagnosticsJson: string;
    blockingCount: number;
    conflictCount: number;
    warningCount: number;
    infoCount: number;
    taskRowCount: number;
    containerRowCount: number;
    errorCode: string | null;
    errorSummary: string | null;
    committedAt: Date | null;
    commitSummaryJson: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: item.id,
      fileName: item.fileName,
      fileSha256: item.fileSha256,
      fileSizeBytes: item.fileSizeBytes,
      parserVersion: item.parserVersion,
      dateSystem: item.dateSystem,
      workdayHours: item.workdayHours,
      status: item.status,
      sheetSummaries: JSON.parse(item.sheetSummaryJson) as unknown,
      ignoredColumns: JSON.parse(item.ignoredColumnsJson) as unknown,
      diagnostics: JSON.parse(item.diagnosticsJson) as unknown,
      counts: {
        blocking: item.blockingCount,
        conflict: item.conflictCount,
        warning: item.warningCount,
        info: item.infoCount,
        tasks: item.taskRowCount,
        containers: item.containerRowCount,
      },
      errorCode: item.errorCode,
      errorSummary: item.errorSummary,
      committedAt: item.committedAt?.toISOString() ?? null,
      commitSummary: JSON.parse(item.commitSummaryJson) as unknown,
      version: item.version,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  private failureFileName(value: string): string {
    const safe = [...value.normalize('NFC')]
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127 && character !== '\\' && character !== '/';
      })
      .join('')
      .trim();
    return (safe || 'invalid.xlsx').slice(0, 255);
  }
}
