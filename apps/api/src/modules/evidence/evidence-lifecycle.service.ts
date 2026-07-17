import { Injectable } from '@nestjs/common';
import type { EvidenceLink, Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { evidenceRuleVersion, newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  ConfirmEvidenceLinkInput,
  CreateManualEvidenceLinkInput,
  RejectEvidenceLinkInput,
  RevokeEvidenceDecisionInput,
} from './evidence.schemas.js';

interface MutationContext {
  actorId: string;
  correlationId: string;
  clientSessionHash: string;
  idempotencyRecordId: string;
}

interface EvidenceCatalogQuery {
  sourceType?: string;
  availability?: string;
  projectId?: string;
  cursor?: string;
  limit: number;
}

@Injectable()
export class EvidenceLifecycleService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  public async listTaskEvidence(taskId: string, status?: string) {
    await this.expireDueLinks();
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
    if (!task) throw new DomainError(errorCodes.notFound, '任务不存在', { httpStatus: 404 });
    const links = await this.prisma.evidenceLink.findMany({
      where: { taskId, ...(status ? { status } : {}) },
      include: {
        evidence: {
          include: {
            project: { select: { id: true, name: true } },
            gitlabProject: { select: { id: true, pathWithNamespace: true, webUrl: true } },
          },
        },
        events: { orderBy: { sequence: 'desc' }, take: 100 },
      },
      orderBy: [{ status: 'asc' }, { confidence: 'desc' }, { updatedAt: 'desc' }],
    });
    const counts = { suggested: 0, confirmed: 0, rejected: 0, expired: 0 };
    for (const link of links) counts[link.status as keyof typeof counts] += 1;
    return { taskId, counts, items: links.map((link) => this.serializeLink(link)) };
  }

  public async listEvidence(query: EvidenceCatalogQuery) {
    const offset = this.decodeCursor(query.cursor);
    const where: Prisma.EvidenceWhereInput = {
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.availability ? { availabilityState: query.availability } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.evidence.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } },
          gitlabProject: { select: { id: true, pathWithNamespace: true, webUrl: true } },
          _count: { select: { links: true } },
        },
        orderBy: [{ eventAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: query.limit,
      }),
      this.prisma.evidence.count({ where }),
    ]);
    const nextOffset = offset + items.length;
    return {
      items: items.map((item) => ({
        id: item.id,
        sourceType: item.sourceType,
        sourceExternalKey: item.sourceExternalKey,
        project: item.project,
        gitlabProject: item.gitlabProject,
        eventAt: item.eventAt?.toISOString() ?? null,
        title: item.title,
        url: item.url,
        contentHash: item.contentHash,
        availabilityState: item.availabilityState,
        sourceSyncedAt: item.sourceSyncedAt?.toISOString() ?? null,
        linkCount: item._count.links,
        version: item.version,
      })),
      total,
      page: {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(nextOffset < total ? { nextCursor: this.encodeCursor(nextOffset) } : {}),
        hasMore: nextOffset < total,
        limit: query.limit,
      },
    };
  }

  public async confirm(linkId: string, input: ConfirmEvidenceLinkInput, context: MutationContext) {
    return this.prisma.$transaction(async (tx) => {
      const link = await this.findLink(tx, linkId);
      this.assertVersion(link, input.version);
      this.assertFutureExpiry(input.expiresAt);
      if (link.status === 'confirmed' && link.revalidationState === 'valid') {
        const result = this.serializeLink(link);
        await this.completeIdempotency(tx, context.idempotencyRecordId, result);
        return result;
      }
      const changed = await tx.evidenceLink.updateMany({
        where: { id: link.id, version: input.version },
        data: {
          status: 'confirmed',
          sourceContentHash: link.evidence.contentHash,
          confirmedBy: context.actorId,
          confirmedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          expiredAt: null,
          decisionReason: null,
          revalidationState: 'valid',
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }
            : {}),
          version: { increment: 1 },
        },
      });
      this.assertUpdated(changed.count);
      const updated = await this.findLink(tx, link.id);
      await this.appendEvent(
        tx,
        updated,
        link.status === 'confirmed' ? 'reconfirmed' : 'confirmed',
        link.status,
        'confirmed',
        context,
        '用户确认证据关系',
      );
      const result = this.serializeLink(await this.findLink(tx, link.id));
      await this.audit.recordInTransaction(tx, {
        actorId: context.actorId,
        action: 'evidence.link_confirmed',
        targetType: 'evidence_link',
        targetId: link.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: { status: link.status, version: link.version },
        after: { status: 'confirmed', version: updated.version },
        clientSessionHash: context.clientSessionHash,
      });
      await this.completeIdempotency(tx, context.idempotencyRecordId, result);
      return result;
    });
  }

  public async reject(linkId: string, input: RejectEvidenceLinkInput, context: MutationContext) {
    return this.prisma.$transaction(async (tx) => {
      const link = await this.findLink(tx, linkId);
      this.assertVersion(link, input.version);
      const changed = await tx.evidenceLink.updateMany({
        where: { id: link.id, version: input.version },
        data: {
          status: 'rejected',
          sourceContentHash: link.evidence.contentHash,
          decisionReason: input.reason,
          rejectedBy: context.actorId,
          rejectedAt: new Date(),
          confirmedBy: null,
          confirmedAt: null,
          expiredAt: null,
          revalidationState: 'valid',
          version: { increment: 1 },
        },
      });
      this.assertUpdated(changed.count);
      const updated = await this.findLink(tx, link.id);
      await this.appendEvent(
        tx,
        updated,
        'rejected',
        link.status,
        'rejected',
        context,
        input.reason,
      );
      const result = this.serializeLink(await this.findLink(tx, link.id));
      await this.audit.recordInTransaction(tx, {
        actorId: context.actorId,
        action: 'evidence.link_rejected',
        targetType: 'evidence_link',
        targetId: link.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: { status: link.status, version: link.version },
        after: { status: 'rejected', version: updated.version, reason: input.reason },
        clientSessionHash: context.clientSessionHash,
      });
      await this.completeIdempotency(tx, context.idempotencyRecordId, result);
      return result;
    });
  }

  public async createManual(input: CreateManualEvidenceLinkInput, context: MutationContext) {
    return this.prisma.$transaction(async (tx) => {
      this.assertFutureExpiry(input.expiresAt);
      const [task, evidence, existing] = await Promise.all([
        tx.task.findUnique({ where: { id: input.taskId }, select: { id: true } }),
        tx.evidence.findUnique({ where: { id: input.evidenceId } }),
        tx.evidenceLink.findUnique({
          where: {
            targetType_targetId_evidenceId: {
              targetType: 'task',
              targetId: input.taskId,
              evidenceId: input.evidenceId,
            },
          },
        }),
      ]);
      if (!task) throw new DomainError(errorCodes.notFound, '任务不存在', { httpStatus: 404 });
      if (!evidence) throw new DomainError(errorCodes.notFound, '证据不存在', { httpStatus: 404 });
      if (existing) {
        throw new DomainError(
          'EVIDENCE_LINK_ALREADY_EXISTS',
          '任务与证据已有关系，请在现有建议上确认或撤销决定',
          { httpStatus: 409, details: { linkId: existing.id, status: existing.status } },
        );
      }
      const link = await tx.evidenceLink.create({
        data: {
          id: newId(),
          targetType: 'task',
          targetId: input.taskId,
          taskId: input.taskId,
          evidenceId: input.evidenceId,
          method: 'manual',
          confidence: 1,
          status: 'confirmed',
          explanation: input.explanation,
          ruleVersion: 'manual-v1',
          sourceContentHash: evidence.contentHash,
          confirmedBy: context.actorId,
          confirmedAt: new Date(),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
        include: { evidence: true },
      });
      await this.appendEvent(
        tx,
        link,
        'manual_created',
        null,
        'confirmed',
        context,
        input.explanation,
      );
      const result = this.serializeLink(await this.findLink(tx, link.id));
      await this.audit.recordInTransaction(tx, {
        actorId: context.actorId,
        action: 'evidence.manual_link_created',
        targetType: 'evidence_link',
        targetId: link.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: { taskId: input.taskId, evidenceId: input.evidenceId, status: 'confirmed' },
        clientSessionHash: context.clientSessionHash,
      });
      await this.completeIdempotency(tx, context.idempotencyRecordId, result);
      return result;
    });
  }

  public async revoke(
    linkId: string,
    input: RevokeEvidenceDecisionInput,
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const link = await this.findLink(tx, linkId);
      this.assertVersion(link, input.version);
      if (!['confirmed', 'rejected'].includes(link.status)) {
        throw new DomainError('EVIDENCE_DECISION_NOT_ACTIVE', '当前关系没有可撤销的人工决定', {
          httpStatus: 409,
        });
      }
      const nextStatus =
        link.method === 'manual' || link.evidence.availabilityState !== 'available'
          ? 'expired'
          : 'suggested';
      const changed = await tx.evidenceLink.updateMany({
        where: { id: link.id, version: input.version },
        data: {
          status: nextStatus,
          decisionReason: input.reason,
          confirmedBy: null,
          confirmedAt: null,
          rejectedBy: null,
          rejectedAt: null,
          expiredAt: nextStatus === 'expired' ? new Date() : null,
          revalidationState: 'valid',
          version: { increment: 1 },
        },
      });
      this.assertUpdated(changed.count);
      const updated = await this.findLink(tx, link.id);
      await this.appendEvent(
        tx,
        updated,
        'decision_revoked',
        link.status,
        nextStatus,
        context,
        input.reason,
      );
      const result = this.serializeLink(await this.findLink(tx, link.id));
      await this.audit.recordInTransaction(tx, {
        actorId: context.actorId,
        action: 'evidence.decision_revoked',
        targetType: 'evidence_link',
        targetId: link.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: { status: link.status, version: link.version },
        after: { status: nextStatus, version: updated.version, reason: input.reason },
        clientSessionHash: context.clientSessionHash,
      });
      await this.completeIdempotency(tx, context.idempotencyRecordId, result);
      return result;
    });
  }

  public async expireDueLinks(now = new Date()): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.evidenceLink.findMany({
        where: {
          status: { in: ['suggested', 'confirmed'] },
          expiresAt: { lte: now },
        },
        include: { evidence: true },
      });
      let expiredCount = 0;
      for (const link of due) {
        const changed = await tx.evidenceLink.updateMany({
          where: { id: link.id, version: link.version, status: link.status },
          data: {
            status: 'expired',
            expiredAt: now,
            decisionReason: '关系有效期已结束',
            revalidationState: 'valid',
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) continue;
        expiredCount += 1;
        const updated = await this.findLink(tx, link.id);
        await this.appendEvent(
          tx,
          updated,
          'expired',
          link.status,
          'expired',
          {
            actorId: 'evidence-expiry-schedule',
            correlationId: `evidence-expiry:${now.toISOString()}`,
            clientSessionHash: 'system',
            idempotencyRecordId: '',
          },
          '关系有效期已结束',
          'system',
        );
        await this.audit.recordInTransaction(tx, {
          actorType: 'system',
          actorId: 'evidence-expiry-schedule',
          action: 'evidence.link_expired',
          targetType: 'evidence_link',
          targetId: link.id,
          correlationId: `evidence-expiry:${now.toISOString()}`,
          outcome: 'succeeded',
          before: { status: link.status, version: link.version },
          after: { status: 'expired', version: updated.version },
          clientSessionHash: 'system',
        });
      }
      return expiredCount;
    });
  }

  private async findLink(tx: Prisma.TransactionClient, id: string) {
    const link = await tx.evidenceLink.findUnique({
      where: { id },
      include: {
        evidence: {
          include: {
            project: { select: { id: true, name: true } },
            gitlabProject: { select: { id: true, pathWithNamespace: true, webUrl: true } },
          },
        },
        events: { orderBy: { sequence: 'desc' }, take: 100 },
      },
    });
    if (!link) throw new DomainError(errorCodes.notFound, '证据关系不存在', { httpStatus: 404 });
    return link;
  }

  private assertVersion(link: EvidenceLink, version: number): void {
    if (link.version !== version) {
      throw new DomainError('EVIDENCE_LINK_VERSION_STALE', '证据关系版本已变化，请刷新后重试', {
        httpStatus: 412,
        details: { expected: link.version, received: version },
      });
    }
  }

  private assertUpdated(count: number): void {
    if (count !== 1) {
      throw new DomainError('EVIDENCE_LINK_VERSION_STALE', '证据关系被并发修改，请刷新后重试', {
        httpStatus: 412,
      });
    }
  }

  private assertFutureExpiry(value: string | null | undefined): void {
    if (value && new Date(value) <= new Date()) {
      throw new DomainError('EVIDENCE_EXPIRY_INVALID', '证据关系有效期必须晚于当前时间', {
        httpStatus: 422,
      });
    }
  }

  private async appendEvent(
    tx: Prisma.TransactionClient,
    link: Pick<EvidenceLink, 'id' | 'ruleVersion' | 'sourceContentHash'>,
    action: string,
    fromStatus: string | null,
    toStatus: string,
    context: MutationContext,
    reason: string,
    actorType: 'local_user' | 'system' = 'local_user',
  ): Promise<void> {
    const last = await tx.evidenceLinkEvent.aggregate({
      where: { evidenceLinkId: link.id },
      _max: { sequence: true },
    });
    await tx.evidenceLinkEvent.create({
      data: {
        id: newId(),
        evidenceLinkId: link.id,
        sequence: (last._max.sequence ?? 0) + 1,
        action,
        fromStatus,
        toStatus,
        actorType,
        actorId: context.actorId,
        reason,
        sourceContentHash: link.sourceContentHash,
        ruleVersion: link.ruleVersion || evidenceRuleVersion,
      },
    });
  }

  private async completeIdempotency(
    tx: Prisma.TransactionClient,
    recordId: string,
    response: unknown,
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        state: 'completed',
        httpStatus: 200,
        responseJson: JSON.stringify(response),
        errorCode: null,
      },
    });
  }

  private serializeLink(link: {
    id: string;
    targetType: string;
    targetId: string;
    evidenceId: string;
    method: string;
    confidence: number;
    status: string;
    explanation: string;
    matchedValue: string | null;
    ruleVersion: string;
    sourceContentHash: string;
    decisionReason: string | null;
    confirmedBy: string | null;
    confirmedAt: Date | null;
    rejectedBy: string | null;
    rejectedAt: Date | null;
    expiresAt: Date | null;
    expiredAt: Date | null;
    revalidationState: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    evidence: {
      id: string;
      sourceType: string;
      sourceExternalKey: string;
      eventAt: Date | null;
      title: string;
      url: string | null;
      contentHash: string;
      availabilityState: string;
      sourceSyncedAt: Date | null;
      project?: { id: string; name: string } | null;
      gitlabProject?: { id: string; pathWithNamespace: string; webUrl: string } | null;
    };
    events?: Array<{
      id: string;
      sequence: number;
      action: string;
      fromStatus: string | null;
      toStatus: string;
      actorType: string;
      actorId: string;
      reason: string | null;
      sourceContentHash: string;
      ruleVersion: string;
      occurredAt: Date;
    }>;
  }) {
    return {
      id: link.id,
      targetType: link.targetType,
      targetId: link.targetId,
      evidenceId: link.evidenceId,
      method: link.method,
      confidence: link.confidence,
      status: link.status,
      explanation: link.explanation,
      matchedValue: link.matchedValue,
      ruleVersion: link.ruleVersion,
      sourceContentHash: link.sourceContentHash,
      decisionReason: link.decisionReason,
      confirmedBy: link.confirmedBy,
      confirmedAt: link.confirmedAt?.toISOString() ?? null,
      rejectedBy: link.rejectedBy,
      rejectedAt: link.rejectedAt?.toISOString() ?? null,
      expiresAt: link.expiresAt?.toISOString() ?? null,
      expiredAt: link.expiredAt?.toISOString() ?? null,
      revalidationState: link.revalidationState,
      version: link.version,
      createdAt: link.createdAt.toISOString(),
      updatedAt: link.updatedAt.toISOString(),
      evidence: {
        id: link.evidence.id,
        sourceType: link.evidence.sourceType,
        sourceExternalKey: link.evidence.sourceExternalKey,
        eventAt: link.evidence.eventAt?.toISOString() ?? null,
        title: link.evidence.title,
        url: link.evidence.url,
        contentHash: link.evidence.contentHash,
        availabilityState: link.evidence.availabilityState,
        sourceSyncedAt: link.evidence.sourceSyncedAt?.toISOString() ?? null,
        project: link.evidence.project ?? null,
        gitlabProject: link.evidence.gitlabProject ?? null,
      },
      events: (link.events ?? []).map((event) => ({
        ...event,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const match = /^offset:(\d+)$/u.exec(decoded);
      const offset = match?.[1] ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid');
      return offset;
    } catch {
      throw new DomainError('PAGINATION_CURSOR_INVALID', '分页游标无效', { httpStatus: 422 });
    }
  }
}
