import { Controller, Get, Inject, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { InstanceLeaseService } from '../jobs/instance-lease.service.js';

@Controller('health')
export class HealthController {
  public constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly instanceLease: InstanceLeaseService,
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
          gitWorker: { ready: false, reason: '尚未完成首次健康握手' },
        },
        binding: { host: this.config.host, port: this.config.port, loopbackOnly: true },
        environment: this.config.environment,
      },
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }
}
