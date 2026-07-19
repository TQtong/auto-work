import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';

export interface QuarterlyCollectionInput {
  reviewVersion: number;
  sources: { tasks: boolean; evidence: boolean; confirmedWeeklyReports: boolean };
  freshnessPolicy: { mode: 'require_fresh' | 'allow_stale'; maximumAgeHours: number };
}

interface MutationContext {
  correlationId: string;
  sessionId: string;
}

interface CandidateDraft {
  sourceKey: string;
  projectId: string | null;
  title: string;
  situation: string;
  action: string;
  result: string;
  impact: string;
  contributionBoundary: string;
  periodStart: string;
  periodEnd: string;
  evidenceStatus: 'complete' | 'partial' | 'needs_evidence';
  evidences: Array<{
    sourceType: string;
    sourceId: string;
    taskId: string | null;
    evidenceId: string | null;
    title: string;
    externalKey: string | null;
    url: string | null;
    eventAt: Date | null;
    availabilityState: string;
    sourceContentHash: string;
    sourceSummary: Record<string, unknown>;
    contributionAngle: string;
    primaryEvidence: boolean;
  }>;
}

type EvidenceWithProject = Prisma.EvidenceGetPayload<{
  include: { project: { include: { repositories: true } } };
}>;

interface IdentityMatchedEvidence {
  evidence: EvidenceWithProject;
  aliasId: string;
  aliasType: string;
  aliasValueHash: string;
  aliasVerifiedAt: string | null;
}

interface IdentityEvidenceCollection {
  matches: IdentityMatchedEvidence[];
  enabledAliasCount: number;
  ignoredUnwhitelistedCount: number;
}

@Injectable()
export class QuarterlyCollectionService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {}

  public async queue(reviewId: string, input: QuarterlyCollectionInput, context: MutationContext) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.quarterlyReview.findFirst({
        where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      });
      if (!review)
        throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
      if (review.version !== input.reviewVersion) {
        throw new DomainError(errorCodes.versionConflict, '季度评审已变化，请刷新后重新收集', {
          httpStatus: 409,
          suggestedAction: 'refresh',
        });
      }
      if (review.status === 'collecting') {
        const active = await tx.job.findFirst({
          where: {
            type: 'quarterly-review.collect',
            payloadRef: reviewId,
            status: { in: ['queued', 'running'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (active) return { replayed: true, jobId: active.id, reviewId, status: review.status };
      }
      const jobId = newId();
      const nextVersion = review.version + 1;
      const fallbackStatus =
        review.status === 'collecting'
          ? 'collection_failed'
          : review.currentConfirmationId
            ? 'selecting'
            : review.status;
      const changed = await tx.quarterlyReview.updateMany({
        where: { id: reviewId, version: input.reviewVersion },
        data: {
          status: 'collecting',
          currentConfirmationId: null,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new DomainError(errorCodes.versionConflict, '季度评审已变化，请刷新后重新收集', {
          httpStatus: 409,
          suggestedAction: 'refresh',
        });
      }
      await tx.job.create({
        data: {
          id: jobId,
          type: 'quarterly-review.collect',
          payloadRef: reviewId,
          payloadSummary: JSON.stringify({
            reviewId,
            expectedReviewVersion: nextVersion,
            fallbackStatus,
            sources: input.sources,
            freshnessPolicy: input.freshnessPolicy,
          }),
          scheduledAt: new Date(),
          maxAttempts: 2,
          dedupeKey: `quarterly-review.collect:${reviewId}:v${nextVersion}`,
        },
      });
      if (review.currentConfirmationId) {
        await tx.quarterlyReviewConfirmation.updateMany({
          where: { id: review.currentConfirmationId, status: 'active' },
          data: {
            status: 'invalidated',
            invalidatedAt: new Date(),
            invalidationReason: '重新收集季度来源数据',
          },
        });
      }
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'quarterly_review.collection_queued',
        targetType: 'quarterly_review',
        targetId: reviewId,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: { jobId, sources: input.sources, freshnessPolicy: input.freshnessPolicy },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return { replayed: false, jobId, reviewId, status: 'collecting' };
    });
  }

  public async listSnapshots(reviewId: string, limit: number) {
    await this.assertOwnedReview(reviewId);
    const snapshots = await this.prisma.quarterlyCollectionSnapshot.findMany({
      where: { reviewId },
      orderBy: [{ sequenceNo: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    return snapshots.map((snapshot) => ({
      id: snapshot.id,
      sequenceNo: snapshot.sequenceNo,
      sources: this.parseJson(snapshot.sourceSelectionJson, {}),
      freshnessPolicy: this.parseJson(snapshot.freshnessPolicyJson, {}),
      warnings: this.parseJson(snapshot.warningsJson, []),
      taskCount: this.parseArray(snapshot.taskFactsJson).length,
      evidenceCount: this.parseArray(snapshot.evidenceFactsJson).length,
      weeklyReportCount: this.parseArray(snapshot.weeklyReportFactsJson).length,
      sourceContentHash: snapshot.sourceContentHash,
      generationHash: snapshot.generationHash,
      createdAt: snapshot.createdAt.toISOString(),
    }));
  }

  public async getSnapshot(reviewId: string, snapshotId: string) {
    await this.assertOwnedReview(reviewId);
    const snapshot = await this.prisma.quarterlyCollectionSnapshot.findFirst({
      where: { id: snapshotId, reviewId },
    });
    if (!snapshot) {
      throw new DomainError(errorCodes.notFound, '季度来源快照不存在', { httpStatus: 404 });
    }
    return {
      id: snapshot.id,
      reviewId,
      sequenceNo: snapshot.sequenceNo,
      sources: this.parseJson(snapshot.sourceSelectionJson, {}),
      freshnessPolicy: this.parseJson(snapshot.freshnessPolicyJson, {}),
      taskFacts: this.parseJson(snapshot.taskFactsJson, []),
      evidenceFacts: this.parseJson(snapshot.evidenceFactsJson, []),
      weeklyReportFacts: this.parseJson(snapshot.weeklyReportFactsJson, []),
      warnings: this.parseJson(snapshot.warningsJson, []),
      sourceContentHash: snapshot.sourceContentHash,
      generationHash: snapshot.generationHash,
      createdAt: snapshot.createdAt.toISOString(),
    };
  }

  public async execute(
    jobId: string,
    reviewId: string,
    reportProgress: (value: number) => Promise<void>,
    isCancellationRequested: () => Promise<boolean> = () => Promise.resolve(false),
  ) {
    const [review, job] = await Promise.all([
      this.prisma.quarterlyReview.findUnique({ where: { id: reviewId } }),
      this.prisma.job.findUnique({ where: { id: jobId } }),
    ]);
    if (!review || !job)
      throw new DomainError(errorCodes.notFound, '季度收集作业或评审不存在', { httpStatus: 404 });
    const payload = this.parsePayload(job.payloadSummary);
    if (review.version !== payload.expectedReviewVersion || review.status !== 'collecting') {
      if (review.status === 'candidates_ready') {
        return { reviewId, status: review.status, replayed: true };
      }
      throw new DomainError(
        'QUARTERLY_COLLECTION_STALE_JOB',
        '季度评审已变化，旧收集作业停止执行',
        {
          httpStatus: 409,
        },
      );
    }
    if (await this.cancelIfRequested(jobId, reviewId, isCancellationRequested)) {
      return { reviewId, status: payload.fallbackStatus, cancelled: true };
    }
    await reportProgress(10);
    const startUtc = this.shanghaiBoundary(review.periodStart);
    const endUtc = this.shanghaiBoundary(review.nextPeriodStart);
    const inclusionFilters: Prisma.TaskWhereInput[] = [];
    if (payload.sources.tasks) {
      inclusionFilters.push({
        statusEvents: {
          some: {
            toNormalizedStatus: 'done',
            OR: [
              { effectiveAt: { gte: startUtc, lt: endUtc } },
              { effectiveAt: null, observedAt: { gte: startUtc, lt: endUtc } },
            ],
          },
        },
      });
    }
    if (payload.sources.evidence) {
      inclusionFilters.push({
        evidenceLinks: {
          some: {
            status: 'confirmed',
            evidence: { eventAt: { gte: startUtc, lt: endUtc } },
          },
        },
      });
    }
    const tasks =
      inclusionFilters.length > 0
        ? await this.prisma.task.findMany({
            where: {
              isCurrentUser: true,
              visibilityState: 'visible',
              OR: inclusionFilters,
            },
            include: {
              project: true,
              statusEvents: {
                where: payload.sources.tasks
                  ? {
                      toNormalizedStatus: 'done',
                      OR: [
                        { effectiveAt: { gte: startUtc, lt: endUtc } },
                        { effectiveAt: null, observedAt: { gte: startUtc, lt: endUtc } },
                      ],
                    }
                  : { id: { in: [] } },
                orderBy: { observedAt: 'asc' },
              },
              evidenceLinks: {
                where: payload.sources.evidence
                  ? {
                      status: 'confirmed',
                      evidence: { eventAt: { gte: startUtc, lt: endUtc } },
                    }
                  : { id: { in: [] } },
                include: { evidence: true },
              },
              fieldProvenances: {
                where: {
                  active: true,
                  fieldName: {
                    in: ['originalEstimateSeconds', 'remainingEstimateSeconds', 'timeSpentSeconds'],
                  },
                },
                orderBy: { fieldName: 'asc' },
              },
            },
            orderBy: { id: 'asc' },
          })
        : [];
    if (await this.cancelIfRequested(jobId, reviewId, isCancellationRequested)) {
      return { reviewId, status: payload.fallbackStatus, cancelled: true };
    }
    await reportProgress(30);
    const identityEvidenceCollection = payload.sources.evidence
      ? await this.collectIdentityMatchedEvidence(startUtc, endUtc, tasks)
      : { matches: [], enabledAliasCount: 0, ignoredUnwhitelistedCount: 0 };
    const identityMatchedEvidence = identityEvidenceCollection.matches;
    if (await this.cancelIfRequested(jobId, reviewId, isCancellationRequested)) {
      return { reviewId, status: payload.fallbackStatus, cancelled: true };
    }
    await reportProgress(45);
    const weeklyReports = payload.sources.confirmedWeeklyReports
      ? await this.prisma.weeklyReport.findMany({
          where: {
            ownerProfileId: review.ownerProfileId,
            archivedAt: null,
            confirmedVersionId: { not: null },
            periodStart: { lte: review.periodEnd },
            periodEnd: { gte: review.periodStart },
          },
          include: {
            confirmedVersion: {
              include: { sourceLinks: true },
            },
          },
        })
      : [];
    if (await this.cancelIfRequested(jobId, reviewId, isCancellationRequested)) {
      return { reviewId, status: payload.fallbackStatus, cancelled: true };
    }
    const taskFacts = tasks.map((task) => ({
      id: task.id,
      issueKey: task.issueKey,
      title: task.title,
      parentTaskId: task.parentTaskId,
      parentTitle: task.parentTitle,
      projectId: task.projectId,
      normalizedStatus: task.normalizedStatus,
      originalEstimateSeconds: task.originalEstimateSeconds,
      remainingEstimateSeconds: task.remainingEstimateSeconds,
      timeSpentSeconds: task.timeSpentSeconds,
      effortProvenance: task.fieldProvenances.map((provenance) => ({
        fieldName: provenance.fieldName,
        sourceType: provenance.sourceType,
        decision: provenance.decision,
        effectiveAt: provenance.effectiveAt.toISOString(),
      })),
      completedEvents: task.statusEvents.map((event) => ({
        effectiveAt: event.effectiveAt?.toISOString() ?? null,
        observedAt: event.observedAt.toISOString(),
      })),
      evidenceIds: task.evidenceLinks.map((link) => link.evidenceId),
    }));
    const evidenceFacts = [
      ...tasks.flatMap((task) =>
        task.evidenceLinks.map((link) => ({
          taskId: task.id,
          linkId: link.id,
          evidenceId: link.evidence.id,
          sourceType: link.evidence.sourceType,
          title: link.evidence.title,
          externalKey: link.evidence.sourceExternalKey,
          url: link.evidence.url,
          eventAt: link.evidence.eventAt?.toISOString() ?? null,
          contentHash: link.evidence.contentHash,
          availabilityState: link.evidence.availabilityState,
          identityMatch: null,
        })),
      ),
      ...identityMatchedEvidence.map((match) => ({
        taskId: null,
        linkId: null,
        evidenceId: match.evidence.id,
        sourceType: match.evidence.sourceType,
        title: match.evidence.title,
        externalKey: match.evidence.sourceExternalKey,
        url: match.evidence.url,
        eventAt: match.evidence.eventAt?.toISOString() ?? null,
        contentHash: match.evidence.contentHash,
        availabilityState: match.evidence.availabilityState,
        identityMatch: {
          aliasId: match.aliasId,
          aliasType: match.aliasType,
          aliasValueHash: match.aliasValueHash,
          aliasVerifiedAt: match.aliasVerifiedAt,
        },
      })),
    ];
    const weeklyFacts = weeklyReports.flatMap((report) => {
      const version = report.confirmedVersion;
      if (!version) return [];
      return [
        {
          reportId: report.id,
          versionId: version.id,
          versionNo: version.versionNo,
          contentHash: version.contentHash,
          weeklyWorkText: version.weeklyWorkText,
          sourceLinks: version.sourceLinks.map((link) => ({
            taskId: link.taskId,
            evidenceId: link.evidenceId,
            blockId: link.blockId,
            sourceContentHash: link.sourceContentHash,
          })),
        },
      ];
    });
    const staleCutoff = new Date(Date.now() - payload.freshnessPolicy.maximumAgeHours * 3_600_000);
    const staleTasks = tasks
      .filter((task) => task.lastObservedAt < staleCutoff)
      .map((task) => task.id);
    const allEvidences = [
      ...tasks.flatMap((task) => task.evidenceLinks.map((link) => link.evidence)),
      ...identityMatchedEvidence.map((match) => match.evidence),
    ];
    const staleEvidence = allEvidences
      .filter((evidence) => (evidence.sourceSyncedAt ?? evidence.updatedAt) < staleCutoff)
      .map((evidence) => evidence.id);
    const unavailableEvidence = allEvidences
      .filter((evidence) => evidence.availabilityState !== 'available')
      .map((evidence) => evidence.id);
    const staleSourceCount = new Set([...staleTasks, ...staleEvidence, ...unavailableEvidence])
      .size;
    if (payload.freshnessPolicy.mode === 'require_fresh' && staleSourceCount > 0) {
      await this.markFailed(
        jobId,
        reviewId,
        'QUARTERLY_SOURCE_STALE',
        `有 ${staleSourceCount} 个任务或证据来源超过新鲜度上限/不可用`,
      );
      throw new DomainError(
        'QUARTERLY_SOURCE_STALE',
        '季度来源数据已过期，请先同步或显式允许旧数据',
        {
          httpStatus: 422,
        },
      );
    }
    const warnings = [
      ...(staleTasks.length > 0
        ? [{ code: 'STALE_TASK_SOURCES', count: new Set(staleTasks).size }]
        : []),
      ...(staleEvidence.length > 0
        ? [{ code: 'STALE_EVIDENCE_SOURCES', count: new Set(staleEvidence).size }]
        : []),
      ...(unavailableEvidence.length > 0
        ? [{ code: 'UNAVAILABLE_EVIDENCE_SOURCES', count: new Set(unavailableEvidence).size }]
        : []),
      ...(payload.sources.tasks && tasks.length === 0
        ? [{ code: 'NO_ELIGIBLE_TASK_FACTS', count: 0 }]
        : []),
      ...(payload.sources.evidence && evidenceFacts.length === 0
        ? [{ code: 'NO_ELIGIBLE_EVIDENCE_FACTS', count: 0 }]
        : []),
      ...(payload.sources.evidence && identityEvidenceCollection.enabledAliasCount === 0
        ? [{ code: 'IDENTITY_ALIAS_MISSING', count: 0 }]
        : []),
      ...(identityEvidenceCollection.ignoredUnwhitelistedCount > 0
        ? [
            {
              code: 'IDENTITY_EVIDENCE_OUTSIDE_REPOSITORY_WHITELIST',
              count: identityEvidenceCollection.ignoredUnwhitelistedCount,
            },
          ]
        : []),
      ...(payload.sources.confirmedWeeklyReports && weeklyFacts.length === 0
        ? [{ code: 'NO_CONFIRMED_WEEKLY_REPORTS', count: 0 }]
        : []),
      ...(payload.sources.tasks &&
      tasks.some((task) => task.primarySource === 'jira' && !task.mappingVersionId)
        ? [
            {
              code: 'TASK_FIELD_MAPPING_UNKNOWN',
              count: tasks.filter((task) => task.primarySource === 'jira' && !task.mappingVersionId)
                .length,
            },
          ]
        : []),
    ];
    const sourceContentHash = requestHash({ taskFacts, evidenceFacts, weeklyFacts });
    const generationHash = requestHash({
      sourceContentHash,
      sources: payload.sources,
      freshnessPolicy: payload.freshnessPolicy,
    });
    const candidates = this.buildCandidates(review, tasks, identityMatchedEvidence, weeklyReports);
    await reportProgress(70);
    if (await this.cancelIfRequested(jobId, reviewId, isCancellationRequested)) {
      return { reviewId, status: payload.fallbackStatus, cancelled: true };
    }
    const result = await this.prisma.$transaction(
      async (tx) => {
        const existingSnapshot = await tx.quarterlyCollectionSnapshot.findUnique({
          where: { reviewId_generationHash: { reviewId, generationHash } },
        });
        const snapshot =
          existingSnapshot ??
          (await tx.quarterlyCollectionSnapshot.create({
            data: {
              id: newId(),
              reviewId,
              sequenceNo: (await tx.quarterlyCollectionSnapshot.count({ where: { reviewId } })) + 1,
              sourceSelectionJson: JSON.stringify(payload.sources),
              freshnessPolicyJson: JSON.stringify(payload.freshnessPolicy),
              taskFactsJson: JSON.stringify(taskFacts),
              evidenceFactsJson: JSON.stringify(evidenceFacts),
              weeklyReportFactsJson: JSON.stringify(weeklyFacts),
              warningsJson: JSON.stringify(warnings),
              sourceContentHash,
              generationHash,
              createdBy: review.ownerProfileId,
            },
          }));
        const existingAchievements = await tx.achievement.findMany({
          where: {
            reviewId,
            sourceKey: { in: candidates.map((candidate) => candidate.sourceKey) },
          },
          select: { id: true, sourceKey: true, evidenceStatus: true },
        });
        const achievementIdBySource = new Map(
          existingAchievements.map((achievement) => [achievement.sourceKey, achievement.id]),
        );
        const newAchievementRows = candidates
          .filter((candidate) => !achievementIdBySource.has(candidate.sourceKey))
          .map((candidate) => {
            const id = newId();
            achievementIdBySource.set(candidate.sourceKey, id);
            return {
              id,
              reviewId,
              collectionSnapshotId: snapshot.id,
              projectId: candidate.projectId,
              sourceType: 'collected',
              sourceKey: candidate.sourceKey,
              title: candidate.title,
              situation: candidate.situation,
              action: candidate.action,
              result: candidate.result,
              impact: candidate.impact,
              contributionBoundary: candidate.contributionBoundary,
              periodStart: candidate.periodStart,
              periodEnd: candidate.periodEnd,
              evidenceStatus: candidate.evidenceStatus,
              createdBy: review.ownerProfileId,
            };
          });
        for (const rows of this.chunks(newAchievementRows, 200)) {
          await tx.achievement.createMany({ data: rows });
        }
        const achievementIds = [...achievementIdBySource.values()];
        const existingEvidenceRows = achievementIds.length
          ? await tx.achievementEvidence.findMany({
              where: { achievementId: { in: achievementIds } },
              select: {
                achievementId: true,
                sourceType: true,
                sourceId: true,
                primaryEvidence: true,
              },
            })
          : [];
        const evidenceKeys = new Set(
          existingEvidenceRows.map(
            (evidence) => `${evidence.achievementId}:${evidence.sourceType}:${evidence.sourceId}`,
          ),
        );
        const achievementsWithPrimary = new Set(
          existingEvidenceRows
            .filter((evidence) => evidence.primaryEvidence)
            .map((evidence) => evidence.achievementId),
        );
        const newEvidenceRows = candidates.flatMap((candidate) => {
          const achievementId = achievementIdBySource.get(candidate.sourceKey)!;
          return candidate.evidences.flatMap((evidence) => {
            const key = `${achievementId}:${evidence.sourceType}:${evidence.sourceId}`;
            if (evidenceKeys.has(key)) return [];
            evidenceKeys.add(key);
            const primaryEvidence =
              evidence.primaryEvidence && !achievementsWithPrimary.has(achievementId);
            if (primaryEvidence) achievementsWithPrimary.add(achievementId);
            return [
              {
                id: newId(),
                achievementId,
                sourceType: evidence.sourceType,
                sourceId: evidence.sourceId,
                taskId: evidence.taskId,
                evidenceId: evidence.evidenceId,
                title: evidence.title,
                externalKey: evidence.externalKey,
                url: evidence.url,
                eventAt: evidence.eventAt,
                availabilityState: evidence.availabilityState,
                sourceContentHash: evidence.sourceContentHash,
                sourceSummaryJson: JSON.stringify(evidence.sourceSummary),
                contributionAngle: evidence.contributionAngle,
                primaryEvidence,
              },
            ];
          });
        });
        for (const rows of this.chunks(newEvidenceRows, 200)) {
          await tx.achievementEvidence.createMany({ data: rows });
        }
        // 重跑只升级证据完整度，绝不把用户补成 complete 的成果降回 partial。
        const completeIds = candidates
          .filter((candidate) => candidate.evidenceStatus === 'complete')
          .map((candidate) => achievementIdBySource.get(candidate.sourceKey)!);
        const partialIds = candidates
          .filter((candidate) => candidate.evidenceStatus === 'partial')
          .map((candidate) => achievementIdBySource.get(candidate.sourceKey)!);
        if (completeIds.length > 0) {
          await tx.achievement.updateMany({
            where: { id: { in: completeIds }, evidenceStatus: { not: 'complete' } },
            data: { evidenceStatus: 'complete', version: { increment: 1 } },
          });
        }
        if (partialIds.length > 0) {
          await tx.achievement.updateMany({
            where: { id: { in: partialIds }, evidenceStatus: 'needs_evidence' },
            data: { evidenceStatus: 'partial', version: { increment: 1 } },
          });
        }
        const createdCount = newAchievementRows.length;
        const total = await tx.achievement.count({ where: { reviewId } });
        const withEvidence = await tx.achievement.count({
          where: { reviewId, evidences: { some: {} } },
        });
        const completeness = {
          sourceFreshness: staleSourceCount > 0 ? 'stale_ack_required' : 'fresh',
          evidenceCoverage: total === 0 ? 0 : withEvidence / total,
          requiredMetricCoverage: 0,
          scoreReasonCoverage: 0,
          unresolvedConflictCount: 0,
          sourceWarningCount: warnings.length,
          sourceChecks: {
            tasks: {
              selected: payload.sources.tasks,
              count: taskFacts.length,
            },
            evidence: {
              selected: payload.sources.evidence,
              count: evidenceFacts.length,
              enabledIdentityAliasCount: identityEvidenceCollection.enabledAliasCount,
              ignoredUnwhitelistedCount: identityEvidenceCollection.ignoredUnwhitelistedCount,
            },
            confirmedWeeklyReports: {
              selected: payload.sources.confirmedWeeklyReports,
              count: weeklyFacts.length,
            },
          },
        };
        const changed = await tx.quarterlyReview.updateMany({
          where: { id: reviewId, version: payload.expectedReviewVersion, status: 'collecting' },
          data: {
            status: 'candidates_ready',
            completenessJson: JSON.stringify(completeness),
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw new DomainError(errorCodes.versionConflict, '季度评审在收集期间发生变化', {
            httpStatus: 409,
          });
        }
        await this.audit.recordInTransaction(tx, {
          actorType: 'system',
          actorId: review.ownerProfileId,
          action: 'quarterly_review.collection_completed',
          targetType: 'quarterly_review',
          targetId: reviewId,
          correlationId: `job:${jobId}`,
          outcome: 'succeeded',
          after: {
            snapshotId: snapshot.id,
            sourceContentHash,
            taskCount: taskFacts.length,
            evidenceCount: evidenceFacts.length,
            weeklyReportCount: weeklyFacts.length,
            candidateCount: candidates.length,
            createdCount,
            warningCount: warnings.length,
          },
          clientSessionHash: requestHash({ component: 'quarterly-collection-handler' }),
        });
        return {
          snapshotId: snapshot.id,
          candidateCount: candidates.length,
          createdCount,
          completeness,
        };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await reportProgress(100);
    return { reviewId, status: 'candidates_ready', ...result };
  }

  private buildCandidates(
    review: { periodStart: string; periodEnd: string },
    tasks: Awaited<ReturnType<QuarterlyCollectionService['queryShapePlaceholder']>>,
    identityMatchedEvidence: IdentityMatchedEvidence[],
    weeklyReports: Array<{
      id: string;
      confirmedVersion: null | {
        id: string;
        versionNo: number;
        weeklyWorkText: string;
        contentHash: string;
        sourceLinks: Array<{
          taskId: string | null;
          evidenceId: string | null;
          blockId: string;
          sourceContentHash: string;
        }>;
      };
    }>,
  ): CandidateDraft[] {
    const groups = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const key = task.parentTaskId ?? task.id;
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    const candidates: CandidateDraft[] = [];
    for (const [groupKey, items] of groups) {
      const completed = items.filter((item) => item.statusEvents.length > 0);
      const evidences = items.flatMap((task, taskIndex) => [
        {
          sourceType: 'task',
          sourceId: task.id,
          taskId: task.id,
          evidenceId: null,
          title: task.title,
          externalKey: task.issueKey,
          url: null,
          eventAt: task.statusEvents[0]?.effectiveAt ?? task.statusEvents[0]?.observedAt ?? null,
          availabilityState: 'available',
          sourceContentHash: requestHash({
            id: task.id,
            title: task.title,
            status: task.normalizedStatus,
          }),
          sourceSummary: {
            issueKey: task.issueKey,
            normalizedStatus: task.normalizedStatus,
            originalEstimateSeconds: task.originalEstimateSeconds,
            remainingEstimateSeconds: task.remainingEstimateSeconds,
            timeSpentSeconds: task.timeSpentSeconds,
            effortProvenance: task.fieldProvenances.map((provenance) => ({
              fieldName: provenance.fieldName,
              sourceType: provenance.sourceType,
              decision: provenance.decision,
            })),
          },
          contributionAngle: '当前用户任务事实',
          primaryEvidence: taskIndex === 0,
        },
        ...task.evidenceLinks.map((link) => ({
          sourceType: link.evidence.sourceType,
          sourceId: link.evidence.id,
          taskId: task.id,
          evidenceId: link.evidence.id,
          title: link.evidence.title,
          externalKey: link.evidence.sourceExternalKey,
          url: link.evidence.url,
          eventAt: link.evidence.eventAt,
          availabilityState: link.evidence.availabilityState,
          sourceContentHash: link.evidence.contentHash,
          sourceSummary: { linkMethod: link.method, confidence: link.confidence },
          contributionAngle: link.explanation,
          primaryEvidence: false,
        })),
      ]);
      candidates.push({
        sourceKey: `task-cluster:${groupKey}`,
        projectId: items[0]?.projectId ?? null,
        title: items[0]?.parentTitle ?? items[0]?.title ?? '未命名成果',
        situation: `本考核周期围绕“${items[0]?.parentTitle ?? items[0]?.title ?? '相关工作'}”开展工作。`,
        action: items
          .map((item) => `${item.issueKey ? `${item.issueKey} ` : ''}${item.title}`)
          .join('；'),
        result:
          completed.length > 0
            ? `完成 ${completed.length} 项有明确完成状态观测的个人任务。`
            : `推进 ${items.length} 项有已确认关系证据的个人任务，完成状态待人工核对。`,
        impact:
          '业务、质量或效率影响待人工根据证据补充；系统未按 Commit 数量、行数或工时推断价值。',
        contributionBoundary:
          '仅归纳当前用户任务及已确认关系证据；团队整体成果和个人职责边界需人工确认。',
        periodStart: review.periodStart,
        periodEnd: review.periodEnd,
        evidenceStatus: evidences.some(
          (evidence) =>
            evidence.sourceType !== 'task' && evidence.availabilityState === 'available',
        )
          ? 'complete'
          : 'partial',
        evidences,
      });
    }
    for (const match of identityMatchedEvidence) {
      const metadata = this.parseObject(match.evidence.metadataJson);
      const isMergeRequest = match.evidence.sourceType === 'merge_request';
      candidates.push({
        sourceKey: `identity-evidence:${match.evidence.id}`,
        projectId: match.evidence.projectId,
        title: match.evidence.title,
        situation: isMergeRequest
          ? '来源为考核周期内、通过已确认 GitLab 身份匹配的 MR 参与事实。'
          : '来源为考核周期内、通过已确认 Git 作者身份匹配的 Commit 事实。',
        action: match.evidence.title,
        result: isMergeRequest
          ? `MR 状态为 ${typeof metadata.state === 'string' ? metadata.state : '待核对'}；是否构成独立交付成果由用户确认。`
          : '保留期间内提交事实；是否构成独立交付成果及其结果由用户结合任务、MR 或发布证据确认。',
        impact:
          '业务、质量或效率影响待人工补充；系统不会根据 Commit 数量、代码行数或 MR 数量推断绩效价值。',
        contributionBoundary:
          '候选仅证明已确认身份参与过该来源对象，不自动把团队整体成果归为个人成果。',
        periodStart: review.periodStart,
        periodEnd: review.periodEnd,
        evidenceStatus: 'partial',
        evidences: [
          {
            sourceType: match.evidence.sourceType,
            sourceId: match.evidence.id,
            taskId: null,
            evidenceId: match.evidence.id,
            title: match.evidence.title,
            externalKey: match.evidence.sourceExternalKey,
            url: match.evidence.url,
            eventAt: match.evidence.eventAt,
            availabilityState: match.evidence.availabilityState,
            sourceContentHash: match.evidence.contentHash,
            sourceSummary: {
              identityAliasId: match.aliasId,
              identityAliasType: match.aliasType,
              identityAliasValueHash: match.aliasValueHash,
              state: typeof metadata.state === 'string' ? metadata.state : null,
            },
            contributionAngle: '已启用且已确认的身份别名匹配',
            primaryEvidence: true,
          },
        ],
      });
    }
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const report of weeklyReports) {
      const version = report.confirmedVersion;
      if (!version) continue;
      const linkedToCollectedTask = version.sourceLinks.some(
        (link) => link.taskId && taskIds.has(link.taskId),
      );
      if (linkedToCollectedTask) continue;
      candidates.push({
        sourceKey: `weekly-report:${report.id}:${version.id}`,
        projectId: null,
        title: `已确认周报 v${version.versionNo} 的季度成果候选`,
        situation: '来源为考核周期内已确认周报的本周工作字段。',
        action: version.weeklyWorkText,
        result: '周报正文已由用户确认，但是否构成独立季度成果仍需人工选择。',
        impact: '影响待人工补充，系统不从周报篇幅或条目数量推断绩效价值。',
        contributionBoundary: '仅引用已确认周报，不引用草稿；个人贡献范围需人工核对。',
        periodStart: review.periodStart,
        periodEnd: review.periodEnd,
        evidenceStatus: version.sourceLinks.length > 0 ? 'complete' : 'needs_evidence',
        evidences: [
          {
            sourceType: 'weekly_report',
            sourceId: version.id,
            taskId: null,
            evidenceId: null,
            title: `周报 v${version.versionNo}`,
            externalKey: report.id,
            url: null,
            eventAt: null,
            availabilityState: 'available',
            sourceContentHash: version.contentHash,
            sourceSummary: { reportId: report.id, versionNo: version.versionNo },
            contributionAngle: '已确认周报工作内容',
            primaryEvidence: true,
          },
        ],
      });
    }
    return candidates;
  }

  // 仅用于让 TypeScript 从实际 Prisma 查询推导候选构造器输入，不会在运行时调用。
  private async queryShapePlaceholder() {
    return this.prisma.task.findMany({
      include: {
        project: true,
        statusEvents: true,
        evidenceLinks: { include: { evidence: true } },
        fieldProvenances: true,
      },
    });
  }

  private async collectIdentityMatchedEvidence(
    startUtc: Date,
    endUtc: Date,
    tasks: Awaited<ReturnType<QuarterlyCollectionService['queryShapePlaceholder']>>,
  ): Promise<IdentityEvidenceCollection> {
    const aliases = await this.prisma.identityAlias.findMany({
      where: {
        profileId: this.sessions.currentProfileId,
        enabled: true,
        verifiedAt: { not: null },
        aliasType: {
          in: ['git_name', 'git_email', 'gitlab_user_id', 'gitlab_username'],
        },
      },
      orderBy: [{ aliasType: 'asc' }, { id: 'asc' }],
    });
    if (aliases.length === 0) {
      return { matches: [], enabledAliasCount: 0, ignoredUnwhitelistedCount: 0 };
    }
    const alreadyLinkedIds = new Set(
      tasks.flatMap((task) => task.evidenceLinks.map((link) => link.evidenceId)),
    );
    const rows = await this.prisma.evidence.findMany({
      where: {
        sourceType: { in: ['commit', 'merge_request'] },
        eventAt: { gte: startUtc, lt: endUtc },
        projectId: { not: null },
      },
      include: { project: { include: { repositories: true } } },
      orderBy: { id: 'asc' },
    });
    const matches: IdentityMatchedEvidence[] = [];
    let ignoredUnwhitelistedCount = 0;
    for (const evidence of rows) {
      if (alreadyLinkedIds.has(evidence.id)) continue;
      const alias = aliases.find((candidate) => this.evidenceMatchesAlias(evidence, candidate));
      if (!alias) continue;
      const projectEligible =
        evidence.project?.enabled === true &&
        evidence.project.archivedAt === null &&
        evidence.project.repositories.some(
          (repository) => repository.whitelistStatus === 'confirmed',
        );
      if (!projectEligible) {
        ignoredUnwhitelistedCount += 1;
        continue;
      }
      matches.push({
        evidence,
        aliasId: alias.id,
        aliasType: alias.aliasType,
        aliasValueHash: requestHash(alias.normalizedValue),
        aliasVerifiedAt: alias.verifiedAt?.toISOString() ?? null,
      });
    }
    return {
      matches,
      enabledAliasCount: aliases.length,
      ignoredUnwhitelistedCount,
    };
  }

  private evidenceMatchesAlias(
    evidence: EvidenceWithProject,
    alias: { aliasType: string; normalizedValue: string },
  ): boolean {
    const metadata = this.parseObject(evidence.metadataJson);
    if (evidence.sourceType === 'commit') {
      const values =
        alias.aliasType === 'git_email'
          ? [metadata.authorEmail, metadata.committerEmail]
          : alias.aliasType === 'git_name'
            ? [metadata.authorName, metadata.committerName]
            : [];
      return values.some(
        (value) =>
          typeof value === 'string' &&
          this.normalizeIdentity(value, alias.aliasType) === alias.normalizedValue,
      );
    }
    if (evidence.sourceType !== 'merge_request') return false;
    const author = this.parseObject(metadata.author);
    const assignees = Array.isArray(metadata.assignees)
      ? metadata.assignees.map((item) => this.parseObject(item))
      : [];
    const people = [author, ...assignees];
    const values =
      alias.aliasType === 'gitlab_user_id'
        ? people.map((person) => person.id)
        : alias.aliasType === 'gitlab_username'
          ? people.map((person) => person.username)
          : [];
    return values.some(
      (value) =>
        (typeof value === 'string' || typeof value === 'number') &&
        this.normalizeIdentity(String(value), alias.aliasType) === alias.normalizedValue,
    );
  }

  private normalizeIdentity(value: string, aliasType: string): string {
    const normalized = value.trim().normalize('NFKC');
    return aliasType === 'git_email' || aliasType === 'gitlab_username'
      ? normalized.toLowerCase()
      : normalized;
  }

  private parseObject(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    }
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  public async restoreAfterCancellation(jobId: string, reviewId: string): Promise<void> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.payloadRef !== reviewId) return;
    const payload = this.parsePayload(job.payloadSummary);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.quarterlyReview.updateMany({
        where: { id: reviewId, version: payload.expectedReviewVersion, status: 'collecting' },
        data: { status: payload.fallbackStatus, version: { increment: 1 } },
      });
      if (changed.count !== 1) return;
      await this.audit.recordInTransaction(tx, {
        actorType: 'system',
        actorId: this.sessions.currentProfileId,
        action: 'quarterly_review.collection_cancelled',
        targetType: 'quarterly_review',
        targetId: reviewId,
        correlationId: `job:${jobId}`,
        outcome: 'succeeded',
        after: { fallbackStatus: payload.fallbackStatus },
        clientSessionHash: requestHash({ component: 'quarterly-collection-handler' }),
      });
    });
  }

  public async markUnexpectedFailure(
    jobId: string,
    reviewId: string,
    errorCode: string,
  ): Promise<void> {
    await this.markFailed(
      jobId,
      reviewId,
      errorCode,
      '季度来源收集作业在安全重试后仍未完成，请检查操作详情后重新收集',
    );
  }

  private async cancelIfRequested(
    jobId: string,
    reviewId: string,
    isCancellationRequested: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!(await isCancellationRequested())) return false;
    await this.restoreAfterCancellation(jobId, reviewId);
    return true;
  }

  private async markFailed(
    jobId: string,
    reviewId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { payloadRef: true, payloadSummary: true },
    });
    if (!job || job.payloadRef !== reviewId) return;
    const payload = this.parsePayload(job.payloadSummary);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.quarterlyReview.updateMany({
        where: {
          id: reviewId,
          status: 'collecting',
          version: payload.expectedReviewVersion,
        },
        data: {
          status: 'collection_failed',
          completenessJson: JSON.stringify({ errorCode: code, errorSummary: message }),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) return;
      await this.audit.recordInTransaction(tx, {
        actorType: 'system',
        actorId: this.sessions.currentProfileId,
        action: 'quarterly_review.collection_failed',
        targetType: 'quarterly_review',
        targetId: reviewId,
        correlationId: `job:${jobId}`,
        outcome: 'failed',
        after: { errorCode: code, errorSummaryHash: requestHash(message) },
        clientSessionHash: requestHash({ component: 'quarterly-collection-handler' }),
      });
    });
  }

  private async assertOwnedReview(reviewId: string): Promise<void> {
    const review = await this.prisma.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      select: { id: true },
    });
    if (!review) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
  }

  private parsePayload(value: string): {
    expectedReviewVersion: number;
    fallbackStatus: string;
    sources: QuarterlyCollectionInput['sources'];
    freshnessPolicy: QuarterlyCollectionInput['freshnessPolicy'];
  } {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const sources = parsed.sources as QuarterlyCollectionInput['sources'];
    const freshnessPolicy = parsed.freshnessPolicy as QuarterlyCollectionInput['freshnessPolicy'];
    if (
      !Number.isInteger(parsed.expectedReviewVersion) ||
      typeof parsed.fallbackStatus !== 'string' ||
      !sources ||
      !freshnessPolicy ||
      typeof sources.tasks !== 'boolean' ||
      typeof sources.evidence !== 'boolean' ||
      typeof sources.confirmedWeeklyReports !== 'boolean' ||
      !['require_fresh', 'allow_stale'].includes(freshnessPolicy.mode) ||
      ![
        'draft',
        'candidates_ready',
        'selecting',
        'scoring',
        'narrative_ready',
        'collection_failed',
        'generation_failed',
        'export_failed',
      ].includes(parsed.fallbackStatus) ||
      !Number.isInteger(freshnessPolicy.maximumAgeHours)
    ) {
      throw new DomainError('QUARTERLY_COLLECTION_PAYLOAD_INVALID', '季度收集作业参数损坏', {
        httpStatus: 500,
      });
    }
    return {
      expectedReviewVersion: Number(parsed.expectedReviewVersion),
      fallbackStatus: parsed.fallbackStatus,
      sources,
      freshnessPolicy,
    };
  }

  private shanghaiBoundary(date: string): Date {
    return new Date(`${date}T00:00:00.000+08:00`);
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private parseArray(value: string): unknown[] {
    const parsed = this.parseJson<unknown>(value, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  private chunks<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size));
    }
    return result;
  }
}
