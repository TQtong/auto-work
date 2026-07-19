import { Controller, Get, Query, Req } from '@nestjs/common';
import { apiResponse, cursorQuerySchema } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

const auditQuerySchema = cursorQuerySchema.extend({
  action: z.string().min(1).max(100).optional(),
  targetType: z.string().min(1).max(100).optional(),
  outcome: z.enum(['succeeded', 'failed', 'rejected', 'unknown']).optional(),
});

@Controller('audit-events')
export class AuditController {
  public constructor(private readonly prisma: PrismaService) {}

  @Get()
  public async list(@Query() rawQuery: unknown, @Req() request: FastifyRequest) {
    const query = auditQuerySchema.parse(rawQuery);
    const where: Prisma.AuditEventWhereInput = {};
    if (query.action) where.action = query.action;
    if (query.targetType) where.targetType = query.targetType;
    if (query.outcome) where.outcome = query.outcome;
    const rows = await this.prisma.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { eventId: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const data = rows.slice(0, query.limit);
    return {
      ...apiResponse(data, request.autoWork.correlationId, { asOf: new Date().toISOString() }),
      page: {
        cursor: query.cursor,
        nextCursor: hasMore ? data.at(-1)?.eventId : undefined,
        hasMore,
        limit: query.limit,
      },
    };
  }
}
