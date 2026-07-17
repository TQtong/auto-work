import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { HttpSecurityModule } from './infrastructure/http/http-security.module.js';
import { VaultModule } from './infrastructure/vault/vault.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { IdempotencyModule } from './modules/idempotency/idempotency.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { BackupModule } from './modules/backup/backup.module.js';
import { SessionModule } from './modules/session/session.module.js';
import { GitModule } from './infrastructure/git/git.module.js';
import { RepositoriesModule } from './modules/repositories/repositories.module.js';
import { GitLabModule } from './modules/gitlab/gitlab.module.js';
import { GitBatchesModule } from './modules/git-batches/git-batches.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: false }),
    AppConfigModule,
    DatabaseModule,
    HttpSecurityModule,
    VaultModule,
    GitModule,
    ScheduleModule.forRoot(),
    SessionModule,
    AuditModule,
    IdempotencyModule,
    JobsModule,
    SettingsModule,
    IntegrationsModule,
    GitLabModule,
    GitBatchesModule,
    BackupModule,
    RepositoriesModule,
    HealthModule,
  ],
})
export class AppModule {}
