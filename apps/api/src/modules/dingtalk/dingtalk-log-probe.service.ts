import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  IntegrationProbeRegistry,
  type IntegrationProbe,
  type ProbeResult,
  type ProbeTarget,
} from '../integrations/integration-probe.registry.js';
import { DingTalkLogClient } from './dingtalk-log.client.js';

const dingTalkLogProbeConfigSchema = z
  .object({
    appKey: z.string().trim().min(1).max(200),
    corpId: z.string().trim().min(1).max(200),
    operatorUserId: z.string().trim().min(1).max(500),
    templateName: z.string().trim().min(1).max(200),
  })
  .strict();

const capabilityLifetimeMs = 24 * 60 * 60 * 1_000;

@Injectable()
export class DingTalkLogProbeService implements IntegrationProbe, OnModuleInit {
  public readonly type = 'dingtalk_log' as const;

  public constructor(
    private readonly registry: IntegrationProbeRegistry,
    private readonly prisma: PrismaService,
    private readonly client: DingTalkLogClient,
  ) {}

  public onModuleInit(): void {
    this.registry.register(this);
  }

  public async probe(target: ProbeTarget): Promise<ProbeResult> {
    const config = dingTalkLogProbeConfigSchema.safeParse(target.config);
    if (!target.baseUrl || !target.credential?.appSecret || !config.success) {
      return {
        healthy: false,
        status: 'configuration_required',
        capabilities: {
          adapterRegistered: true,
          authenticated: false,
          officialLogChannel: true,
          robotSubstitutionForbidden: true,
        },
        errorCode: 'DINGTALK_LOG_CONFIGURATION_REQUIRED',
        message: '钉钉正式日志需要固定基础地址、App Key、App Secret、Corp ID、操作用户和模板名',
      };
    }
    try {
      const token = await this.client.accessToken({
        appKey: config.data.appKey,
        appSecret: target.credential.appSecret,
        configuredAccessToken: target.credential.accessToken,
      });
      const template = await this.client.getTemplate({
        baseUrl: target.baseUrl,
        accessToken: token.value,
        templateName: config.data.templateName,
        operatorUserId: config.data.operatorUserId,
      });
      const fields = [...template.fields]
        .sort((left, right) => left.sort - right.sort)
        .map((field) => ({
          externalFieldId: `sort:${field.sort}:hash:${requestHash({ name: field.field_name, type: field.type }).slice(0, 16)}`,
          externalFieldName: field.field_name,
          externalType: String(field.type),
          order: field.sort,
          required: true,
          maxLength: null,
        }));
      const fieldNames = new Set(fields.map((field) => field.externalFieldName));
      const fieldOrders = new Set(fields.map((field) => field.order));
      const exactSixFields = fields.length === 6 && fieldNames.size === 6 && fieldOrders.size === 6;
      const templateHash = requestHash({
        id: template.id,
        name: template.name,
        fields,
      });
      const observedAt = new Date();
      const expiresAt = new Date(observedAt.getTime() + capabilityLifetimeMs);
      const snapshotHash = requestHash({
        adapter: 'legacy_report_topapi',
        templateHash,
        operatorUserId: config.data.operatorUserId,
        receivers: template.default_receivers.map((receiver) => receiver.userid).sort(),
        conversations: template.default_received_convs
          .map((conversation) => conversation.conversation_id)
          .sort(),
        observedAt: observedAt.toISOString(),
      });
      const selectedTemplate = {
        templateId: template.id,
        templateName: template.name,
        externalTemplateVersion: null,
        templateHash,
        fields,
      };
      await this.persistRecipients(target.id, snapshotHash, observedAt, expiresAt, [
        ...template.default_receivers.map((receiver) => ({
          subjectType: 'user',
          externalId: receiver.userid,
          displayName: receiver.user_name,
        })),
        ...template.default_received_convs.map((conversation) => ({
          subjectType: 'group',
          externalId: conversation.conversation_id,
          displayName: conversation.title,
        })),
      ]);
      return {
        healthy: exactSixFields,
        status: exactSixFields ? 'healthy' : 'configuration_required',
        identity: {
          corpId: config.data.corpId,
          operatorUserId: template.userid,
          operatorName: template.user_name ?? null,
        },
        capabilities: {
          adapterRegistered: true,
          adapter: 'legacy_report_topapi',
          authenticated: true,
          tokenSource: token.source,
          tokenExpiresAt: token.expiresAt,
          officialLogChannel: true,
          robotSubstitutionForbidden: true,
          templateDiscovery: {
            supported: true,
            snapshotHash,
            observedAt: observedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            selectedTemplate,
            exactSixFields,
            syntheticFieldIds: true,
            requiredSemantics: 'all_observed_template_fields_are_required_for_create',
          },
          reportCreate: {
            supported: true,
            endpoint: '/topapi/report/create',
            returnsExternalReportId: true,
          },
          resultQuery: {
            supported: true,
            endpoint: '/topapi/report/list',
            exactBusinessIdSupported: false,
          },
          recipients: {
            defaultUserCount: template.default_receivers.length,
            defaultGroupCount: template.default_received_convs.length,
            cacheExpiresAt: expiresAt.toISOString(),
          },
          attachments: {
            supported: false,
            reason: '当前已批准日志适配未探测到可靠的通用文件附件上传契约',
          },
          providerRequestId: template.requestId,
        },
        ...(exactSixFields
          ? {}
          : {
              errorCode: 'DINGTALK_TEMPLATE_FIELDS_NOT_EXACTLY_SIX',
              message: '目标模板必须恰好包含六个唯一字段；请在钉钉侧修正模板后重新探测',
            }),
      };
    } catch (error) {
      const domainError = error instanceof DomainError ? error : null;
      return {
        healthy: false,
        status: ['DINGTALK_CREDENTIAL_INVALID', 'DINGTALK_PERMISSION_DENIED'].includes(
          domainError?.code ?? '',
        )
          ? 'invalid'
          : 'degraded',
        capabilities: {
          adapterRegistered: true,
          adapter: 'legacy_report_topapi',
          authenticated: false,
          officialLogChannel: true,
          robotSubstitutionForbidden: true,
        },
        errorCode: domainError?.code ?? 'DINGTALK_LOG_PROBE_FAILED',
        message: (error instanceof Error ? error.message : '钉钉正式日志能力探测失败').slice(
          0,
          500,
        ),
      };
    }
  }

  private async persistRecipients(
    connectionId: string,
    capabilitySnapshotHash: string,
    observedAt: Date,
    expiresAt: Date,
    recipients: Array<{ subjectType: string; externalId: string; displayName: string }>,
  ): Promise<void> {
    const unique = new Map(
      recipients.map((recipient) => [
        `${recipient.subjectType}:${recipient.externalId}`,
        recipient,
      ]),
    );
    await this.prisma.$transaction(async (tx) => {
      const historical = await tx.dingTalkRecipientValidation.findMany({
        where: { connectionId },
        orderBy: { observedAt: 'desc' },
      });
      const latestHistorical = new Map<
        string,
        { subjectType: string; externalId: string; displayName: string; available: boolean }
      >();
      for (const row of historical) {
        const key = `${row.subjectType}:${row.externalId}`;
        if (!latestHistorical.has(key)) latestHistorical.set(key, row);
      }
      // 当前探测未再返回的默认接收对象也写入不可用事实，避免继续沿用未过期的旧缓存。
      const observedFacts = [
        ...[...unique.values()].map((recipient) => ({ ...recipient, available: true })),
        ...[...latestHistorical.entries()]
          .filter(([key, row]) => !unique.has(key) && row.available)
          .map(([, row]) => ({
            subjectType: row.subjectType,
            externalId: row.externalId,
            displayName: row.displayName,
            available: false,
          })),
      ];
      for (const recipient of observedFacts) {
        const contentHash = requestHash({
          ...recipient,
          capabilitySnapshotHash,
        });
        const exists = await tx.dingTalkRecipientValidation.findFirst({
          where: { connectionId, contentHash },
          select: { id: true },
        });
        if (exists) continue;
        await tx.dingTalkRecipientValidation.create({
          data: {
            id: requestHash({ connectionId, contentHash, observedAt: observedAt.toISOString() }),
            connectionId,
            ...recipient,
            capabilitySnapshotHash,
            observedAt,
            expiresAt,
            contentHash,
          },
        });
      }
    });
  }
}
