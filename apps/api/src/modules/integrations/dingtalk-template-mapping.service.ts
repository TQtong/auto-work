import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import type { RequestAuditContext } from '../settings/profile.service.js';
import {
  saveDingTalkTemplateMappingSchema,
  type SaveDingTalkTemplateMappingInput,
} from './dingtalk-template-mapping.schemas.js';

const requiredInternalFields = [
  'reportDate',
  'recentGoals',
  'weeklyWork',
  'nextWeekPlans',
  'problems',
  'other',
] as const;

export interface TemplateMappingProbeAuditContext {
  actorType: 'local_user' | 'system';
  actorId: string;
  correlationId: string;
  clientSessionHash: string;
}

interface TemplateMappingAuditContext extends TemplateMappingProbeAuditContext {
  createdBy: string;
}

@Injectable()
export class DingTalkTemplateMappingService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {}

  public async list(connectionId: string) {
    await this.requireDingTalkLogConnection(connectionId);
    const mapping = await this.prisma.dingTalkTemplateMapping.findUnique({
      where: { connectionId },
      include: { versions: { orderBy: { versionNo: 'desc' } } },
    });
    if (!mapping)
      return { connectionId, currentVersionId: null, aggregateVersion: null, versions: [] };
    return {
      connectionId,
      currentVersionId: mapping.currentVersionId,
      aggregateVersion: mapping.version,
      versions: mapping.versions.map((version) => this.serializeVersion(version, connectionId)),
    };
  }

  public async save(
    connectionId: string,
    input: SaveDingTalkTemplateMappingInput,
    context: RequestAuditContext,
  ) {
    const connection = await this.requireDingTalkLogConnection(connectionId);
    return this.saveForConnection(connection, input, {
      actorType: 'local_user',
      actorId: this.sessions.currentProfileId,
      createdBy: this.sessions.currentProfileId,
      correlationId: context.correlationId,
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
  }

  /**
   * 真实连接探测成功后立即把同一份能力快照固化为当前模板版本。
   * 这样模板的 30 天有效期可以通过“测试连接”正常续期，不依赖隐藏的手工 API。
   */
  public async refreshFromCurrentDiscovery(
    connectionId: string,
    context: TemplateMappingProbeAuditContext,
  ) {
    const connection = await this.requireDingTalkLogConnection(connectionId);
    const capabilities = this.parseObject(connection.capabilitiesJson);
    const discovery = this.parseObject(capabilities.templateDiscovery);
    const selectedTemplate = this.parseObject(discovery.selectedTemplate);
    const discoveredFields = Array.isArray(selectedTemplate.fields)
      ? selectedTemplate.fields.map((field) => this.parseObject(field))
      : [];
    const input = saveDingTalkTemplateMappingSchema.parse({
      connectionVersion: connection.version,
      templateId: selectedTemplate.templateId,
      templateName: selectedTemplate.templateName,
      externalTemplateVersion: selectedTemplate.externalTemplateVersion ?? null,
      templateHash: selectedTemplate.templateHash,
      capabilitySnapshotHash: discovery.snapshotHash,
      observedAt: discovery.observedAt,
      expiresAt: discovery.expiresAt,
      fields: discoveredFields.map((field, index) => ({
        internalField: requiredInternalFields[index],
        externalFieldId: field.externalFieldId,
        externalFieldName: field.externalFieldName,
        externalType: field.externalType,
        order: field.order,
        required: field.required,
        maxLength: field.maxLength ?? null,
      })),
    });
    return this.saveForConnection(connection, input, {
      ...context,
      createdBy: context.actorId,
    });
  }

  private async saveForConnection(
    connection: Awaited<ReturnType<DingTalkTemplateMappingService['requireDingTalkLogConnection']>>,
    input: SaveDingTalkTemplateMappingInput,
    context: TemplateMappingAuditContext,
  ) {
    if (!connection.enabled || connection.status !== 'healthy') {
      throw new DomainError(
        'DINGTALK_TEMPLATE_CONNECTION_NOT_HEALTHY',
        '只有已启用且探测健康的钉钉日志连接才能保存模板映射',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }
    if (connection.version !== input.connectionVersion) {
      throw new DomainError(errorCodes.versionConflict, '钉钉连接已被修改，请重新探测模板', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    const capabilities = this.parseObject(connection.capabilitiesJson);
    const discovery = this.parseObject(capabilities.templateDiscovery);
    if (discovery.supported !== true || discovery.snapshotHash !== input.capabilitySnapshotHash) {
      throw new DomainError(
        'DINGTALK_TEMPLATE_CAPABILITY_SNAPSHOT_MISMATCH',
        '模板映射必须来自当前连接最近一次真实能力探测，不能手工伪造字段字符串',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }
    const fields = [...input.fields].sort((left, right) => left.order - right.order);
    if (fields.some((field, index) => field.internalField !== requiredInternalFields[index])) {
      throw new DomainError(
        'DINGTALK_TEMPLATE_FIELD_ORDER_INVALID',
        '模板字段顺序必须严格对应周报六字段，避免提交时错填栏目',
        { httpStatus: 422 },
      );
    }
    const selectedTemplate = this.parseObject(discovery.selectedTemplate);
    const selectedFields = Array.isArray(selectedTemplate.fields) ? selectedTemplate.fields : [];
    const discoveredFacts = {
      templateId: selectedTemplate.templateId,
      templateName: selectedTemplate.templateName,
      externalTemplateVersion: selectedTemplate.externalTemplateVersion ?? null,
      templateHash: selectedTemplate.templateHash,
      observedAt: discovery.observedAt,
      expiresAt: discovery.expiresAt,
      fields: selectedFields.map((field) => {
        const value = this.parseObject(field);
        return {
          externalFieldId: value.externalFieldId,
          externalFieldName: value.externalFieldName,
          externalType: value.externalType,
          order: value.order,
          required: value.required,
          maxLength: value.maxLength ?? null,
        };
      }),
    };
    const submittedFacts = {
      templateId: input.templateId,
      templateName: input.templateName,
      externalTemplateVersion: input.externalTemplateVersion,
      templateHash: input.templateHash,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
      fields: fields.map((field) => ({
        externalFieldId: field.externalFieldId,
        externalFieldName: field.externalFieldName,
        externalType: field.externalType,
        order: field.order,
        required: field.required,
        maxLength: field.maxLength,
      })),
    };
    if (
      selectedFields.length !== 6 ||
      requestHash(discoveredFacts) !== requestHash(submittedFacts)
    ) {
      throw new DomainError(
        'DINGTALK_TEMPLATE_DISCOVERED_FACTS_MISMATCH',
        '模板标识、探测时间或六个外部字段事实与最近一次钉钉探测不一致',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }
    const now = new Date();
    if (new Date(input.expiresAt) <= now) {
      throw new DomainError(
        'DINGTALK_TEMPLATE_MAPPING_EXPIRED',
        '模板探测结果已经过期，请重新探测',
        {
          httpStatus: 422,
          suggestedAction: 'reconfigure',
        },
      );
    }
    const content = {
      templateId: input.templateId,
      templateName: input.templateName,
      externalTemplateVersion: input.externalTemplateVersion,
      templateHash: input.templateHash,
      fields,
      capabilitySnapshotHash: input.capabilitySnapshotHash,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    };
    const contentHash = requestHash(content);

    try {
      return await this.prisma.$transaction(async (tx) => {
        let mapping = await tx.dingTalkTemplateMapping.findUnique({
          where: { connectionId: connection.id },
          include: { currentVersion: true },
        });
        if (mapping?.currentVersion?.contentHash === contentHash) {
          return {
            replayed: true,
            version: this.serializeVersion(mapping.currentVersion, connection.id),
          };
        }
        if (!mapping) {
          mapping = await tx.dingTalkTemplateMapping.create({
            data: { id: newId(), connectionId: connection.id },
            include: { currentVersion: true },
          });
        }
        const latest = await tx.dingTalkTemplateMappingVersion.aggregate({
          where: { mappingId: mapping.id },
          _max: { versionNo: true },
        });
        const version = await tx.dingTalkTemplateMappingVersion.create({
          data: {
            id: newId(),
            mappingId: mapping.id,
            versionNo: (latest._max.versionNo ?? 0) + 1,
            templateId: input.templateId,
            templateName: input.templateName,
            externalTemplateVersion: input.externalTemplateVersion,
            templateHash: input.templateHash,
            fieldsJson: JSON.stringify(fields),
            capabilitySnapshotHash: input.capabilitySnapshotHash,
            observedAt: new Date(input.observedAt),
            expiresAt: new Date(input.expiresAt),
            contentHash,
            createdBy: context.createdBy,
          },
        });
        const changed = await tx.dingTalkTemplateMapping.updateMany({
          where: { id: mapping.id, version: mapping.version },
          data: { currentVersionId: version.id, version: { increment: 1 } },
        });
        if (changed.count !== 1) {
          throw new DomainError(errorCodes.versionConflict, '模板映射被并发更新，请刷新后重试', {
            httpStatus: 409,
            suggestedAction: 'refresh',
          });
        }
        await this.audit.recordInTransaction(tx, {
          actorType: context.actorType,
          actorId: context.actorId,
          action: 'dingtalk.template_mapping_version_saved',
          targetType: 'dingtalk_template_mapping',
          targetId: mapping.id,
          correlationId: context.correlationId,
          outcome: 'succeeded',
          before: { aggregateVersion: mapping.version, currentVersionId: mapping.currentVersionId },
          after: {
            aggregateVersion: mapping.version + 1,
            versionId: version.id,
            versionNo: version.versionNo,
            contentHash,
          },
          clientSessionHash: context.clientSessionHash,
        });
        return { replayed: false, version: this.serializeVersion(version, connection.id) };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError(
          errorCodes.versionConflict,
          '模板映射版本发生并发冲突，请刷新后重试',
          {
            httpStatus: 409,
            suggestedAction: 'refresh',
          },
        );
      }
      throw error;
    }
  }

  public async listRecipientCache(connectionId: string, now = new Date()) {
    await this.requireDingTalkLogConnection(connectionId);
    const rows = await this.prisma.dingTalkRecipientValidation.findMany({
      where: { connectionId },
      orderBy: [{ observedAt: 'desc' }, { externalId: 'asc' }],
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.subjectType}:${row.externalId}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()].map((row) => ({
      id: row.id,
      subjectType: row.subjectType,
      externalId: row.externalId,
      displayName: row.displayName,
      available: row.available,
      expired: row.expiresAt <= now,
      observedAt: row.observedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      contentHash: row.contentHash,
    }));
  }

  private async requireDingTalkLogConnection(connectionId: string) {
    const connection = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
    });
    if (!connection || !['dingtalk_log', 'dingtalk_desktop'].includes(connection.type)) {
      throw new DomainError(errorCodes.notFound, '钉钉日志连接不存在', { httpStatus: 404 });
    }
    return connection;
  }

  private parseObject(value: unknown): Record<string, unknown> {
    try {
      const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private serializeVersion(
    version: {
      id: string;
      versionNo: number;
      templateId: string;
      templateName: string;
      externalTemplateVersion: string | null;
      templateHash: string;
      fieldsJson: string;
      capabilitySnapshotHash: string;
      observedAt: Date;
      expiresAt: Date;
      contentHash: string;
      createdBy: string;
      createdAt: Date;
    },
    connectionId: string,
  ) {
    return {
      id: version.id,
      connectionId,
      versionNo: version.versionNo,
      templateId: version.templateId,
      templateName: version.templateName,
      externalTemplateVersion: version.externalTemplateVersion,
      templateHash: version.templateHash,
      fields: JSON.parse(version.fieldsJson) as unknown,
      capabilitySnapshotHash: version.capabilitySnapshotHash,
      observedAt: version.observedAt.toISOString(),
      expiresAt: version.expiresAt.toISOString(),
      expired: version.expiresAt <= new Date(),
      contentHash: version.contentHash,
      createdBy: version.createdBy,
      createdAt: version.createdAt.toISOString(),
    };
  }
}
