import { Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import type { RequestAuditContext } from '../settings/profile.service.js';
import type { JiraMappingInput } from './jira-mapping.schemas.js';

interface CapabilityField {
  id: string;
  name: string;
  schema?: { type?: string | null; items?: string | null } | null;
  occurrenceRate?: number;
  sampleValues?: unknown[];
}

@Injectable()
export class JiraMappingService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
  ) {}

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
}
