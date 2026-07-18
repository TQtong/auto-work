import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';

const canonicalFields = [
  { internalField: 'reportDate', column: 'reportDateText', label: '周报填写日期' },
  { internalField: 'recentGoals', column: 'recentGoalsText', label: '近期工作目标' },
  { internalField: 'weeklyWork', column: 'weeklyWorkText', label: '本周工作内容' },
  { internalField: 'nextWeekPlans', column: 'nextWeekPlansText', label: '下周工作计划' },
  { internalField: 'problems', column: 'problemsText', label: '需要协助或存在的问题' },
  { internalField: 'other', column: 'otherText', label: '其他补充' },
] as const;

type InternalField = (typeof canonicalFields)[number]['internalField'];
interface ExportCopyContext {
  correlationId: string;
  sessionId: string;
}

interface MappingField {
  internalField: InternalField;
  externalFieldName: string;
  order: number;
}

@Injectable()
export class WeeklyReportExportCopyService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {}

  /**
   * 复制/导出只生成本地人工操作材料，不创建交付意图、作业或外部调用。
   * 为防止用户误复制旧页面内容，入口只接受服务端当前聚合版本。
   */
  public async generate(
    reportId: string,
    input: { versionId: string; reportVersion: number },
    context: ExportCopyContext,
  ) {
    const report = await this.prisma.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      include: { currentVersion: true },
    });
    if (!report?.currentVersion) {
      throw new DomainError(errorCodes.notFound, '周报或当前版本不存在', { httpStatus: 404 });
    }
    if (report.currentVersionId !== input.versionId || report.version !== input.reportVersion) {
      throw new DomainError(errorCodes.versionConflict, '周报已产生新版本，请刷新后重新预览', {
        httpStatus: 409,
        suggestedAction: 'refresh',
        details: {
          expectedVersionId: report.currentVersionId,
          expectedReportVersion: report.version,
        },
      });
    }
    const currentVersion = report.currentVersion;

    const mapping = currentVersion.templateMappingVersionId
      ? await this.prisma.dingTalkTemplateMappingVersion.findUnique({
          where: { id: currentVersion.templateMappingVersionId },
        })
      : null;
    const mappedFields = mapping ? this.parseMapping(mapping.fieldsJson) : null;
    const fields = (mappedFields ?? this.canonicalMapping()).map((field) => {
      const definition = canonicalFields.find(
        (item) => item.internalField === field.internalField,
      )!;
      return {
        internalField: field.internalField,
        label: field.externalFieldName,
        order: field.order,
        content: currentVersion[definition.column],
      };
    });
    const emptyFields = fields.filter((field) => !field.content.trim()).map((field) => field.label);
    const warnings = [
      ...(!mappedFields
        ? [
            mapping
              ? '冻结的钉钉模板映射无效，已使用标准六字段名称'
              : '当前版本没有冻结的钉钉模板映射，已使用标准六字段名称',
          ]
        : []),
      ...(emptyFields.length > 0 ? [`以下字段尚未填写：${emptyFields.join('、')}`] : []),
    ];
    const generatedAt = new Date();
    const copyText = this.render({
      reportId,
      versionNo: report.currentVersion.versionNo,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      templateName: mapping?.templateName ?? report.templateName,
      fields,
      warnings,
    });
    // 添加 UTF-8 BOM，确保 Windows 记事本和常见办公软件直接打开中文附件时不乱码。
    const attachmentBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(copyText)]);
    const attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex');
    const generated = {
      reportId,
      versionId: report.currentVersion.id,
      versionNo: report.currentVersion.versionNo,
      reportVersion: report.version,
      contentHash: report.currentVersion.contentHash,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      templateName: mapping?.templateName ?? report.templateName,
      templateMappingVersionId: mapping?.id ?? null,
      mappingSource: mappedFields ? ('frozen_mapping' as const) : ('canonical_fallback' as const),
      submitted: false as const,
      formalLogState: report.logDeliveryState,
      generatedAt: generatedAt.toISOString(),
      warnings,
      fields,
      copyText,
      attachment: {
        fileName: `周报_${report.periodStart}_${report.periodEnd}_v${report.currentVersion.versionNo}_未正式提交.txt`,
        mimeType: 'text/plain;charset=utf-8',
        encoding: 'base64' as const,
        contentBase64: attachmentBytes.toString('base64'),
        sizeBytes: attachmentBytes.length,
        sha256: attachmentHash,
      },
    };
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'weekly_report.export_copy_generated',
      targetType: 'weekly_report_version',
      targetId: report.currentVersion.id,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      after: {
        reportId,
        reportVersion: report.version,
        versionNo: report.currentVersion.versionNo,
        contentHash: report.currentVersion.contentHash,
        attachmentHash,
        submitted: false,
        mappingSource: generated.mappingSource,
        warningCount: warnings.length,
      },
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
    return generated;
  }

  private render(input: {
    reportId: string;
    versionNo: number;
    periodStart: string;
    periodEnd: string;
    templateName: string;
    fields: Array<{ label: string; order: number; content: string }>;
    warnings: string[];
  }): string {
    const sections = input.fields.map(
      (field) => `${field.order}. ${field.label}\r\n${field.content || '（未填写）'}`,
    );
    return [
      '【未正式提交】',
      '本文件仅供人工复制或作为附件上传，不代表 Auto Work 已提交钉钉正式日志。',
      `周报周期：${input.periodStart} 至 ${input.periodEnd}`,
      `周报版本：v${input.versionNo}`,
      `钉钉模板：${input.templateName}`,
      `本机周报 ID：${input.reportId}`,
      ...(input.warnings.length > 0
        ? ['注意：', ...input.warnings.map((item) => `- ${item}`)]
        : []),
      '----------------------------------------',
      ...sections,
      '----------------------------------------',
      '【未正式提交】请在钉钉中人工核对六字段和最终提交结果。',
    ].join('\r\n\r\n');
  }

  private canonicalMapping(): MappingField[] {
    return canonicalFields.map((field, index) => ({
      internalField: field.internalField,
      externalFieldName: field.label,
      order: index + 1,
    }));
  }

  private parseMapping(value: string): MappingField[] | null {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== canonicalFields.length) return null;
      const rows = parsed.flatMap((item): MappingField[] => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const internalField = record.internalField;
        const order = Number(record.order);
        const externalFieldName = this.safeLabel(record.externalFieldName);
        if (
          typeof internalField !== 'string' ||
          !canonicalFields.some((field) => field.internalField === internalField) ||
          !Number.isInteger(order) ||
          order < 1 ||
          order > canonicalFields.length ||
          !externalFieldName
        ) {
          return [];
        }
        return [{ internalField: internalField as InternalField, externalFieldName, order }];
      });
      if (
        rows.length !== canonicalFields.length ||
        new Set(rows.map((item) => item.internalField)).size !== canonicalFields.length ||
        new Set(rows.map((item) => item.order)).size !== canonicalFields.length ||
        new Set(rows.map((item) => item.externalFieldName)).size !== canonicalFields.length
      ) {
        return null;
      }
      return rows.sort((left, right) => left.order - right.order);
    } catch {
      return null;
    }
  }

  private safeLabel(value: unknown): string {
    if (typeof value !== 'string') return '';
    const withoutControls = Array.from(value.normalize('NFKC'), (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    }).join('');
    return withoutControls.trim().slice(0, 200);
  }
}
