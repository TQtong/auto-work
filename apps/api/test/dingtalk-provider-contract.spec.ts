import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SecureHttpService } from '../src/infrastructure/http/secure-http.service.js';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { DingTalkLogClient } from '../src/modules/dingtalk/dingtalk-log.client.js';
import { DingTalkLogProbeService } from '../src/modules/dingtalk/dingtalk-log-probe.service.js';
import {
  DingTalkRobotClient,
  dingTalkRobotMaximumTextBytes,
  validateDingTalkRobotWebhook,
} from '../src/modules/dingtalk/dingtalk-robot.client.js';
import { DingTalkRobotProbeService } from '../src/modules/dingtalk/dingtalk-robot-probe.service.js';
import { IntegrationProbeRegistry } from '../src/modules/integrations/integration-probe.registry.js';

describe('钉钉官方接口适配契约', () => {
  it('使用新版令牌端点并缓存令牌，再从固定旧版日志主机读取模板', async () => {
    const postJson = vi
      .fn<SecureHttpService['postJson']>()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: { accessToken: 'oauth-access-token', expireIn: 7_200 },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: {
          errcode: 0,
          request_id: 'template-request',
          result: {
            id: 'weekly-template',
            name: '研发周报',
            userid: 'operator-1',
            user_name: '模板管理员',
            fields: [{ field_name: '日期', sort: '0', type: '1' }],
            default_receivers: [],
            default_received_convs: [],
          },
        },
      });
    const client = new DingTalkLogClient({ postJson } as unknown as SecureHttpService);

    const first = await client.accessToken({ appKey: 'app-key', appSecret: 'app-secret-value' });
    const cached = await client.accessToken({ appKey: 'app-key', appSecret: 'app-secret-value' });
    const template = await client.getTemplate({
      baseUrl: 'https://oapi.dingtalk.com/',
      accessToken: first.value,
      templateName: '研发周报',
      operatorUserId: 'operator-1',
    });

    expect(first).toMatchObject({ value: 'oauth-access-token', source: 'oauth2' });
    expect(cached.value).toBe(first.value);
    expect(template).toMatchObject({ id: 'weekly-template', requestId: 'template-request' });
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(postJson.mock.calls[0]![0]).toMatchObject({
      url: new URL('https://api.dingtalk.com/v1.0/oauth2/accessToken'),
      expectedHost: 'api.dingtalk.com',
      allowPrivateNetwork: false,
      body: { appKey: 'app-key', appSecret: 'app-secret-value' },
    });
    const templateRequest = postJson.mock.calls[1]![0];
    expect(templateRequest.url.hostname).toBe('oapi.dingtalk.com');
    expect(templateRequest.url.pathname).toBe('/topapi/report/template/getbyname');
    expect(templateRequest.url.searchParams.get('access_token')).toBe('oauth-access-token');
    expect(templateRequest.body).toEqual({ template_name: '研发周报', userid: 'operator-1' });
  });

  it('拒绝非官方日志主机和操作用户不一致的模板响应', async () => {
    const postJson = vi.fn<SecureHttpService['postJson']>().mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        errcode: 0,
        result: {
          id: 'template',
          name: '研发周报',
          userid: 'another-user',
          fields: [{ field_name: '日期', sort: 0, type: 1 }],
          default_receivers: [],
          default_received_convs: [],
        },
      },
    });
    const client = new DingTalkLogClient({ postJson } as unknown as SecureHttpService);
    const input = {
      accessToken: 'access-token',
      templateName: '研发周报',
      operatorUserId: 'operator-1',
    };

    await expect(
      client.getTemplate({ ...input, baseUrl: 'https://example.com/' }),
    ).rejects.toMatchObject({ code: 'DINGTALK_LOG_BASE_URL_REJECTED' });
    await expect(
      client.getTemplate({ ...input, baseUrl: 'https://oapi.dingtalk.com/' }),
    ).rejects.toMatchObject({ code: 'DINGTALK_TEMPLATE_OPERATOR_MISMATCH' });
  });

  it('按官方旧版日志协议提交恰好六个字段，并解析外部日志 ID', async () => {
    const postJson = vi.fn<SecureHttpService['postJson']>().mockResolvedValue({
      status: 200,
      headers: {},
      body: { errcode: 0, request_id: 'create-request', result: 'report-1001' },
    });
    const client = new DingTalkLogClient({ postJson } as unknown as SecureHttpService);
    const contents = Array.from({ length: 6 }, (_, index) => ({
      key: `字段 ${index + 1}`,
      sort: String(index),
      type: '1',
      content: `内容 ${index + 1}`,
    }));

    const result = await client.createReport({
      baseUrl: 'https://oapi.dingtalk.com/',
      accessToken: 'access-token',
      operatorUserId: 'operator-1',
      templateId: 'weekly-template',
      contents,
      toUserIds: ['user-2', 'user-1', 'user-2'],
      toChat: false,
      source: 'auto-work',
    });

    expect(result).toEqual({ reportId: 'report-1001', requestId: 'create-request' });
    const request = postJson.mock.calls[0]![0];
    expect(request.url.hostname).toBe('oapi.dingtalk.com');
    expect(request.url.pathname).toBe('/topapi/report/create');
    expect(request.url.searchParams.get('access_token')).toBe('access-token');
    expect(request.body).toEqual({
      userid: 'operator-1',
      template_id: 'weekly-template',
      contents,
      to_chat: false,
      to_userids: ['user-2', 'user-1'],
      dd_from: 'auto-work',
    });

    await expect(
      client.createReport({
        baseUrl: 'https://oapi.dingtalk.com/',
        accessToken: 'access-token',
        operatorUserId: 'operator-1',
        templateId: 'weekly-template',
        contents: contents.slice(0, 5),
        toUserIds: [],
        toChat: false,
        source: 'auto-work',
      }),
    ).rejects.toMatchObject({ code: 'DINGTALK_REPORT_CONTENTS_INVALID' });
  });

  it('按 timestamp 换行 secret 生成 HMAC-SHA256 加签并发送固定文本结构', async () => {
    const postJson = vi.fn<SecureHttpService['postJson']>().mockResolvedValue({
      status: 200,
      headers: {},
      body: { errcode: 0, request_id: 'robot-request' },
    });
    const client = new DingTalkRobotClient({ postJson } as unknown as SecureHttpService);
    const timestamp = 1_752_816_000_000;
    const secret = 'SEC-robot-secret-value';
    const result = await client.sendText({
      webhook: 'https://oapi.dingtalk.com/robot/send?access_token=robot-token',
      secret,
      text: '固定测试消息',
      timestamp,
    });

    const request = postJson.mock.calls[0]![0];
    const expectedSign = createHmac('sha256', secret)
      .update(`${timestamp}\n${secret}`, 'utf8')
      .digest('base64');
    expect(request.url.searchParams.get('timestamp')).toBe(String(timestamp));
    expect(request.url.searchParams.get('sign')).toBe(expectedSign);
    expect(request).toMatchObject({
      expectedHost: 'oapi.dingtalk.com',
      allowPrivateNetwork: false,
      body: {
        msgtype: 'text',
        text: { content: '固定测试消息' },
        at: { isAtAll: false },
      },
    });
    expect(result).toEqual({ requestId: 'robot-request', timestamp });
  });

  it('严格拒绝伪造 Webhook、额外查询参数和超长机器人正文', async () => {
    expect(() =>
      validateDingTalkRobotWebhook('https://example.com/robot/send?access_token=x'),
    ).toThrowError(expect.objectContaining({ code: 'DINGTALK_ROBOT_WEBHOOK_REJECTED' }));
    expect(() =>
      validateDingTalkRobotWebhook(
        'https://oapi.dingtalk.com/robot/send?access_token=x&redirect=https://example.com',
      ),
    ).toThrowError(expect.objectContaining({ code: 'DINGTALK_ROBOT_WEBHOOK_REJECTED' }));
    const client = new DingTalkRobotClient({ postJson: vi.fn() } as unknown as SecureHttpService);
    await expect(
      client.sendText({
        webhook: 'https://oapi.dingtalk.com/robot/send?access_token=x',
        secret: 'secret-value',
        text: '中'.repeat(dingTalkRobotMaximumTextBytes),
      }),
    ).rejects.toMatchObject({ code: 'DINGTALK_ROBOT_MESSAGE_TOO_LARGE' });
  });

  it('正式日志探测只在模板恰好包含六个唯一字段时健康，并持久化收件人快照', async () => {
    const createdRecipients: unknown[] = [];
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        dingTalkRecipientValidation: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn((input: unknown) => {
            createdRecipients.push(input);
            return Promise.resolve(input);
          }),
        },
      }),
    );
    const client = {
      accessToken: vi.fn().mockResolvedValue({
        value: 'access-token',
        source: 'oauth2',
        expiresAt: '2026-07-18T10:00:00.000Z',
      }),
      getTemplate: vi.fn().mockResolvedValue({
        id: 'template-1',
        name: '研发周报',
        userid: 'operator-1',
        user_name: '管理员',
        fields: Array.from({ length: 6 }, (_, index) => ({
          field_name: `字段 ${index}`,
          sort: index,
          type: 1,
        })),
        default_receivers: [{ userid: 'user-1', user_name: '接收人' }],
        default_received_convs: [{ conversation_id: 'group-1', title: '研发群' }],
        requestId: 'template-request',
      }),
    };
    const registry = new IntegrationProbeRegistry();
    const probe = new DingTalkLogProbeService(
      registry,
      { $transaction: transaction } as unknown as PrismaService,
      client as unknown as DingTalkLogClient,
    );
    probe.onModuleInit();

    const result = await registry.probe({
      id: 'connection-1',
      type: 'dingtalk_log',
      baseUrl: 'https://oapi.dingtalk.com/',
      config: {
        appKey: 'app-key',
        corpId: 'corp-1',
        operatorUserId: 'operator-1',
        templateName: '研发周报',
      },
      credential: { appSecret: 'app-secret-value' },
    });

    expect(result).toMatchObject({
      healthy: true,
      status: 'healthy',
      capabilities: {
        officialLogChannel: true,
        robotSubstitutionForbidden: true,
        templateDiscovery: { exactSixFields: true, syntheticFieldIds: true },
        attachments: { supported: false },
      },
    });
    expect(createdRecipients).toHaveLength(2);
  });

  it('机器人探测只能发送固定的无敏感测试消息', async () => {
    const sendText = vi.fn().mockResolvedValue({ requestId: 'robot-request', timestamp: 123 });
    const registry = new IntegrationProbeRegistry();
    const probe = new DingTalkRobotProbeService(registry, {
      sendText,
    } as unknown as DingTalkRobotClient);
    probe.onModuleInit();
    const result = await registry.probe({
      id: 'robot-1',
      type: 'dingtalk_robot',
      baseUrl: null,
      config: { robotName: '研发通知', groupId: 'group-1' },
      credential: {
        webhook: 'https://oapi.dingtalk.com/robot/send?access_token=secret-token',
        secret: 'secret-value',
      },
    });

    expect(result).toMatchObject({
      healthy: true,
      capabilities: { fixedProbeMessage: true, fullReportForbidden: true },
    });
    expect(sendText).toHaveBeenCalledOnce();
    const sent = sendText.mock.calls[0]![0] as { text: string };
    expect(sent.text).toContain('只验证 Webhook 与加签');
    expect(sent.text).not.toContain('secret-token');
    expect(sent.text).not.toContain('secret-value');
    expect(sent.text).not.toContain('localhost');
  });

  it('重新探测发现默认收件人被移除时立即冻结不可用事实', async () => {
    const createdFacts: Array<{ data: Record<string, unknown> }> = [];
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        dingTalkRecipientValidation: {
          findMany: vi.fn().mockResolvedValue([
            {
              subjectType: 'user',
              externalId: 'removed-user',
              displayName: '已移除用户',
              available: true,
              observedAt: new Date('2026-07-18T01:00:00.000Z'),
            },
          ]),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn((input: { data: Record<string, unknown> }) => {
            createdFacts.push(input);
            return Promise.resolve(input);
          }),
        },
      }),
    );
    const registry = new IntegrationProbeRegistry();
    const probe = new DingTalkLogProbeService(
      registry,
      { $transaction: transaction } as unknown as PrismaService,
      {
        accessToken: vi.fn().mockResolvedValue({
          value: 'access-token',
          source: 'oauth2',
          expiresAt: null,
        }),
        getTemplate: vi.fn().mockResolvedValue({
          id: 'template-1',
          name: '研发周报',
          userid: 'operator-1',
          fields: Array.from({ length: 6 }, (_, index) => ({
            field_name: `字段 ${index}`,
            sort: index,
            type: 1,
          })),
          default_receivers: [],
          default_received_convs: [],
          requestId: null,
        }),
      } as unknown as DingTalkLogClient,
    );
    probe.onModuleInit();

    const result = await registry.probe({
      id: 'connection-removed-recipient',
      type: 'dingtalk_log',
      baseUrl: 'https://oapi.dingtalk.com/',
      config: {
        appKey: 'app-key',
        corpId: 'corp-1',
        operatorUserId: 'operator-1',
        templateName: '研发周报',
      },
      credential: { appSecret: 'app-secret-value' },
    });

    expect(result.healthy).toBe(true);
    expect(createdFacts).toHaveLength(1);
    expect(createdFacts[0]!.data).toMatchObject({
      subjectType: 'user',
      externalId: 'removed-user',
      available: false,
    });
  });
});
