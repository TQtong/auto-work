import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DomainError, errorCodes, weeklyReportWarningRuleCodes } from '@auto-work/contracts';
import { newId, normalizeHttpsBaseUrl, requestHash } from '@auto-work/domain';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { SessionService } from '../session/session.service.js';
import type { RequestAuditContext } from '../settings/profile.service.js';
import { IntegrationProbeRegistry, type IntegrationType } from './integration-probe.registry.js';
import { aiProviderConfigSchema } from '../ai/ai-provider.config.js';
import { validateDingTalkRobotWebhook } from '../dingtalk/dingtalk-robot.client.js';

const configSchemas = {
  gitlab: z
    .object({
      projectIds: z.array(z.number().int().positive()).max(100).default([]),
      projectRefs: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
      historyDays: z.number().int().min(1).max(730).default(120),
    })
    .strict(),
  jira: z
    .object({
      authScheme: z.enum(['bearer', 'basic_pat']).default('bearer'),
      accountName: z.string().trim().min(1).max(200).optional(),
      maxResults: z.number().int().min(1).max(1_000).default(100),
    })
    .strict(),
  dingtalk_log: z
    .object({
      appKey: z.string().trim().min(1).max(200),
      corpId: z.string().trim().min(1).max(200),
      operatorUserId: z.string().trim().min(1).max(500),
      templateName: z.string().trim().min(1).max(200).default('uTwin产研创新部周报'),
    })
    .strict(),
  dingtalk_robot: z
    .object({
      robotName: z.string().trim().min(1).max(100),
      groupId: z.string().trim().min(1).max(200),
      quietWindowMinutes: z.number().int().min(0).max(1_440).default(30),
      severeRiskCodes: z
        .array(z.enum(weeklyReportWarningRuleCodes))
        .max(weeklyReportWarningRuleCodes.length)
        .refine((codes) => new Set(codes).size === codes.length, '严重风险规则不得重复')
        .default([]),
    })
    .strict(),
  ai: aiProviderConfigSchema,
} satisfies Record<IntegrationType, z.ZodType<Record<string, unknown>>>;

const credentialSchemas: Record<IntegrationType, z.ZodType> = {
  gitlab: z.object({ token: z.string().min(8).max(4_096) }).strict(),
  jira: z.object({ token: z.string().min(8).max(4_096) }).strict(),
  dingtalk_log: z
    .object({
      appSecret: z.string().min(8).max(4_096),
      accessToken: z.string().min(8).max(4_096).optional(),
    })
    .strict(),
  dingtalk_robot: z
    .object({ webhook: z.string().url().max(4_096), secret: z.string().min(8).max(4_096) })
    .strict(),
  ai: z.object({ apiKey: z.string().min(8).max(4_096) }).strict(),
};

export interface CreateIntegrationInput {
  type: IntegrationType;
  name: string;
  baseUrl?: string | undefined;
  config: Record<string, unknown>;
  credential?: Record<string, string> | undefined;
}

export interface UpdateIntegrationInput {
  version: number;
  name?: string | undefined;
  baseUrl?: string | undefined;
  config?: Record<string, unknown> | undefined;
  credential?: Record<string, string> | undefined;
}

@Injectable()
export class IntegrationsService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly queue: JobQueueService,
    private readonly probes: IntegrationProbeRegistry,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
  ) {}

  public async list() {
    const rows = await this.prisma.integrationConnection.findMany({
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    return rows.map((row) => this.toPublic(row));
  }

  public async create(input: CreateIntegrationInput, context: RequestAuditContext) {
    const normalized = this.normalize(input.type, input.baseUrl, input.config);
    const credential = input.credential
      ? this.validateCredential(input.type, input.credential)
      : undefined;
    let credentialRef: string | null = null;
    let connectionPersisted = false;
    try {
      if (credential) credentialRef = await this.vault.put(JSON.stringify(credential));
      const connection = await this.prisma.integrationConnection.create({
        data: {
          id: newId(),
          type: input.type,
          name: input.name,
          baseUrl: normalized.baseUrl,
          configJson: JSON.stringify(normalized.config),
          credentialRef: input.type === 'dingtalk_robot' ? null : credentialRef,
          credentialMask:
            credential && input.type !== 'dingtalk_robot'
              ? JSON.stringify(this.maskCredential(credential))
              : null,
          pendingCredentialRef: input.type === 'dingtalk_robot' ? credentialRef : null,
          pendingCredentialMask:
            credential && input.type === 'dingtalk_robot'
              ? JSON.stringify(this.maskCredential(credential))
              : null,
          pendingCredentialCreatedAt:
            credential && input.type === 'dingtalk_robot' ? new Date() : null,
          ...(input.type === 'jira' && credential ? { status: 'testing' } : {}),
        },
      });
      connectionPersisted = true;
      await this.audit.record({
        actorId: this.sessions.currentProfileId,
        action: 'integration.created',
        targetType: 'integration_connection',
        targetId: connection.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: {
          type: connection.type,
          name: connection.name,
          baseUrl: connection.baseUrl,
          hasCredential: Boolean(credentialRef),
          credentialPendingExplicitTest: input.type === 'dingtalk_robot' && Boolean(credentialRef),
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      if (input.type === 'jira' && credentialRef) {
        const testedCredentialFingerprint = requestHash({
          connectionId: connection.id,
          credentialRef,
          configJson: connection.configJson,
        });
        await this.queue.enqueue({
          type: 'integration.test',
          payloadRef: connection.id,
          payloadSummary: {
            integrationType: 'jira',
            integrationId: connection.id,
            requestedBy: this.sessions.currentProfileId,
            correlationId: context.correlationId,
            clientSessionHash: this.security.sessionHash(context.sessionId),
            automatic: true,
          },
          maxAttempts: 2,
          dedupeKey: `integration.test:${connection.id}:${testedCredentialFingerprint}`,
        });
      }
      return this.toPublic(connection);
    } catch (error) {
      if (credentialRef && !connectionPersisted) await this.vault.delete(credentialRef);
      throw error;
    }
  }

  public async update(id: string, input: UpdateIntegrationInput, context: RequestAuditContext) {
    const before = await this.find(id);
    const normalized = this.normalize(
      before.type as IntegrationType,
      input.baseUrl ?? before.baseUrl ?? undefined,
      input.config ?? (JSON.parse(before.configJson) as Record<string, unknown>),
    );
    let newCredentialRef: string | null = null;
    let credentialProbeResult: Awaited<ReturnType<IntegrationProbeRegistry['probe']>> | null = null;
    const credential = input.credential
      ? this.validateCredential(before.type as IntegrationType, input.credential)
      : undefined;
    if (credential) {
      newCredentialRef = await this.vault.put(JSON.stringify(credential));
      // 机器人探测会真实向群内发送固定测试消息，保存时只暂存，必须由用户显式触发测试。
      if (before.type !== 'dingtalk_robot') {
        credentialProbeResult = await this.probes.probe({
          id,
          type: before.type as IntegrationType,
          baseUrl: normalized.baseUrl,
          config: normalized.config,
          credential,
        });
        const credentialUsable =
          credentialProbeResult.healthy ||
          (before.type === 'jira' &&
            credentialProbeResult.status === 'configuration_required' &&
            credentialProbeResult.capabilities.authenticated === true);
        if (!credentialUsable) {
          await this.vault.delete(newCredentialRef);
          throw new DomainError(
            'CREDENTIAL_TEST_FAILED',
            credentialProbeResult.message ?? '新凭证连接测试未通过',
            {
              httpStatus: 422,
              details: {
                code: credentialProbeResult.errorCode,
                status: credentialProbeResult.status,
              },
              suggestedAction: 'reconfigure',
            },
          );
        }
      }
    }
    let persisted = false;
    try {
      const updateData: Prisma.IntegrationConnectionUpdateManyMutationInput = {
        baseUrl: normalized.baseUrl,
        configJson: JSON.stringify(normalized.config),
        version: { increment: 1 },
      };
      if (input.name !== undefined) updateData.name = input.name;
      if (credential && newCredentialRef) {
        if (before.type === 'dingtalk_robot') {
          updateData.pendingCredentialRef = newCredentialRef;
          updateData.pendingCredentialMask = JSON.stringify(this.maskCredential(credential));
          updateData.pendingCredentialCreatedAt = new Date();
        } else {
          updateData.credentialRef = newCredentialRef;
          updateData.credentialMask = JSON.stringify(this.maskCredential(credential));
          const probeResult = credentialProbeResult!;
          updateData.status = probeResult.status;
          updateData.capabilitiesJson = JSON.stringify(probeResult.capabilities);
          updateData.lastTestedAt = new Date();
          if (probeResult.healthy || probeResult.capabilities.authenticated === true) {
            updateData.lastSuccessAt = new Date();
          }
        }
      }
      const updated = await this.prisma.integrationConnection.updateMany({
        where: { id, version: input.version },
        data: updateData,
      });
      if (updated.count !== 1) {
        throw new DomainError(errorCodes.versionConflict, '集成配置版本已变化，请刷新后重试', {
          httpStatus: 409,
          suggestedAction: 'refresh',
        });
      }
      persisted = true;
      if (newCredentialRef && before.type === 'dingtalk_robot') {
        if (before.pendingCredentialRef) await this.vault.delete(before.pendingCredentialRef);
      } else if (newCredentialRef && before.credentialRef) {
        await this.vault.delete(before.credentialRef);
      }
      const after = await this.find(id);
      await this.auditChange('integration.updated', before, after, context);
      return this.toPublic(after);
    } catch (error) {
      if (newCredentialRef && !persisted) await this.vault.delete(newCredentialRef);
      throw error;
    }
  }

  public async test(id: string, context: RequestAuditContext) {
    const connection = await this.find(id);
    if (!connection.enabled)
      throw new DomainError('INTEGRATION_DISABLED', '已禁用连接不能测试', { httpStatus: 409 });
    if (connection.type === 'dingtalk_robot') {
      throw new DomainError(
        'DINGTALK_ROBOT_EXPLICIT_TEST_REQUIRED',
        '钉钉机器人测试必须使用专用端点并显式确认发送固定测试消息',
        { httpStatus: 422 },
      );
    }
    const testedCredentialFingerprint = requestHash({
      connectionId: id,
      credentialRef: connection.credentialRef ?? 'none',
      configJson: connection.configJson,
    });
    await this.prisma.integrationConnection.update({
      where: { id },
      data: {
        status: 'testing',
        lastTestedAt: new Date(),
        version: { increment: 1 },
      },
    });
    const job = await this.queue.enqueue({
      type: 'integration.test',
      payloadRef: id,
      payloadSummary: {
        integrationType: connection.type,
        integrationId: id,
        requestedBy: this.sessions.currentProfileId,
        correlationId: context.correlationId,
        clientSessionHash: this.security.sessionHash(context.sessionId),
      },
      maxAttempts: 2,
      // 同一凭证的排队/执行中测试只允许一个；完成后仍可由用户再次显式发起。
      dedupeKey: `integration.test:${id}:${testedCredentialFingerprint}`,
    });
    await this.auditChange('integration.test_requested', connection, await this.find(id), context);
    return job;
  }

  public async testDingTalkRobot(
    id: string,
    context: RequestAuditContext,
    idempotencyRecordId: string,
  ) {
    const connection = await this.find(id);
    if (!connection.enabled)
      throw new DomainError('INTEGRATION_DISABLED', '已禁用连接不能测试', { httpStatus: 409 });
    if (connection.type !== 'dingtalk_robot') {
      throw new DomainError('DINGTALK_ROBOT_CONNECTION_REQUIRED', '该连接不是钉钉机器人', {
        httpStatus: 422,
      });
    }
    const testedCredentialFingerprint = requestHash({
      connectionId: id,
      credentialRef: connection.pendingCredentialRef ?? connection.credentialRef ?? 'none',
      configJson: connection.configJson,
    });
    const dedupeKey = `integration.test:${id}:${testedCredentialFingerprint}`;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.job.findFirst({
        where: { dedupeKey, status: { in: ['queued', 'running'] } },
        orderBy: { createdAt: 'desc' },
      });
      let job = existing;
      if (!job) {
        const changed = await tx.integrationConnection.updateMany({
          where: { id, version: connection.version, enabled: true },
          data: {
            // 已有生效凭证时保持健康状态，待测试凭证只在固定消息成功后提升。
            ...(connection.pendingCredentialRef ? {} : { status: 'testing' }),
            lastTestedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw new DomainError(errorCodes.versionConflict, '机器人配置版本已变化', {
            httpStatus: 409,
          });
        }
        job = await tx.job.create({
          data: {
            id: newId(),
            type: 'integration.test',
            payloadRef: id,
            payloadSummary: JSON.stringify({
              integrationType: connection.type,
              integrationId: id,
              requestedBy: this.sessions.currentProfileId,
              correlationId: context.correlationId,
              clientSessionHash: this.security.sessionHash(context.sessionId),
            }),
            priority: 100,
            scheduledAt: new Date(),
            maxAttempts: 1,
            dedupeKey,
          },
        });
      }
      const response = {
        operationId: job.id,
        status: job.status,
        statusUrl: `/api/v1/operations/${job.id}`,
      };
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'integration.dingtalk_robot_test_requested',
        targetType: 'integration_connection',
        targetId: id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: { status: connection.status, version: connection.version },
        after: { operationId: job.id, replayedActiveOperation: Boolean(existing) },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      // 作业、连接状态和审计与首次 202 响应同事务落库，网络重试不会再次向群发送消息。
      await tx.idempotencyRecord.update({
        where: { id: idempotencyRecordId },
        data: {
          state: 'completed',
          httpStatus: 202,
          responseJson: JSON.stringify(response),
          errorCode: null,
        },
      });
      return response;
    });
  }

  public async disable(id: string, version: number, context: RequestAuditContext) {
    const before = await this.find(id);
    const result = await this.prisma.integrationConnection.updateMany({
      where: { id, version },
      data: {
        enabled: false,
        status: 'disabled',
        disabledAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (result.count !== 1)
      throw new DomainError(errorCodes.versionConflict, '集成配置版本已变化', { httpStatus: 409 });
    const after = await this.find(id);
    await this.auditChange('integration.disabled', before, after, context);
    return this.toPublic(after);
  }

  public async revokeCredential(id: string, version: number, context: RequestAuditContext) {
    const before = await this.find(id);
    const result = await this.prisma.integrationConnection.updateMany({
      where: { id, version },
      data: {
        credentialRef: null,
        credentialMask: null,
        pendingCredentialRef: null,
        pendingCredentialMask: null,
        pendingCredentialCreatedAt: null,
        status: 'invalid',
        version: { increment: 1 },
      },
    });
    if (result.count !== 1)
      throw new DomainError(errorCodes.versionConflict, '集成配置版本已变化', { httpStatus: 409 });
    if (before.credentialRef) await this.vault.delete(before.credentialRef);
    if (before.pendingCredentialRef) await this.vault.delete(before.pendingCredentialRef);
    const after = await this.find(id);
    await this.auditChange('integration.credential_revoked', before, after, context);
    return this.toPublic(after);
  }

  private async find(id: string) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection)
      throw new DomainError(errorCodes.notFound, '集成连接不存在', { httpStatus: 404 });
    return connection;
  }

  private normalize(
    type: IntegrationType,
    baseUrl: string | undefined,
    config: Record<string, unknown>,
  ) {
    const requiresUrl = type !== 'dingtalk_robot';
    if (requiresUrl && !baseUrl)
      throw new DomainError('INTEGRATION_URL_REQUIRED', '该集成必须配置基础地址', {
        httpStatus: 422,
      });
    const normalizedUrl = baseUrl
      ? normalizeHttpsBaseUrl(baseUrl, {
          allowPrivateNetwork: !['ai', 'dingtalk_log'].includes(type),
          ...(type === 'dingtalk_log' ? { allowedHosts: ['oapi.dingtalk.com'] } : {}),
        }).toString()
      : null;
    if (type === 'dingtalk_log' && normalizedUrl !== 'https://oapi.dingtalk.com/') {
      throw new DomainError(
        'DINGTALK_LOG_BASE_URL_INVALID',
        '钉钉正式日志基础地址必须严格为 https://oapi.dingtalk.com/',
        { httpStatus: 422 },
      );
    }
    return { baseUrl: normalizedUrl, config: configSchemas[type].parse(config) };
  }

  private maskCredential(credential: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(credential).map(([key, value]) => [
        key,
        key.toLowerCase().includes('webhook')
          ? '[已配置]'
          : value.length >= 8
            ? `••••${value.slice(-4)}`
            : '[已配置]',
      ]),
    );
  }

  private validateCredential(
    type: IntegrationType,
    credential: Record<string, string>,
  ): Record<string, string> {
    const parsed = credentialSchemas[type].parse(credential) as Record<string, unknown>;
    if (type === 'dingtalk_robot' && typeof parsed.webhook === 'string') {
      // 保存前即阻断伪造主机、路径或额外查询参数，避免恶意地址进入凭证库。
      validateDingTalkRobotWebhook(parsed.webhook);
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  private toPublic(connection: Awaited<ReturnType<IntegrationsService['find']>>) {
    return {
      id: connection.id,
      type: connection.type,
      name: connection.name,
      baseUrl: connection.baseUrl,
      credentialMask: connection.credentialMask
        ? (JSON.parse(connection.credentialMask) as unknown)
        : null,
      enabled: connection.enabled,
      status: connection.status,
      capabilities: JSON.parse(connection.capabilitiesJson) as unknown,
      config: JSON.parse(connection.configJson) as unknown,
      lastTestedAt: connection.lastTestedAt?.toISOString() ?? null,
      lastSuccessAt: connection.lastSuccessAt?.toISOString() ?? null,
      credentialReplacementPending: Boolean(connection.pendingCredentialRef),
      pendingCredentialCreatedAt: connection.pendingCredentialCreatedAt?.toISOString() ?? null,
      version: connection.version,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }

  private async auditChange(
    action: string,
    before: Awaited<ReturnType<IntegrationsService['find']>>,
    after: Awaited<ReturnType<IntegrationsService['find']>>,
    context: RequestAuditContext,
  ): Promise<void> {
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action,
      targetType: 'integration_connection',
      targetId: after.id,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      before: {
        type: before.type,
        name: before.name,
        baseUrl: before.baseUrl,
        enabled: before.enabled,
        status: before.status,
        version: before.version,
        hasCredential: Boolean(before.credentialRef),
      },
      after: {
        type: after.type,
        name: after.name,
        baseUrl: after.baseUrl,
        enabled: after.enabled,
        status: after.status,
        version: after.version,
        hasCredential: Boolean(after.credentialRef),
      },
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
  }
}
