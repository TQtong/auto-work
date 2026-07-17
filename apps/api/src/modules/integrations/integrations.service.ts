import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, normalizeHttpsBaseUrl } from '@auto-work/domain';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { SessionService } from '../session/session.service.js';
import type { RequestAuditContext } from '../settings/profile.service.js';
import { IntegrationProbeRegistry, type IntegrationType } from './integration-probe.registry.js';

const configSchemas = {
  gitlab: z
    .object({ projectIds: z.array(z.number().int().positive()).max(100).default([]) })
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
      templateName: z.string().trim().min(1).max(200).default('uTwin产研创新部周报'),
    })
    .strict(),
  dingtalk_robot: z
    .object({
      robotName: z.string().trim().min(1).max(100),
      groupId: z.string().trim().min(1).max(200),
      quietWindowMinutes: z.number().int().min(0).max(1_440).default(30),
    })
    .strict(),
  ai: z
    .object({
      protocol: z.enum(['openai_compatible', 'anthropic', 'gemini']),
      model: z.string().trim().min(1).max(200),
      metadataOnly: z.literal(true).default(true),
      timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
      maxInputTokens: z.number().int().min(256).max(1_000_000).default(32_000),
      maxOutputTokens: z.number().int().min(128).max(100_000).default(4_096),
      allowedPurposes: z
        .array(
          z.enum(['weekly_report', 'evidence_suggestion', 'quarterly_review', 'score_suggestion']),
        )
        .min(1),
    })
    .strict(),
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
    try {
      if (credential) credentialRef = await this.vault.put(JSON.stringify(credential));
      const connection = await this.prisma.integrationConnection.create({
        data: {
          id: newId(),
          type: input.type,
          name: input.name,
          baseUrl: normalized.baseUrl,
          configJson: JSON.stringify(normalized.config),
          credentialRef,
          credentialMask: credential ? JSON.stringify(this.maskCredential(credential)) : null,
        },
      });
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
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return this.toPublic(connection);
    } catch (error) {
      if (credentialRef) await this.vault.delete(credentialRef);
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
    const credential = input.credential
      ? this.validateCredential(before.type as IntegrationType, input.credential)
      : undefined;
    if (credential) {
      newCredentialRef = await this.vault.put(JSON.stringify(credential));
      const testResult = await this.probes.probe({
        id,
        type: before.type as IntegrationType,
        baseUrl: normalized.baseUrl,
        config: normalized.config,
        credential,
      });
      if (!testResult.healthy) {
        await this.vault.delete(newCredentialRef);
        throw new DomainError(
          'CREDENTIAL_TEST_FAILED',
          testResult.message ?? '新凭证连接测试未通过',
          {
            httpStatus: 422,
            details: { code: testResult.errorCode, status: testResult.status },
            suggestedAction: 'reconfigure',
          },
        );
      }
    }
    try {
      const updateData: Prisma.IntegrationConnectionUpdateManyMutationInput = {
        baseUrl: normalized.baseUrl,
        configJson: JSON.stringify(normalized.config),
        version: { increment: 1 },
      };
      if (input.name !== undefined) updateData.name = input.name;
      if (credential && newCredentialRef) {
        updateData.credentialRef = newCredentialRef;
        updateData.credentialMask = JSON.stringify(this.maskCredential(credential));
        updateData.status = 'healthy';
        updateData.lastTestedAt = new Date();
        updateData.lastSuccessAt = new Date();
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
      if (newCredentialRef && before.credentialRef) await this.vault.delete(before.credentialRef);
      const after = await this.find(id);
      await this.auditChange('integration.updated', before, after, context);
      return this.toPublic(after);
    } catch (error) {
      if (newCredentialRef) await this.vault.delete(newCredentialRef);
      throw error;
    }
  }

  public async test(id: string) {
    const connection = await this.find(id);
    if (!connection.enabled)
      throw new DomainError('INTEGRATION_DISABLED', '已禁用连接不能测试', { httpStatus: 409 });
    await this.prisma.integrationConnection.update({
      where: { id },
      data: { status: 'testing', lastTestedAt: new Date(), version: { increment: 1 } },
    });
    return this.queue.enqueue({
      type: 'integration.test',
      payloadRef: id,
      payloadSummary: { integrationType: connection.type, integrationId: id },
      maxAttempts: 2,
      dedupeKey: `integration.test:${id}:${connection.version}`,
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
        status: 'invalid',
        version: { increment: 1 },
      },
    });
    if (result.count !== 1)
      throw new DomainError(errorCodes.versionConflict, '集成配置版本已变化', { httpStatus: 409 });
    if (before.credentialRef) await this.vault.delete(before.credentialRef);
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
      ? normalizeHttpsBaseUrl(baseUrl, { allowPrivateNetwork: type !== 'ai' }).toString()
      : null;
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
