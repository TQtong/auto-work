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
import { GitLabSyncService } from './gitlab-sync.service.js';

@Injectable()
export class GitLabSyncHandler implements JobHandler, OnModuleInit {
  public readonly type = 'gitlab.sync';
  public readonly concurrency = 1;
  public readonly recovery = 'safe_replay' as const;

  public constructor(
    private readonly registry: JobRegistryService,
    private readonly prisma: PrismaService,
    private readonly syncService: GitLabSyncService,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
  ) {}

  public onModuleInit(): void {
    this.registry.register(this);
  }

  public async execute(context: JobExecutionContext) {
    if (!context.payloadRef)
      throw new DomainError('GITLAB_CONNECTION_ID_MISSING', '同步作业缺少 GitLab 连接 ID');
    const connection = await this.prisma.integrationConnection.findUnique({
      where: { id: context.payloadRef },
    });
    if (!connection || connection.type !== 'gitlab')
      throw new DomainError('GITLAB_CONNECTION_NOT_FOUND', 'GitLab 连接不存在', {
        httpStatus: 404,
      });
    if (!connection.credentialRef)
      throw new DomainError('GITLAB_CREDENTIAL_REQUIRED', 'GitLab 连接没有本机凭证', {
        httpStatus: 422,
      });
    const credential = JSON.parse(await this.vault.get(connection.credentialRef)) as Record<
      string,
      string
    >;
    if (!credential.token)
      throw new DomainError('GITLAB_CREDENTIAL_INVALID', 'GitLab Token 配置缺失', {
        httpStatus: 422,
      });
    return this.syncService.sync(connection, credential.token, context.reportProgress);
  }
}
