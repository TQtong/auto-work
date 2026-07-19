import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  JobRegistryService,
  type JobExecutionContext,
  type JobHandler,
} from '../jobs/job-registry.service.js';
import { JiraSyncService } from './jira-sync.service.js';

@Injectable()
export class JiraSyncHandler implements JobHandler, OnModuleInit {
  public readonly type = 'jira.sync';
  public readonly concurrency = 1;
  public readonly recovery = 'safe_replay' as const;

  public constructor(
    private readonly registry: JobRegistryService,
    private readonly prisma: PrismaService,
    private readonly syncService: JiraSyncService,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
  ) {}

  public onModuleInit(): void {
    this.registry.register(this);
  }

  public async execute(context: JobExecutionContext) {
    if (!context.payloadRef)
      throw new DomainError('JIRA_SYNC_RUN_ID_MISSING', '同步作业缺少 Jira 运行 ID');
    const run = await this.prisma.jiraSyncRun.findUnique({ where: { id: context.payloadRef } });
    if (!run)
      throw new DomainError('JIRA_SYNC_RUN_NOT_FOUND', 'Jira 同步运行不存在', {
        httpStatus: 404,
      });
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: run.connectionId, type: 'jira' },
    });
    if (!connection)
      throw new DomainError('JIRA_CONNECTION_NOT_FOUND', 'Jira 连接不存在', { httpStatus: 404 });
    if (!connection.credentialRef)
      throw new DomainError('JIRA_CREDENTIAL_REQUIRED', 'Jira 连接没有本机凭证', {
        httpStatus: 422,
      });
    const credential = JSON.parse(await this.vault.get(connection.credentialRef)) as Record<
      string,
      string
    >;
    if (!credential.token)
      throw new DomainError('JIRA_CREDENTIAL_INVALID', 'Jira Token 配置缺失', {
        httpStatus: 422,
      });
    return this.syncService.sync({
      run,
      connection,
      token: credential.token,
      reportProgress: context.reportProgress,
    });
  }
}
