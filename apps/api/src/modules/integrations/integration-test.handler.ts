import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { IntegrationConnection } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { JobExecutionContext, JobHandler } from '../jobs/job-registry.service.js';
import { JobRegistryService } from '../jobs/job-registry.service.js';
import { IntegrationProbeRegistry, type IntegrationType } from './integration-probe.registry.js';

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
      return this.finishPendingRobotTest(connection, result);
    }
    await this.prisma.integrationConnection.update({
      where: { id: connection.id },
      data: {
        status: result.status,
        capabilitiesJson: JSON.stringify(result.capabilities),
        lastTestedAt: new Date(),
        lastSuccessAt: result.healthy ? new Date() : connection.lastSuccessAt,
        version: { increment: 1 },
      },
    });
    return result;
  }

  private async finishPendingRobotTest(
    connection: IntegrationConnection,
    result: Awaited<ReturnType<IntegrationProbeRegistry['probe']>>,
  ): Promise<unknown> {
    const testedAt = new Date();
    if (result.healthy) {
      // 只有固定测试消息被钉钉确认接收后，才在同一条数据库更新中提升新凭证并清空待测试槽位。
      const promoted = await this.prisma.integrationConnection.updateMany({
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
      if (
        connection.credentialRef &&
        connection.credentialRef !== connection.pendingCredentialRef
      ) {
        // 数据库已经安全指向新凭证；旧凭证清理失败不应让作业重放并再次向群内发测试消息。
        await this.vault.delete(connection.credentialRef).catch(() => undefined);
      }
      return { ...result, credentialPromoted: true };
    }

    const currentCapabilities = JSON.parse(connection.capabilitiesJson) as Record<string, unknown>;
    const hasActiveCredential = Boolean(connection.credentialRef);
    const failed = await this.prisma.integrationConnection.updateMany({
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
    return { ...result, credentialPromoted: false, activeCredentialPreserved: hasActiveCredential };
  }
}
