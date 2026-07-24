import { Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import type { RequestAuditContext } from '../settings/profile.service.js';
import type { JiraMappingInput } from './jira-mapping.schemas.js';
import type { JiraFieldMappings } from './jira-task-normalizer.js';

interface CapabilityField {
  id: string;
  name: string;
  schema?: { type?: string | null | undefined; items?: string | null | undefined } | null;
  occurrenceRate?: number;
  sampleValues?: unknown[];
}

interface CapabilityStatus {
  id: string;
  name: string;
  categoryKey?: string | null;
}

@Injectable()
export class JiraMappingService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
  ) {}

  /**
   * Jira 字段差异属于适配器实现细节，不要求用户在 Web 端维护映射。
   * 探测成功后根据 Jira 系统字段及字段元数据生成一个内部、不可变的读取配置。
   */
  public async ensureAutomatic(
    connectionId: string,
    fields: CapabilityField[],
    statuses: CapabilityStatus[],
  ) {
    await this.connection(connectionId);
    const byId = new Map(fields.map((field) => [field.id, field]));
    const fieldMappings: JiraFieldMappings = {
      plannedStartDate: this.findField(
        fields,
        ['计划开始', '开始日期', 'start date'],
        ['date', 'datetime', 'string'],
      ),
      dueDate: byId.has('duedate') ? 'duedate' : null,
      sprint: this.findField(fields, ['sprint'], ['array', 'string']),
      parent: byId.has('parent') ? 'parent' : null,
      originalEstimateSeconds: byId.has('timeoriginalestimate') ? 'timeoriginalestimate' : null,
      remainingEstimateSeconds: byId.has('timeestimate') ? 'timeestimate' : null,
      timeSpentSeconds: byId.has('timespent') ? 'timespent' : null,
      assignee: byId.has('assignee') ? 'assignee' : null,
      status: byId.has('status') ? 'status' : null,
      priority: byId.has('priority') ? 'priority' : null,
      labels: byId.has('labels') ? 'labels' : null,
      components: byId.has('components') ? 'components' : null,
    };
    const statusMappings = Object.fromEntries(
      statuses.map((status) => [status.id, this.automaticStatus(status)]),
    );
    const parserRules = {
      parentFallbackFieldId: null,
      sprintStringFallback: true,
      preserveUnknownStatus: true,
    };
    const serialized = {
      fields: JSON.stringify(fieldMappings),
      statuses: JSON.stringify(statusMappings),
      parserRules: JSON.stringify(parserRules),
    };
    const latest = await this.prisma.fieldMappingVersion.findFirst({
      where: { connectionId },
      orderBy: { versionNo: 'desc' },
    });
    if (
      latest?.fieldMappingsJson === serialized.fields &&
      latest.statusMappingsJson === serialized.statuses &&
      latest.parserRulesJson === serialized.parserRules
    ) {
      return latest;
    }
    return this.prisma.fieldMappingVersion.create({
      data: {
        id: newId(),
        connectionId,
        versionNo: (latest?.versionNo ?? 0) + 1,
        fieldMappingsJson: serialized.fields,
        statusMappingsJson: serialized.statuses,
        parserRulesJson: serialized.parserRules,
        validationSummaryJson: JSON.stringify({
          mode: 'automatic_read_adapter',
          detectedAt: new Date().toISOString(),
          availableFieldCount: fields.length,
          statusCount: statuses.length,
        }),
        createdBy: 'system:auto-jira-adapter',
      },
    });
  }

  public async list(connectionId: string) {
    await this.connection(connectionId);
    const rows = await this.prisma.fieldMappingVersion.findMany({
      where: { connectionId },
      orderBy: { versionNo: 'desc' },
    });
    return rows.map((row) => this.toPublic(row));
  }

  public async create(connectionId: string, input: JiraMappingInput, context: RequestAuditContext) {
    const connection = await this.connection(connectionId);
    const capabilities = JSON.parse(connection.capabilitiesJson) as Record<string, unknown>;
    const fields = Array.isArray(capabilities.fields)
      ? (capabilities.fields as CapabilityField[])
      : [];
    if (fields.length === 0) {
      throw new DomainError('JIRA_PROBE_REQUIRED', '请先完成 Jira 连接测试和字段发现', {
        httpStatus: 409,
        suggestedAction: 'reconfigure',
      });
    }
    const validations = this.validateFields(input, fields);
    const statuses = Array.isArray(capabilities.statuses)
      ? (capabilities.statuses as Array<{ id?: unknown; name?: unknown }>)
      : [];
    const missingStatuses = statuses.filter(
      (status) =>
        typeof status.id === 'string' &&
        input.statusMappings[status.id] === undefined &&
        (typeof status.name !== 'string' || input.statusMappings[status.name] === undefined),
    );
    if (missingStatuses.length > 0) {
      throw new DomainError('JIRA_STATUS_MAPPING_INCOMPLETE', '存在尚未映射的 Jira 状态', {
        httpStatus: 422,
        details: {
          missing: missingStatuses.slice(0, 100).map((status) => ({
            id: status.id,
            name: status.name,
          })),
        },
      });
    }
    if (Object.keys(input.statusMappings).length === 0) {
      throw new DomainError('JIRA_STATUS_MAPPING_REQUIRED', '至少需要配置一个状态映射', {
        httpStatus: 422,
      });
    }

    const created = await this.prisma.$transaction(async (transaction) => {
      const latest = await transaction.fieldMappingVersion.findFirst({
        where: { connectionId },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      });
      const row = await transaction.fieldMappingVersion.create({
        data: {
          id: newId(),
          connectionId,
          versionNo: (latest?.versionNo ?? 0) + 1,
          fieldMappingsJson: JSON.stringify(input.fieldMappings),
          statusMappingsJson: JSON.stringify(input.statusMappings),
          parserRulesJson: JSON.stringify(input.parserRules),
          validationSummaryJson: JSON.stringify({
            validatedAt: new Date().toISOString(),
            fieldCount: validations.length,
            fields: validations,
            statusCount: Object.keys(input.statusMappings).length,
            sampleParsingValidated: true,
          }),
          createdBy: this.sessions.currentProfileId,
        },
      });
      await transaction.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: 'healthy',
          capabilitiesJson: JSON.stringify({
            ...capabilities,
            currentMappingVersionId: row.id,
            currentMappingVersionNo: row.versionNo,
          }),
          version: { increment: 1 },
        },
      });
      return row;
    });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'jira.mapping_created',
      targetType: 'field_mapping_version',
      targetId: created.id,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      after: {
        connectionId,
        versionNo: created.versionNo,
        fieldCount: validations.length,
        statusCount: Object.keys(input.statusMappings).length,
      },
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
    return this.toPublic(created);
  }

  private validateFields(input: JiraMappingInput, fields: CapabilityField[]) {
    const byId = new Map(fields.map((field) => [field.id, field]));
    const expected: Record<keyof JiraMappingInput['fieldMappings'], string[]> = {
      plannedStartDate: ['date', 'datetime', 'string'],
      dueDate: ['date', 'datetime', 'string'],
      sprint: ['array', 'string'],
      parent: ['issuelink', 'issue', 'any'],
      originalEstimateSeconds: ['number', 'integer', 'any'],
      remainingEstimateSeconds: ['number', 'integer', 'any'],
      timeSpentSeconds: ['number', 'integer', 'any'],
      assignee: ['user', 'any'],
      status: ['status', 'any'],
      priority: ['priority', 'any'],
      labels: ['array', 'string', 'any'],
      components: ['array', 'any'],
    };
    return Object.entries(input.fieldMappings).flatMap(([purpose, fieldId]) => {
      if (fieldId === null) return [];
      const field = byId.get(fieldId);
      if (!field) {
        throw new DomainError('JIRA_MAPPING_FIELD_MISSING', `映射字段 ${fieldId} 不存在`, {
          httpStatus: 422,
          details: { purpose, fieldId },
        });
      }
      const schemaType = field.schema?.type ?? 'any';
      if (!expected[purpose as keyof typeof expected].includes(schemaType)) {
        throw new DomainError('JIRA_MAPPING_TYPE_MISMATCH', `字段 ${field.name} 类型不符合用途`, {
          httpStatus: 422,
          details: {
            purpose,
            fieldId,
            schemaType,
            expected: expected[purpose as keyof typeof expected],
          },
        });
      }
      return [
        {
          purpose,
          fieldId,
          fieldName: field.name,
          schemaType,
          occurrenceRate: field.occurrenceRate ?? 0,
          sampleCount: field.sampleValues?.length ?? 0,
        },
      ];
    });
  }

  private async connection(id: string) {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id, type: 'jira' },
    });
    if (!connection)
      throw new DomainError(errorCodes.notFound, 'Jira 连接不存在', { httpStatus: 404 });
    return connection;
  }

  private toPublic(row: Awaited<ReturnType<JiraMappingService['latestRow']>>) {
    return {
      id: row.id,
      connectionId: row.connectionId,
      versionNo: row.versionNo,
      fieldMappings: JSON.parse(row.fieldMappingsJson) as unknown,
      statusMappings: JSON.parse(row.statusMappingsJson) as unknown,
      parserRules: JSON.parse(row.parserRulesJson) as unknown,
      validationSummary: JSON.parse(row.validationSummaryJson) as unknown,
      createdBy: row.createdBy,
      effectiveAt: row.effectiveAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async latestRow() {
    return this.prisma.fieldMappingVersion.findFirstOrThrow();
  }

  private findField(
    fields: CapabilityField[],
    names: string[],
    acceptedTypes: string[],
  ): string | null {
    const matched = fields.find((field) => {
      const name = field.name.toLocaleLowerCase();
      const type = field.schema?.type ?? 'any';
      return names.some((candidate) => name.includes(candidate)) && acceptedTypes.includes(type);
    });
    return matched?.id ?? null;
  }

  private automaticStatus(status: CapabilityStatus) {
    const name = status.name.toLocaleLowerCase();
    if (/(取消|作废|cancel|won't do|wont do)/u.test(name)) return 'cancelled' as const;
    if (/(阻塞|受阻|blocked|impediment)/u.test(name)) return 'blocked' as const;
    if (status.categoryKey === 'new') return 'planned' as const;
    if (status.categoryKey === 'indeterminate') return 'in_progress' as const;
    if (status.categoryKey === 'done') return 'done' as const;
    return 'other' as const;
  }
}
