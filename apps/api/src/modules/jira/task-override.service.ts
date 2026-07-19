import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

export const taskOverrideFields = [
  'plannedStartDate',
  'dueDate',
  'originalEstimateSeconds',
] as const;
export type TaskOverrideField = (typeof taskOverrideFields)[number];

interface OverrideAuditContext {
  actorType?: 'local_user' | 'scheduler' | 'system';
  actorId: string;
  correlationId: string;
  clientSessionHash: string;
}

@Injectable()
export class TaskOverrideService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  public async setOverride(
    taskId: string,
    input: {
      fieldName: TaskOverrideField;
      value: string | number | null;
      reason: string;
      expiresAt: Date;
      version: number;
    },
    auditContext: OverrideAuditContext,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId } });
      if (!task) throw new DomainError(errorCodes.notFound, '任务不存在', { httpStatus: 404 });
      const current = await tx.taskFieldProvenance.findFirst({
        where: { taskId, fieldName: input.fieldName, active: true },
        orderBy: { effectiveAt: 'desc' },
      });
      const updated = await tx.task.updateMany({
        where: { id: taskId, version: input.version },
        data: { [input.fieldName]: input.value, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new DomainError(errorCodes.versionConflict, '任务版本已变化，请刷新后重新覆盖', {
          httpStatus: 409,
          suggestedAction: 'refresh',
        });
      }
      const effectiveAt = new Date();
      await tx.taskFieldProvenance.updateMany({
        where: { taskId, fieldName: input.fieldName, active: true },
        data: { active: false, supersededAt: effectiveAt },
      });
      const currentValue = current ? (JSON.parse(current.valueJson) as unknown) : null;
      const hasJiraConflict =
        current?.sourceType === 'jira' &&
        JSON.stringify(currentValue) !== JSON.stringify(input.value);
      const override = await tx.taskFieldProvenance.create({
        data: {
          id: newId(),
          taskId,
          fieldName: input.fieldName,
          sourceType: 'manual',
          decision: 'override',
          valueJson: JSON.stringify(input.value),
          reason: input.reason,
          active: true,
          effectiveAt,
          expiresAt: input.expiresAt,
          conflictValueJson: hasJiraConflict ? current?.valueJson : null,
          conflictDetectedAt: hasJiraConflict ? effectiveAt : null,
        },
      });
      await this.audit.recordInTransaction(tx, {
        ...auditContext,
        action: 'task.manual_override_set',
        targetType: 'task',
        targetId: taskId,
        outcome: 'succeeded',
        before: {
          fieldName: input.fieldName,
          version: task.version,
          sourceType: current?.sourceType,
        },
        after: {
          fieldName: input.fieldName,
          version: task.version + 1,
          expiresAt: input.expiresAt.toISOString(),
          conflict: hasJiraConflict,
        },
      });
      return { override, taskVersion: task.version + 1 };
    });
    return this.overrideView(result.override, result.taskVersion);
  }

  public async revokeOverride(
    taskId: string,
    fieldName: TaskOverrideField,
    input: { version: number; reason: string },
    auditContext: OverrideAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId } });
      if (!task) throw new DomainError(errorCodes.notFound, '任务不存在', { httpStatus: 404 });
      const override = await tx.taskFieldProvenance.findFirst({
        where: { taskId, fieldName, sourceType: 'manual', decision: 'override', active: true },
        orderBy: { effectiveAt: 'desc' },
      });
      if (!override) {
        throw new DomainError('TASK_OVERRIDE_NOT_ACTIVE', '该字段没有生效中的人工覆盖', {
          httpStatus: 409,
        });
      }
      const restored = await this.restoreOverride(tx, task, override, input.version, input.reason);
      await this.audit.recordInTransaction(tx, {
        ...auditContext,
        action: 'task.manual_override_revoked',
        targetType: 'task',
        targetId: taskId,
        outcome: 'succeeded',
        before: { fieldName, version: task.version, expiresAt: override.expiresAt?.toISOString() },
        after: { fieldName, version: restored.taskVersion, restoredSource: restored.sourceType },
      });
      return restored;
    });
  }

  public async listConflicts(input: {
    projectId?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }) {
    const offset = this.decodeCursor(input.cursor);
    const now = new Date();
    const where: Prisma.TaskFieldProvenanceWhereInput = {
      sourceType: 'manual',
      decision: 'override',
      active: true,
      conflictDetectedAt: { not: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(input.projectId ? { task: { projectId: input.projectId } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.taskFieldProvenance.findMany({
        where,
        include: { task: { include: { project: true } } },
        orderBy: [{ conflictDetectedAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: input.limit,
      }),
      this.prisma.taskFieldProvenance.count({ where }),
    ]);
    const nextOffset = offset + items.length;
    return {
      items: items.map((item) => ({
        id: item.id,
        task: {
          id: item.task.id,
          issueKey: item.task.issueKey,
          title: item.task.title,
          version: item.task.version,
          project: item.task.project
            ? { id: item.task.project.id, name: item.task.project.name }
            : null,
        },
        fieldName: item.fieldName,
        manualValue: JSON.parse(item.valueJson) as unknown,
        jiraValue: item.conflictValueJson ? (JSON.parse(item.conflictValueJson) as unknown) : null,
        reason: item.reason,
        effectiveAt: item.effectiveAt.toISOString(),
        expiresAt: item.expiresAt?.toISOString() ?? null,
        conflictDetectedAt: item.conflictDetectedAt?.toISOString() ?? null,
      })),
      total,
      page: {
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(nextOffset < total ? { nextCursor: this.encodeCursor(nextOffset) } : {}),
        hasMore: nextOffset < total,
        limit: input.limit,
      },
    };
  }

  public async expireDue(now = new Date()): Promise<number> {
    const due = await this.prisma.taskFieldProvenance.findMany({
      where: {
        sourceType: 'manual',
        decision: 'override',
        active: true,
        expiresAt: { lte: now },
      },
      include: { task: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    let expired = 0;
    for (const override of due) {
      const changed = await this.prisma.$transaction(async (tx) => {
        const current = await tx.taskFieldProvenance.findUnique({ where: { id: override.id } });
        if (!current?.active || !current.expiresAt || current.expiresAt > now) return false;
        const task = await tx.task.findUniqueOrThrow({ where: { id: override.taskId } });
        const restored = await this.restoreOverride(
          tx,
          task,
          current,
          task.version,
          '人工覆盖有效期结束，恢复最新可用来源事实',
        );
        await this.audit.recordInTransaction(tx, {
          actorType: 'scheduler',
          actorId: 'task-override-expiry-schedule',
          action: 'task.manual_override_expired',
          targetType: 'task',
          targetId: task.id,
          correlationId: `task-override-expiry:${current.id}`,
          outcome: 'succeeded',
          clientSessionHash: 'scheduler',
          before: { fieldName: current.fieldName, version: task.version },
          after: { fieldName: current.fieldName, version: restored.taskVersion },
        });
        return true;
      });
      if (changed) expired += 1;
    }
    return expired;
  }

  private async restoreOverride(
    tx: Prisma.TransactionClient,
    task: { id: string; version: number },
    override: {
      id: string;
      fieldName: string;
      effectiveAt: Date;
      conflictValueJson: string | null;
    },
    expectedVersion: number,
    reason: string,
  ) {
    const previous = await tx.taskFieldProvenance.findFirst({
      where: {
        taskId: task.id,
        fieldName: override.fieldName,
        id: { not: override.id },
        sourceType: { not: 'manual' },
        effectiveAt: { lte: override.effectiveAt },
      },
      orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
    });
    const valueJson = override.conflictValueJson ?? previous?.valueJson ?? 'null';
    const value = JSON.parse(valueJson) as string | number | null;
    const previousSourceType = previous?.sourceType;
    const restoredSourceType =
      previousSourceType === 'jira' || previousSourceType === 'excel'
        ? previousSourceType
        : 'manual';
    const updated = await tx.task.updateMany({
      where: { id: task.id, version: expectedVersion },
      data: {
        [override.fieldName]: value,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new DomainError(errorCodes.versionConflict, '任务版本已变化，请刷新后重试', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    const completedAt = new Date();
    await tx.taskFieldProvenance.update({
      where: { id: override.id },
      data: { active: false, supersededAt: completedAt },
    });
    await tx.taskFieldProvenance.create({
      data: {
        id: newId(),
        taskId: task.id,
        fieldName: override.fieldName,
        sourceType: restoredSourceType,
        decision: restoredSourceType === 'manual' ? 'superseded' : 'source_fact',
        valueJson,
        sourceObservationId: previous?.sourceObservationId ?? null,
        excelImportRowId: previous?.excelImportRowId ?? null,
        reason,
        active: true,
        effectiveAt: completedAt,
      },
    });
    return {
      taskId: task.id,
      fieldName: override.fieldName,
      value,
      sourceType: restoredSourceType,
      taskVersion: expectedVersion + 1,
    };
  }

  private overrideView(
    override: {
      id: string;
      taskId: string;
      fieldName: string;
      valueJson: string;
      reason: string | null;
      effectiveAt: Date;
      expiresAt: Date | null;
      conflictValueJson: string | null;
      conflictDetectedAt: Date | null;
    },
    taskVersion: number,
  ) {
    return {
      id: override.id,
      taskId: override.taskId,
      fieldName: override.fieldName,
      value: JSON.parse(override.valueJson) as unknown,
      reason: override.reason,
      effectiveAt: override.effectiveAt.toISOString(),
      expiresAt: override.expiresAt?.toISOString() ?? null,
      conflictValue: override.conflictValueJson
        ? (JSON.parse(override.conflictValueJson) as unknown)
        : null,
      conflictDetectedAt: override.conflictDetectedAt?.toISOString() ?? null,
      taskVersion,
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
      if (!match) throw new Error('invalid cursor');
      const offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid offset');
      return offset;
    } catch {
      throw new DomainError('PAGINATION_CURSOR_INVALID', '分页游标无效', { httpStatus: 422 });
    }
  }
}
