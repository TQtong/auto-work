import { Injectable, OnModuleInit } from '@nestjs/common';
import { requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  IntegrationProbeRegistry,
  type IntegrationProbe,
  type ProbeResult,
  type ProbeTarget,
} from '../integrations/integration-probe.registry.js';
import { DingTalkDesktopClient, dingTalkDesktopConfigSchema } from './dingtalk-desktop.client.js';

const capabilityLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const internalFields = [
  'reportDate',
  'recentGoals',
  'weeklyWork',
  'nextWeekPlans',
  'problems',
  'other',
] as const;

@Injectable()
export class DingTalkDesktopProbeService implements IntegrationProbe, OnModuleInit {
  public readonly type = 'dingtalk_desktop' as const;

  public constructor(
    private readonly registry: IntegrationProbeRegistry,
    private readonly prisma: PrismaService,
    private readonly client: DingTalkDesktopClient,
  ) {}

  public onModuleInit(): void {
    this.registry.register(this);
  }

  public async probe(target: ProbeTarget): Promise<ProbeResult> {
    const config = dingTalkDesktopConfigSchema.safeParse(target.config);
    if (!config.success) {
      return {
        healthy: false,
        status: 'configuration_required',
        capabilities: {
          adapterRegistered: true,
          adapter: 'dingtalk_desktop_ocr',
          credentialRequired: false,
          officialLogChannel: true,
        },
        errorCode: 'DINGTALK_DESKTOP_CONFIGURATION_REQUIRED',
        message: '钉钉桌面连接需要公司名称、周报模板名称和接收群名称',
      };
    }
    try {
      const result = await this.client.probe(config.data);
      if (!result.success) {
        return {
          healthy: false,
          status: result.status === 'unknown' ? 'degraded' : 'configuration_required',
          capabilities: {
            adapterRegistered: true,
            adapter: 'dingtalk_desktop_ocr',
            credentialRequired: false,
            officialLogChannel: true,
          },
          errorCode: result.errorCode ?? 'DINGTALK_DESKTOP_PROBE_FAILED',
          message: result.message ?? '钉钉桌面客户端探测失败',
        };
      }
      const observedFields = result.observedFields ?? [];
      const exactSixFields = observedFields.length === 6 && new Set(observedFields).size === 6;
      const recipientVisible = result.recipientVisible === true;
      const fields = observedFields.map((name, index) => ({
        externalFieldId: `desktop:${internalFields[index] ?? index}:${requestHash(name).slice(0, 16)}`,
        externalFieldName: name,
        externalType: index === 0 ? 'date' : 'text',
        order: index + 1,
        required: true,
        maxLength: null,
      }));
      const templateId = `desktop-template:${requestHash({
        organizationName: config.data.organizationName,
        templateName: config.data.templateName,
      }).slice(0, 24)}`;
      const templateHash = requestHash({ templateId, fields });
      const observedAt = new Date();
      const expiresAt = new Date(observedAt.getTime() + capabilityLifetimeMs);
      const snapshotHash = requestHash({
        adapter: 'dingtalk_desktop_ocr',
        organizationName: config.data.organizationName,
        templateHash,
        recipientGroupName: config.data.recipientGroupName,
      });
      if (recipientVisible) {
        await this.persistRecipient(
          target.id,
          config.data.recipientGroupName,
          snapshotHash,
          observedAt,
          expiresAt,
        );
      }
      return {
        healthy: exactSixFields && recipientVisible,
        status: exactSixFields && recipientVisible ? 'healthy' : 'configuration_required',
        identity: {
          organizationName: config.data.organizationName,
          desktopProcessId: result.processId ?? null,
          windowTitle: result.windowTitle ?? null,
        },
        capabilities: {
          adapterRegistered: true,
          adapter: 'dingtalk_desktop_ocr',
          credentialRequired: false,
          usesLoggedInDesktopSession: true,
          officialLogChannel: true,
          robotSubstitutionForbidden: true,
          templateDiscovery: {
            supported: true,
            snapshotHash,
            observedAt: observedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            selectedTemplate: {
              templateId,
              templateName: config.data.templateName,
              externalTemplateVersion: null,
              templateHash,
              fields,
            },
            exactSixFields,
            syntheticFieldIds: true,
            requiredSemantics: 'all_visible_fields_must_be_resolved_before_submit',
          },
          reportCreate: {
            supported: true,
            transport: 'windows_ocr_automation',
            returnsExternalReportId: false,
            returnsLocalAutomationReceipt: true,
          },
          resultQuery: {
            supported: false,
            reason: '无接口权限时无法可靠读取公司日志列表；未知结果必须人工核对',
          },
          recipients: {
            defaultUserCount: 0,
            defaultGroupCount: 1,
            cacheExpiresAt: expiresAt.toISOString(),
          },
          attachments: {
            supported: false,
            reason: '桌面自动化仅填写已确认的六字段文本，不自动操作附件选择器',
          },
        },
        ...(exactSixFields && recipientVisible
          ? {}
          : {
              errorCode: exactSixFields
                ? 'DINGTALK_DESKTOP_RECIPIENT_NOT_VISIBLE'
                : 'DINGTALK_DESKTOP_FIELDS_NOT_EXACTLY_SIX',
              message: exactSixFields
                ? '桌面页面没有识别到配置的默认接收群，请核对群名后重新测试'
                : '桌面页面没有识别到六个唯一周报字段，请打开正确模板并重新测试',
            }),
      };
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'DINGTALK_DESKTOP_PROBE_FAILED';
      return {
        healthy: false,
        status: 'degraded',
        capabilities: {
          adapterRegistered: true,
          adapter: 'dingtalk_desktop_ocr',
          credentialRequired: false,
          officialLogChannel: true,
        },
        errorCode: code,
        message: (error instanceof Error ? error.message : '钉钉桌面客户端探测失败').slice(0, 500),
      };
    }
  }

  private async persistRecipient(
    connectionId: string,
    groupName: string,
    capabilitySnapshotHash: string,
    observedAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    const externalId = `desktop-group:${requestHash(groupName).slice(0, 24)}`;
    const contentHash = requestHash({
      subjectType: 'group',
      externalId,
      displayName: groupName,
      available: true,
      capabilitySnapshotHash,
    });
    const exists = await this.prisma.dingTalkRecipientValidation.findFirst({
      where: { connectionId, contentHash },
      select: { id: true },
    });
    if (exists) {
      await this.prisma.dingTalkRecipientValidation.update({
        where: { id: exists.id },
        data: { observedAt, expiresAt },
      });
      return;
    }
    await this.prisma.dingTalkRecipientValidation.create({
      data: {
        id: requestHash({ connectionId, contentHash, observedAt: observedAt.toISOString() }),
        connectionId,
        subjectType: 'group',
        externalId,
        displayName: groupName,
        available: true,
        capabilitySnapshotHash,
        observedAt,
        expiresAt,
        contentHash,
      },
    });
  }
}
