import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { requestHash } from '@auto-work/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { JobQueueService } from '../src/modules/jobs/job-queue.service.js';
import { JobRegistryService } from '../src/modules/jobs/job-registry.service.js';
import { QuarterlyAchievementService } from '../src/modules/quarterly-reviews/quarterly-achievement.service.js';
import { QuarterlyCollectionService } from '../src/modules/quarterly-reviews/quarterly-collection.service.js';
import { QuarterlyCollectionHandler } from '../src/modules/quarterly-reviews/quarterly-collection.handler.js';
import { QuarterlyCompletenessService } from '../src/modules/quarterly-reviews/quarterly-completeness.service.js';
import { QuarterlyReviewService } from '../src/modules/quarterly-reviews/quarterly-review.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('季度多来源采集、候选成果、证据与指标映射', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let reviews: QuarterlyReviewService;
  let collection: QuarterlyCollectionService;
  let achievements: QuarterlyAchievementService;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-quarterly-collection-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'quarterly.db').replaceAll('\\', '/')}`,
    });
    const migrationRoot = resolve('prisma/migrations');
    const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationRoot, migration, 'migration.sql'), 'utf8');
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim())) {
        if (statement) await prisma.$executeRawUnsafe(statement);
      }
    }
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-quarterly-collection',
        displayName: '季度材料验收用户',
        timezone: 'Asia/Shanghai',
      },
    });
    await prisma.project.create({
      data: { id: 'project-quarterly', name: '季度验收项目', jiraProjectKey: 'QPR' },
    });
    await prisma.repository.create({
      data: {
        id: 'repository-quarterly',
        projectId: 'project-quarterly',
        canonicalPath: 'D:\\work\\quarterly',
        realPathHash: requestHash('D:\\work\\quarterly'),
        identityHash: requestHash('quarterly-repository'),
        displayName: '季度验收仓库',
        gitDirKind: 'worktree',
        whitelistStatus: 'confirmed',
      },
    });
    await prisma.identityAlias.createMany({
      data: [
        {
          id: 'alias-quarterly-email',
          profileId: 'local-user',
          aliasType: 'git_email',
          value: 'Current.User@example.com',
          normalizedValue: 'current.user@example.com',
          source: 'user',
          enabled: true,
          verifiedAt: new Date(),
        },
        {
          id: 'alias-quarterly-gitlab',
          profileId: 'local-user',
          aliasType: 'gitlab_username',
          value: 'CurrentUser',
          normalizedValue: 'currentuser',
          source: 'user',
          enabled: true,
          verifiedAt: new Date(),
        },
      ],
    });
    const prismaService = prisma as unknown as PrismaService;
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    const security = {
      sessionHash: (value: string) => createHash('sha256').update(value).digest('hex'),
    } as LocalSecurityService;
    const audit = new AuditService(prismaService);
    const completeness = new QuarterlyCompletenessService();
    reviews = new QuarterlyReviewService(prismaService, sessions, audit, security, completeness);
    collection = new QuarterlyCollectionService(prismaService, sessions, audit, security);
    achievements = new QuarterlyAchievementService(
      prismaService,
      sessions,
      audit,
      security,
      completeness,
    );
    await seedQuarterTwoFacts();
    await seedQuarterOneToggleFacts();
    await seedQuarterThreeStaleFact();
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('只纳入期间完成任务、期间确认关系证据和已确认周报，并冻结不可变来源快照', async () => {
    const review = await reviews.create(
      { periodType: 'natural_quarter', year: 2026, quarter: 2 },
      context('q2-create'),
    );
    const queued = await collection.queue(
      review.id,
      {
        reviewVersion: review.version,
        sources: { tasks: true, evidence: true, confirmedWeeklyReports: true },
        freshnessPolicy: { mode: 'allow_stale', maximumAgeHours: 24 },
      },
      context('q2-queue'),
    );
    const result = await collection.execute(queued.jobId, review.id, noProgress);
    expect(result).toMatchObject({
      status: 'candidates_ready',
      candidateCount: 5,
      createdCount: 5,
    });

    if (!('snapshotId' in result)) throw new Error('收集成功后必须返回快照 ID');
    const snapshot = await prisma.quarterlyCollectionSnapshot.findUniqueOrThrow({
      where: { id: result.snapshotId },
    });
    const taskFacts = JSON.parse(snapshot.taskFactsJson) as Array<{ id: string }>;
    const evidenceFacts = JSON.parse(snapshot.evidenceFactsJson) as Array<{ evidenceId: string }>;
    const weeklyFacts = JSON.parse(snapshot.weeklyReportFactsJson) as Array<{ reportId: string }>;
    expect(taskFacts.map((item) => item.id).sort()).toEqual([
      'task-q2-completed',
      'task-q2-confirmed-evidence',
    ]);
    expect(evidenceFacts.map((item) => item.evidenceId).sort()).toEqual([
      'evidence-q2-commit-identity',
      'evidence-q2-confirmed',
      'evidence-q2-merge-request-identity',
      'evidence-q2-pipeline',
      'evidence-q2-release',
    ]);
    expect(weeklyFacts.map((item) => item.reportId)).toEqual(['weekly-confirmed-q2']);
    expect(snapshot.sourceContentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await collection.listSnapshots(review.id, 20)).toMatchObject([
      {
        id: snapshot.id,
        sequenceNo: 1,
        taskCount: 2,
        evidenceCount: 5,
        weeklyReportCount: 1,
      },
    ]);
    const snapshotDetail = await collection.getSnapshot(review.id, snapshot.id);
    expect(snapshotDetail).toMatchObject({
      id: snapshot.id,
      reviewId: review.id,
    });
    expect(Array.isArray(snapshotDetail.taskFacts)).toBe(true);
    expect(Array.isArray(snapshotDetail.evidenceFacts)).toBe(true);
    await expect(
      prisma.quarterlyCollectionSnapshot.update({
        where: { id: snapshot.id },
        data: { warningsJson: '[]' },
      }),
    ).rejects.toBeTruthy();

    const candidates = await prisma.achievement.findMany({
      where: { reviewId: review.id },
      include: { evidences: true },
      orderBy: { sourceKey: 'asc' },
    });
    expect(candidates).toHaveLength(5);
    expect(candidates.some((item) => item.action.includes('仅在季度内更新'))).toBe(false);
    expect(candidates.some((item) => item.action.includes('未确认关系任务'))).toBe(false);
    expect(candidates.some((item) => item.action.includes('季度边界外完成'))).toBe(false);
    expect(candidates.some((item) => item.action.includes('周报草稿不应入选'))).toBe(false);
    expect(
      candidates.every((item) => item.impact.includes('不') || item.impact.includes('待人工')),
    ).toBe(true);
    expect(candidates.map((item) => item.impact).join('\n')).toContain('Commit 数量、行数或工时');
    expect(
      candidates.some((item) => item.sourceKey === 'identity-evidence:evidence-q2-commit-identity'),
    ).toBe(true);
    expect(
      candidates.some(
        (item) => item.sourceKey === 'identity-evidence:evidence-q2-merge-request-identity',
      ),
    ).toBe(true);
    const completedTaskFact = taskFacts.find((item) => item.id === 'task-q2-completed') as
      | ({ timeSpentSeconds: number; effortProvenance: Array<{ sourceType: string }> } & {
          id: string;
        })
      | undefined;
    expect(completedTaskFact).toMatchObject({
      timeSpentSeconds: 7_200,
      effortProvenance: [{ sourceType: 'excel' }],
    });

    const replay = await collection.execute(queued.jobId, review.id, noProgress);
    expect(replay).toMatchObject({ status: 'candidates_ready', replayed: true });
    expect(await prisma.quarterlyCollectionSnapshot.count({ where: { reviewId: review.id } })).toBe(
      1,
    );
  });

  it('严格执行来源开关，重跑保留旧候选，并能取消后恢复原业务阶段', async () => {
    const review = await reviews.create(
      { periodType: 'natural_quarter', year: 2026, quarter: 1 },
      context('q1-create'),
    );
    const evidenceOnly = await collection.queue(
      review.id,
      {
        reviewVersion: review.version,
        sources: { tasks: false, evidence: true, confirmedWeeklyReports: false },
        freshnessPolicy: { mode: 'allow_stale', maximumAgeHours: 24 },
      },
      context('q1-evidence-only'),
    );
    const first = await collection.execute(evidenceOnly.jobId, review.id, noProgress);
    if (!('snapshotId' in first)) throw new Error('证据来源收集必须返回快照 ID');
    const firstSnapshot = await prisma.quarterlyCollectionSnapshot.findUniqueOrThrow({
      where: { id: first.snapshotId },
    });
    expect(
      (JSON.parse(firstSnapshot.taskFactsJson) as Array<{ id: string }>).map((item) => item.id),
    ).toEqual(['task-q1-evidence']);

    const afterFirst = await prisma.quarterlyReview.findUniqueOrThrow({ where: { id: review.id } });
    const tasksOnly = await collection.queue(
      review.id,
      {
        reviewVersion: afterFirst.version,
        sources: { tasks: true, evidence: false, confirmedWeeklyReports: false },
        freshnessPolicy: { mode: 'allow_stale', maximumAgeHours: 24 },
      },
      context('q1-tasks-only'),
    );
    const second = await collection.execute(tasksOnly.jobId, review.id, noProgress);
    if (!('snapshotId' in second)) throw new Error('任务来源收集必须返回快照 ID');
    const secondSnapshot = await prisma.quarterlyCollectionSnapshot.findUniqueOrThrow({
      where: { id: second.snapshotId },
    });
    expect(
      (JSON.parse(secondSnapshot.taskFactsJson) as Array<{ id: string }>).map((item) => item.id),
    ).toEqual(['task-q1-completed']);
    expect(await prisma.achievement.count({ where: { reviewId: review.id } })).toBe(2);

    const beforeCancel = await prisma.quarterlyReview.findUniqueOrThrow({
      where: { id: review.id },
    });
    const cancellable = await collection.queue(
      review.id,
      {
        reviewVersion: beforeCancel.version,
        sources: { tasks: true, evidence: true, confirmedWeeklyReports: false },
        freshnessPolicy: { mode: 'allow_stale', maximumAgeHours: 24 },
      },
      context('q1-cancel'),
    );
    const cancelled = await collection.execute(cancellable.jobId, review.id, noProgress, () =>
      Promise.resolve(true),
    );
    expect(cancelled).toMatchObject({ cancelled: true, status: 'candidates_ready' });
    expect(
      await prisma.quarterlyReview.findUniqueOrThrow({ where: { id: review.id } }),
    ).toMatchObject({
      status: 'candidates_ready',
    });
    expect(await prisma.quarterlyCollectionSnapshot.count({ where: { reviewId: review.id } })).toBe(
      2,
    );

    // 真实 API 取消排队作业时不会进入 execute，注册处理器必须主动恢复聚合状态。
    await prisma.job.update({
      where: { id: cancellable.jobId },
      data: { status: 'cancelled', cancelRequested: true, completedAt: new Date() },
    });
    const afterRunningCancel = await prisma.quarterlyReview.findUniqueOrThrow({
      where: { id: review.id },
    });
    const queuedForCancel = await collection.queue(
      review.id,
      {
        reviewVersion: afterRunningCancel.version,
        sources: { tasks: true, evidence: true, confirmedWeeklyReports: false },
        freshnessPolicy: { mode: 'allow_stale', maximumAgeHours: 24 },
      },
      context('q1-queued-cancel'),
    );
    const registry = new JobRegistryService();
    new QuarterlyCollectionHandler(registry, collection).onModuleInit();
    const queue = new JobQueueService(prisma as unknown as PrismaService, registry);
    await queue.requestCancel(queuedForCancel.jobId);
    expect(
      await prisma.job.findUniqueOrThrow({ where: { id: queuedForCancel.jobId } }),
    ).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
    });
    expect(
      await prisma.quarterlyReview.findUniqueOrThrow({ where: { id: review.id } }),
    ).toMatchObject({
      status: 'candidates_ready',
    });
    expect(
      await prisma.auditEvent.count({
        where: { action: 'quarterly_review.collection_cancelled', targetId: review.id },
      }),
    ).toBe(2);
  });

  it('严格新鲜度策略拒绝过期任务并留下失败状态和脱敏审计', async () => {
    const review = await reviews.create(
      { periodType: 'natural_quarter', year: 2026, quarter: 3 },
      context('q3-create'),
    );
    const queued = await collection.queue(
      review.id,
      {
        reviewVersion: review.version,
        sources: { tasks: true, evidence: false, confirmedWeeklyReports: false },
        freshnessPolicy: { mode: 'require_fresh', maximumAgeHours: 1 },
      },
      context('q3-stale'),
    );
    await expect(collection.execute(queued.jobId, review.id, noProgress)).rejects.toMatchObject({
      code: 'QUARTERLY_SOURCE_STALE',
    });
    expect(
      await prisma.quarterlyReview.findUniqueOrThrow({ where: { id: review.id } }),
    ).toMatchObject({
      status: 'collection_failed',
    });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'quarterly_review.collection_failed', targetId: review.id },
    });
    expect(audit.afterSummaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(audit)).not.toContain('超过新鲜度上限');
  });

  it('五千条身份归属证据通过后台批量路径生成候选并冻结，不退化为逐条事务', async () => {
    const review = await reviews.create(
      { periodType: 'natural_quarter', year: 2027, quarter: 2 },
      context('q2-2027-create'),
    );
    const rows = Array.from({ length: 5_000 }, (_, index) => ({
      id: `evidence-scale-${String(index).padStart(4, '0')}`,
      sourceType: 'commit',
      sourceInternalId: `scale-internal-${index}`,
      sourceExternalKey: `scale-sha-${index}`,
      projectId: 'project-quarterly',
      eventAt: new Date('2027-05-15T04:00:00.000Z'),
      title: `规模候选 ${index + 1}`,
      contentHash: requestHash({ scope: 'quarterly-scale', index }),
      metadataJson: JSON.stringify({ authorEmail: 'current.user@example.com' }),
      sourceSyncedAt: new Date(),
    }));
    for (let index = 0; index < rows.length; index += 500) {
      await prisma.evidence.createMany({ data: rows.slice(index, index + 500) });
    }
    const queued = await collection.queue(
      review.id,
      {
        reviewVersion: review.version,
        sources: { tasks: false, evidence: true, confirmedWeeklyReports: false },
        freshnessPolicy: { mode: 'allow_stale', maximumAgeHours: 24 },
      },
      context('q2-2027-scale'),
    );
    const progress: number[] = [];
    const result = await collection.execute(queued.jobId, review.id, (value) => {
      progress.push(value);
      return Promise.resolve();
    });
    expect(result).toMatchObject({ candidateCount: 5_000, createdCount: 5_000 });
    expect(progress.at(-1)).toBe(100);
    expect(await prisma.achievement.count({ where: { reviewId: review.id } })).toBe(5_000);
    const snapshots = await collection.listSnapshots(review.id, 1);
    expect(snapshots[0]).toMatchObject({ evidenceCount: 5_000, taskCount: 0 });
  }, 30_000);

  it('人工成果支持并发编辑、选择/排除恢复、重复证据提示和指标映射版本历史', async () => {
    const review = await reviews.create(
      { periodType: 'natural_quarter', year: 2026, quarter: 4 },
      context('q4-create'),
    );
    const first = await achievements.createManual(
      review.id,
      manualAchievement(review.version, '交付季度绩效工作台'),
      context('manual-a'),
    );
    const second = await achievements.createManual(
      review.id,
      manualAchievement(first.reviewVersion, '完善季度材料审计链'),
      context('manual-b'),
    );
    const selected = await achievements.updateSelection(
      review.id,
      {
        reviewVersion: second.reviewVersion,
        actions: [
          {
            achievementId: first.achievementId,
            version: first.achievementVersion,
            status: 'selected',
            reason: '作为核心交付成果纳入',
            sortOrder: 10,
          },
          {
            achievementId: second.achievementId,
            version: second.achievementVersion,
            status: 'selected',
            reason: '作为质量治理成果纳入',
            sortOrder: 20,
          },
        ],
      },
      context('select-two'),
    );
    const evidenceInput = {
      sourceType: 'manual_link' as const,
      title: '季度验收记录',
      externalKey: 'QPR-UAT-2026Q4',
      url: 'https://business.example/qpr/uat',
      eventAt: '2026-11-20T10:00:00.000+08:00',
      availabilityState: 'available',
      summary: { type: 'uat', conclusion: 'passed' },
      contributionAngle: '证明季度成果通过业务验收',
      primaryEvidence: true,
    };
    const evidenceA = await achievements.addEvidence(
      first.achievementId,
      {
        reviewVersion: selected.reviewVersion,
        achievementVersion: first.achievementVersion + 1,
        ...evidenceInput,
      },
      context('evidence-a'),
    );
    const evidenceB = await achievements.addEvidence(
      second.achievementId,
      {
        reviewVersion: evidenceA.reviewVersion,
        achievementVersion: second.achievementVersion + 1,
        ...evidenceInput,
        contributionAngle: '证明审计链覆盖同一业务验收过程',
      },
      context('evidence-b'),
    );
    await expect(
      prisma.achievementEvidence.create({
        data: {
          id: 'second-primary-for-a',
          achievementId: first.achievementId,
          sourceType: 'manual_link',
          sourceId: 'second-primary-source',
          title: '不允许出现的第二主证据',
          availabilityState: 'available',
          sourceContentHash: requestHash('second-primary-source'),
          contributionAngle: '数据库唯一约束验证',
          primaryEvidence: true,
        },
      }),
    ).rejects.toBeTruthy();
    await expect(
      prisma.achievementEvidence.update({
        where: { id: evidenceA.evidenceId },
        data: { title: '不可改写的证据' },
      }),
    ).rejects.toBeTruthy();
    await expect(
      achievements.addEvidence(
        first.achievementId,
        {
          reviewVersion: evidenceB.reviewVersion,
          achievementVersion: evidenceA.achievementVersion,
          ...evidenceInput,
        },
        context('duplicate-evidence'),
      ),
    ).rejects.toMatchObject({ code: 'ACHIEVEMENT_EVIDENCE_DUPLICATE' });

    const template = await reviews.createMetricTemplate(
      {
        name: '季度候选映射模板',
        formulaType: 'weighted_average_100',
        roundingRule: 'half_up_1_decimal',
        metrics: [
          performanceMetric('delivery', '业务交付', 60),
          performanceMetric('quality', '质量治理', 40),
        ],
      },
      context('q4-template'),
    );
    const bound = await reviews.bindMetricTemplate(
      review.id,
      { templateVersionId: template.versionId, reviewVersion: evidenceB.reviewVersion },
      context('q4-bind'),
    );
    const deliveryMetric = template.metrics[0]!;
    const mapped = await achievements.updateMetrics(
      first.achievementId,
      {
        reviewVersion: bound.reviewVersion,
        achievementVersion: evidenceA.achievementVersion,
        links: [{ metricId: deliveryMetric.id, contribution: '支撑业务交付指标的完整落地' }],
      },
      context('map-v1'),
    );
    const remapped = await achievements.updateMetrics(
      first.achievementId,
      {
        reviewVersion: mapped.reviewVersion,
        achievementVersion: mapped.achievementVersion,
        links: [{ metricId: deliveryMetric.id, contribution: '支撑业务交付和验收闭环' }],
      },
      context('map-v2'),
    );
    const linkHistory = await prisma.achievementMetricLink.findMany({
      where: { achievementId: first.achievementId, metricId: deliveryMetric.id },
      orderBy: { version: 'asc' },
    });
    expect(linkHistory.map((link) => [link.version, link.active])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(linkHistory[0]!.supersededAt).not.toBeNull();
    await expect(
      prisma.achievementMetricLink.update({
        where: { id: linkHistory[1]!.id },
        data: { contribution: '不允许原地覆盖的贡献说明' },
      }),
    ).rejects.toBeTruthy();

    const excluded = await achievements.updateSelection(
      review.id,
      {
        reviewVersion: remapped.reviewVersion,
        actions: [
          {
            achievementId: second.achievementId,
            version: evidenceB.achievementVersion,
            status: 'excluded',
            reason: '暂时与核心成果重复，先排除',
            sortOrder: 20,
          },
        ],
      },
      context('exclude-b'),
    );
    const restored = await achievements.updateSelection(
      review.id,
      {
        reviewVersion: excluded.reviewVersion,
        actions: [
          {
            achievementId: second.achievementId,
            version: evidenceB.achievementVersion + 1,
            status: 'selected',
            reason: '贡献角度不同，恢复为独立成果',
            sortOrder: 20,
          },
        ],
      },
      context('restore-b'),
    );
    const updated = await achievements.update(
      first.achievementId,
      {
        reviewVersion: restored.reviewVersion,
        version: remapped.achievementVersion,
        projectId: 'project-quarterly',
        title: '交付完整季度绩效工作台',
        situation: '季度材料分散且缺少统一工作流。',
        action: '完成采集、筛选、证据和指标映射。',
        result: '形成可恢复、可追踪的季度材料。',
        impact: '减少人工整理遗漏，影响不虚构量化数字。',
        contributionBoundary: '本人负责本机工作台实现，业务评价由用户确认。',
        periodStart: '2026-10-01',
        periodEnd: '2026-12-31',
        changeReason: '补充个人职责边界和完整交付范围',
      },
      context('edit-a'),
    );
    await expect(
      prisma.achievement.update({
        where: { id: first.achievementId },
        data: { situation: '', version: { increment: 1 } },
      }),
    ).rejects.toBeTruthy();
    await expect(
      achievements.update(
        first.achievementId,
        {
          reviewVersion: restored.reviewVersion,
          version: remapped.achievementVersion,
          ...manualFields('并发覆盖不应成功'),
          changeReason: '模拟旧页面覆盖',
        },
        context('stale-edit'),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const filtered = await achievements.list(review.id, {
      status: 'selected',
      sourceType: 'manual',
      evidenceStatus: 'complete',
      metricId: deliveryMetric.id,
      month: '2026-11',
      limit: 1,
    });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      id: first.achievementId,
      version: updated.achievementVersion,
    });
    expect(filtered.items[0]!.evidences[0]).toMatchObject({ duplicateInReview: true });
    const all = await achievements.list(review.id, { limit: 100 });
    expect(
      all.items
        .flatMap((item) => item.evidences)
        .filter((evidence) => evidence.sourceType === 'manual_link')
        .every((evidence) => evidence.duplicateInReview),
    ).toBe(true);
    expect((await reviews.get(review.id)).completeness).toMatchObject({
      materialCompletenessOnly: true,
      selectedAchievementCount: 2,
      evidenceCoverage: 1,
      requiredMetricCoverage: 0.5,
      selectedWithoutMetricCount: 1,
      duplicateEvidenceReferenceCount: 1,
      unresolvedConflictCount: 1,
    });

    const replacementTemplate = await reviews.createMetricTemplate(
      {
        name: '季度候选映射替换模板',
        formulaType: 'simple_sum',
        roundingRule: 'none',
        metrics: [performanceMetric('replacement', '替换指标', 1)],
      },
      context('replacement-template'),
    );
    const rebound = await reviews.bindMetricTemplate(
      review.id,
      {
        templateVersionId: replacementTemplate.versionId,
        reviewVersion: updated.reviewVersion,
      },
      context('replacement-bind'),
    );
    expect(rebound).not.toHaveProperty('replayed');
    expect(
      await prisma.achievementMetricLink.count({
        where: { achievementId: first.achievementId, active: true },
      }),
    ).toBe(0);
    expect((await reviews.get(review.id)).completeness).toMatchObject({
      requiredMetricCoverage: 0,
      selectedWithoutMetricCount: 2,
      requiredMetricUncoveredCount: 1,
    });
    expect(
      await reviews.bindMetricTemplate(
        review.id,
        {
          templateVersionId: replacementTemplate.versionId,
          reviewVersion: rebound.reviewVersion,
        },
        context('replacement-replay'),
      ),
    ).toMatchObject({ replayed: true, reviewVersion: rebound.reviewVersion });

    const auditText = JSON.stringify(
      await prisma.auditEvent.findMany({
        where: { targetType: 'quarterly_achievement' },
      }),
    );
    expect(auditText).not.toContain('business.example');
    expect(auditText).not.toContain('贡献角度不同');
  });

  function context(suffix: string) {
    return { correlationId: `corr-${suffix}`, sessionId: `session-${suffix}` };
  }

  function manualAchievement(reviewVersion: number, title: string) {
    return { reviewVersion, ...manualFields(title) };
  }

  function manualFields(title: string) {
    return {
      projectId: 'project-quarterly',
      title,
      situation: '季度材料分散，需要统一整理。',
      action: '完成结构化整理和证据核对。',
      result: '形成可追踪的季度成果材料。',
      impact: '降低人工遗漏风险，不虚构量化价值。',
      contributionBoundary: '仅描述本人承担的工作，团队成果由用户补充。',
      periodStart: '2026-10-01',
      periodEnd: '2026-12-31',
    };
  }

  async function seedQuarterTwoFacts() {
    await seedTask('task-q2-completed', '季度边界内完成', new Date(), true);
    await prisma.task.update({
      where: { id: 'task-q2-completed' },
      data: { timeSpentSeconds: 7_200 },
    });
    await prisma.taskFieldProvenance.create({
      data: {
        id: 'provenance-q2-time-spent',
        taskId: 'task-q2-completed',
        fieldName: 'timeSpentSeconds',
        sourceType: 'excel',
        decision: 'supplement',
        valueJson: '7200',
        reason: 'Excel 补充有来源工时',
        active: true,
      },
    });
    await seedStatusEvent('task-q2-completed', '2026-06-30T15:59:59.000Z');
    await seedTask('task-q2-updated-only', '仅在季度内更新', new Date(), true);
    await seedTask('task-q2-outside-boundary', '季度边界外完成', new Date(), true);
    await seedStatusEvent('task-q2-outside-boundary', '2026-06-30T16:00:00.000Z');
    await seedTask('task-q2-confirmed-evidence', '确认关系推进任务', new Date(), true);
    await seedEvidenceLink(
      'task-q2-confirmed-evidence',
      'evidence-q2-confirmed',
      'confirmed',
      '2026-05-20T04:00:00.000Z',
      'release',
    );
    await seedEvidenceLink(
      'task-q2-confirmed-evidence',
      'evidence-q2-pipeline',
      'confirmed',
      '2026-05-21T04:00:00.000Z',
      'pipeline',
    );
    await seedEvidenceLink(
      'task-q2-confirmed-evidence',
      'evidence-q2-release',
      'confirmed',
      '2026-05-22T04:00:00.000Z',
      'release',
    );
    await seedTask('task-q2-unconfirmed-evidence', '未确认关系任务', new Date(), true);
    await seedEvidenceLink(
      'task-q2-unconfirmed-evidence',
      'evidence-q2-suggested',
      'suggested',
      '2026-05-21T04:00:00.000Z',
      'commit',
    );
    await prisma.evidence.createMany({
      data: [
        {
          id: 'evidence-q2-commit-identity',
          sourceType: 'commit',
          sourceInternalId: 'internal-q2-identity-commit',
          sourceExternalKey: 'abcdef123456',
          projectId: 'project-quarterly',
          eventAt: new Date('2026-05-23T04:00:00.000Z'),
          title: '通过确认邮箱归属的 Commit',
          contentHash: requestHash('evidence-q2-commit-identity'),
          metadataJson: JSON.stringify({ authorEmail: 'CURRENT.USER@example.com' }),
          sourceSyncedAt: new Date(),
        },
        {
          id: 'evidence-q2-merge-request-identity',
          sourceType: 'merge_request',
          sourceInternalId: 'internal-q2-identity-mr',
          sourceExternalKey: 'group/project!88',
          projectId: 'project-quarterly',
          eventAt: new Date('2026-05-24T04:00:00.000Z'),
          title: '通过确认 GitLab 用户归属的 MR',
          contentHash: requestHash('evidence-q2-merge-request-identity'),
          metadataJson: JSON.stringify({
            state: 'merged',
            author: { id: 1001, username: 'CURRENTUSER' },
          }),
          sourceSyncedAt: new Date(),
        },
      ],
    });
    await seedWeeklyReport(
      'weekly-confirmed-q2',
      '2026-05-11',
      '2026-05-15',
      true,
      '已确认周报成果',
    );
    await seedWeeklyReport(
      'weekly-draft-q2',
      '2026-06-01',
      '2026-06-05',
      false,
      '周报草稿不应入选',
    );
  }

  async function seedQuarterOneToggleFacts() {
    await seedTask('task-q1-completed', 'Q1 完成任务来源', new Date(), true);
    await seedStatusEvent('task-q1-completed', '2026-03-20T04:00:00.000Z');
    await seedTask('task-q1-evidence', 'Q1 确认证据来源', new Date(), true);
    await seedEvidenceLink(
      'task-q1-evidence',
      'evidence-q1-confirmed',
      'confirmed',
      '2026-02-20T04:00:00.000Z',
      'release',
    );
  }

  async function seedQuarterThreeStaleFact() {
    await seedTask('task-q3-stale', 'Q3 过期来源任务', new Date('2020-01-01T00:00:00.000Z'), true);
    await seedStatusEvent('task-q3-stale', '2026-08-20T04:00:00.000Z');
  }

  async function seedTask(id: string, title: string, lastObservedAt: Date, currentUser: boolean) {
    await prisma.task.create({
      data: {
        id,
        projectId: 'project-quarterly',
        primarySource: 'jira',
        issueKey: `QPR-${id}`,
        projectKey: 'QPR',
        title,
        isCurrentUser: currentUser,
        normalizedStatus: 'in_progress',
        visibilityState: 'visible',
        lastObservedAt,
      },
    });
  }

  async function seedStatusEvent(taskId: string, effectiveAt: string) {
    const observationId = `observation-${taskId}`;
    await prisma.taskSourceObservation.create({
      data: {
        id: observationId,
        taskId,
        sourceType: 'jira',
        sourceUpdatedAt: new Date(effectiveAt),
        contentHash: requestHash({ taskId, effectiveAt }),
        fieldsJson: '{}',
        observedAt: new Date(effectiveAt),
      },
    });
    await prisma.taskStatusEvent.create({
      data: {
        id: `status-${taskId}`,
        taskId,
        toNormalizedStatus: 'done',
        effectiveAt: new Date(effectiveAt),
        observedAt: new Date(effectiveAt),
        sourceObservationId: observationId,
      },
    });
  }

  async function seedEvidenceLink(
    taskId: string,
    evidenceId: string,
    status: 'confirmed' | 'suggested',
    eventAt: string,
    sourceType: 'commit' | 'pipeline' | 'release',
  ) {
    await prisma.evidence.create({
      data: {
        id: evidenceId,
        sourceType,
        sourceInternalId: `internal-${evidenceId}`,
        sourceExternalKey: `external-${evidenceId}`,
        projectId: 'project-quarterly',
        eventAt: new Date(eventAt),
        title: `${taskId} 的可核对证据`,
        contentHash: requestHash({ evidenceId }),
        sourceSyncedAt: new Date(),
      },
    });
    await prisma.evidenceLink.create({
      data: {
        id: `link-${evidenceId}`,
        targetType: 'task',
        targetId: taskId,
        taskId,
        evidenceId,
        method: 'commit_issue_key',
        confidence: 0.98,
        status,
        explanation: `${status === 'confirmed' ? '已确认' : '待确认'}的任务证据关系`,
        matchedValue: taskId,
        ruleVersion: 'quarterly-evidence-v1',
        sourceContentHash: requestHash({ evidenceId }),
        ...(status === 'confirmed' ? { confirmedBy: 'local-user', confirmedAt: new Date() } : {}),
      },
    });
  }

  async function seedWeeklyReport(
    id: string,
    periodStart: string,
    periodEnd: string,
    confirmed: boolean,
    weeklyWorkText: string,
  ) {
    await prisma.weeklyReport.create({
      data: {
        id,
        ownerProfileId: 'local-user',
        periodStart,
        periodEnd,
        reportDate: periodEnd,
        status: 'generated',
      },
    });
    const snapshotId = `snapshot-${id}`;
    await prisma.reportSourceSnapshot.create({
      data: {
        id: snapshotId,
        reportId: id,
        periodStart,
        periodEnd,
        reportDate: periodEnd,
        timezone: 'Asia/Shanghai',
        profileId: 'local-user',
        profileVersion: 1,
        taskFactsJson: '[]',
        evidenceFactsJson: '[]',
        freshnessPolicyJson: JSON.stringify({ mode: 'allow_stale', maximumAgeHours: 168 }),
        ruleVersion: 'weekly-rule-v1',
        sanitizationPolicyVersion: 'metadata-only-v1',
        generationHash: requestHash({ id, type: 'generation' }),
        sourceContentHash: requestHash({ id, type: 'source' }),
        createdBy: 'local-user',
      },
    });
    const versionId = `version-${id}`;
    await prisma.weeklyReportVersion.create({
      data: {
        id: versionId,
        reportId: id,
        versionNo: 1,
        origin: 'rule',
        reportDateText: periodEnd,
        recentGoalsText: '完成季度目标',
        weeklyWorkText,
        nextWeekPlansText: '继续推进',
        problemsText: '暂无',
        otherText: '无',
        fieldsJson: JSON.stringify({ weeklyWork: weeklyWorkText }),
        sourceSnapshotId: snapshotId,
        contentHash: requestHash({ id, weeklyWorkText }),
        createdBy: 'local-user',
      },
    });
    await prisma.weeklyReport.update({
      where: { id },
      data: {
        currentVersionId: versionId,
        ...(confirmed ? { confirmedVersionId: versionId, status: 'confirmed' } : {}),
        version: { increment: 1 },
      },
    });
  }
});

function noProgress(): Promise<void> {
  return Promise.resolve();
}

function performanceMetric(code: string, name: string, weight: number) {
  return {
    code,
    name,
    definition: `${name}必须由选定成果和证据支撑`,
    weight,
    minimum: 1,
    maximum: 5,
    step: 0.5,
    required: true,
    evidenceRequirement: { minimumEvidence: 1 },
    enabled: true,
  };
}
