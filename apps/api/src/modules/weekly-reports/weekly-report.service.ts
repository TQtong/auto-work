import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { Prisma, type WorkCalendarVersion } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import {
  generateWeeklyReportRuleDraft,
  newId,
  requestHash,
  weeklyReportRuleVersion,
  type WeeklyEvidenceFact,
  type WeeklyManualInput,
  type WeeklyReportBlock,
  type WeeklyReportField,
  type WeeklyTaskFact,
} from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import type {
  ConfirmWeeklyReportInput,
  EditWeeklyReportInput,
  GenerateWeeklyReportInput,
  ListWeeklyReportsQuery,
  RestoreWeeklyReportVersionInput,
} from './weekly-report.schemas.js';
import { WeeklyReportAttachmentService } from './weekly-report-attachment.service.js';

const shanghaiOffsetMilliseconds = 8 * 3_600_000;
const defaultCalendarId = 'enterprise-work-calendar';
const defaultTemplateName = 'uTwin产研创新部周报';
const sanitizationPolicyVersion = 'ai-sanitization-policy-v1';
const weeklyFields: WeeklyReportField[] = [
  'recentGoals',
  'weeklyWork',
  'nextWeekPlans',
  'problems',
  'other',
];

interface RequestContext {
  correlationId: string;
  sessionId: string;
}

interface MutationContext extends RequestContext {
  idempotencyRecordId: string;
}

interface ResolvedPeriod {
  periodStart: string;
  periodEnd: string;
  reportDate: string;
}

function fieldsFromVersion(version: {
  reportDateText: string;
  recentGoalsText: string;
  weeklyWorkText: string;
  nextWeekPlansText: string;
  problemsText: string;
  otherText: string;
}) {
  return {
    reportDate: version.reportDateText,
    recentGoals: version.recentGoalsText,
    weeklyWork: version.weeklyWorkText,
    nextWeekPlans: version.nextWeekPlansText,
    problems: version.problemsText,
    other: version.otherText,
  };
}

@Injectable()
export class WeeklyReportService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly attachments: WeeklyReportAttachmentService,
  ) {}

  public async generate(
    input: GenerateWeeklyReportInput,
    context: RequestContext,
    now = new Date(),
  ) {
    if (input.aiProviderConfigId) {
      throw new DomainError(
        'WEEKLY_REPORT_AI_PROVIDER_NOT_READY',
        '当前增量尚未启用 AI 表述；请先生成可追溯的规则版本',
        { httpStatus: 422 },
      );
    }
    const profile = await this.prisma.userProfile.findUniqueOrThrow({
      where: { id: this.sessions.currentProfileId },
    });
    const selectedMapping = input.templateMappingVersionId
      ? await this.resolveSelectableMapping(this.prisma, input.templateMappingVersionId)
      : null;
    if (profile.timezone !== 'Asia/Shanghai' || input.timezone !== 'Asia/Shanghai') {
      throw new DomainError(
        'WEEKLY_REPORT_TIMEZONE_UNSUPPORTED',
        '周报生成要求当前用户和请求时区均为 Asia/Shanghai',
        { httpStatus: 422 },
      );
    }
    const calendarVersion = await this.resolveCalendarVersion(input.calendarVersionId);
    const period = this.resolvePeriod(input, calendarVersion, now);
    const sources = await this.collectSources(input, period, now);
    if (
      input.freshnessPolicy.mode === 'require_fresh' &&
      (sources.tasks.some((task) => task.sourceFreshness !== 'fresh') ||
        sources.evidence.some((evidence) => evidence.availabilityState !== 'available'))
    ) {
      throw new DomainError(
        'WEEKLY_REPORT_SOURCE_NOT_FRESH',
        '存在过期或不可用来源；请先同步，或明确选择允许使用过期来源',
        {
          httpStatus: 422,
          details: {
            taskIds: sources.tasks
              .filter((task) => task.sourceFreshness !== 'fresh')
              .map((task) => task.id),
            evidenceIds: sources.evidence
              .filter((evidence) => evidence.availabilityState !== 'available')
              .map((evidence) => evidence.id),
          },
        },
      );
    }
    const manualInputs: WeeklyManualInput[] = input.manualInputs.map((item) => ({
      id: item.id,
      field: item.field,
      text: item.text,
      ...(item.projectName !== undefined ? { projectName: item.projectName } : {}),
      pinned: item.pinned,
    }));
    const ruleDraft = generateWeeklyReportRuleDraft({
      ...period,
      timezone: input.timezone,
      calendarVersion: calendarVersion?.id ?? null,
      tasks: sources.tasks,
      evidence: sources.evidence,
      manualInputs,
    });
    const jiraQuery = {
      scope: 'weekly',
      currentUser: true,
      visibility: 'visible',
      connectionIds: input.jiraQuery.connectionIds ?? [],
      projectIds: input.jiraQuery.projectIds ?? [],
    };
    const sourceContent = {
      period,
      timezone: input.timezone,
      calendarVersion: calendarVersion
        ? { id: calendarVersion.id, contentHash: calendarVersion.contentHash }
        : null,
      profile: { id: profile.id, version: profile.version },
      jiraQuery,
      jiraSyncRunIds: sources.jiraSyncRunIds,
      tasks: sources.tasks,
      evidence: sources.evidence,
      manualInputs,
      freshnessPolicy: input.freshnessPolicy,
      includeUnconfirmedEvidence: input.includeUnconfirmedEvidence,
      ruleVersion: weeklyReportRuleVersion,
      templateMappingVersionId: input.templateMappingVersionId,
      sanitizationPolicyVersion,
    };
    const sourceContentHash = requestHash(sourceContent);
    const generationHash = requestHash({
      sourceContentHash,
      ruleContentHash: ruleDraft.contentHash,
    });

    try {
      // 周报根、来源快照、不可变正文、段落来源和审计必须一起成功，不能暴露半份报告。
      return await this.prisma.$transaction(async (tx) => {
        const existingReport = await tx.weeklyReport.findFirst({
          where: {
            ownerProfileId: profile.id,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            archivedAt: null,
          },
          include: { currentVersion: true, currentConfirmation: true },
        });
        if (existingReport && input.existingReportPolicy === 'reject') {
          throw new DomainError(
            'WEEKLY_REPORT_PERIOD_EXISTS',
            '同一周期已经存在周报；请打开现有报告，或明确生成新版本',
            {
              httpStatus: 409,
              details: {
                reportId: existingReport.id,
                reportVersion: existingReport.version,
                currentVersionId: existingReport.currentVersionId,
              },
              suggestedAction: 'manual_review',
            },
          );
        }
        if (existingReport) {
          const replay = await tx.reportSourceSnapshot.findUnique({
            where: { reportId_generationHash: { reportId: existingReport.id, generationHash } },
            include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
          });
          const replayVersion = replay?.versions[0];
          if (replay && replayVersion) {
            return {
              replayed: true,
              report: await this.serializeReport(tx, existingReport.id),
              sourceSnapshot: this.serializeSnapshot(replay),
              version: await this.serializeVersion(tx, replayVersion.id),
            };
          }
        }

        const report = existingReport
          ? existingReport
          : await tx.weeklyReport.create({
              data: {
                id: newId(),
                ownerProfileId: profile.id,
                ...period,
                timezone: input.timezone,
                templateName: defaultTemplateName,
                templateMappingVersionId: input.templateMappingVersionId,
                status: 'collecting',
              },
            });
        const snapshot = await tx.reportSourceSnapshot.create({
          data: {
            id: newId(),
            reportId: report.id,
            ...period,
            timezone: input.timezone,
            calendarVersionId: calendarVersion?.id ?? null,
            profileId: profile.id,
            profileVersion: profile.version,
            jiraQueryJson: JSON.stringify(jiraQuery),
            jiraSyncRunIdsJson: JSON.stringify(sources.jiraSyncRunIds),
            taskFactsJson: JSON.stringify(sources.tasks),
            evidenceFactsJson: JSON.stringify(sources.evidence),
            manualInputsJson: JSON.stringify(manualInputs),
            freshnessPolicyJson: JSON.stringify(input.freshnessPolicy),
            warningsJson: JSON.stringify(ruleDraft.warnings),
            ruleVersion: weeklyReportRuleVersion,
            templateMappingVersionId: input.templateMappingVersionId,
            sanitizationPolicyVersion,
            generationHash,
            sourceContentHash,
            createdBy: profile.id,
          },
        });
        const latestVersion = existingReport
          ? await tx.weeklyReportVersion.findFirst({
              where: { reportId: report.id },
              orderBy: { versionNo: 'desc' },
              select: { versionNo: true },
            })
          : null;
        const versionId = newId();
        const rendered = this.renderFields(ruleDraft.fields);
        const initialRecipientScope = {
          connectionId: selectedMapping?.mapping.connectionId ?? null,
          recipients: [],
        };
        const versionContentHash = requestHash({
          fields: { reportDate: period.reportDate, ...rendered },
          structured: ruleDraft.fields,
          warnings: ruleDraft.warnings,
          attachments: [],
          recipientScope: initialRecipientScope,
          templateMappingVersionId: input.templateMappingVersionId,
          scheduleAt: null,
          sourceContentHash,
        });
        const version = await tx.weeklyReportVersion.create({
          data: {
            id: versionId,
            reportId: report.id,
            versionNo: (latestVersion?.versionNo ?? 0) + 1,
            origin: 'rule',
            parentVersionId: existingReport?.currentVersionId ?? null,
            reportDateText: period.reportDate,
            recentGoalsText: rendered.recentGoals,
            weeklyWorkText: rendered.weeklyWork,
            nextWeekPlansText: rendered.nextWeekPlans,
            problemsText: rendered.problems,
            otherText: rendered.other,
            fieldsJson: JSON.stringify(ruleDraft.fields),
            warningsJson: JSON.stringify(ruleDraft.warnings),
            attachmentsJson: '[]',
            recipientScopeJson: JSON.stringify(initialRecipientScope),
            templateMappingVersionId: input.templateMappingVersionId,
            scheduleAt: null,
            sourceSnapshotId: snapshot.id,
            contentHash: versionContentHash,
            changeSummaryJson: JSON.stringify({
              kind: existingReport ? 'regenerated_from_new_snapshot' : 'initial_rule_generation',
              sourceContentHash,
            }),
            createdBy: profile.id,
          },
        });
        const sourceLinks = this.buildSourceLinks(
          snapshot.id,
          version.id,
          ruleDraft.fields,
          sources.tasks,
          sources.evidence,
          manualInputs,
        );
        if (sourceLinks.length > 0) await tx.reportSourceLink.createMany({ data: sourceLinks });
        await this.invalidateConfirmation(
          tx,
          existingReport?.currentConfirmation ?? null,
          '重新采集来源并生成了新规则版本',
        );
        const changed = await tx.weeklyReport.updateMany({
          where: { id: report.id, version: report.version },
          data: {
            reportDate: period.reportDate,
            templateMappingVersionId: input.templateMappingVersionId,
            status: 'generated',
            currentVersionId: version.id,
            confirmedVersionId: null,
            currentConfirmationId: null,
            logDeliveryState: 'not_started',
            robotDeliveryState: 'not_started',
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw new DomainError(errorCodes.versionConflict, '周报已被其他页面修改，请刷新后重试', {
            httpStatus: 409,
            suggestedAction: 'refresh',
          });
        }
        await this.audit.recordInTransaction(tx, {
          actorId: profile.id,
          action: existingReport
            ? 'weekly_report.rule_version_generated'
            : 'weekly_report.generated',
          targetType: 'weekly_report',
          targetId: report.id,
          correlationId: context.correlationId,
          outcome: 'succeeded',
          before: existingReport
            ? { aggregateVersion: report.version, currentVersionId: report.currentVersionId }
            : undefined,
          after: {
            aggregateVersion: report.version + 1,
            reportVersionId: version.id,
            reportVersionNo: version.versionNo,
            sourceSnapshotId: snapshot.id,
            contentHash: version.contentHash,
          },
          clientSessionHash: this.security.sessionHash(context.sessionId),
        });
        return {
          replayed: false,
          report: await this.serializeReport(tx, report.id),
          sourceSnapshot: this.serializeSnapshot(snapshot),
          version: await this.serializeVersion(tx, version.id),
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError(
          errorCodes.versionConflict,
          '同周期周报或版本已被并发创建，请刷新后打开最新报告',
          { httpStatus: 409, suggestedAction: 'refresh' },
        );
      }
      throw error;
    }
  }

  public async list(query: ListWeeklyReportsQuery) {
    const offset = this.decodeCursor(query.cursor);
    const where: Prisma.WeeklyReportWhereInput = {
      ownerProfileId: this.sessions.currentProfileId,
      archivedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.periodFrom || query.periodTo
        ? {
            periodStart: {
              ...(query.periodFrom ? { gte: query.periodFrom } : {}),
              ...(query.periodTo ? { lte: query.periodTo } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.weeklyReport.findMany({
        where,
        include: { currentVersion: true, _count: { select: { versions: true } } },
        orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
        skip: offset,
        take: query.limit,
      }),
      this.prisma.weeklyReport.count({ where }),
    ]);
    const nextOffset = offset + items.length;
    return {
      items: items.map((report) => this.serializeReportSummary(report)),
      total,
      page: {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(nextOffset < total ? { nextCursor: this.encodeCursor(nextOffset) } : {}),
        hasMore: nextOffset < total,
        limit: query.limit,
      },
    };
  }

  public async get(reportId: string) {
    return this.serializeReport(this.prisma, reportId);
  }

  public async listVersions(reportId: string) {
    await this.assertOwnedReport(this.prisma, reportId);
    const versions = await this.prisma.weeklyReportVersion.findMany({
      where: { reportId },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        versionNo: true,
        origin: true,
        parentVersionId: true,
        sourceSnapshotId: true,
        contentHash: true,
        templateMappingVersionId: true,
        scheduleAt: true,
        changeSummaryJson: true,
        createdBy: true,
        createdAt: true,
      },
    });
    return versions.map((version) => ({
      ...version,
      changeSummary: JSON.parse(version.changeSummaryJson) as unknown,
      templateMappingVersionId: version.templateMappingVersionId,
      scheduleAt: version.scheduleAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
      changeSummaryJson: undefined,
    }));
  }

  public async getVersion(reportId: string, versionId: string) {
    await this.assertOwnedReport(this.prisma, reportId);
    return this.serializeVersion(this.prisma, versionId, reportId);
  }

  public async edit(reportId: string, input: EditWeeklyReportInput, context: MutationContext) {
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.weeklyReport.findFirst({
        where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
        include: {
          currentVersion: { include: { sourceLinks: true } },
          currentConfirmation: true,
        },
      });
      if (!report?.currentVersion) {
        throw new DomainError(errorCodes.notFound, '周报或当前版本不存在', { httpStatus: 404 });
      }
      this.assertEditBase(report, input.baseVersionId, input.reportVersion);

      const current = report.currentVersion;
      const fields = {
        reportDate: input.fields.reportDate ?? current.reportDateText,
        recentGoals: input.fields.recentGoals ?? current.recentGoalsText,
        weeklyWork: input.fields.weeklyWork ?? current.weeklyWorkText,
        nextWeekPlans: input.fields.nextWeekPlans ?? current.nextWeekPlansText,
        problems: input.fields.problems ?? current.problemsText,
        other: input.fields.other ?? current.otherText,
      };
      if (!fields.problems.trim()) {
        throw new DomainError(
          'WEEKLY_REPORT_PROBLEMS_REQUIRED',
          '问题栏不能为空；没有问题时请明确填写“无”',
          {
            httpStatus: 422,
          },
        );
      }
      const changedFields = Object.entries(input.fields).flatMap(([field, value]) =>
        value !== undefined &&
        value !== fieldsFromVersion(current)[field as keyof ReturnType<typeof fieldsFromVersion>]
          ? [field]
          : [],
      );
      const structured = this.buildManualStructuredFields(current, fields, changedFields);
      const attachmentFacts =
        input.attachmentIds === undefined
          ? this.parseArray(current.attachmentsJson)
          : await this.resolveAttachmentFacts(tx, reportId, input.attachmentIds);
      const templateMappingVersionId =
        input.templateMappingVersionId === undefined
          ? current.templateMappingVersionId
          : input.templateMappingVersionId;
      const mapping = templateMappingVersionId
        ? await this.resolveSelectableMapping(tx, templateMappingVersionId)
        : null;
      const recipientScope =
        input.recipientValidationIds === undefined
          ? this.parseObject(current.recipientScopeJson)
          : await this.resolveRecipientScope(
              tx,
              mapping?.mapping.connectionId ?? null,
              input.recipientValidationIds,
            );
      this.assertRecipientMappingCompatibility(
        recipientScope,
        mapping?.mapping.connectionId ?? null,
      );
      const scheduleAt =
        input.scheduleAt === undefined
          ? current.scheduleAt
          : input.scheduleAt === null
            ? null
            : new Date(input.scheduleAt);
      const warnings = this.parseArray(current.warningsJson);
      const contentHash = requestHash({
        fields,
        structured,
        warnings,
        attachments: attachmentFacts,
        recipientScope,
        templateMappingVersionId,
        scheduleAt: scheduleAt?.toISOString() ?? null,
        sourceSnapshotId: current.sourceSnapshotId,
      });
      if (contentHash === current.contentHash) {
        const response = {
          replayed: true,
          report: await this.serializeReport(tx, reportId),
          version: await this.serializeVersion(tx, current.id, reportId),
        };
        await this.completeIdempotency(tx, context.idempotencyRecordId, response);
        return response;
      }

      const versionId = newId();
      const latest = await tx.weeklyReportVersion.aggregate({
        where: { reportId },
        _max: { versionNo: true },
      });
      const version = await tx.weeklyReportVersion.create({
        data: {
          id: versionId,
          reportId,
          versionNo: (latest._max.versionNo ?? 0) + 1,
          origin: 'manual',
          parentVersionId: current.id,
          reportDateText: fields.reportDate,
          recentGoalsText: fields.recentGoals,
          weeklyWorkText: fields.weeklyWork,
          nextWeekPlansText: fields.nextWeekPlans,
          problemsText: fields.problems,
          otherText: fields.other,
          fieldsJson: JSON.stringify(structured),
          warningsJson: JSON.stringify(warnings),
          attachmentsJson: JSON.stringify(attachmentFacts),
          recipientScopeJson: JSON.stringify(recipientScope),
          templateMappingVersionId,
          scheduleAt,
          sourceSnapshotId: current.sourceSnapshotId,
          contentHash,
          changeSummaryJson: JSON.stringify({
            kind: 'manual_edit',
            reason: input.changeReason,
            changedFields,
            attachmentsChanged: input.attachmentIds !== undefined,
            recipientScopeChanged: input.recipientValidationIds !== undefined,
            templateMappingChanged: input.templateMappingVersionId !== undefined,
            scheduleChanged: input.scheduleAt !== undefined,
          }),
          createdBy: this.sessions.currentProfileId,
        },
      });
      await this.copySourceLinks(tx, current, version.id, structured, changedFields);
      await this.invalidateConfirmation(
        tx,
        report.currentConfirmation,
        '正文或提交元数据已生成新版本',
      );
      const recipientChanged =
        requestHash(recipientScope) !== requestHash(this.parseObject(current.recipientScopeJson));
      const changed = await tx.weeklyReport.updateMany({
        where: { id: reportId, version: report.version, currentVersionId: current.id },
        data: {
          reportDate: fields.reportDate,
          templateMappingVersionId,
          scheduleAt,
          currentVersionId: version.id,
          confirmedVersionId: null,
          currentConfirmationId: null,
          status: 'editing',
          logDeliveryState: 'not_started',
          robotDeliveryState: 'not_started',
          ...(recipientChanged ? { recipientScopeVersion: { increment: 1 } } : {}),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.throwVersionConflict();
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.version_edited',
        targetType: 'weekly_report',
        targetId: reportId,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: {
          aggregateVersion: report.version,
          versionId: current.id,
          contentHash: current.contentHash,
        },
        after: {
          aggregateVersion: report.version + 1,
          versionId: version.id,
          versionNo: version.versionNo,
          contentHash,
          changedFields,
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      const response = {
        replayed: false,
        report: await this.serializeReport(tx, reportId),
        version: await this.serializeVersion(tx, version.id, reportId),
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response);
      return response;
    });
  }

  public async restore(
    reportId: string,
    targetVersionId: string,
    input: RestoreWeeklyReportVersionInput,
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.weeklyReport.findFirst({
        where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
        include: { currentVersion: true, currentConfirmation: true },
      });
      if (!report?.currentVersion) {
        throw new DomainError(errorCodes.notFound, '周报或当前版本不存在', { httpStatus: 404 });
      }
      this.assertEditBase(report, input.baseVersionId, input.reportVersion);
      const target = await tx.weeklyReportVersion.findFirst({
        where: { id: targetVersionId, reportId },
        include: { sourceLinks: true },
      });
      if (!target)
        throw new DomainError(errorCodes.notFound, '待恢复的历史版本不存在', { httpStatus: 404 });
      if (target.id === report.currentVersion.id) {
        const response = {
          replayed: true,
          report: await this.serializeReport(tx, reportId),
          version: await this.serializeVersion(tx, target.id, reportId),
        };
        await this.completeIdempotency(tx, context.idempotencyRecordId, response);
        return response;
      }
      const latest = await tx.weeklyReportVersion.aggregate({
        where: { reportId },
        _max: { versionNo: true },
      });
      const version = await tx.weeklyReportVersion.create({
        data: {
          id: newId(),
          reportId,
          versionNo: (latest._max.versionNo ?? 0) + 1,
          origin: 'restore',
          parentVersionId: report.currentVersion.id,
          reportDateText: target.reportDateText,
          recentGoalsText: target.recentGoalsText,
          weeklyWorkText: target.weeklyWorkText,
          nextWeekPlansText: target.nextWeekPlansText,
          problemsText: target.problemsText,
          otherText: target.otherText,
          fieldsJson: target.fieldsJson,
          warningsJson: target.warningsJson,
          attachmentsJson: target.attachmentsJson,
          recipientScopeJson: target.recipientScopeJson,
          templateMappingVersionId: target.templateMappingVersionId,
          scheduleAt: target.scheduleAt,
          sourceSnapshotId: target.sourceSnapshotId,
          aiGenerationId: target.aiGenerationId,
          contentHash: target.contentHash,
          changeSummaryJson: JSON.stringify({
            kind: 'history_restore',
            restoredFromVersionId: target.id,
            restoredFromVersionNo: target.versionNo,
            reason: input.changeReason,
          }),
          createdBy: this.sessions.currentProfileId,
        },
      });
      if (target.sourceLinks.length > 0) {
        await tx.reportSourceLink.createMany({
          data: target.sourceLinks.map((link) => ({
            id: newId(),
            snapshotId: link.snapshotId,
            versionId: version.id,
            fieldName: link.fieldName,
            blockId: link.blockId,
            sourceType: link.sourceType,
            sourceId: link.sourceId,
            taskId: link.taskId,
            evidenceId: link.evidenceId,
            sourceContentHash: link.sourceContentHash,
            sourceSummaryJson: link.sourceSummaryJson,
          })),
        });
      }
      await this.invalidateConfirmation(
        tx,
        report.currentConfirmation,
        '已从历史版本恢复并生成新版本',
      );
      const changed = await tx.weeklyReport.updateMany({
        where: {
          id: reportId,
          version: report.version,
          currentVersionId: report.currentVersion.id,
        },
        data: {
          reportDate: target.reportDateText,
          templateMappingVersionId: target.templateMappingVersionId,
          scheduleAt: target.scheduleAt,
          currentVersionId: version.id,
          confirmedVersionId: null,
          currentConfirmationId: null,
          status: 'editing',
          logDeliveryState: 'not_started',
          robotDeliveryState: 'not_started',
          recipientScopeVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.throwVersionConflict();
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.version_restored',
        targetType: 'weekly_report',
        targetId: reportId,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: { aggregateVersion: report.version, versionId: report.currentVersion.id },
        after: {
          aggregateVersion: report.version + 1,
          versionId: version.id,
          restoredFrom: target.id,
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      const response = {
        replayed: false,
        report: await this.serializeReport(tx, reportId),
        version: await this.serializeVersion(tx, version.id, reportId),
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response);
      return response;
    });
  }

  public async confirm(
    reportId: string,
    input: ConfirmWeeklyReportInput,
    context: MutationContext,
  ) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.weeklyReport.findFirst({
        where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
        include: { currentVersion: true, currentConfirmation: true },
      });
      if (!report?.currentVersion) {
        throw new DomainError(errorCodes.notFound, '周报或当前版本不存在', { httpStatus: 404 });
      }
      this.assertEditBase(report, input.versionId, input.reportVersion);
      const version = report.currentVersion;
      const fields = fieldsFromVersion(version);
      const missingFields = Object.entries(fields)
        .filter(([, value]) => !value.trim())
        .map(([field]) => field);
      if (missingFields.length > 0) {
        throw new DomainError(
          'WEEKLY_REPORT_FIELDS_INCOMPLETE',
          '六个周报字段必须全部填写后才能确认',
          {
            httpStatus: 422,
            details: { missingFields },
          },
        );
      }
      if (fields.reportDate < report.periodStart || fields.reportDate > report.periodEnd) {
        throw new DomainError(
          'WEEKLY_REPORT_DATE_OUTSIDE_PERIOD',
          '报告日期必须位于当前周报周期内',
          {
            httpStatus: 422,
          },
        );
      }
      if (version.scheduleAt && version.scheduleAt <= now) {
        throw new DomainError(
          'WEEKLY_REPORT_SCHEDULE_EXPIRED',
          '计划提交时间已过期，请调整后再确认',
          {
            httpStatus: 422,
          },
        );
      }
      if (
        version.templateMappingVersionId !== input.templateMappingVersionId ||
        report.templateMappingVersionId !== input.templateMappingVersionId
      ) {
        throw new DomainError(
          'WEEKLY_REPORT_TEMPLATE_MAPPING_CHANGED',
          '模板映射已变化，请刷新当前版本',
          {
            httpStatus: 409,
            suggestedAction: 'refresh',
          },
        );
      }
      const mapping = await tx.dingTalkTemplateMappingVersion.findUnique({
        where: { id: input.templateMappingVersionId },
        include: { mapping: { include: { connection: true } } },
      });
      if (
        !mapping ||
        mapping.mapping.currentVersionId !== mapping.id ||
        mapping.expiresAt <= now ||
        !mapping.mapping.connection.enabled ||
        mapping.mapping.connection.status !== 'healthy'
      ) {
        throw new DomainError(
          'WEEKLY_REPORT_TEMPLATE_MAPPING_INVALID',
          '当前模板映射不是最新有效探测结果，请重新探测并保存新版本',
          { httpStatus: 422, suggestedAction: 'reconfigure' },
        );
      }
      const capabilities = this.parseObject(mapping.mapping.connection.capabilitiesJson);
      const discovery = this.parseObject(capabilities.templateDiscovery);
      if (discovery.snapshotHash !== mapping.capabilitySnapshotHash) {
        throw new DomainError(
          'WEEKLY_REPORT_TEMPLATE_CAPABILITY_CHANGED',
          '钉钉连接能力快照已变化，请重新确认模板字段',
          { httpStatus: 422, suggestedAction: 'reconfigure' },
        );
      }
      this.assertTemplateLengths(fields, this.parseArray(mapping.fieldsJson));
      const warnings = this.warningFacts(version.warningsJson);
      const blocking = warnings.filter((warning) => warning.blocking);
      if (blocking.length > 0) {
        throw new DomainError('WEEKLY_REPORT_BLOCKING_WARNINGS', '存在阻断 warning，不能确认周报', {
          httpStatus: 422,
          details: { warnings: blocking },
        });
      }
      const acknowledged = new Set(input.acknowledgedWarningIds);
      const currentWarningIds = new Set(warnings.map((warning) => warning.id));
      const unknownAcknowledgements = input.acknowledgedWarningIds.filter(
        (warningId) => !currentWarningIds.has(warningId),
      );
      if (unknownAcknowledgements.length > 0) {
        throw new DomainError(
          'WEEKLY_REPORT_WARNING_ACKNOWLEDGEMENT_INVALID',
          'warning 知悉清单包含不属于当前版本的条目，请刷新后重新确认',
          { httpStatus: 409, details: { unknownAcknowledgements }, suggestedAction: 'refresh' },
        );
      }
      const missingAcknowledgements = warnings
        .filter((warning) => !warning.blocking && !acknowledged.has(warning.id))
        .map((warning) => warning.id);
      if (missingAcknowledgements.length > 0) {
        throw new DomainError(
          'WEEKLY_REPORT_WARNINGS_NOT_ACKNOWLEDGED',
          '所有非阻断 warning 都必须逐项知悉后才能确认',
          { httpStatus: 422, details: { missingAcknowledgements } },
        );
      }
      const attachmentFacts = this.parseArray(version.attachmentsJson);
      await this.verifyAttachments(tx, reportId, attachmentFacts);
      const recipientScope = this.parseObject(version.recipientScopeJson);
      await this.verifyRecipientScope(tx, mapping.mapping.connectionId, recipientScope, now);
      const recipientScopeHash = requestHash(recipientScope);
      const attachmentsHash = requestHash(attachmentFacts);
      if (
        report.currentConfirmation?.status === 'active' &&
        report.currentConfirmation.versionId === version.id &&
        report.currentConfirmation.contentHash === version.contentHash &&
        report.currentConfirmation.templateMappingVersionId === mapping.id &&
        report.currentConfirmation.recipientScopeHash === recipientScopeHash &&
        report.currentConfirmation.attachmentsHash === attachmentsHash
      ) {
        const response = {
          replayed: true,
          confirmation: this.serializeConfirmation(report.currentConfirmation),
          report: await this.serializeReport(tx, reportId),
        };
        await this.completeIdempotency(tx, context.idempotencyRecordId, response);
        return response;
      }
      const confirmation = await tx.weeklyReportConfirmation.create({
        data: {
          id: newId(),
          reportId,
          versionId: version.id,
          reportAggregateVersion: report.version,
          contentHash: version.contentHash,
          templateMappingVersionId: mapping.id,
          warningAcknowledgementsJson: JSON.stringify(
            warnings.map((warning) => ({
              id: warning.id,
              code: warning.code,
              acknowledgedAt: now.toISOString(),
            })),
          ),
          recipientScopeHash,
          attachmentsHash,
          confirmedBy: this.sessions.currentProfileId,
          confirmedAt: now,
        },
      });
      const changed = await tx.weeklyReport.updateMany({
        where: { id: reportId, version: report.version, currentVersionId: version.id },
        data: {
          status: 'confirmed',
          confirmedVersionId: version.id,
          currentConfirmationId: confirmation.id,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.throwVersionConflict();
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.confirmed',
        targetType: 'weekly_report',
        targetId: reportId,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: { aggregateVersion: report.version, status: report.status },
        after: {
          aggregateVersion: report.version + 1,
          status: 'confirmed',
          confirmationId: confirmation.id,
          versionId: version.id,
          contentHash: version.contentHash,
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      const response = {
        replayed: false,
        confirmation: this.serializeConfirmation(confirmation),
        report: await this.serializeReport(tx, reportId),
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response);
      return response;
    });
  }

  private assertEditBase(
    report: { version: number; currentVersionId: string | null },
    baseVersionId: string,
    reportVersion: number,
  ): void {
    if (report.currentVersionId !== baseVersionId || report.version !== reportVersion) {
      throw new DomainError(errorCodes.versionConflict, '周报已被其他页面修改，请刷新后重试', {
        httpStatus: 409,
        details: {
          expectedVersionId: report.currentVersionId,
          expectedReportVersion: report.version,
        },
        suggestedAction: 'refresh',
      });
    }
  }

  private buildManualStructuredFields(
    current: {
      id: string;
      fieldsJson: string;
      sourceLinks: Array<{ fieldName: string; sourceType: string; sourceId: string }>;
    },
    fields: ReturnType<typeof fieldsFromVersion>,
    changedFields: string[],
  ): Record<string, unknown> {
    const existing = this.parseObject(current.fieldsJson);
    const result: Record<string, unknown> = {};
    for (const field of weeklyFields) {
      if (!changedFields.includes(field)) {
        result[field] = existing[field] ?? [];
        continue;
      }
      const sourceRefs = current.sourceLinks
        .filter((link) => link.fieldName === field)
        .map((link) => ({ type: link.sourceType, id: link.sourceId }))
        .filter(
          (value, index, all) =>
            all.findIndex((candidate) => requestHash(candidate) === requestHash(value)) === index,
        );
      result[field] = [
        {
          id: `manual-${requestHash({ parent: current.id, field, text: fields[field] }).slice(0, 24)}`,
          body: fields[field],
          sourceRefs,
          provenance: { kind: 'manual_edit', parentVersionId: current.id },
        },
      ];
    }
    return result;
  }

  private async resolveAttachmentFacts(
    tx: Prisma.TransactionClient,
    reportId: string,
    attachmentIds: string[],
  ) {
    if (attachmentIds.length === 0) return [];
    const rows = await tx.weeklyReportAttachment.findMany({
      where: { id: { in: attachmentIds }, reportId, status: 'available' },
    });
    if (rows.length !== attachmentIds.length) {
      throw new DomainError(
        'WEEKLY_REPORT_ATTACHMENT_INVALID',
        '存在不属于当前周报或已删除的附件',
        { httpStatus: 422 },
      );
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return attachmentIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error('附件查询结果不完整');
      return {
        id: row.id,
        originalName: row.originalName,
        mimeType: row.mimeType,
        extension: row.extension,
        sizeBytes: row.sizeBytes,
        contentHash: row.contentHash,
      };
    });
  }

  private async resolveSelectableMapping(
    tx: Prisma.TransactionClient | PrismaService,
    versionId: string,
  ) {
    const version = await tx.dingTalkTemplateMappingVersion.findUnique({
      where: { id: versionId },
      include: { mapping: { include: { connection: true } } },
    });
    if (
      !version ||
      version.mapping.currentVersionId !== version.id ||
      version.expiresAt <= new Date() ||
      !version.mapping.connection.enabled ||
      version.mapping.connection.status !== 'healthy'
    ) {
      throw new DomainError(
        'WEEKLY_REPORT_TEMPLATE_MAPPING_NOT_SELECTABLE',
        '只能选择当前有效且连接健康的钉钉模板映射',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }
    return version;
  }

  private async resolveRecipientScope(
    tx: Prisma.TransactionClient,
    connectionId: string | null,
    validationIds: string[],
  ) {
    if (validationIds.length === 0) return { connectionId, recipients: [] };
    if (!connectionId) {
      throw new DomainError(
        'WEEKLY_REPORT_RECIPIENT_MAPPING_REQUIRED',
        '选择收件人前必须先选择有效的钉钉模板映射',
        { httpStatus: 422 },
      );
    }
    const rows = await tx.dingTalkRecipientValidation.findMany({
      where: { id: { in: validationIds }, connectionId, available: true },
    });
    if (rows.length !== validationIds.length) {
      throw new DomainError(
        'WEEKLY_REPORT_RECIPIENT_VALIDATION_INVALID',
        '存在不属于当前连接或不可用的收件人校验快照',
        { httpStatus: 422 },
      );
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      connectionId,
      recipients: validationIds.map((id) => {
        const row = byId.get(id);
        if (!row) throw new Error('收件人查询结果不完整');
        return {
          validationId: row.id,
          subjectType: row.subjectType,
          externalId: row.externalId,
          displayName: row.displayName,
          observedAt: row.observedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          contentHash: row.contentHash,
        };
      }),
    };
  }

  private assertRecipientMappingCompatibility(
    recipientScope: Record<string, unknown>,
    mappingConnectionId: string | null,
  ): void {
    const recipients = Array.isArray(recipientScope.recipients) ? recipientScope.recipients : [];
    if (recipients.length > 0 && recipientScope.connectionId !== mappingConnectionId) {
      throw new DomainError(
        'WEEKLY_REPORT_RECIPIENT_CONNECTION_MISMATCH',
        '收件人校验快照与模板映射不属于同一个钉钉连接',
        { httpStatus: 422 },
      );
    }
  }

  private async copySourceLinks(
    tx: Prisma.TransactionClient,
    current: {
      sourceLinks: Array<{
        snapshotId: string;
        fieldName: string;
        blockId: string;
        sourceType: string;
        sourceId: string;
        taskId: string | null;
        evidenceId: string | null;
        sourceContentHash: string;
        sourceSummaryJson: string;
      }>;
    },
    versionId: string,
    structured: Record<string, unknown>,
    changedFields: string[],
  ): Promise<void> {
    const seen = new Set<string>();
    const data = current.sourceLinks.flatMap((link) => {
      const blockId = changedFields.includes(link.fieldName)
        ? this.firstBlockId(structured[link.fieldName])
        : link.blockId;
      if (!blockId) return [];
      const key = `${link.fieldName}:${blockId}:${link.sourceType}:${link.sourceId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          id: newId(),
          snapshotId: link.snapshotId,
          versionId,
          fieldName: link.fieldName,
          blockId,
          sourceType: link.sourceType,
          sourceId: link.sourceId,
          taskId: link.taskId,
          evidenceId: link.evidenceId,
          sourceContentHash: link.sourceContentHash,
          sourceSummaryJson: link.sourceSummaryJson,
        },
      ];
    });
    if (data.length > 0) await tx.reportSourceLink.createMany({ data });
  }

  private firstBlockId(value: unknown): string | null {
    if (!Array.isArray(value)) return null;
    const first: unknown = (value as unknown[])[0];
    if (typeof first !== 'object' || first === null || !('id' in first)) return null;
    return String(first.id);
  }

  private async invalidateConfirmation(
    tx: Prisma.TransactionClient,
    confirmation: { id: string; status: string } | null,
    reason: string,
  ): Promise<void> {
    if (!confirmation || confirmation.status !== 'active') return;
    await tx.weeklyReportConfirmation.update({
      where: { id: confirmation.id },
      data: { status: 'invalidated', invalidatedAt: new Date(), invalidationReason: reason },
    });
    const pendingScheduled = await tx.deliveryIntent.findMany({
      where: { confirmationId: confirmation.id, channel: 'dingtalk_log', status: 'pending' },
      select: { id: true, jobId: true },
    });
    if (pendingScheduled.length === 0) return;
    const cancelledAt = new Date();
    const cancellationReason = `确认版本已失效：${reason}`.slice(0, 500);
    // 尚未开始的预约正式提交必须与旧确认一起取消，绝不能把新正文混入旧批准。
    await tx.deliveryIntent.updateMany({
      where: { id: { in: pendingScheduled.map((intent) => intent.id) }, status: 'pending' },
      data: {
        status: 'cancelled',
        cancelledAt,
        cancellationReason,
        lastErrorCode: 'SCHEDULED_DELIVERY_CONFIRMATION_INVALIDATED',
        lastErrorSummary: cancellationReason,
        completedAt: cancelledAt,
        version: { increment: 1 },
      },
    });
    const jobIds = pendingScheduled.flatMap((intent) => (intent.jobId ? [intent.jobId] : []));
    if (jobIds.length > 0) {
      await tx.job.updateMany({
        where: { id: { in: jobIds }, status: 'queued' },
        data: {
          status: 'cancelled',
          cancelRequested: true,
          completedAt: cancelledAt,
          lastErrorCode: 'SCHEDULED_DELIVERY_CONFIRMATION_INVALIDATED',
          lastError: cancellationReason,
        },
      });
    }
  }

  private warningFacts(value: string) {
    return this.parseArray(value).map((warning) => {
      const object =
        typeof warning === 'object' && warning !== null
          ? (warning as Record<string, unknown>)
          : { message: String(warning) };
      return {
        ...object,
        id: requestHash(object),
        code: typeof object.code === 'string' ? object.code : 'WEEKLY_REPORT_WARNING',
        blocking: object.blocking === true,
      };
    });
  }

  private assertTemplateLengths(
    fields: ReturnType<typeof fieldsFromVersion>,
    mappings: unknown[],
  ): void {
    const violations = mappings.flatMap((mapping) => {
      if (typeof mapping !== 'object' || mapping === null) return [];
      const item = mapping as Record<string, unknown>;
      const field = item.internalField;
      const maxLength = item.maxLength;
      if (
        typeof field !== 'string' ||
        !(field in fields) ||
        typeof maxLength !== 'number' ||
        fields[field as keyof typeof fields].length <= maxLength
      ) {
        return [];
      }
      return [{ field, maxLength, actualLength: fields[field as keyof typeof fields].length }];
    });
    if (violations.length > 0) {
      throw new DomainError('WEEKLY_REPORT_TEMPLATE_FIELD_TOO_LONG', '周报字段超过钉钉模板限制', {
        httpStatus: 422,
        details: { violations },
      });
    }
  }

  private async verifyAttachments(
    tx: Prisma.TransactionClient,
    reportId: string,
    attachmentFacts: unknown[],
  ): Promise<void> {
    const ids = attachmentFacts.flatMap((fact) =>
      typeof fact === 'object' && fact !== null && 'id' in fact ? [String(fact.id)] : [],
    );
    if (ids.length !== attachmentFacts.length || new Set(ids).size !== ids.length) {
      throw new DomainError('WEEKLY_REPORT_ATTACHMENT_METADATA_INVALID', '附件元数据结构无效', {
        httpStatus: 422,
      });
    }
    if (ids.length === 0) return;
    const rows = await tx.weeklyReportAttachment.findMany({
      where: { id: { in: ids }, reportId, status: 'available' },
    });
    if (rows.length !== ids.length) {
      throw new DomainError(
        'WEEKLY_REPORT_ATTACHMENT_UNAVAILABLE',
        '存在已删除或不属于当前周报的附件',
        {
          httpStatus: 422,
        },
      );
    }
    for (const row of rows) {
      let buffer: Buffer;
      try {
        buffer = await readFile(this.attachments.storedPath(reportId, row.storedName));
      } catch {
        throw new DomainError(
          'WEEKLY_REPORT_ATTACHMENT_FILE_MISSING',
          `附件文件不存在：${row.originalName}`,
          {
            httpStatus: 422,
          },
        );
      }
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (buffer.length !== row.sizeBytes || hash !== row.contentHash) {
        throw new DomainError(
          'WEEKLY_REPORT_ATTACHMENT_FILE_CHANGED',
          `附件文件校验失败：${row.originalName}`,
          {
            httpStatus: 422,
          },
        );
      }
    }
  }

  private async verifyRecipientScope(
    tx: Prisma.TransactionClient,
    connectionId: string,
    scope: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const recipients = Array.isArray(scope.recipients) ? scope.recipients : [];
    if (scope.connectionId !== connectionId || recipients.length === 0) {
      throw new DomainError(
        'WEEKLY_REPORT_RECIPIENT_SCOPE_INVALID',
        '确认前必须选择至少一个属于当前钉钉连接的有效收件人',
        { httpStatus: 422 },
      );
    }
    const validationIds = recipients.flatMap((recipient) =>
      typeof recipient === 'object' && recipient !== null && 'validationId' in recipient
        ? [String((recipient as { validationId: unknown }).validationId)]
        : [],
    );
    if (
      validationIds.length !== recipients.length ||
      new Set(validationIds).size !== validationIds.length
    ) {
      throw new DomainError('WEEKLY_REPORT_RECIPIENT_SCOPE_INVALID', '收件人快照结构无效或重复', {
        httpStatus: 422,
      });
    }
    const rows = await tx.dingTalkRecipientValidation.findMany({
      where: { id: { in: validationIds }, connectionId, available: true, expiresAt: { gt: now } },
    });
    if (rows.length !== validationIds.length) {
      throw new DomainError(
        'WEEKLY_REPORT_RECIPIENT_VALIDATION_EXPIRED',
        '收件人校验快照已失效，请重新从钉钉验证接收范围',
        { httpStatus: 422, suggestedAction: 'reconfirm' },
      );
    }
    const factById = new Map(
      recipients.map((recipient) => {
        const object = recipient as Record<string, unknown>;
        return [String(object.validationId), object] as const;
      }),
    );
    for (const row of rows) {
      const fact = factById.get(row.id);
      if (!fact || fact.contentHash !== row.contentHash || fact.externalId !== row.externalId) {
        throw new DomainError(
          'WEEKLY_REPORT_RECIPIENT_FACT_CHANGED',
          '收件人事实与保存版本不一致，请重新选择',
          { httpStatus: 422 },
        );
      }
    }
  }

  private serializeConfirmation(confirmation: {
    id: string;
    versionId: string;
    reportAggregateVersion: number;
    contentHash: string;
    templateMappingVersionId: string;
    warningAcknowledgementsJson: string;
    recipientScopeHash: string;
    attachmentsHash: string;
    status: string;
    confirmedBy: string;
    confirmedAt: Date;
    invalidatedAt: Date | null;
    invalidationReason: string | null;
  }) {
    return {
      id: confirmation.id,
      versionId: confirmation.versionId,
      reportAggregateVersion: confirmation.reportAggregateVersion,
      contentHash: confirmation.contentHash,
      templateMappingVersionId: confirmation.templateMappingVersionId,
      warningAcknowledgements: JSON.parse(confirmation.warningAcknowledgementsJson) as unknown,
      recipientScopeHash: confirmation.recipientScopeHash,
      attachmentsHash: confirmation.attachmentsHash,
      status: confirmation.status,
      confirmedBy: confirmation.confirmedBy,
      confirmedAt: confirmation.confirmedAt.toISOString(),
      invalidatedAt: confirmation.invalidatedAt?.toISOString() ?? null,
      invalidationReason: confirmation.invalidationReason,
    };
  }

  private async completeIdempotency(
    tx: Prisma.TransactionClient,
    recordId: string,
    response: unknown,
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        state: 'completed',
        httpStatus: 200,
        responseJson: JSON.stringify(response),
        errorCode: null,
      },
    });
  }

  private throwVersionConflict(): never {
    throw new DomainError(errorCodes.versionConflict, '周报发生并发修改，请刷新后重试', {
      httpStatus: 409,
      suggestedAction: 'refresh',
    });
  }

  private async collectSources(
    input: GenerateWeeklyReportInput,
    period: ResolvedPeriod,
    now: Date,
  ): Promise<{
    tasks: WeeklyTaskFact[];
    evidence: WeeklyEvidenceFact[];
    jiraSyncRunIds: string[];
  }> {
    const taskRows = await this.prisma.task.findMany({
      where: {
        isCurrentUser: true,
        visibilityState: 'visible',
        ...(input.jiraQuery.connectionIds?.length
          ? { connectionId: { in: input.jiraQuery.connectionIds } }
          : {}),
        ...(input.jiraQuery.projectIds?.length
          ? { projectId: { in: input.jiraQuery.projectIds } }
          : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        statusEvents: { orderBy: { observedAt: 'desc' }, take: 1 },
        sourceObservations: {
          orderBy: { observedAt: 'desc' },
          take: 1,
          include: { syncRun: { select: { id: true, status: true } } },
        },
      },
      orderBy: { id: 'asc' },
    });
    const tasks: WeeklyTaskFact[] = taskRows.map((task) => {
      const latestObservation = task.sourceObservations[0];
      const observedAt = latestObservation?.observedAt ?? task.lastObservedAt;
      const sourceUnavailable =
        task.visibilityState === 'unavailable' ||
        (task.primarySource === 'jira' &&
          Boolean(latestObservation?.syncRun) &&
          latestObservation?.syncRun?.status !== 'succeeded');
      const sourceFreshness = sourceUnavailable
        ? 'unavailable'
        : this.isFresh(observedAt, now, input.freshnessPolicy.taskMaxAgeMinutes)
          ? 'fresh'
          : 'stale';
      const lastStatus = task.statusEvents[0];
      // 这里只构造明确白名单字段；Jira description、源码、diff 和附件从未进入快照对象。
      return {
        id: task.id,
        issueKey: task.issueKey,
        projectId: task.projectId,
        projectName: task.project?.name ?? task.projectKey ?? '未归属项目',
        parentTaskId: task.parentTaskId,
        parentTitle: task.parentTitle,
        title: task.title,
        normalizedStatus: this.normalizeTaskStatus(task.normalizedStatus),
        priority: task.priority,
        plannedStartDate: task.plannedStartDate,
        dueDate: task.dueDate,
        timeSpentSeconds: task.timeSpentSeconds,
        originalEstimateSeconds: task.originalEstimateSeconds,
        remainingEstimateSeconds: task.remainingEstimateSeconds,
        sprintActive: this.hasActiveSprint(task.sprintIdsJson),
        isCurrentUser: task.isCurrentUser,
        visibilityState: this.normalizeVisibility(task.visibilityState),
        lastObservedAt: task.lastObservedAt.toISOString(),
        statusChangedAt: lastStatus
          ? (lastStatus.effectiveAt ?? lastStatus.observedAt).toISOString()
          : null,
        sourceFreshness,
      };
    });
    const taskIds = taskRows.map((task) => task.id);
    const links = taskIds.length
      ? await this.prisma.evidenceLink.findMany({
          where: {
            taskId: { in: taskIds },
            status: {
              in: input.includeUnconfirmedEvidence ? ['confirmed', 'suggested'] : ['confirmed'],
            },
          },
          include: { evidence: true },
          orderBy: [{ taskId: 'asc' }, { evidenceId: 'asc' }],
        })
      : [];
    const evidence: WeeklyEvidenceFact[] = links.map((link) => {
      const ageFresh = link.evidence.sourceSyncedAt
        ? this.isFresh(
            link.evidence.sourceSyncedAt,
            now,
            input.freshnessPolicy.evidenceMaxAgeMinutes,
          )
        : false;
      const availabilityState =
        link.evidence.availabilityState === 'unavailable'
          ? 'unavailable'
          : link.evidence.availabilityState === 'stale' || !ageFresh
            ? 'stale'
            : 'available';
      const metadata = this.parseObject(link.evidence.metadataJson);
      return {
        id: link.evidence.id,
        taskId: link.taskId,
        projectId: link.evidence.projectId,
        sourceType: this.normalizeEvidenceType(link.evidence.sourceType),
        title: link.evidence.title,
        url: link.evidence.url,
        eventAt: link.evidence.eventAt?.toISOString() ?? null,
        relationStatus: link.status as WeeklyEvidenceFact['relationStatus'],
        revalidationState: link.revalidationState as WeeklyEvidenceFact['revalidationState'],
        availabilityState,
        pipelineStatus:
          typeof metadata.status === 'string'
            ? metadata.status
            : typeof metadata.pipelineStatus === 'string'
              ? metadata.pipelineStatus
              : null,
      };
    });
    if (input.includeUnconfirmedEvidence) {
      const aliases = await this.prisma.identityAlias.findMany({
        where: {
          profileId: this.sessions.currentProfileId,
          enabled: true,
          aliasType: { in: ['git_name', 'git_email'] },
        },
        select: { normalizedValue: true },
      });
      const normalizedAliases = new Set(
        aliases.map((alias) => this.normalizeIdentity(alias.normalizedValue)),
      );
      const projectIds = [...new Set(taskRows.flatMap((task) => task.projectId ?? []))];
      if (normalizedAliases.size > 0 && projectIds.length > 0) {
        const linkedEvidenceIds = new Set(evidence.map((item) => item.id));
        const unlinkedCommits = await this.prisma.evidence.findMany({
          where: {
            projectId: { in: projectIds },
            sourceType: 'commit',
            eventAt: {
              gte: this.businessDateStart(period.periodStart),
              lt: this.businessDateStart(this.addDays(period.periodEnd, 1)),
            },
            links: { none: { taskId: { in: taskIds } } },
          },
          orderBy: { id: 'asc' },
        });
        for (const candidate of unlinkedCommits) {
          if (linkedEvidenceIds.has(candidate.id)) continue;
          const metadata = this.parseObject(candidate.metadataJson);
          const authors = [
            metadata.authorName,
            metadata.authorEmail,
            metadata.committerName,
            metadata.committerEmail,
          ]
            .filter((value): value is string => typeof value === 'string')
            .map((value) => this.normalizeIdentity(value));
          if (!authors.some((author) => normalizedAliases.has(author))) continue;
          const ageFresh = candidate.sourceSyncedAt
            ? this.isFresh(
                candidate.sourceSyncedAt,
                now,
                input.freshnessPolicy.evidenceMaxAgeMinutes,
              )
            : false;
          evidence.push({
            id: candidate.id,
            taskId: null,
            projectId: candidate.projectId,
            sourceType: 'commit',
            title: candidate.title,
            url: candidate.url,
            eventAt: candidate.eventAt?.toISOString() ?? null,
            relationStatus: 'suggested',
            revalidationState: 'valid',
            availabilityState:
              candidate.availabilityState === 'unavailable'
                ? 'unavailable'
                : candidate.availabilityState === 'stale' || !ageFresh
                  ? 'stale'
                  : 'available',
            pipelineStatus: null,
          });
        }
      }
    }
    evidence.sort((left, right) => left.id.localeCompare(right.id));
    const jiraSyncRunIds = [
      ...new Set(
        taskRows.flatMap((task) =>
          task.sourceObservations[0]?.syncRun?.status === 'succeeded'
            ? [task.sourceObservations[0].syncRun?.id]
            : [],
        ),
      ),
    ].sort();
    return { tasks, evidence, jiraSyncRunIds };
  }

  private resolvePeriod(
    input: GenerateWeeklyReportInput,
    calendarVersion: WorkCalendarVersion | null,
    now: Date,
  ): ResolvedPeriod {
    if (input.periodStart && input.periodEnd && input.reportDate) {
      return {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        reportDate: input.reportDate,
      };
    }
    const current = this.businessDateFromInstant(now);
    const currentWeekday = this.isoWeekday(current);
    const monday = this.addDays(current, -(currentWeekday - 1));
    const weekdays = calendarVersion
      ? (JSON.parse(calendarVersion.workingWeekdaysJson) as number[])
      : [1, 2, 3, 4, 5];
    const overrides = calendarVersion
      ? (JSON.parse(calendarVersion.dateOverridesJson) as Array<{
          date: string;
          isWorkday: boolean;
        }>)
      : [];
    const overrideMap = new Map(overrides.map((override) => [override.date, override.isWorkday]));
    const workdays = Array.from({ length: 7 }, (_, index) => this.addDays(monday, index)).filter(
      (date) => overrideMap.get(date) ?? weekdays.includes(this.isoWeekday(date)),
    );
    if (workdays.length === 0) {
      throw new DomainError(
        'WORK_CALENDAR_WEEK_EMPTY',
        '当前自然周没有任何工作日，无法生成默认周报周期',
        {
          httpStatus: 422,
        },
      );
    }
    return {
      periodStart: workdays[0] as string,
      periodEnd: workdays.at(-1) as string,
      reportDate: workdays.at(-1) as string,
    };
  }

  private async resolveCalendarVersion(versionId: string | undefined) {
    if (versionId) {
      const version = await this.prisma.workCalendarVersion.findFirst({
        where: { id: versionId, calendarId: defaultCalendarId },
      });
      if (!version) {
        throw new DomainError(errorCodes.notFound, '工作日历版本不存在', { httpStatus: 404 });
      }
      return version;
    }
    const calendar = await this.prisma.workCalendar.findUnique({
      where: { id: defaultCalendarId },
      include: { currentVersion: true },
    });
    return calendar?.currentVersion ?? null;
  }

  private renderFields(fields: Record<WeeklyReportField, WeeklyReportBlock[]>) {
    return Object.fromEntries(
      weeklyFields.map((field) => [
        field,
        fields[field]
          .map((block) => block.body.trim())
          .filter(Boolean)
          .join('\n'),
      ]),
    ) as Record<WeeklyReportField, string>;
  }

  private buildSourceLinks(
    snapshotId: string,
    versionId: string,
    fields: Record<WeeklyReportField, WeeklyReportBlock[]>,
    tasks: WeeklyTaskFact[],
    evidence: WeeklyEvidenceFact[],
    manualInputs: WeeklyManualInput[],
  ) {
    const taskById = new Map(tasks.map((item) => [item.id, item]));
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const manualById = new Map(manualInputs.map((item) => [item.id, item]));
    // 链接细化到字段和稳定块 ID，后续人工版本可以继承或重新绑定，而无需猜测文本相似度。
    return weeklyFields.flatMap((field) =>
      fields[field].flatMap((block) =>
        block.sourceRefs.map((source) => {
          const summary =
            source.type === 'task'
              ? taskById.get(source.id)
              : source.type === 'evidence'
                ? evidenceById.get(source.id)
                : manualById.get(source.id);
          if (!summary) {
            throw new DomainError(
              'WEEKLY_REPORT_SOURCE_REFERENCE_INVALID',
              `周报块 ${block.id} 引用了不存在的来源 ${source.type}:${source.id}`,
              { httpStatus: 500 },
            );
          }
          return {
            id: newId(),
            snapshotId,
            versionId,
            fieldName: field,
            blockId: block.id,
            sourceType: source.type,
            sourceId: source.id,
            taskId: source.type === 'task' ? source.id : null,
            evidenceId: source.type === 'evidence' ? source.id : null,
            sourceContentHash: requestHash(summary),
            sourceSummaryJson: JSON.stringify(summary),
          };
        }),
      ),
    );
  }

  private async serializeReport(
    client: Prisma.TransactionClient | PrismaService,
    reportId: string,
  ) {
    const report = await client.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      include: {
        currentVersion: true,
        confirmedVersion: true,
        currentConfirmation: true,
        _count: {
          select: { versions: true, sourceSnapshots: true, confirmations: true, attachments: true },
        },
      },
    });
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
    return {
      ...this.serializeReportSummary(report),
      confirmedVersion: report.confirmedVersion
        ? this.serializeVersionSummary(report.confirmedVersion)
        : null,
      currentConfirmation: report.currentConfirmation
        ? this.serializeConfirmation(report.currentConfirmation)
        : null,
      delivery: {
        log: report.logDeliveryState,
        robot: report.robotDeliveryState,
        partial:
          report.logDeliveryState === 'submitted' &&
          !['notified', 'skipped'].includes(report.robotDeliveryState),
      },
      sourceSnapshotCount: report._count.sourceSnapshots,
      confirmationCount: report._count.confirmations,
      attachmentCount: report._count.attachments,
    };
  }

  private serializeReportSummary(report: {
    id: string;
    periodStart: string;
    periodEnd: string;
    reportDate: string;
    timezone: string;
    templateName: string;
    templateMappingVersionId: string | null;
    status: string;
    logDeliveryState: string;
    robotDeliveryState: string;
    currentVersionId: string | null;
    confirmedVersionId: string | null;
    recipientScopeVersion: number;
    scheduleAt: Date | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    currentVersion?: {
      id: string;
      versionNo: number;
      origin: string;
      aiGenerationId: string | null;
      contentHash: string;
      createdAt: Date;
    } | null;
    _count?: { versions: number };
  }) {
    return {
      id: report.id,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      reportDate: report.reportDate,
      timezone: report.timezone,
      templateName: report.templateName,
      templateMappingVersionId: report.templateMappingVersionId,
      status: report.status,
      logDeliveryState: report.logDeliveryState,
      robotDeliveryState: report.robotDeliveryState,
      currentVersionId: report.currentVersionId,
      confirmedVersionId: report.confirmedVersionId,
      currentVersion: report.currentVersion
        ? this.serializeVersionSummary(report.currentVersion)
        : null,
      recipientScopeVersion: report.recipientScopeVersion,
      scheduleAt: report.scheduleAt?.toISOString() ?? null,
      versionCount: report._count?.versions ?? null,
      version: report.version,
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
    };
  }

  private serializeVersionSummary(version: {
    id: string;
    versionNo: number;
    origin: string;
    aiGenerationId: string | null;
    contentHash: string;
    createdAt: Date;
  }) {
    return {
      id: version.id,
      versionNo: version.versionNo,
      origin: version.origin,
      aiGenerationId: version.aiGenerationId,
      contentHash: version.contentHash,
      createdAt: version.createdAt.toISOString(),
    };
  }

  private async serializeVersion(
    client: Prisma.TransactionClient | PrismaService,
    versionId: string,
    expectedReportId?: string,
  ) {
    const version = await client.weeklyReportVersion.findFirst({
      where: {
        id: versionId,
        ...(expectedReportId ? { reportId: expectedReportId } : {}),
        report: { ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      },
      include: {
        sourceSnapshot: true,
        sourceLinks: { orderBy: [{ fieldName: 'asc' }, { blockId: 'asc' }, { sourceId: 'asc' }] },
      },
    });
    if (!version) throw new DomainError(errorCodes.notFound, '周报版本不存在', { httpStatus: 404 });
    return {
      id: version.id,
      reportId: version.reportId,
      versionNo: version.versionNo,
      origin: version.origin,
      parentVersionId: version.parentVersionId,
      aiGenerationId: version.aiGenerationId,
      fields: {
        reportDate: version.reportDateText,
        recentGoals: version.recentGoalsText,
        weeklyWork: version.weeklyWorkText,
        nextWeekPlans: version.nextWeekPlansText,
        problems: version.problemsText,
        other: version.otherText,
      },
      structuredFields: JSON.parse(version.fieldsJson) as unknown,
      warnings: this.warningFacts(version.warningsJson),
      attachments: JSON.parse(version.attachmentsJson) as unknown,
      recipientScope: JSON.parse(version.recipientScopeJson) as unknown,
      templateMappingVersionId: version.templateMappingVersionId,
      scheduleAt: version.scheduleAt?.toISOString() ?? null,
      sourceSnapshot: this.serializeSnapshot(version.sourceSnapshot),
      sourceLinks: version.sourceLinks.map((link) => ({
        id: link.id,
        field: link.fieldName,
        blockId: link.blockId,
        sourceType: link.sourceType,
        sourceId: link.sourceId,
        sourceContentHash: link.sourceContentHash,
        sourceSummary: JSON.parse(link.sourceSummaryJson) as unknown,
      })),
      contentHash: version.contentHash,
      changeSummary: JSON.parse(version.changeSummaryJson) as unknown,
      createdBy: version.createdBy,
      createdAt: version.createdAt.toISOString(),
    };
  }

  private serializeSnapshot(snapshot: {
    id: string;
    periodStart: string;
    periodEnd: string;
    reportDate: string;
    timezone: string;
    calendarVersionId: string | null;
    profileId: string;
    profileVersion: number;
    jiraQueryJson: string;
    jiraSyncRunIdsJson: string;
    taskFactsJson: string;
    evidenceFactsJson: string;
    manualInputsJson: string;
    freshnessPolicyJson: string;
    warningsJson: string;
    ruleVersion: string;
    templateMappingVersionId: string | null;
    sanitizationPolicyVersion: string;
    generationHash: string;
    sourceContentHash: string;
    createdAt: Date;
  }) {
    return {
      id: snapshot.id,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      reportDate: snapshot.reportDate,
      timezone: snapshot.timezone,
      calendarVersionId: snapshot.calendarVersionId,
      profile: { id: snapshot.profileId, version: snapshot.profileVersion },
      jiraQuery: JSON.parse(snapshot.jiraQueryJson) as unknown,
      jiraSyncRunIds: JSON.parse(snapshot.jiraSyncRunIdsJson) as unknown,
      sources: {
        tasks: JSON.parse(snapshot.taskFactsJson) as unknown,
        evidence: JSON.parse(snapshot.evidenceFactsJson) as unknown,
        manualInputs: JSON.parse(snapshot.manualInputsJson) as unknown,
      },
      freshnessPolicy: JSON.parse(snapshot.freshnessPolicyJson) as unknown,
      warnings: JSON.parse(snapshot.warningsJson) as unknown,
      ruleVersion: snapshot.ruleVersion,
      templateMappingVersionId: snapshot.templateMappingVersionId,
      sanitizationPolicyVersion: snapshot.sanitizationPolicyVersion,
      generationHash: snapshot.generationHash,
      sourceContentHash: snapshot.sourceContentHash,
      createdAt: snapshot.createdAt.toISOString(),
    };
  }

  private async assertOwnedReport(
    client: Prisma.TransactionClient | PrismaService,
    reportId: string,
  ) {
    const report = await client.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      select: { id: true },
    });
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
  }

  private normalizeTaskStatus(value: string): WeeklyTaskFact['normalizedStatus'] {
    return ['planned', 'in_progress', 'blocked', 'done', 'cancelled'].includes(value)
      ? (value as WeeklyTaskFact['normalizedStatus'])
      : 'other';
  }

  private normalizeVisibility(value: string): WeeklyTaskFact['visibilityState'] {
    return ['visible', 'out_of_scope', 'unavailable'].includes(value)
      ? (value as WeeklyTaskFact['visibilityState'])
      : 'unavailable';
  }

  private normalizeEvidenceType(value: string): WeeklyEvidenceFact['sourceType'] {
    if (
      ['branch', 'commit', 'merge_request', 'pipeline', 'tag', 'release', 'manual'].includes(value)
    ) {
      return value as WeeklyEvidenceFact['sourceType'];
    }
    throw new DomainError(
      'WEEKLY_REPORT_EVIDENCE_TYPE_UNSUPPORTED',
      `周报规则不支持证据类型 ${value}`,
      { httpStatus: 422 },
    );
  }

  private hasActiveSprint(value: string): boolean {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return false;
    return parsed.some(
      (item) =>
        (typeof item === 'string' && item.length > 0) ||
        (typeof item === 'object' &&
          item !== null &&
          'state' in item &&
          String((item as { state: unknown }).state).toLowerCase() === 'active'),
    );
  }

  private parseObject(value: unknown): Record<string, unknown> {
    try {
      const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private parseArray(value: string): unknown[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private isFresh(value: Date, now: Date, maxAgeMinutes: number): boolean {
    const age = now.getTime() - value.getTime();
    return age <= maxAgeMinutes * 60_000;
  }

  private businessDateStart(value: string): Date {
    return new Date(`${value}T00:00:00+08:00`);
  }

  private normalizeIdentity(value: string): string {
    return value.trim().normalize('NFKC').toLowerCase();
  }

  private businessDateFromInstant(value: Date): string {
    const shifted = new Date(value.getTime() + shanghaiOffsetMilliseconds);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  }

  private isoWeekday(value: string): number {
    const [year, month, day] = value.split('-').map(Number);
    const weekday = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
    return weekday === 0 ? 7 : weekday;
  }

  private addDays(value: string, days: number): string {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
      const match = /^offset:(\d+)$/u.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
      const offset = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid');
      return offset;
    } catch {
      throw new DomainError('PAGINATION_CURSOR_INVALID', '分页游标无效', { httpStatus: 422 });
    }
  }
}
