import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash, sha256 } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { SessionService } from '../session/session.service.js';
import type { ExcelDiagnostic, NormalizedExcelRow } from './excel-import.types.js';
import type { CommitExcelImportInput, SaveExcelResolutionsInput } from './excel-import.schemas.js';
import { ExcelImportPreviewService } from './excel-import-preview.service.js';
import { normalizeMatchText } from './excel-workbook-parser.service.js';

type Transaction = Prisma.TransactionClient;
type ResolutionRow = SaveExcelResolutionsInput['rows'][number];

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/u;
const FIELD_NAMES = ['plannedStartDate', 'dueDate', 'originalEstimateSeconds'] as const;

@Injectable()
export class ExcelImportCommitService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly previews: ExcelImportPreviewService,
  ) {}

  public async saveResolutions(importId: string, input: SaveExcelResolutionsInput) {
    const profile = await this.prisma.userProfile.findUniqueOrThrow({
      where: { id: this.sessions.currentProfileId },
      include: { aliases: { where: { enabled: true, verifiedAt: { not: null } } } },
    });
    const aliases = new Set([
      normalizeMatchText(profile.displayName),
      ...profile.aliases.map((alias) => normalizeMatchText(alias.value)),
    ]);
    await this.prisma.$transaction(async (tx) => {
      const excelImport = await tx.excelImport.findUnique({
        where: { id: importId },
        include: { rows: true },
      });
      if (!excelImport)
        throw new DomainError(errorCodes.notFound, 'Excel 导入预检不存在', { httpStatus: 404 });
      if (excelImport.status !== 'preview_ready') {
        throw new DomainError('EXCEL_IMPORT_NOT_EDITABLE', '只有待确认的预检可以修正', {
          httpStatus: 409,
        });
      }
      if (excelImport.version !== input.version) {
        throw new DomainError('EXCEL_PREVIEW_VERSION_STALE', '预检版本已变化，请刷新后重试', {
          httpStatus: 412,
          details: { expected: excelImport.version, received: input.version },
        });
      }
      const requestedIds = new Set(input.rows.map((row) => row.id));
      if (requestedIds.size !== input.rows.length) {
        throw new DomainError('EXCEL_RESOLUTION_DUPLICATE_ROW', '同一行不能在一次修正中重复出现', {
          httpStatus: 422,
        });
      }
      const byId = new Map(excelImport.rows.map((row) => [row.id, row]));
      for (const resolution of input.rows) {
        const row = byId.get(resolution.id);
        if (!row) {
          throw new DomainError('EXCEL_RESOLUTION_ROW_INVALID', '修正行不属于当前预检', {
            httpStatus: 422,
            details: { rowId: resolution.id },
          });
        }
        if (row.version !== resolution.version) {
          throw new DomainError('EXCEL_ROW_VERSION_STALE', 'Excel 行版本已变化，请刷新后重试', {
            httpStatus: 412,
            details: { rowId: row.id, expected: row.version, received: resolution.version },
          });
        }
        const prepared = await this.prepareResolution(
          tx,
          row,
          resolution,
          aliases,
          profile.workdayHours,
        );
        const updated = await tx.excelImportRow.updateMany({
          where: { id: row.id, importId, version: row.version, commitStatus: 'pending' },
          data: {
            normalizedJson: JSON.stringify(prepared.normalized),
            diagnosticsJson: JSON.stringify(prepared.diagnostics),
            resolutionJson: JSON.stringify({
              fields: resolution.fields,
              action: resolution.action,
              matchedTaskId: prepared.matchedTaskId,
            }),
            proposedAction: resolution.action,
            matchedTaskId: prepared.matchedTaskId,
            rowFingerprint: prepared.fingerprint,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          throw new DomainError('EXCEL_ROW_VERSION_STALE', 'Excel 行被并发修改，请刷新后重试', {
            httpStatus: 412,
            details: { rowId: row.id },
          });
        }
      }
      const allRows = await tx.excelImportRow.findMany({ where: { importId } });
      const diagnostics = [
        ...(JSON.parse(excelImport.diagnosticsJson) as ExcelDiagnostic[]),
        ...allRows.flatMap((row) => JSON.parse(row.diagnosticsJson) as ExcelDiagnostic[]),
      ];
      const count = (severity: ExcelDiagnostic['severity']) =>
        diagnostics.filter((item) => item.severity === severity).length;
      const updatedImport = await tx.excelImport.updateMany({
        where: { id: importId, version: input.version, status: 'preview_ready' },
        data: {
          blockingCount: count('blocking'),
          conflictCount: count('conflict'),
          warningCount: count('warning'),
          infoCount: count('info'),
          version: { increment: 1 },
        },
      });
      if (updatedImport.count !== 1) {
        throw new DomainError('EXCEL_PREVIEW_VERSION_STALE', '预检被并发修改，请刷新后重试', {
          httpStatus: 412,
        });
      }
    });
    return this.previews.detail(importId);
  }

  public async commit(
    importId: string,
    input: CommitExcelImportInput,
    idempotencyRecordId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const excelImport = await tx.excelImport.findUnique({
        where: { id: importId },
        include: { rows: { orderBy: [{ sheetName: 'asc' }, { rowNumber: 'asc' }] } },
      });
      if (!excelImport)
        throw new DomainError(errorCodes.notFound, 'Excel 导入预检不存在', { httpStatus: 404 });
      if (excelImport.status === 'committed') {
        const replay = JSON.parse(excelImport.commitSummaryJson) as unknown;
        await this.completeIdempotency(tx, idempotencyRecordId, replay);
        return replay;
      }
      if (excelImport.status !== 'preview_ready') {
        throw new DomainError('EXCEL_IMPORT_NOT_COMMITTABLE', '当前 Excel 导入不能提交', {
          httpStatus: 409,
        });
      }
      if (excelImport.version !== input.previewVersion) {
        throw new DomainError('EXCEL_PREVIEW_VERSION_STALE', '预检版本已变化，禁止提交旧快照', {
          httpStatus: 412,
          details: { expected: excelImport.version, received: input.previewVersion },
        });
      }
      const importDiagnostics = JSON.parse(excelImport.diagnosticsJson) as ExcelDiagnostic[];
      const actionableRows = excelImport.rows.filter((row) => row.proposedAction !== 'skip');
      const rowDiagnostics = actionableRows.flatMap(
        (row) => JSON.parse(row.diagnosticsJson) as ExcelDiagnostic[],
      );
      const unresolved = [...importDiagnostics, ...rowDiagnostics].filter((diagnostic) =>
        ['blocking', 'conflict'].includes(diagnostic.severity),
      );
      if (unresolved.length > 0) {
        throw new DomainError('EXCEL_PREVIEW_UNRESOLVED', '仍有 blocking 或 conflict，不能提交', {
          httpStatus: 422,
          details: { count: unresolved.length, codes: [...new Set(unresolved.map((d) => d.code))] },
        });
      }
      const warnings = [...importDiagnostics, ...rowDiagnostics].filter(
        (diagnostic) => diagnostic.severity === 'warning',
      );
      if (warnings.length > 0 && !input.acknowledgedWarnings) {
        throw new DomainError('EXCEL_WARNINGS_NOT_ACKNOWLEDGED', '提交前必须确认预检警告', {
          httpStatus: 422,
          details: { count: warnings.length },
        });
      }

      const summary = { created: 0, linked: 0, supplemented: 0, keptJira: 0, skipped: 0 };
      for (const row of excelImport.rows) {
        if (row.proposedAction === 'skip') {
          await tx.excelImportRow.update({
            where: { id: row.id },
            data: { commitStatus: 'skipped', version: { increment: 1 } },
          });
          summary.skipped += 1;
          continue;
        }
        if (row.proposedAction === 'create_excel') {
          await this.commitExcelTask(tx, row, excelImport.workdayHours);
          summary.created += 1;
          continue;
        }
        if (row.proposedAction === 'link_jira' && row.matchedTaskId) {
          const result = await this.commitJiraSupplement(tx, row);
          summary.linked += 1;
          summary.supplemented += result.supplemented;
          summary.keptJira += result.keptJira;
          continue;
        }
        throw new DomainError('EXCEL_ROW_ACTION_INVALID', '预检行没有可执行的确认动作', {
          httpStatus: 422,
          details: { rowId: row.id, action: row.proposedAction },
        });
      }
      const committedAt = new Date();
      const result = {
        importId,
        status: 'committed',
        committedAt: committedAt.toISOString(),
        previewVersion: input.previewVersion,
        summary,
      };
      const updated = await tx.excelImport.updateMany({
        where: { id: importId, version: input.previewVersion, status: 'preview_ready' },
        data: {
          status: 'committed',
          committedAt,
          commitSummaryJson: JSON.stringify(result),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new DomainError('EXCEL_PREVIEW_VERSION_STALE', '提交期间预检状态发生变化', {
          httpStatus: 412,
        });
      }
      // 业务写入和幂等响应必须在同一个事务落盘，避免提交成功后进程退出造成永久 processing。
      await this.completeIdempotency(tx, idempotencyRecordId, result);
      return result;
    });
  }

  private async prepareResolution(
    tx: Transaction,
    row: {
      id: string;
      rowKind: string;
      sheetName: string;
      normalizedJson: string;
      diagnosticsJson: string;
      candidatesJson: string;
    },
    resolution: ResolutionRow,
    aliases: Set<string>,
    workdayHours: number,
  ) {
    if (row.rowKind === 'container' && resolution.action !== 'skip') {
      throw new DomainError('EXCEL_CONTAINER_ACTION_INVALID', '父任务容器行只能跳过', {
        httpStatus: 422,
        details: { rowId: row.id },
      });
    }
    const original = JSON.parse(row.normalizedJson) as NormalizedExcelRow;
    const fields = resolution.fields;
    const normalized: NormalizedExcelRow = {
      ...original,
      parentIssueKey: this.cleanText(
        fields.parentIssueKey === undefined ? original.parentIssueKey : fields.parentIssueKey,
        true,
      ),
      parentTitle: this.cleanText(
        fields.parentTitle === undefined ? original.parentTitle : fields.parentTitle,
      ),
      title: this.cleanText(fields.title === undefined ? original.title : fields.title),
      assigneeName: this.cleanText(
        fields.assigneeName === undefined ? original.assigneeName : fields.assigneeName,
      ),
      plannedStartDate:
        fields.plannedStartDate === undefined ? original.plannedStartDate : fields.plannedStartDate,
      dueDate: fields.dueDate === undefined ? original.dueDate : fields.dueDate,
      estimateHours:
        fields.estimateHours === undefined ? original.estimateHours : fields.estimateHours,
      personDays:
        fields.estimateHours === undefined
          ? original.personDays
          : fields.estimateHours === null
            ? null
            : fields.estimateHours / workdayHours,
      personDaysSource:
        fields.estimateHours === undefined
          ? original.personDaysSource
          : fields.estimateHours === null
            ? 'empty'
            : 'derived',
      isCurrentUser: false,
    };
    normalized.isCurrentUser =
      Boolean(normalized.assigneeName) && aliases.has(normalizeMatchText(normalized.assigneeName));
    const originalDiagnostics = JSON.parse(row.diagnosticsJson) as ExcelDiagnostic[];
    const diagnostics = this.revalidate(normalized, row.rowKind, originalDiagnostics, resolution);
    if (normalized.assigneeName && !normalized.isCurrentUser && resolution.action !== 'skip') {
      diagnostics.push({
        severity: 'warning',
        code: 'EXCEL_ASSIGNEE_NOT_CURRENT_USER',
        message: '经办人未匹配已确认的当前用户别名，该任务不会进入个人报告',
      });
    }
    let matchedTaskId: string | null = null;
    if (resolution.action === 'link_jira') {
      matchedTaskId = resolution.matchedTaskId ?? null;
      const candidates = JSON.parse(row.candidatesJson) as Array<{ id: string }>;
      if (!matchedTaskId || !candidates.some((candidate) => candidate.id === matchedTaskId)) {
        throw new DomainError('EXCEL_JIRA_SELECTION_INVALID', '只能链接预检列出的 Jira 候选', {
          httpStatus: 422,
          details: { rowId: row.id },
        });
      }
      const task = await tx.task.findUnique({
        where: { id: matchedTaskId },
        select: { primarySource: true },
      });
      if (!task || task.primarySource !== 'jira') {
        throw new DomainError('EXCEL_JIRA_SELECTION_INVALID', '选择的 Jira 任务已不可用', {
          httpStatus: 422,
        });
      }
    }
    const fingerprint = sha256(
      JSON.stringify({
        parentIssueKey: normalized.parentIssueKey,
        title: normalizeMatchText(normalized.title),
        assignee: normalizeMatchText(normalized.assigneeName),
        planned: normalized.plannedStartDate,
        due: normalized.dueDate,
      }),
    );
    return { normalized, diagnostics, matchedTaskId, fingerprint };
  }

  private revalidate(
    value: NormalizedExcelRow,
    rowKind: string,
    original: ExcelDiagnostic[],
    resolution: ResolutionRow,
  ): ExcelDiagnostic[] {
    if (resolution.action === 'skip') {
      return [{ severity: 'info', code: 'EXCEL_ROW_SKIPPED_BY_USER', message: '用户确认跳过本行' }];
    }
    const diagnostics = original.filter((diagnostic) => {
      if (!['blocking', 'conflict'].includes(diagnostic.severity)) {
        if (diagnostic.code === 'EXCEL_ASSIGNEE_NOT_CURRENT_USER') return false;
        if (
          (diagnostic.code.includes('ESTIMATE_') || diagnostic.code.includes('PERSON_DAYS_')) &&
          Object.prototype.hasOwnProperty.call(resolution.fields, 'estimateHours')
        ) {
          return false;
        }
        return true;
      }
      if (diagnostic.code === 'EXCEL_JIRA_MATCH_AMBIGUOUS') return false;
      if (diagnostic.code.includes('DATE_')) {
        const field = diagnostic.cell?.toUpperCase().startsWith('E')
          ? 'plannedStartDate'
          : 'dueDate';
        return !Object.prototype.hasOwnProperty.call(resolution.fields, field);
      }
      if (diagnostic.code.includes('ESTIMATE_') || diagnostic.code.includes('PERSON_DAYS_')) {
        return !Object.prototype.hasOwnProperty.call(resolution.fields, 'estimateHours');
      }
      return false;
    });
    if (!value.parentIssueKey || !value.parentTitle) {
      diagnostics.push({
        severity: 'blocking',
        code: 'EXCEL_PARENT_MISSING',
        message: '父任务 ID 和名称必须同时存在',
      });
    } else if (!JIRA_KEY.test(value.parentIssueKey)) {
      diagnostics.push({
        severity: 'blocking',
        code: 'EXCEL_PARENT_KEY_INVALID',
        message: '父任务 ID 不符合当前 Jira issue key 规则',
      });
    }
    if (rowKind === 'task' && !value.title) {
      diagnostics.push({
        severity: 'blocking',
        code: 'EXCEL_TITLE_MISSING',
        message: '任务标题不能为空',
      });
    }
    if (value.title && value.title.length > 4_000) {
      diagnostics.push({
        severity: 'blocking',
        code: 'EXCEL_TITLE_TOO_LONG',
        message: '任务标题超过 4,000 字符',
      });
    }
    for (const [field, label] of [
      ['plannedStartDate', '开始日期'],
      ['dueDate', '到期日期'],
    ] as const) {
      const date = value[field];
      if (date && !this.validDate(date)) {
        diagnostics.push({
          severity: 'blocking',
          code: 'EXCEL_DATE_INVALID',
          message: `${label}无效`,
        });
      }
    }
    if (value.plannedStartDate && value.dueDate && value.dueDate < value.plannedStartDate) {
      diagnostics.push({
        severity: 'blocking',
        code: 'EXCEL_DATE_RANGE_INVALID',
        message: '到期日期不能早于开始日期',
      });
    }
    if (
      value.estimateHours !== null &&
      (!Number.isFinite(value.estimateHours) ||
        value.estimateHours < 0 ||
        value.estimateHours > 10_000)
    ) {
      diagnostics.push({
        severity: 'blocking',
        code: 'EXCEL_ESTIMATE_INVALID',
        message: '预估工时必须是 0 到 10,000 之间的数值',
      });
    }
    return this.uniqueDiagnostics(diagnostics);
  }

  private async commitExcelTask(
    tx: Transaction,
    row: { id: string; sheetName: string; rowFingerprint: string; normalizedJson: string },
    workdayHours: number,
  ): Promise<void> {
    const value = JSON.parse(row.normalizedJson) as NormalizedExcelRow;
    if (!value.title)
      throw new DomainError('EXCEL_TITLE_MISSING', 'Excel 任务标题不能为空', { httpStatus: 422 });
    const sourceStableKey = `excel:${sha256(`${row.sheetName}:${row.rowFingerprint}`)}`;
    const now = new Date();
    const task = await tx.task.upsert({
      where: { sourceStableKey },
      create: {
        id: newId(),
        sourceStableKey,
        primarySource: 'excel',
        parentIssueKey: value.parentIssueKey,
        parentTitle: value.parentTitle,
        title: value.title,
        assigneeName: value.assigneeName,
        isCurrentUser: value.isCurrentUser,
        normalizedStatus: 'other',
        plannedStartDate: value.plannedStartDate,
        dueDate: value.dueDate,
        originalEstimateSeconds: this.hoursToSeconds(value.estimateHours),
        lastObservedAt: now,
      },
      update: {
        parentIssueKey: value.parentIssueKey,
        parentTitle: value.parentTitle,
        title: value.title,
        assigneeName: value.assigneeName,
        isCurrentUser: value.isCurrentUser,
        plannedStartDate: value.plannedStartDate,
        dueDate: value.dueDate,
        originalEstimateSeconds: this.hoursToSeconds(value.estimateHours),
        lastObservedAt: now,
        version: { increment: 1 },
      },
    });
    const observation = await this.ensureExcelObservation(tx, task.id, row.id, value);
    for (const [fieldName, fieldValue] of [
      ['plannedStartDate', value.plannedStartDate],
      ['dueDate', value.dueDate],
      ['originalEstimateSeconds', this.hoursToSeconds(value.estimateHours)],
    ] as const) {
      if (fieldValue !== null) {
        await this.activateProvenance(tx, {
          taskId: task.id,
          fieldName,
          sourceType: 'excel',
          decision: 'source_fact',
          value: fieldValue,
          sourceObservationId: observation.id,
          excelImportRowId: row.id,
          reason: `Excel 独立任务；换算参数 ${workdayHours} 小时/人日`,
        });
      }
    }
    await tx.excelImportRow.update({
      where: { id: row.id },
      data: {
        commitStatus: 'committed',
        committedTaskId: task.id,
        sourceObservationId: observation.id,
        version: { increment: 1 },
      },
    });
  }

  private async commitJiraSupplement(
    tx: Transaction,
    row: { id: string; matchedTaskId: string | null; normalizedJson: string },
  ): Promise<{ supplemented: number; keptJira: number }> {
    if (!row.matchedTaskId)
      throw new DomainError('EXCEL_JIRA_SELECTION_INVALID', 'Excel 行缺少 Jira 匹配任务', {
        httpStatus: 422,
      });
    const task = await tx.task.findUnique({
      where: { id: row.matchedTaskId },
      include: {
        fieldProvenances: { where: { active: true } },
        sourceObservations: {
          where: { sourceType: 'jira' },
          orderBy: { observedAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!task || task.primarySource !== 'jira') {
      throw new DomainError('EXCEL_JIRA_SELECTION_INVALID', '匹配的 Jira 任务已不可用', {
        httpStatus: 422,
      });
    }
    const value = JSON.parse(row.normalizedJson) as NormalizedExcelRow;
    const observation = await this.ensureExcelObservation(tx, task.id, row.id, value);
    const excelValues = {
      plannedStartDate: value.plannedStartDate,
      dueDate: value.dueDate,
      originalEstimateSeconds: this.hoursToSeconds(value.estimateHours),
    };
    const updates: Prisma.TaskUpdateInput = {};
    let supplemented = 0;
    let keptJira = 0;
    for (const fieldName of FIELD_NAMES) {
      const taskValue = task[fieldName];
      const excelValue = excelValues[fieldName];
      const active = task.fieldProvenances.find((item) => item.fieldName === fieldName);
      const jiraOwnsValue = taskValue !== null && active?.sourceType !== 'excel';
      if (jiraOwnsValue) {
        await this.activateProvenance(tx, {
          taskId: task.id,
          fieldName,
          sourceType: 'jira',
          decision: 'keep_jira',
          value: taskValue,
          sourceObservationId: task.sourceObservations[0]?.id ?? null,
          excelImportRowId: row.id,
          reason: `Jira 已有值，Excel 候选 ${JSON.stringify(excelValue)} 未覆盖主事实`,
        });
        keptJira += 1;
      } else if (excelValue !== null) {
        updates[fieldName] = excelValue;
        await this.activateProvenance(tx, {
          taskId: task.id,
          fieldName,
          sourceType: 'excel',
          decision: 'supplement',
          value: excelValue,
          sourceObservationId: observation.id,
          excelImportRowId: row.id,
          reason: 'Jira 对应字段为空，采用用户确认的 Excel 补充值',
        });
        supplemented += 1;
      }
    }
    if (supplemented > 0) {
      await tx.task.update({
        where: { id: task.id },
        data: { ...updates, lastObservedAt: new Date(), version: { increment: 1 } },
      });
    }
    await tx.excelImportRow.update({
      where: { id: row.id },
      data: {
        commitStatus: 'committed',
        committedTaskId: task.id,
        sourceObservationId: observation.id,
        version: { increment: 1 },
      },
    });
    return { supplemented, keptJira };
  }

  private async ensureExcelObservation(
    tx: Transaction,
    taskId: string,
    rowId: string,
    value: NormalizedExcelRow,
  ) {
    const contentHash = requestHash({ rowId, value });
    const existing = await tx.taskSourceObservation.findFirst({
      where: { taskId, sourceType: 'excel', contentHash },
    });
    if (existing) return existing;
    return tx.taskSourceObservation.create({
      data: {
        id: newId(),
        taskId,
        sourceType: 'excel',
        contentHash,
        fieldsJson: JSON.stringify(value),
        warningsJson: '[]',
        observedAt: new Date(),
      },
    });
  }

  private async activateProvenance(
    tx: Transaction,
    input: {
      taskId: string;
      fieldName: string;
      sourceType: 'jira' | 'excel';
      decision: 'source_fact' | 'supplement' | 'keep_jira';
      value: unknown;
      sourceObservationId: string | null;
      excelImportRowId: string | null;
      reason: string;
    },
  ): Promise<void> {
    const now = new Date();
    await tx.taskFieldProvenance.updateMany({
      where: { taskId: input.taskId, fieldName: input.fieldName, active: true },
      data: { active: false, supersededAt: now },
    });
    await tx.taskFieldProvenance.create({
      data: {
        id: newId(),
        taskId: input.taskId,
        fieldName: input.fieldName,
        sourceType: input.sourceType,
        decision: input.decision,
        valueJson: JSON.stringify(input.value),
        sourceObservationId: input.sourceObservationId,
        excelImportRowId: input.excelImportRowId,
        reason: input.reason,
        active: true,
        effectiveAt: now,
      },
    });
  }

  private async completeIdempotency(
    tx: Transaction,
    recordId: string,
    response: unknown,
  ): Promise<void> {
    const updated = await tx.idempotencyRecord.updateMany({
      where: { id: recordId, state: 'processing' },
      data: {
        state: 'completed',
        httpStatus: 200,
        responseJson: JSON.stringify(response),
        errorCode: null,
      },
    });
    if (updated.count !== 1) {
      throw new DomainError('IDEMPOTENCY_STATE_INVALID', '幂等记录状态已变化，提交已回滚', {
        httpStatus: 409,
      });
    }
  }

  private cleanText(value: string | null, uppercase = false): string | null {
    const cleaned = value?.normalize('NFC').trim() ?? '';
    return cleaned ? (uppercase ? cleaned.toUpperCase() : cleaned) : null;
  }

  private validDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    const maximum = `${new Date().getUTCFullYear() + 10}-12-31`;
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= '2000-01-01' &&
      value <= maximum
    );
  }

  private hoursToSeconds(value: number | null): number | null {
    return value === null ? null : Math.round(value * 3_600);
  }

  private uniqueDiagnostics(diagnostics: ExcelDiagnostic[]): ExcelDiagnostic[] {
    const seen = new Set<string>();
    return diagnostics.filter((item) => {
      const key = `${item.severity}:${item.code}:${item.cell ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
