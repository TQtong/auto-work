import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import {
  IntegrationProbeRegistry,
  type IntegrationProbe,
  type ProbeResult,
  type ProbeTarget,
} from '../integrations/integration-probe.registry.js';
import { DingTalkRobotClient, dingTalkRobotMaximumTextBytes } from './dingtalk-robot.client.js';

const fixedProbeMessage =
  'Auto Work 钉钉机器人连接测试：本消息只验证 Webhook 与加签，不包含周报正文、凭证或本机链接。';

@Injectable()
export class DingTalkRobotProbeService implements IntegrationProbe, OnModuleInit {
  public readonly type = 'dingtalk_robot' as const;

  public constructor(
    private readonly registry: IntegrationProbeRegistry,
    private readonly client: DingTalkRobotClient,
  ) {}

  public onModuleInit(): void {
    this.registry.register(this);
  }

  public async probe(target: ProbeTarget): Promise<ProbeResult> {
    if (
      !target.credential?.webhook ||
      !target.credential.secret ||
      typeof target.config.robotName !== 'string' ||
      typeof target.config.groupId !== 'string'
    ) {
      return {
        healthy: false,
        status: 'configuration_required',
        capabilities: { adapterRegistered: true, signedWebhook: true, fixedProbeMessage: true },
        errorCode: 'DINGTALK_ROBOT_CONFIGURATION_REQUIRED',
        message: '钉钉机器人名称、群稳定标识、Webhook 和加签 Secret 均为必填项',
      };
    }
    try {
      const result = await this.client.sendText({
        webhook: target.credential.webhook,
        secret: target.credential.secret,
        text: fixedProbeMessage,
      });
      return {
        healthy: true,
        status: 'healthy',
        identity: {
          robotName: target.config.robotName,
          groupId: target.config.groupId,
        },
        capabilities: {
          adapterRegistered: true,
          signedWebhook: true,
          fixedProbeMessage: true,
          explicitUserTestRequired: true,
          fullReportForbidden: true,
          localhostLinkForbidden: true,
          maximumTextBytes: dingTalkRobotMaximumTextBytes,
          providerRequestId: result.requestId,
          testedTimestamp: result.timestamp,
          capabilitySnapshotHash: requestHash({
            robotName: target.config.robotName,
            groupId: target.config.groupId,
            signedWebhook: true,
            maximumTextBytes: dingTalkRobotMaximumTextBytes,
          }),
        },
      };
    } catch (error) {
      const domainError = error instanceof DomainError ? error : null;
      return {
        healthy: false,
        status: ['DINGTALK_ROBOT_PERMISSION_DENIED', 'DINGTALK_ROBOT_SIGNATURE_INVALID'].includes(
          domainError?.code ?? '',
        )
          ? 'invalid'
          : 'degraded',
        capabilities: {
          adapterRegistered: true,
          signedWebhook: true,
          fixedProbeMessage: true,
          fullReportForbidden: true,
        },
        errorCode: domainError?.code ?? 'DINGTALK_ROBOT_PROBE_FAILED',
        message: (error instanceof Error ? error.message : '钉钉机器人连接测试失败').slice(0, 500),
      };
    }
  }
}
