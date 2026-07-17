import { Injectable } from '@nestjs/common';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

export interface AuditInput {
  actorType?: 'local_user' | 'scheduler' | 'system';
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  approvalId?: string;
  outcome: 'succeeded' | 'failed' | 'rejected' | 'unknown';
  before?: unknown;
  after?: unknown;
  clientSessionHash: string;
  errorCode?: string;
}

@Injectable()
export class AuditService {
  public constructor(private readonly prisma: PrismaService) {}

  /** 审计只保存非敏感摘要哈希；调用方不得把原始 Token、正文或外部响应传入。 */
  public async record(input: AuditInput): Promise<string> {
    const eventId = newId();
    await this.prisma.auditEvent.create({
      data: {
        eventId,
        actorType: input.actorType ?? 'local_user',
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        correlationId: input.correlationId,
        approvalId: input.approvalId ?? null,
        outcome: input.outcome,
        beforeSummaryHash: input.before === undefined ? null : requestHash(input.before),
        afterSummaryHash: input.after === undefined ? null : requestHash(input.after),
        clientSessionHash: input.clientSessionHash,
        errorCode: input.errorCode ?? null,
      },
    });
    return eventId;
  }
}
