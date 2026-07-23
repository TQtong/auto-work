import { describe, expect, it } from 'vitest';
import { robotSevereRiskCodes, toIntegrationPayload } from './SettingsPage.js';

describe('AI 连接配置视图模型', () => {
  it('完整提交协议、模型、超时、Token、温度、用途和一次性密钥', () => {
    expect(
      toIntegrationPayload({
        type: 'ai',
        name: '企业外部 AI',
        baseUrl: 'https://api.example/v1',
        apiKey: 'secret-value',
        protocol: 'anthropic',
        model: 'claude-model',
        aiTimeoutMs: 45_000,
        aiMaxInputTokens: 16_000,
        aiMaxOutputTokens: 2_048,
        aiTemperaturePolicy: 'deterministic',
        aiTemperature: 0.2,
        aiAllowedPurposes: ['weekly_report', 'quarterly_review'],
      }),
    ).toEqual({
      type: 'ai',
      name: '企业外部 AI',
      baseUrl: 'https://api.example/v1',
      config: {
        protocol: 'anthropic',
        model: 'claude-model',
        metadataOnly: true,
        timeoutMs: 45_000,
        maxInputTokens: 16_000,
        maxOutputTokens: 2_048,
        temperaturePolicy: 'deterministic',
        temperature: 0.2,
        allowedPurposes: ['weekly_report', 'quarterly_review'],
      },
      credential: { apiKey: 'secret-value' },
    });
  });

  it('完整提交钉钉正式日志的固定主机、操作用户和应用凭证', () => {
    expect(
      toIntegrationPayload({
        type: 'dingtalk_log',
        name: '研发正式日志',
        baseUrl: 'https://oapi.dingtalk.com',
        appKey: 'app-key',
        corpId: 'corp-1',
        operatorUserId: 'operator-1',
        templateName: '研发周报',
        appSecret: 'app-secret-value',
      }),
    ).toEqual({
      type: 'dingtalk_log',
      name: '研发正式日志',
      baseUrl: 'https://oapi.dingtalk.com',
      config: {
        appKey: 'app-key',
        corpId: 'corp-1',
        operatorUserId: 'operator-1',
        templateName: '研发周报',
      },
      credential: { appSecret: 'app-secret-value' },
    });
  });

  it('桌面正式日志只提交公司、模板和接收群配置，不要求任何接口凭证', () => {
    expect(
      toIntegrationPayload({
        type: 'dingtalk_desktop',
        name: '公司桌面周报',
        organizationName: '示例科技有限公司',
        templateName: '研发周报',
        recipientGroupName: '研发中心',
        desktopTimeoutSeconds: 60,
        desktopExecutablePath: 'C:\\Apps\\DingTalk.exe',
      }),
    ).toEqual({
      type: 'dingtalk_desktop',
      name: '公司桌面周报',
      baseUrl: undefined,
      config: {
        organizationName: '示例科技有限公司',
        templateName: '研发周报',
        recipientGroupName: '研发中心',
        timeoutSeconds: 60,
        executablePath: 'C:\\Apps\\DingTalk.exe',
      },
    });
  });

  it('机器人 Webhook 与加签只进入一次性凭证载荷，不混入普通配置', () => {
    expect(
      toIntegrationPayload({
        type: 'dingtalk_robot',
        name: '研发通知',
        robotName: '研发机器人',
        groupId: 'group-1',
        webhook: 'https://oapi.dingtalk.com/robot/send?access_token=token',
        secret: 'secret-value',
      }),
    ).toEqual({
      type: 'dingtalk_robot',
      name: '研发通知',
      baseUrl: undefined,
      config: {
        robotName: '研发机器人',
        groupId: 'group-1',
        quietWindowMinutes: 30,
        severeRiskCodes: [],
      },
      credential: {
        webhook: 'https://oapi.dingtalk.com/robot/send?access_token=token',
        secret: 'secret-value',
      },
    });
  });

  it('机器人严重风险配置仅保留共享目录中的规则并去重', () => {
    expect(
      robotSevereRiskCodes({
        severeRiskCodes: [
          'SOURCE_UNAVAILABLE',
          'FORGED_RULE',
          'SOURCE_UNAVAILABLE',
          'AI_GENERATED_CONTENT',
        ],
      }),
    ).toEqual(['SOURCE_UNAVAILABLE', 'AI_GENERATED_CONTENT']);
  });
});
