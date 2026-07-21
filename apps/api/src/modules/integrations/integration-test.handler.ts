import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { IntegrationConnection, Prisma } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { JobExecutionContext, JobHandler } from '../jobs/job-registry.service.js';
import { JobRegistryService } from '../jobs/job-registry.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { IntegrationProbeRegistry, type IntegrationType } from './integration-probe.registry.js';

interface TestAuditContext {
  actorType: 'local_user' | 'system';
  actorId: string;
  correlationId: string;
  clientSessionHash: string;
}

@Injectable()
export class IntegrationTestHandler implements JobHandler, OnModuleInit {
  public readonly type = 'integration.test';
  public readonly concurrency = 2;
  // 机器人探测包含真实群消息副作用，进程崩溃后的结果未知，整个测试作业统一进入人工复核而不自动重放。
  public readonly recovery = 'manual_review' as const;

  public constructor(
    private readonly jobs: JobRegistryService,
    private readonly prisma: PrismaService,
    private readonly probes: IntegrationProbeRegistry,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
    private readonly audit: AuditService,
    private readonly queue: JobQueueService,
  ) {}

  public onModuleInit(): void {
    this.jobs.register(this);
  }

  public async execute(context: JobExecutionContext): Promise<unknown> {
    if (!context.payloadRef) throw new DomainError('INTEGRATION_ID_MISSING', '测试作业缺少连接 ID');
    const connection = await this.prisma.integrationConnection.findUnique({
      where: { id: context.payloadRef },
    });
    if (!connection)
      throw new DomainError('INTEGRATION_NOT_FOUND', '待测试连接不存在', { httpStatus: 404 });
    const auditContext = await this.testAuditContext(context.jobId);
    await context.reportProgress(10);
    const testsPendingRobotCredential =
      connection.type === 'dingtalk_robot' && Boolean(connection.pendingCredentialRef);
    const testedCredentialRef = testsPendingRobotCredential
      ? connection.pendingCredentialRef
      : connection.credentialRef;
    const credential = testedCredentialRef
      ? (JSON.parse(await this.vault.get(testedCredentialRef)) as Record<string, string>)
      : null;
    const result = await this.probes.probe({
      id: connection.id,
      type: connection.type as IntegrationType,
      baseUrl: connection.baseUrl,
      config: JSON.parse(connection.configJson) as Record<string, unknown>,
      credential,
    });
    await context.reportProgress(90);
    if (testsPendingRobotCredential && connection.pendingCredentialRef) {
      return this.finishPendingRobotTest(connection, result, auditContext);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.integrationConnection.update({
        where: { id: connection.id },
        data: {
          status: result.status,
          capabilitiesJson: JSON.stringify(result.capabilities),
          lastTestedAt: new Date(),
          lastSuccessAt: result.healthy ? new Date() : connection.lastSuccessAt,
          version: { increment: 1 },
        },
      });
      await this.recordResultAudit(tx, connection, result, auditContext);
    });
    if (connection.type === 'jira' && result.healthy) {
      await this.enqueueInitialJiraSync(connection.id, result.capabilities);
    }
    return result;
  }

  private async finishPendingRobotTest(
    connection: IntegrationConnection,
    result: Awaited<ReturnType<IntegrationProbeRegistry['probe']>>,
    auditContext: TestAuditContext,
  ): Promise<unknown> {
    const testedAt = new Date();
    if (result.healthy) {
      const response = { ...result, credentialPromoted: true };
      await this.prisma.$transaction(async (tx) => {
        // 只有固定测试消息被钉钉确认接收后，才原子提升新凭证、清空待测试槽位并记录结果审计。
        const promoted = await tx.integrationConnection.updateMany({
          where: {
            id: connection.id,
            version: connection.version,
            pendingCredentialRef: connection.pendingCredentialRef,
          },
          data: {
            credentialRef: connection.pendingCredentialRef,
            credentialMask: connection.pendingCredentialMask,
            pendingCredentialRef: null,
            pendingCredentialMask: null,
            pendingCredentialCreatedAt: null,
            status: result.status,
            capabilitiesJson: JSON.stringify(result.capabilities),
            lastTestedAt: testedAt,
            lastSuccessAt: testedAt,
            version: { increment: 1 },
          },
        });
        if (promoted.count !== 1) {
          throw new DomainError(
            'INTEGRATION_VERSION_CONFLICT',
            '机器人配置在测试期间已变化，未替换当前凭证',
            { httpStatus: 409, retryable: false },
          );
        }
        await this.recordResultAudit(tx, connection, response, auditContext);
      });
      if (
        connection.credentialRef &&
        connection.credentialRef !== connection.pendingCredentialRef
      ) {
        // 数据库已经安全指向新凭证；旧凭证清理失败不应让作业重放并再次向群内发测试消息。
        await this.vault.delete(connection.credentialRef).catch(() => undefined);
      }
      return response;
    }

    const currentCapabilities = JSON.parse(connection.capabilitiesJson) as Record<string, unknown>;
    const hasActiveCredential = Boolean(connection.credentialRef);
    const response = {
      ...result,
      credentialPromoted: false,
      activeCredentialPreserved: hasActiveCredential,
    };
    await this.prisma.$transaction(async (tx) => {
      const failed = await tx.integrationConnection.updateMany({
        where: {
          id: connection.id,
          version: connection.version,
          pendingCredentialRef: connection.pendingCredentialRef,
        },
        data: {
          // 已有可用凭证时保持其状态和能力，只附加不含敏感信息的待测试结果。
          status: hasActiveCredential ? connection.status : result.status,
          capabilitiesJson: JSON.stringify(
            hasActiveCredential
              ? {
                  ...currentCapabilities,
                  pendingCredentialTest: {
                    healthy: false,
                    status: result.status,
                    errorCode: result.errorCode ?? null,
                    message: result.message ?? null,
                    testedAt: testedAt.toISOString(),
                  },
                }
              : result.capabilities,
          ),
          lastTestedAt: testedAt,
          version: { increment: 1 },
        },
      });
      if (failed.count !== 1) {
        throw new DomainError(
          'INTEGRATION_VERSION_CONFLICT',
          '机器人配置在测试期间已变化，测试结果未覆盖新配置',
          { httpStatus: 409, retryable: false },
        );
      }
      await this.recordResultAudit(tx, connection, response, auditContext);
    });
    return response;
  }

  private async testAuditContext(jobId: string): Promise<TestAuditContext> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { payloadSummary: true },
    });
    let summary: Record<string, unknown> = {};
    try {
      summary = job ? (JSON.parse(job.payloadSummary) as Record<string, unknown>) : {};
    } catch {
      // 旧作业摘要损坏时仍保留系统审计，不让解析异常掩盖真实测试结果。
    }
    const requestedBy = typeof summary.requestedBy === 'string' ? summary.requestedBy : null;
    return {
      actorType: requestedBy ? 'local_user' : 'system',
      actorId: requestedBy ?? 'system',
      correlationId:
        typeof summary.correlationId === 'string' ? summary.correlationId : `job:${jobId}`,
      clientSessionHash:
        typeof summary.clientSessionHash === 'string'
          ? summary.clientSessionHash
          : requestHash({ actor: 'system', jobId }),
    };
  }

  private async recordResultAudit(
    tx: Prisma.TransactionClient,
    connection: IntegrationConnection,
    result: Awaited<ReturnType<IntegrationProbeRegistry['probe']>> & {
      credentialPromoted?: boolean;
      activeCredentialPreserved?: boolean;
    },
    context: TestAuditContext,
  ): Promise<void> {
    await this.audit.recordInTransaction(tx, {
      actorType: context.actorType,
      actorId: context.actorId,
      action: 'integration.test_completed',
      targetType: 'integration_connection',
      targetId: connection.id,
      correlationId: context.correlationId,
      outcome: result.healthy ? 'succeeded' : 'failed',
      before: { status: connection.status, version: connection.version },
      after: {
        integrationType: connection.type,
        healthy: result.healthy,
        status: result.status,
        credentialPromoted: result.credentialPromoted ?? false,
        activeCredentialPreserved: result.activeCredentialPreserved ?? false,
      },
      clientSessionHash: context.clientSessionHash,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
  }

  private async enqueueInitialJiraSync(
    connectionId: string,
    capabilities: Record<string, unknown>,
  ): Promise<void> {
    const active = await this.prisma.job.findFirst({
      where: {
        dedupeKey: `jira.sync:${connectionId}:full`,
        status: { in: ['queued', 'running'] },
      },
      select: { id: true },
    });
    if (active) return;
    const configuredId = capabilities.automaticReadConfigVersionId;
    const mapping =
      typeof configuredId === 'string'
        ? await this.prisma.fieldMappingVersion.findFirst({
            where: { id: configuredId, connectionId },
          })
        : await this.prisma.fieldMappingVersion.findFirst({
            where: { connectionId },
            orderBy: { versionNo: 'desc' },
          });
    if (!mapping) {
      throw new DomainError('JIRA_READ_CONFIG_REQUIRED', 'Jira 自动读取配置不存在', {
        httpStatus: 409,
      });
    }
    const request = { scope: 'full' as const };
    const run = await this.prisma.jiraSyncRun.create({
      data: {
        id: newId(),
        connectionId,
        scope: request.scope,
        trigger: 'automatic_after_connection',
        status: 'queued',
        mappingVersionId: mapping.id,
        queryHash: requestHash(request),
        requestJson: JSON.stringify(request),
        startedAt: new Date(),
      },
    });
    await this.queue.enqueue({
      type: 'jira.sync',
      payloadRef: run.id,
      payloadSummary: { connectionId, scope: request.scope, runId: run.id },
      priority: 35,
      maxAttempts: 3,
      dedupeKey: `jira.sync:${connectionId}:full`,
    });
  }
}
