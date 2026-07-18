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
import type { GenerateWeeklyReportInput, ListWeeklyReportsQuery } from './weekly-report.schemas.js';

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

interface ResolvedPeriod {
  periodStart: string;
  periodEnd: string;
  reportDate: string;
}

@Injectable()
export class WeeklyReportService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
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
          include: { currentVersion: true },
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
            sourceSnapshotId: snapshot.id,
            contentHash: ruleDraft.contentHash,
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
        const changed = await tx.weeklyReport.updateMany({
          where: { id: report.id, version: report.version },
          data: {
            reportDate: period.reportDate,
            templateMappingVersionId: input.templateMappingVersionId,
            status: 'generated',
            currentVersionId: version.id,
            confirmedVersionId: null,
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
        changeSummaryJson: true,
        createdBy: true,
        createdAt: true,
      },
    });
    return versions.map((version) => ({
      ...version,
      changeSummary: JSON.parse(version.changeSummaryJson) as unknown,
      createdAt: version.createdAt.toISOString(),
      changeSummaryJson: undefined,
    }));
  }

  public async getVersion(reportId: string, versionId: string) {
    await this.assertOwnedReport(this.prisma, reportId);
    return this.serializeVersion(this.prisma, versionId, reportId);
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
        _count: { select: { versions: true, sourceSnapshots: true } },
      },
    });
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
    return {
      ...this.serializeReportSummary(report),
      confirmedVersion: report.confirmedVersion
        ? this.serializeVersionSummary(report.confirmedVersion)
        : null,
      delivery: {
        log: report.logDeliveryState,
        robot: report.robotDeliveryState,
        partial:
          report.logDeliveryState === 'submitted' &&
          !['notified', 'skipped'].includes(report.robotDeliveryState),
      },
      sourceSnapshotCount: report._count.sourceSnapshots,
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
    contentHash: string;
    createdAt: Date;
  }) {
    return {
      id: version.id,
      versionNo: version.versionNo,
      origin: version.origin,
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
      fields: {
        reportDate: version.reportDateText,
        recentGoals: version.recentGoalsText,
        weeklyWork: version.weeklyWorkText,
        nextWeekPlans: version.nextWeekPlansText,
        problems: version.problemsText,
        other: version.otherText,
      },
      structuredFields: JSON.parse(version.fieldsJson) as unknown,
      warnings: JSON.parse(version.warningsJson) as unknown,
      attachments: JSON.parse(version.attachmentsJson) as unknown,
      recipientScope: JSON.parse(version.recipientScopeJson) as unknown,
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

  private parseObject(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
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
