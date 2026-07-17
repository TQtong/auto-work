import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
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
  public readonly recovery = 'safe_replay' as const;

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
    const credential = connection.credentialRef
      ? (JSON.parse(await this.vault.get(connection.credentialRef)) as Record<string, string>)
      : null;
    const result = await this.probes.probe({
      id: connection.id,
      type: connection.type as IntegrationType,
      baseUrl: connection.baseUrl,
      config: JSON.parse(connection.configJson) as Record<string, unknown>,
      credential,
    });
    await context.reportProgress(90);
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
}
