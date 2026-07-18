import { Injectable } from '@nestjs/common';
import { Prisma, type RobotNotification } from '@prisma/client';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { WeeklyReportRobotNotificationType } from './weekly-report-robot-notification.js';

export interface ReserveRobotNotificationInput {
  reportId: string;
  connectionId: string;
  deliveryIntentId?: string | null;
  notificationType: WeeklyReportRobotNotificationType;
  businessObjectKey: string;
  stateVersion: number;
  contentHash: string;
  quietWindowMinutes: number;
  scheduledFor: Date;
  jobId?: string | null;
  now?: Date;
}

export type RobotNotificationReservation = {
  notification: RobotNotification;
  disposition: 'created' | 'duplicate' | 'coalesced';
};

@Injectable()
export class WeeklyReportNotificationLedgerService {
  public constructor(private readonly prisma: PrismaService) {}

  public reserve(input: ReserveRobotNotificationInput): Promise<RobotNotificationReservation> {
    return this.prisma.$transaction((tx) => this.reserveInTransaction(tx, input));
  }

  public async reserveInTransaction(
    tx: Prisma.TransactionClient,
    input: ReserveRobotNotificationInput,
  ): Promise<RobotNotificationReservation> {
    const now = input.now ?? new Date();
    const dedupeKey = requestHash({
      businessObjectKey: input.businessObjectKey,
      notificationType: input.notificationType,
      stateVersion: input.stateVersion,
    });
    const duplicate = await tx.robotNotification.findUnique({ where: { dedupeKey } });
    if (duplicate) return { notification: duplicate, disposition: 'duplicate' };

    // 状态版本不同但正文完全相同的提醒在静默窗口内并入首条，不产生第二次外部调用。
    if (input.quietWindowMinutes > 0) {
      const quietMatch = await tx.robotNotification.findFirst({
        where: {
          businessObjectKey: input.businessObjectKey,
          notificationType: input.notificationType,
          contentHash: input.contentHash,
          quietWindowEndsAt: { gt: now },
          status: { notIn: ['skipped', 'cancelled'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (quietMatch) {
        const notification = await tx.robotNotification.update({
          where: { id: quietMatch.id },
          data: { coalescedCount: { increment: 1 }, version: { increment: 1 } },
        });
        return { notification, disposition: 'coalesced' };
      }
    }

    const quietWindowEndsAt = new Date(now.getTime() + input.quietWindowMinutes * 60_000);
    try {
      const notification = await tx.robotNotification.create({
        data: {
          id: newId(),
          reportId: input.reportId,
          connectionId: input.connectionId,
          deliveryIntentId: input.deliveryIntentId ?? null,
          notificationType: input.notificationType,
          businessObjectKey: input.businessObjectKey,
          stateVersion: input.stateVersion,
          dedupeKey,
          contentHash: input.contentHash,
          status: input.jobId ? 'queued' : 'pending',
          quietWindowStartedAt: now,
          quietWindowEndsAt,
          scheduledFor: input.scheduledFor,
          jobId: input.jobId ?? null,
        },
      });
      return { notification, disposition: 'created' };
    } catch (error) {
      // 并发重复状态版本由数据库唯一键收敛，调用方得到同一账本事实。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const notification = await tx.robotNotification.findUnique({ where: { dedupeKey } });
        if (notification) return { notification, disposition: 'duplicate' };
      }
      throw error;
    }
  }
}
