import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { CredentialVault } from '../src/infrastructure/vault/credential-vault.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import { IntegrationProbeRegistry } from '../src/modules/integrations/integration-probe.registry.js';
import { IntegrationTestHandler } from '../src/modules/integrations/integration-test.handler.js';
import { IntegrationsController } from '../src/modules/integrations/integrations.controller.js';
import { IntegrationsService } from '../src/modules/integrations/integrations.service.js';
import type { JobRegistryService } from '../src/modules/jobs/job-registry.service.js';
import type { JobQueueService } from '../src/modules/jobs/job-queue.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('钉钉机器人待测试凭证安全轮换', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let handler: IntegrationTestHandler;
  let integrations: IntegrationsService;
  let controller: IntegrationsController;
  let vault: CredentialVault;
  let probes: IntegrationProbeRegistry;
  const secrets = new Map<string, string>();
  const deletedReferences: string[] = [];
  const enqueue = vi
    .fn<(input: Parameters<JobQueueService['enqueue']>[0]) => Promise<{ id: string }>>()
    .mockResolvedValue({ id: 'integration-test-job' });
  let referenceSequence = 0;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-dingtalk-rotation-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'rotation.db').replaceAll('\\', '/')}`,
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
    probes = new IntegrationProbeRegistry();
    probes.register({
      type: 'dingtalk_robot',
      probe: (target) =>
        Promise.resolve(
          target.credential?.secret === 'valid-new-secret'
            ? {
                healthy: true,
                status: 'healthy',
                capabilities: { signedWebhook: true, fixedProbeMessage: true },
              }
            : {
                healthy: false,
                status: 'invalid',
                capabilities: { signedWebhook: true, fixedProbeMessage: true },
                errorCode: 'DINGTALK_ROBOT_SIGNATURE_INVALID',
                message: '固定测试消息发送失败',
              },
        ),
    });
    vault = {
      put: (secret) => {
        referenceSequence += 1;
        const reference = `generated-ref-${referenceSequence}`;
        secrets.set(reference, secret);
        return Promise.resolve(reference);
      },
      get: (reference) => {
        const value = secrets.get(reference);
        if (!value) throw new Error(`测试保险箱引用不存在：${reference}`);
        return Promise.resolve(value);
      },
      delete: (reference) => {
        deletedReferences.push(reference);
        secrets.delete(reference);
        return Promise.resolve();
      },
    };
    handler = new IntegrationTestHandler(
      { register: vi.fn() } as unknown as JobRegistryService,
      prisma as unknown as PrismaService,
      probes,
      vault,
      new AuditService(prisma as unknown as PrismaService),
      { enqueue } as unknown as JobQueueService,
    );
    const prismaService = prisma as unknown as PrismaService;
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    const security = {
      sessionHash: () => 'dingtalk-rotation-session-hash',
    } as unknown as LocalSecurityService;
    integrations = new IntegrationsService(
      prismaService,
      sessions,
      new AuditService(prismaService),
      security,
      { enqueue } as unknown as JobQueueService,
      probes,
      vault,
    );
    controller = new IntegrationsController(
      integrations,
      {} as never,
      new IdempotencyService(prismaService),
      sessions,
    );
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-dingtalk-rotation-test',
        displayName: '连接管理员',
        timezone: 'Asia/Shanghai',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('创建和替换机器人凭证时只写入待测试槽位且不会调用探测器', async () => {
    const probeSpy = vi.spyOn(probes, 'probe');
    const context = { correlationId: 'rotation-create', sessionId: 'rotation-session' };
    const created = await integrations.create(
      {
        type: 'dingtalk_robot',
        name: '研发通知',
        config: { robotName: '研发机器人', groupId: 'group-1', quietWindowMinutes: 30 },
        credential: { webhook: officialWebhook('first'), secret: 'first-secret-value' },
      },
      context,
    );
    const createdRow = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: created.id },
    });
    const firstPendingReference = createdRow.pendingCredentialRef;

    expect(created).toMatchObject({
      credentialMask: null,
      credentialReplacementPending: true,
      status: 'unknown',
      config: {
        robotName: '研发机器人',
        groupId: 'group-1',
        quietWindowMinutes: 30,
        severeRiskCodes: [],
      },
    });
    expect(createdRow).toMatchObject({ credentialRef: null });
    expect(firstPendingReference).not.toBeNull();
    const updated = await integrations.update(
      created.id,
      {
        version: created.version,
        credential: { webhook: officialWebhook('second'), secret: 'second-secret-value' },
      },
      { ...context, correlationId: 'rotation-update' },
    );
    const updatedRow = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(updated).toMatchObject({ credentialReplacementPending: true, status: 'unknown' });
    expect(updatedRow.credentialRef).toBeNull();
    expect(updatedRow.pendingCredentialRef).not.toBe(firstPendingReference);
    expect(deletedReferences).toContain(firstPendingReference);
    expect(probeSpy).not.toHaveBeenCalled();
    await expect(controller.test(created.id, request('generic-bypass'))).rejects.toMatchObject({
      code: 'DINGTALK_ROBOT_EXPLICIT_TEST_REQUIRED',
    });
    await expect(
      controller.testDingTalkRobot(
        created.id,
        { confirmSendTestMessage: true },
        undefined,
        request('missing-key'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(
      controller.testDingTalkRobot(
        created.id,
        { confirmSendTestMessage: false },
        'robot-invalid-confirmation',
        request('invalid-confirmation'),
      ),
    ).rejects.toThrow();

    const first = await controller.testDingTalkRobot(
      created.id,
      { confirmSendTestMessage: true },
      'robot-test-first-request',
      request('robot-test-first'),
    );
    const idempotentReplay = await controller.testDingTalkRobot(
      created.id,
      { confirmSendTestMessage: true },
      'robot-test-first-request',
      request('robot-test-replay'),
    );
    expect(idempotentReplay.data).toEqual(first.data);
    const activeOperationReplay = await controller.testDingTalkRobot(
      created.id,
      { confirmSendTestMessage: true },
      'robot-test-second-request',
      request('robot-test-active-operation'),
    );
    expect(activeOperationReplay.data).toEqual(first.data);
    expect(
      await prisma.job.count({ where: { type: 'integration.test', payloadRef: created.id } }),
    ).toBe(1);
    expect(
      await prisma.job.findFirstOrThrow({
        where: { type: 'integration.test', payloadRef: created.id },
      }),
    ).toMatchObject({ maxAttempts: 1, status: 'queued' });
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          route: `/api/v1/integrations/${created.id}/dingtalk-robot/test`,
          state: 'completed',
          httpStatus: 202,
        },
      }),
    ).toBe(2);
    expect(
      await prisma.auditEvent.count({
        where: { action: 'integration.dingtalk_robot_test_requested', targetId: created.id },
      }),
    ).toBe(2);
    expect(enqueue).not.toHaveBeenCalled();
    probeSpy.mockRestore();
  });

  it('严重风险规则只接受共享目录代码，拒绝客户端自造规则', async () => {
    await expect(
      integrations.create(
        {
          type: 'dingtalk_robot',
          name: '伪造风险规则机器人',
          config: {
            robotName: '风险机器人',
            groupId: 'group-risk-invalid',
            quietWindowMinutes: 30,
            severeRiskCodes: ['CLIENT_FORGED_RULE'],
          },
        },
        { correlationId: 'risk-rule-invalid', sessionId: 'rotation-session' },
      ),
    ).rejects.toThrow();
    expect(
      await prisma.integrationConnection.count({ where: { name: '伪造风险规则机器人' } }),
    ).toBe(0);
  });

  it('固定消息测试成功后原子提升新凭证并清除旧保险箱引用', async () => {
    secrets.set(
      'old-ref',
      JSON.stringify({ webhook: officialWebhook('old'), secret: 'old-secret' }),
    );
    secrets.set(
      'pending-good-ref',
      JSON.stringify({ webhook: officialWebhook('new'), secret: 'valid-new-secret' }),
    );
    await createConnection({
      id: 'robot-success',
      activeRef: 'old-ref',
      pendingRef: 'pending-good-ref',
    });
    await createTestJob('robot-success', 'result-success');

    const result = await handler.execute(jobContext('robot-success'));
    const row = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: 'robot-success' },
    });

    expect(result).toMatchObject({ healthy: true, credentialPromoted: true });
    expect(row).toMatchObject({
      credentialRef: 'pending-good-ref',
      pendingCredentialRef: null,
      pendingCredentialMask: null,
      pendingCredentialCreatedAt: null,
      status: 'healthy',
    });
    expect(row.lastSuccessAt).not.toBeNull();
    expect(deletedReferences).toContain('old-ref');
    expect(secrets.has('pending-good-ref')).toBe(true);
    expect(
      await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'integration.test_completed', targetId: 'robot-success' },
      }),
    ).toMatchObject({
      actorType: 'local_user',
      actorId: 'local-user',
      correlationId: 'corr-result-success',
      outcome: 'succeeded',
      errorCode: null,
    });
  });

  it('测试失败时保留旧凭证、健康状态和待测试凭证以便修正后重试', async () => {
    secrets.set(
      'active-stable-ref',
      JSON.stringify({ webhook: officialWebhook('stable'), secret: 'stable-secret' }),
    );
    secrets.set(
      'pending-bad-ref',
      JSON.stringify({ webhook: officialWebhook('bad'), secret: 'invalid-new-secret' }),
    );
    await createConnection({
      id: 'robot-failure',
      activeRef: 'active-stable-ref',
      pendingRef: 'pending-bad-ref',
    });
    await createTestJob('robot-failure', 'result-failure');

    const result = await handler.execute(jobContext('robot-failure'));
    const row = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: 'robot-failure' },
    });
    const capabilities = JSON.parse(row.capabilitiesJson) as Record<string, unknown>;

    expect(result).toMatchObject({
      healthy: false,
      credentialPromoted: false,
      activeCredentialPreserved: true,
    });
    expect(row).toMatchObject({
      credentialRef: 'active-stable-ref',
      pendingCredentialRef: 'pending-bad-ref',
      status: 'healthy',
    });
    expect(capabilities).toMatchObject({
      existingCapability: true,
      pendingCredentialTest: {
        healthy: false,
        errorCode: 'DINGTALK_ROBOT_SIGNATURE_INVALID',
      },
    });
    expect(deletedReferences).not.toContain('active-stable-ref');
    expect(secrets.has('pending-bad-ref')).toBe(true);
    expect(
      await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'integration.test_completed', targetId: 'robot-failure' },
      }),
    ).toMatchObject({
      actorType: 'local_user',
      actorId: 'local-user',
      correlationId: 'corr-result-failure',
      outcome: 'failed',
      errorCode: 'DINGTALK_ROBOT_SIGNATURE_INVALID',
    });
  });

  async function createConnection(input: {
    id: string;
    activeRef: string;
    pendingRef: string;
  }): Promise<void> {
    await prisma.integrationConnection.create({
      data: {
        id: input.id,
        type: 'dingtalk_robot',
        name: input.id,
        configJson: JSON.stringify({ robotName: '研发通知', groupId: 'group-1' }),
        credentialRef: input.activeRef,
        credentialMask: JSON.stringify({ webhook: '[已配置]', secret: '••••cret' }),
        pendingCredentialRef: input.pendingRef,
        pendingCredentialMask: JSON.stringify({ webhook: '[已配置]', secret: '••••cret' }),
        pendingCredentialCreatedAt: new Date(),
        status: 'healthy',
        capabilitiesJson: JSON.stringify({ existingCapability: true }),
      },
    });
  }

  async function createTestJob(connectionId: string, suffix: string): Promise<void> {
    await prisma.job.create({
      data: {
        id: `job-${connectionId}`,
        type: 'integration.test',
        payloadRef: connectionId,
        payloadSummary: JSON.stringify({
          integrationType: 'dingtalk_robot',
          integrationId: connectionId,
          requestedBy: 'local-user',
          correlationId: `corr-${suffix}`,
          clientSessionHash: `session-hash-${suffix}`,
        }),
        scheduledAt: new Date(),
        maxAttempts: 1,
      },
    });
  }

  function jobContext(id: string) {
    return {
      jobId: `job-${id}`,
      payloadRef: id,
      isCancellationRequested: () => Promise.resolve(false),
      reportProgress: () => Promise.resolve(),
    };
  }

  function officialWebhook(token: string): string {
    return `https://oapi.dingtalk.com/robot/send?access_token=${token}`;
  }

  function request(suffix: string) {
    return {
      autoWork: {
        correlationId: `corr-${suffix}`,
        sessionId: `session-${suffix}`,
      },
    } as never;
  }
});
