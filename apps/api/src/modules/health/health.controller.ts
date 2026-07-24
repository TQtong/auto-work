import { Controller, Get, Inject, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { InstanceLeaseService } from '../jobs/instance-lease.service.js';
import { GitHealthService } from '../../infrastructure/git/git-health.service.js';

@Controller('health')
export class HealthController {
  public constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly instanceLease: InstanceLeaseService,
    private readonly gitHealth: GitHealthService,
  ) {}

  @Get()
  public async health(@Req() request: FastifyRequest) {
    const database = await this.prisma.readiness();
    return apiResponse(
      {
        status: database.ready ? 'ready' : 'degraded',
        liveness: 'ok',
        readiness: {
          database,
          scheduler: {
            ready: this.instanceLease.isHeld,
            persistence: 'sqlite',
            leaseOwner: this.instanceLease.currentOwnerId,
          },
          gitWorker: {
            ready: this.gitHealth.ready,
            version: this.gitHealth.version,
            reason: this.gitHealth.reason,
          },
        },
        binding: {
          host: this.config.host,
          port: this.config.port,
          // 容器内监听所有接口，但 Compose 仍只向宿主机回环地址发布端口。
          loopbackOnly: this.config.host !== '0.0.0.0',
        },
        environment: this.config.environment,
      },
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }
}
