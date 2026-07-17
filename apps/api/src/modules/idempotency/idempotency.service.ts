import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

export interface IdempotencyScope {
  actorId: string;
  route: string;
  key: string;
  requestHash: string;
}

export type IdempotencyStart =
  | { kind: 'started'; recordId: string }
  | { kind: 'replay'; recordId: string; httpStatus: number; response: unknown }
  | { kind: 'processing'; recordId: string };

@Injectable()
export class IdempotencyService {
  public constructor(private readonly prisma: PrismaService) {}

  public async start(scope: IdempotencyScope): Promise<IdempotencyStart> {
    try {
      const record = await this.prisma.idempotencyRecord.create({
        data: {
          id: newId(),
          actorId: scope.actorId,
          route: scope.route,
          idempotencyKey: scope.key,
          requestHash: scope.requestHash,
        },
      });
      return { kind: 'started', recordId: record.id };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
    }

    const existing = await this.prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        actorId_route_idempotencyKey: {
          actorId: scope.actorId,
          route: scope.route,
          idempotencyKey: scope.key,
        },
      },
    });
    if (existing.requestHash !== scope.requestHash) {
      throw new DomainError(errorCodes.idempotencyConflict, '同一幂等键不能用于不同请求内容', {
        httpStatus: 409,
        retryable: false,
      });
    }
    if (existing.state === 'completed' && existing.responseJson && existing.httpStatus) {
      return {
        kind: 'replay',
        recordId: existing.id,
        httpStatus: existing.httpStatus,
        response: JSON.parse(existing.responseJson) as unknown,
      };
    }
    return { kind: 'processing', recordId: existing.id };
  }

  public async complete(recordId: string, httpStatus: number, response: unknown): Promise<void> {
    await this.prisma.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        state: 'completed',
        httpStatus,
        responseJson: JSON.stringify(response),
        errorCode: null,
      },
    });
  }

  public async fail(recordId: string, errorCode: string): Promise<void> {
    await this.prisma.idempotencyRecord.update({
      where: { id: recordId },
      data: { state: 'failed', errorCode },
    });
  }
}
