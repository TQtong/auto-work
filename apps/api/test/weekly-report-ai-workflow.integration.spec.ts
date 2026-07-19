import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import type { WeeklyReportField, WeeklyTaskFact } from '@auto-work/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import type { CredentialVault } from '../src/infrastructure/vault/credential-vault.js';
import type { AiProviderClient } from '../src/modules/ai/ai-provider.client.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';
import { WeeklyReportAiService } from '../src/modules/weekly-reports/weekly-report-ai.service.js';

describe('周报 AI 建议、确定性回退与人工决定完整工作流', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: WeeklyReportAiService;
  const generate = vi.fn<AiProviderClient['generate']>();
  const vaultGet = vi
    .fn<CredentialVault['get']>()
    .mockResolvedValue(JSON.stringify({ apiKey: 'provider-secret-value' }));
  const contextBase = {
    correlationId: 'ai-workflow-correlation',
    sessionId: 'ai-workflow-session',
  };

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-ai-workflow-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'ai-workflow.db').replaceAll('\\', '/')}`,
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
    const prismaService = prisma as unknown as PrismaService;
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    const security = {
      sessionHash: () => 'ai-workflow-session-hash',
    } as unknown as LocalSecurityService;
    const vault = {
      get: vaultGet,
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as CredentialVault;
    service = new WeeklyReportAiService(
      prismaService,
      sessions,
      new AuditService(prismaService),
      security,
      { generate } as unknown as AiProviderClient,
      vault,
    );
    await seed();
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('生成成功时只增加非当前 AI 建议，保存引用和供应商事实且不覆盖人工正文', async () => {
    generate.mockImplementationOnce((input) =>
      Promise.resolve(validProviderResponse(input.request.userPrompt)),
    );
    const idempotencyRecordId = await idempotency('generate-success');
    const result = await service.createSuggestion(
      'report-main',
      {
        baseVersionId: 'base-main',
        reportVersion: 1,
        providerConnectionId: 'ai-provider',
        fields: ['recentGoals'],
        consent: {
          allowPeopleNames: false,
          allowInternalUrls: false,
          allowDescriptionSummaries: false,
        },
      },
      { ...contextBase, idempotencyRecordId },
    );

    if (!('suggestionVersion' in result)) throw new Error('预期成功生成 AI 建议版本');
    expect(result.fallback).toBe(false);
    expect(result.report).toMatchObject({ currentVersionId: 'base-main', version: 2 });
    expect(result.suggestionVersion).toMatchObject({ origin: 'ai', versionNo: 2 });
    expect(result.generation).toMatchObject({
      status: 'succeeded',
      adoptionStatus: 'pending',
      requestedFields: ['recentGoals'],
    });
    expect(result.generation.sanitizedInputHash).toMatch(/^[a-f0-9]{64}$/u);
    const report = await prisma.weeklyReport.findUniqueOrThrow({ where: { id: 'report-main' } });
    expect(report).toMatchObject({ currentVersionId: 'base-main', version: 2 });
    const suggestion = await prisma.weeklyReportVersion.findUniqueOrThrow({
      where: { id: result.suggestionVersion.id },
      include: { sourceLinks: true },
    });
    expect(suggestion.recentGoalsText).toContain('AW-12');
    expect(
      suggestion.sourceLinks.some(
        (link) =>
          link.sourceType === 'task' && link.sourceId === 'task-1' && link.taskId === 'task-1',
      ),
    ).toBe(true);
    expect(suggestion.warningsJson).toContain('AI_GENERATED_CONTENT');
    const storedGeneration = await prisma.aiGeneration.findUniqueOrThrow({
      where: { id: result.generation.id },
    });
    expect(storedGeneration).toMatchObject({
      providerConfigVersion: 4,
      retentionMode: 'hash_only',
      sanitizedInputJson: null,
      providerRequestId: 'provider-request-success',
    });
    expect(storedGeneration.rawOutput).toContain('AW-12');
    expect(vaultGet).toHaveBeenCalledWith('vault-reference');
    expect(await completed(idempotencyRecordId)).toBe(true);
  });

  it('只有显式采纳才创建人工派生版本、切换当前指针并冻结决定', async () => {
    const generation = await prisma.aiGeneration.findFirstOrThrow({
      where: { reportId: 'report-main', adoptionStatus: 'pending' },
      include: { generatedVersions: true },
    });
    const suggestion = generation.generatedVersions.find((version) => version.origin === 'ai')!;
    const idempotencyRecordId = await idempotency('adopt-success');
    const result = await service.adopt(
      'report-main',
      generation.id,
      {
        suggestionVersionId: suggestion.id,
        baseVersionId: 'base-main',
        reportVersion: 2,
        decisionReason: '逐段核对引用、数字与日期后采纳',
      },
      { ...contextBase, idempotencyRecordId },
    );

    expect(result).toMatchObject({
      replayed: false,
      generation: { adoptionStatus: 'adopted' },
      adoptedVersion: { origin: 'manual', versionNo: 3 },
      report: { currentVersionId: result.adoptedVersion.id, version: 3, status: 'editing' },
    });
    expect(
      await prisma.weeklyReportVersion.count({ where: { aiGenerationId: generation.id } }),
    ).toBe(2);
    expect(
      await prisma.weeklyReport.findUniqueOrThrow({ where: { id: 'report-main' } }),
    ).toMatchObject({
      currentVersionId: result.adoptedVersion.id,
      confirmedVersionId: null,
      version: 3,
    });
    expect(await completed(idempotencyRecordId)).toBe(true);
  });

  it('供应商失败和结构化输出无效均保留失败记录并确定性回退当前版本', async () => {
    const report = await prisma.weeklyReport.findUniqueOrThrow({ where: { id: 'report-main' } });
    generate.mockRejectedValueOnce(
      new DomainError('AI_RATE_LIMITED', '供应商限流', { httpStatus: 503, retryable: true }),
    );
    const providerFailureRecord = await idempotency('provider-fallback');
    const providerFailure = await service.createSuggestion(
      'report-main',
      suggestionInput(report.currentVersionId!, report.version),
      { ...contextBase, idempotencyRecordId: providerFailureRecord },
    );
    expect(providerFailure).toMatchObject({
      fallback: true,
      fallbackReasonCode: 'AI_RATE_LIMITED',
      fallbackVersion: { id: report.currentVersionId },
      generation: { status: 'failed', adoptionStatus: 'not_applicable' },
    });

    generate.mockResolvedValueOnce({
      protocol: 'openai_compatible',
      model: 'observed-model',
      outputText: JSON.stringify({
        fields: [
          {
            field: 'recentGoals',
            paragraphs: [
              { projectName: 'Alpha', text: '虚构投入 999 小时', citations: ['ref_unknown'] },
            ],
          },
        ],
      }),
      stopReason: 'stop',
      providerRequestId: 'invalid-output-request',
      usage: usage(),
    });
    const invalidOutputRecord = await idempotency('invalid-output-fallback');
    const invalidOutput = await service.createSuggestion(
      'report-main',
      suggestionInput(report.currentVersionId!, report.version),
      { ...contextBase, idempotencyRecordId: invalidOutputRecord },
    );
    expect(invalidOutput).toMatchObject({
      fallback: true,
      fallbackReasonCode: 'AI_OUTPUT_CITATION_UNKNOWN',
      generation: { status: 'failed', providerRequestId: 'invalid-output-request' },
    });
    const invalidGeneration = await prisma.aiGeneration.findUniqueOrThrow({
      where: { id: invalidOutput.generation.id },
    });
    expect(invalidGeneration.rawOutput).toContain('999');
    expect(invalidGeneration.parsedOutputJson).toBeNull();

    generate.mockResolvedValueOnce({
      protocol: 'openai_compatible',
      model: 'observed-model',
      outputText: JSON.stringify({
        fields: [
          {
            field: 'recentGoals',
            paragraphs: [
              {
                projectName: null,
                text: 'Authorization: Bearer provider-invented-secret-value',
                citations: ['ref_any'],
              },
            ],
          },
        ],
      }),
      stopReason: 'stop',
      providerRequestId: 'unsafe-output-request',
      usage: usage(),
    });
    const unsafeOutputRecord = await idempotency('unsafe-output-fallback');
    const unsafeOutput = await service.createSuggestion(
      'report-main',
      suggestionInput(report.currentVersionId!, report.version),
      { ...contextBase, idempotencyRecordId: unsafeOutputRecord },
    );
    expect(unsafeOutput).toMatchObject({
      fallback: true,
      fallbackReasonCode: 'AI_OUTPUT_SECURITY_BLOCKED',
      generation: { status: 'blocked', rawOutput: null },
    });
    expect(unsafeOutput.generation.securityBlocks).toContain('authorization_headers');
    const unsafeStored = await prisma.aiGeneration.findUniqueOrThrow({
      where: { id: unsafeOutput.generation.id },
    });
    expect(JSON.stringify(unsafeStored)).not.toContain('provider-invented-secret-value');
    expect(
      await prisma.weeklyReport.findUniqueOrThrow({ where: { id: 'report-main' } }),
    ).toMatchObject({ currentVersionId: report.currentVersionId, version: report.version });
  });

  it('本地秘密扫描在读取凭证和调用供应商前阻断，只记录类别且不回显秘密', async () => {
    const beforeCalls = generate.mock.calls.length;
    const beforeVaultCalls = vaultGet.mock.calls.length;
    const idempotencyRecordId = await idempotency('security-block');
    const result = await service.createSuggestion(
      'report-secret',
      {
        baseVersionId: 'base-secret',
        reportVersion: 1,
        providerConnectionId: 'ai-provider',
        fields: ['recentGoals'],
        consent: {
          allowPeopleNames: false,
          allowInternalUrls: false,
          allowDescriptionSummaries: false,
        },
      },
      { ...contextBase, idempotencyRecordId },
    );

    if (!('fallbackReasonCode' in result)) throw new Error('预期本地安全阻断并回退');
    expect(result.fallback).toBe(true);
    expect(result.fallbackReasonCode).toBe('AI_INPUT_SECURITY_BLOCKED');
    expect(result.generation).toMatchObject({ status: 'blocked', rawOutput: null });
    expect(result.generation.securityBlocks).toContain('authorization_headers');
    expect(generate).toHaveBeenCalledTimes(beforeCalls);
    expect(vaultGet).toHaveBeenCalledTimes(beforeVaultCalls);
    const stored = await prisma.aiGeneration.findUniqueOrThrow({
      where: { id: result.generation.id },
    });
    expect(JSON.stringify(stored)).not.toContain('top-secret-never-store');
    expect(stored.sanitizedInputHash).toBeNull();
    expect(stored.sanitizedInputJson).toBeNull();
  });

  it('可拒绝待处理建议；正文已变化时禁止采纳旧建议但仍允许拒绝', async () => {
    const current = await prisma.weeklyReport.findUniqueOrThrow({
      where: { id: 'report-main' },
      include: { currentVersion: true },
    });
    generate.mockImplementationOnce((input) =>
      Promise.resolve(validProviderResponse(input.request.userPrompt)),
    );
    const generateRecord = await idempotency('generate-to-reject');
    const created = await service.createSuggestion(
      'report-main',
      suggestionInput(current.currentVersionId!, current.version),
      { ...contextBase, idempotencyRecordId: generateRecord },
    );
    if (!('suggestionVersion' in created)) throw new Error('预期成功生成待拒绝建议');
    const generationId = created.generation.id;
    const suggestionVersionId = created.suggestionVersion.id;
    const latest = await prisma.weeklyReportVersion.aggregate({
      where: { reportId: 'report-main' },
      _max: { versionNo: true },
    });
    const manual = await prisma.weeklyReportVersion.create({
      data: {
        id: 'manual-after-ai',
        reportId: 'report-main',
        versionNo: (latest._max.versionNo ?? 0) + 1,
        origin: 'manual',
        parentVersionId: current.currentVersionId,
        reportDateText: current.currentVersion!.reportDateText,
        recentGoalsText: '用户在 AI 建议后继续手工编辑',
        weeklyWorkText: current.currentVersion!.weeklyWorkText,
        nextWeekPlansText: current.currentVersion!.nextWeekPlansText,
        problemsText: current.currentVersion!.problemsText,
        otherText: current.currentVersion!.otherText,
        fieldsJson: current.currentVersion!.fieldsJson,
        warningsJson: current.currentVersion!.warningsJson,
        attachmentsJson: current.currentVersion!.attachmentsJson,
        recipientScopeJson: current.currentVersion!.recipientScopeJson,
        templateMappingVersionId: current.currentVersion!.templateMappingVersionId,
        scheduleAt: current.currentVersion!.scheduleAt,
        sourceSnapshotId: current.currentVersion!.sourceSnapshotId,
        contentHash: '9'.repeat(64),
        changeSummaryJson: '{"kind":"test_manual_edit"}',
        createdBy: 'local-user',
      },
    });
    await prisma.weeklyReport.update({
      where: { id: 'report-main' },
      data: { currentVersionId: manual.id, version: { increment: 1 } },
    });

    const staleAdoptRecord = await idempotency('stale-adopt');
    await expect(
      service.adopt(
        'report-main',
        generationId,
        {
          suggestionVersionId,
          baseVersionId: manual.id,
          reportVersion: current.version + 2,
          decisionReason: '尝试采纳旧建议',
        },
        { ...contextBase, idempotencyRecordId: staleAdoptRecord },
      ),
    ).rejects.toMatchObject({ code: 'AI_SUGGESTION_STALE' });

    const rejectRecord = await idempotency('reject-stale');
    const rejected = await service.reject(
      'report-main',
      generationId,
      { decisionReason: '正文已变化，明确拒绝旧建议' },
      { ...contextBase, idempotencyRecordId: rejectRecord },
    );
    expect(rejected).toMatchObject({
      replayed: false,
      generation: { adoptionStatus: 'rejected', decisionReason: '正文已变化，明确拒绝旧建议' },
    });
    expect(await completed(rejectRecord)).toBe(true);
  });

  it('列表和详情只暴露净化引用、哈希和纯文本输出，不存在凭证字段', async () => {
    const list = await service.list('report-main');
    expect(list.total).toBeGreaterThanOrEqual(4);
    expect(list.items.every((item) => !('rawOutput' in item))).toBe(true);
    const successful = list.items.find((item) => item.status === 'succeeded')!;
    const detail = await service.get('report-main', successful.id);
    expect(detail).toHaveProperty('inputRefs');
    expect(detail).toHaveProperty('rawOutput');
    expect(JSON.stringify(detail)).not.toContain('provider-secret-value');
    expect(detail.retentionMode).toBe('hash_only');
  });

  async function seed(): Promise<void> {
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-ai-workflow-user',
        displayName: 'AI 工作流验收用户',
        timezone: 'Asia/Shanghai',
      },
    });
    await prisma.integrationConnection.create({
      data: {
        id: 'ai-provider',
        type: 'ai',
        name: '验收 AI',
        baseUrl: 'https://ai.example.test',
        credentialRef: 'vault-reference',
        credentialMask: '{"apiKey":"pr****************ue"}',
        enabled: true,
        status: 'healthy',
        version: 4,
        configJson: JSON.stringify({
          protocol: 'openai_compatible',
          model: 'configured-model',
          metadataOnly: true,
          timeoutMs: 20_000,
          maxInputTokens: 32_000,
          maxOutputTokens: 1_024,
          temperaturePolicy: 'deterministic',
          temperature: 0,
          allowedPurposes: ['weekly_report'],
        }),
      },
    });
    await prisma.project.create({ data: { id: 'project-1', name: 'Alpha' } });
    await prisma.task.create({
      data: {
        id: 'task-1',
        projectId: 'project-1',
        primarySource: 'jira',
        issueKey: 'AW-12',
        title: '完整实现 AI 建议',
        normalizedStatus: 'in_progress',
        isCurrentUser: true,
        plannedStartDate: '2026-07-13',
        dueDate: '2026-07-18',
        timeSpentSeconds: 7_200,
        originalEstimateSeconds: 7_200,
        remainingEstimateSeconds: 3_600,
        lastObservedAt: new Date('2026-07-18T01:00:00.000Z'),
      },
    });
    await seedReport(
      'report-main',
      'base-main',
      '推进 Alpha 项目 AW-12，截止 2026-07-18，预计 2 小时。',
    );
    await seedReport(
      'report-secret',
      'base-secret',
      'Authorization: Bearer top-secret-never-store',
    );
  }

  async function seedReport(reportId: string, versionId: string, recentGoalsText: string) {
    const period =
      reportId === 'report-main'
        ? { start: '2026-07-13', end: '2026-07-19', reportDate: '2026-07-18' }
        : { start: '2026-07-20', end: '2026-07-26', reportDate: '2026-07-25' };
    await prisma.weeklyReport.create({
      data: {
        id: reportId,
        ownerProfileId: 'local-user',
        periodStart: period.start,
        periodEnd: period.end,
        reportDate: period.reportDate,
        status: 'editing',
      },
    });
    const snapshotId = `snapshot-${reportId}`;
    await prisma.reportSourceSnapshot.create({
      data: {
        id: snapshotId,
        reportId,
        periodStart: period.start,
        periodEnd: period.end,
        reportDate: period.reportDate,
        timezone: 'Asia/Shanghai',
        profileId: 'local-user',
        profileVersion: 1,
        taskFactsJson: JSON.stringify([taskFact()]),
        evidenceFactsJson: '[]',
        manualInputsJson: '[]',
        freshnessPolicyJson: '{}',
        warningsJson: '[]',
        ruleVersion: 'weekly-report-rule-v1',
        sanitizationPolicyVersion: 'weekly-report-ai-sanitization-v1',
        generationHash: reportId === 'report-main' ? '1'.repeat(64) : '2'.repeat(64),
        sourceContentHash: reportId === 'report-main' ? '3'.repeat(64) : '4'.repeat(64),
        createdBy: 'local-user',
      },
    });
    await prisma.weeklyReportVersion.create({
      data: {
        id: versionId,
        reportId,
        versionNo: 1,
        origin: 'rule',
        reportDateText: period.reportDate,
        recentGoalsText,
        weeklyWorkText: '本周推进 Alpha 项目 AW-12，投入 2 小时。',
        nextWeekPlansText: '下周继续推进 Alpha 项目 AW-12。',
        problemsText: '暂无',
        otherText: '无',
        fieldsJson: JSON.stringify({
          recentGoals: [],
          weeklyWork: [],
          nextWeekPlans: [],
          problems: [],
          other: [],
        }),
        warningsJson: '[]',
        attachmentsJson: '[]',
        recipientScopeJson: '{}',
        sourceSnapshotId: snapshotId,
        contentHash: reportId === 'report-main' ? '5'.repeat(64) : '6'.repeat(64),
        changeSummaryJson: '{"kind":"rule_generation"}',
        createdBy: 'local-user',
      },
    });
    await prisma.weeklyReport.update({
      where: { id: reportId },
      data: { currentVersionId: versionId },
    });
  }

  function taskFact(): WeeklyTaskFact {
    return {
      id: 'task-1',
      issueKey: 'AW-12',
      projectId: 'project-1',
      projectName: 'Alpha',
      title: '完整实现 AI 建议',
      normalizedStatus: 'in_progress',
      plannedStartDate: '2026-07-13',
      dueDate: '2026-07-18',
      timeSpentSeconds: 7_200,
      originalEstimateSeconds: 7_200,
      remainingEstimateSeconds: 3_600,
      sprintActive: true,
      isCurrentUser: true,
      visibilityState: 'visible',
      lastObservedAt: '2026-07-18T01:00:00.000Z',
      sourceFreshness: 'fresh',
    };
  }

  function suggestionInput(baseVersionId: string, reportVersion: number) {
    return {
      baseVersionId,
      reportVersion,
      providerConnectionId: 'ai-provider',
      fields: ['recentGoals'] as WeeklyReportField[],
      consent: {
        allowPeopleNames: false,
        allowInternalUrls: false,
        allowDescriptionSummaries: false,
      },
    };
  }

  function validProviderResponse(userPrompt: string) {
    const payload = JSON.parse(userPrompt) as {
      input: {
        requestedFields: WeeklyReportField[];
        sources: Array<{ refId: string; kind: string }>;
      };
    };
    const taskRef = payload.input.sources.find((source) => source.kind === 'task')!.refId;
    return {
      protocol: 'openai_compatible' as const,
      model: 'observed-model',
      outputText: JSON.stringify({
        fields: payload.input.requestedFields.map((field) => ({
          field,
          paragraphs: [
            {
              projectName: 'Alpha',
              text: '推进 Alpha 项目 AW-12，投入 2 小时，截止 2026-07-18。',
              citations: [taskRef],
            },
          ],
        })),
      }),
      stopReason: 'stop',
      providerRequestId: 'provider-request-success',
      usage: usage(),
    };
  }

  function usage() {
    return {
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  async function idempotency(suffix: string): Promise<string> {
    const id = `idempotency-${suffix}`;
    await prisma.idempotencyRecord.create({
      data: {
        id,
        actorId: 'local-user',
        route: `/test/${suffix}`,
        idempotencyKey: `key-${suffix}`,
        requestHash: suffix.padEnd(64, '0').slice(0, 64),
        state: 'processing',
      },
    });
    return id;
  }

  async function completed(id: string): Promise<boolean> {
    const row = await prisma.idempotencyRecord.findUniqueOrThrow({ where: { id } });
    return row.state === 'completed' && row.httpStatus === 200 && row.responseJson !== null;
  }
});
