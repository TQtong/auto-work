import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('AI 生成记录、建议版本与单向人工决定约束', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  const now = new Date('2026-07-18T03:00:00.000Z');

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-ai-generation-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'ai-generation.db').replaceAll('\\', '/')}`,
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
    await seedBaseVersion();
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('在 hash-only 模式完整保留生成事实，但拒绝落库净化正文和非法结束状态', async () => {
    await expect(
      prisma.aiGeneration.create({
        data: generationData({
          id: 'invalid-retention',
          sanitizedInputJson: '{"secret":"must-not-be-stored"}',
        }),
      }),
    ).rejects.toThrow();

    await expect(
      prisma.aiGeneration.create({
        data: generationData({ id: 'invalid-status', status: 'pending' }),
      }),
    ).rejects.toThrow();

    expect(
      await prisma.aiGeneration.count({
        where: { id: { in: ['invalid-retention', 'invalid-status'] } },
      }),
    ).toBe(0);

    const blocked = await prisma.aiGeneration.create({
      data: generationData({
        id: 'blocked-generation',
        sanitizedInputHash: null,
        rawOutput: null,
        parsedOutputJson: null,
        status: 'blocked',
        errorCode: 'AI_INPUT_SECURITY_BLOCKED',
        securityBlocksJson: JSON.stringify(['private_keys']),
        adoptionStatus: 'not_applicable',
      }),
    });
    expect(blocked.securityBlocksJson).toBe('["private_keys"]');
    expect(blocked.sanitizedInputJson).toBeNull();
  });

  it('成功记录先产生非当前 AI 建议版本，再由人工版本显式采纳且决定不可反悔', async () => {
    const generation = await prisma.aiGeneration.create({
      data: generationData({
        id: 'weekly-generation',
        reportId: 'report-1',
        baseVersionId: 'rule-version-1',
        baseReportVersion: 1,
        adoptionStatus: 'pending',
      }),
    });
    const suggestion = await prisma.weeklyReportVersion.create({
      data: versionData({
        id: 'ai-suggestion-version',
        versionNo: 2,
        origin: 'ai',
        parentVersionId: 'rule-version-1',
        aiGenerationId: generation.id,
        recentGoalsText: 'AI 建议正文',
      }),
    });

    expect(
      (await prisma.weeklyReport.findUniqueOrThrow({ where: { id: 'report-1' } })).currentVersionId,
    ).toBe('rule-version-1');
    expect(suggestion.origin).toBe('ai');

    const adoptedVersion = await prisma.weeklyReportVersion.create({
      data: versionData({
        id: 'adopted-manual-version',
        versionNo: 3,
        origin: 'manual',
        parentVersionId: 'rule-version-1',
        aiGenerationId: generation.id,
        recentGoalsText: '人工采纳后的正文',
      }),
    });
    const decided = await prisma.aiGeneration.update({
      where: { id: generation.id },
      data: {
        adoptionStatus: 'adopted',
        adoptedVersionId: adoptedVersion.id,
        decisionReason: '逐段核对引用后采纳',
        decidedAt: now,
      },
    });
    expect(decided).toMatchObject({
      adoptionStatus: 'adopted',
      adoptedVersionId: adoptedVersion.id,
      decisionReason: '逐段核对引用后采纳',
    });

    await expect(
      prisma.aiGeneration.update({
        where: { id: generation.id },
        data: { adoptionStatus: 'rejected', adoptedVersionId: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.aiGeneration.update({
        where: { id: generation.id },
        data: { rawOutput: '{"tampered":true}' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.weeklyReportVersion.update({
        where: { id: suggestion.id },
        data: { recentGoalsText: '覆盖 AI 历史' },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.aiGeneration.findUniqueOrThrow({ where: { id: generation.id } }),
    ).toMatchObject({
      adoptionStatus: 'adopted',
      adoptedVersionId: adoptedVersion.id,
      rawOutput: '{"fields":[]}',
    });
    expect(
      (await prisma.weeklyReportVersion.findUniqueOrThrow({ where: { id: suggestion.id } }))
        .recentGoalsText,
    ).toBe('AI 建议正文');
  });

  it('拒绝跨周报引用、无生成记录的 AI 版本和不完整成功记录', async () => {
    await expect(
      prisma.weeklyReportVersion.create({
        data: versionData({
          id: 'orphan-ai-version',
          versionNo: 4,
          origin: 'ai',
          aiGenerationId: null,
        }),
      }),
    ).rejects.toThrow();
    await expect(
      prisma.aiGeneration.create({
        data: generationData({
          id: 'incomplete-success',
          rawOutput: null,
          parsedOutputJson: null,
        }),
      }),
    ).rejects.toThrow();

    expect(
      await prisma.weeklyReportVersion.findUnique({ where: { id: 'orphan-ai-version' } }),
    ).toBeNull();
    expect(
      await prisma.aiGeneration.findUnique({ where: { id: 'incomplete-success' } }),
    ).toBeNull();

    expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    expect(await prisma.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
  });

  async function seedBaseVersion(): Promise<void> {
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-ai-generation-test',
        displayName: 'AI 验收用户',
        timezone: 'Asia/Shanghai',
      },
    });
    await prisma.integrationConnection.create({
      data: {
        id: 'ai-provider-1',
        type: 'ai',
        name: 'AI 主连接',
        baseUrl: 'https://ai.example.test',
        enabled: true,
        status: 'healthy',
        version: 3,
        configJson: JSON.stringify({ protocol: 'openai_compatible', model: 'test-model' }),
      },
    });
    await prisma.weeklyReport.create({
      data: {
        id: 'report-1',
        ownerProfileId: 'local-user',
        periodStart: '2026-07-13',
        periodEnd: '2026-07-19',
        reportDate: '2026-07-18',
        status: 'editing',
      },
    });
    await prisma.reportSourceSnapshot.create({
      data: {
        id: 'snapshot-1',
        reportId: 'report-1',
        periodStart: '2026-07-13',
        periodEnd: '2026-07-19',
        reportDate: '2026-07-18',
        timezone: 'Asia/Shanghai',
        profileId: 'local-user',
        profileVersion: 1,
        taskFactsJson: '[]',
        evidenceFactsJson: '[]',
        manualInputsJson: '[]',
        freshnessPolicyJson: '{}',
        warningsJson: '[]',
        ruleVersion: 'weekly-report-rule-v1',
        sanitizationPolicyVersion: 'weekly-report-ai-sanitization-v1',
        generationHash: '1'.repeat(64),
        sourceContentHash: '2'.repeat(64),
        createdBy: 'local-user',
      },
    });
    await prisma.weeklyReportVersion.create({
      data: versionData({ id: 'rule-version-1', versionNo: 1, origin: 'rule' }),
    });
    await prisma.weeklyReport.update({
      where: { id: 'report-1' },
      data: { currentVersionId: 'rule-version-1' },
    });
  }

  function generationData(overrides: Partial<Prisma.AiGenerationUncheckedCreateInput> = {}) {
    return {
      id: 'generation-default',
      ownerProfileId: 'local-user',
      providerConnectionId: 'ai-provider-1',
      providerConfigVersion: 3,
      purpose: 'weekly_report',
      promptTemplateVersion: 'weekly-report-ai-prompt-v1',
      sanitizationPolicyVersion: 'weekly-report-ai-sanitization-v1',
      retentionMode: 'hash_only',
      requestedFieldsJson: '["recentGoals"]',
      inputRefsJson: '[]',
      inputCategoriesJson: '["jira_metadata"]',
      removedCategoriesJson: '["internal_urls"]',
      sanitizedInputHash: 'a'.repeat(64),
      sanitizedInputJson: null,
      rawOutput: '{"fields":[]}',
      parsedOutputJson: '{"fields":[]}',
      protocol: 'openai_compatible',
      model: 'test-model',
      providerRequestId: 'provider-request-1',
      stopReason: 'stop',
      usageJson: '{"inputTokens":10,"outputTokens":5,"totalTokens":15}',
      durationMs: 120,
      status: 'succeeded',
      errorCode: null,
      securityBlocksJson: '[]',
      adoptionStatus: 'not_applicable',
      createdBy: 'local-user',
      completedAt: now,
      ...overrides,
    };
  }

  function versionData(overrides: Partial<Prisma.WeeklyReportVersionUncheckedCreateInput> = {}) {
    return {
      id: 'version-default',
      reportId: 'report-1',
      versionNo: 1,
      origin: 'rule',
      parentVersionId: null,
      reportDateText: '2026-07-18',
      recentGoalsText: '原始目标',
      weeklyWorkText: '原始工作',
      nextWeekPlansText: '原始计划',
      problemsText: '暂无',
      otherText: '无',
      fieldsJson: '{}',
      warningsJson: '[]',
      attachmentsJson: '[]',
      recipientScopeJson: '{}',
      sourceSnapshotId: 'snapshot-1',
      aiGenerationId: null,
      contentHash: 'b'.repeat(64),
      changeSummaryJson: '{}',
      createdBy: 'local-user',
      ...overrides,
    };
  }
});
