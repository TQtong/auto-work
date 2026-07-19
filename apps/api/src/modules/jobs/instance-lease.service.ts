import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

const LEASE_NAME = 'control-service';
const LEASE_MILLISECONDS = 30_000;

@Injectable()
export class InstanceLeaseService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InstanceLeaseService.name);
  private readonly ownerId = newId();
  private held = false;

  public constructor(private readonly prisma: PrismaService) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.acquire();
  }

  public async onApplicationShutdown(): Promise<void> {
    if (!this.held) return;
    await this.prisma.instanceLease.deleteMany({
      where: { name: LEASE_NAME, ownerId: this.ownerId },
    });
    this.held = false;
  }

  public get isHeld(): boolean {
    return this.held;
  }

  public get currentOwnerId(): string {
    return this.ownerId;
  }

  @Interval(10_000)
  public async renew(): Promise<void> {
    if (!this.held) return;
    const now = new Date();
    const result = await this.prisma.instanceLease.updateMany({
      where: { name: LEASE_NAME, ownerId: this.ownerId },
      data: { renewedAt: now, expiresAt: new Date(now.getTime() + LEASE_MILLISECONDS) },
    });
    if (result.count === 0) {
      this.held = false;
      this.logger.error('实例租约已丢失，调度器将停止领取新作业');
    }
  }

  private async acquire(): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LEASE_MILLISECONDS);
    const reclaimed = await this.prisma.instanceLease.updateMany({
      where: { name: LEASE_NAME, expiresAt: { lt: now } },
      data: { ownerId: this.ownerId, acquiredAt: now, renewedAt: now, expiresAt },
    });
    if (reclaimed.count === 1) {
      this.held = true;
      return;
    }
    try {
      await this.prisma.instanceLease.create({
        data: {
          name: LEASE_NAME,
          ownerId: this.ownerId,
          acquiredAt: now,
          renewedAt: now,
          expiresAt,
        },
      });
      this.held = true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new Error('已有 Auto Work 实例持有数据库租约，请关闭重复进程后重试');
      }
      throw error;
    }
  }
}
