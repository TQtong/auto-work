import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import {
  DingTalkDesktopClient,
  dingTalkDesktopConfigSchema,
} from '../src/modules/dingtalk/dingtalk-desktop.client.js';
import { DingTalkDesktopProbeService } from '../src/modules/dingtalk/dingtalk-desktop-probe.service.js';
import { IntegrationProbeRegistry } from '../src/modules/integrations/integration-probe.registry.js';

const config = {
  organizationName: '示例科技有限公司',
  templateName: '研发周报',
  recipientGroupName: '研发中心',
  timeoutSeconds: 45,
};

describe('钉钉桌面正式日志适配器', () => {
  it('配置不需要 AppKey、CorpID、UserID、Secret 或 AccessToken', () => {
    expect(dingTalkDesktopConfigSchema.parse(config)).toEqual(config);
    expect(
      dingTalkDesktopConfigSchema.safeParse({
        templateName: '研发周报',
        recipientGroupName: '研发中心',
      }).success,
    ).toBe(false);
  });

  it('Docker 模式在排队前拒绝缺失或过期的 Windows 桥接心跳', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-work-desktop-heartbeat-'));
    const client = new DingTalkDesktopClient();
    const now = Date.now();
    try {
      await expect(client.assertReady('linux', root, now)).rejects.toMatchObject({
        code: 'DINGTALK_DESKTOP_BRIDGE_UNAVAILABLE',
      });
      await writeFile(
        join(root, 'heartbeat.json'),
        JSON.stringify({
          version: 1,
          processId: 1234,
          updatedAt: new Date(now - 16_000).toISOString(),
        }),
      );
      await expect(client.assertReady('linux', root, now)).rejects.toMatchObject({
        code: 'DINGTALK_DESKTOP_BRIDGE_UNAVAILABLE',
      });
      await writeFile(
        join(root, 'heartbeat.json'),
        JSON.stringify({ version: 1, processId: 1234, updatedAt: new Date(now).toISOString() }),
      );
      await expect(client.assertReady('linux', root, now)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('从真实桌面探测结果构造六字段模板事实和接收群缓存', async () => {
    const createRecipient = vi.fn().mockResolvedValue({ id: 'recipient-1' });
    const prisma = {
      dingTalkRecipientValidation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: createRecipient,
        update: vi.fn(),
      },
    } as unknown as PrismaService;
    const client = {
      probe: vi.fn().mockResolvedValue({
        success: true,
        status: 'healthy',
        processId: 100,
        windowTitle: '钉钉',
        recipientVisible: true,
        observedFields: [
          '周报填写日期',
          '近期工作目标',
          '本周工作内容（当前迭代任务及完成情况）',
          '下周工作计划',
          '需要协助或存在的问题',
          '其他补充',
        ],
      }),
    } as unknown as DingTalkDesktopClient;
    const service = new DingTalkDesktopProbeService(new IntegrationProbeRegistry(), prisma, client);

    const result = await service.probe({
      id: 'desktop-connection',
      type: 'dingtalk_desktop',
      baseUrl: null,
      config,
      credential: null,
    });

    expect(result).toMatchObject({
      healthy: true,
      status: 'healthy',
      identity: { organizationName: '示例科技有限公司', desktopProcessId: 100 },
      capabilities: {
        adapter: 'dingtalk_desktop_ocr',
        credentialRequired: false,
        officialLogChannel: true,
        templateDiscovery: { exactSixFields: true },
        resultQuery: { supported: false },
      },
    });
    const discovery = result.capabilities.templateDiscovery as {
      selectedTemplate: { fields: unknown[] };
    };
    expect(discovery.selectedTemplate.fields).toHaveLength(6);
    expect(createRecipient).toHaveBeenCalledTimes(1);
    expect(createRecipient.mock.calls[0]?.[0] as unknown).toMatchObject({
      data: {
        connectionId: 'desktop-connection',
        subjectType: 'group',
        displayName: '研发中心',
        available: true,
      },
    });
  });

  it('未识别到恰好六个字段时拒绝把连接标为健康', async () => {
    const prisma = {
      dingTalkRecipientValidation: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing' }),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ id: 'existing' }),
      },
    } as unknown as PrismaService;
    const client = {
      probe: vi.fn().mockResolvedValue({
        success: true,
        status: 'healthy',
        recipientVisible: true,
        observedFields: ['日期', '目标', '本周工作', '下周计划', '问题'],
      }),
    } as unknown as DingTalkDesktopClient;
    const service = new DingTalkDesktopProbeService(new IntegrationProbeRegistry(), prisma, client);

    await expect(
      service.probe({
        id: 'desktop-connection',
        type: 'dingtalk_desktop',
        baseUrl: null,
        config,
        credential: null,
      }),
    ).resolves.toMatchObject({
      healthy: false,
      status: 'configuration_required',
      errorCode: 'DINGTALK_DESKTOP_FIELDS_NOT_EXACTLY_SIX',
    });
  });

  it('未识别到配置的接收群时不缓存群事实且连接不健康', async () => {
    const createRecipient = vi.fn();
    const prisma = {
      dingTalkRecipientValidation: {
        findFirst: vi.fn(),
        create: createRecipient,
        update: vi.fn(),
      },
    } as unknown as PrismaService;
    const client = {
      probe: vi.fn().mockResolvedValue({
        success: true,
        status: 'healthy',
        recipientVisible: false,
        observedFields: [
          '周报填写日期',
          '近期工作目标',
          '本周工作内容（当前迭代任务及完成情况）',
          '下周工作计划',
          '需要协助或存在的问题',
          '其他补充',
        ],
      }),
    } as unknown as DingTalkDesktopClient;
    const service = new DingTalkDesktopProbeService(new IntegrationProbeRegistry(), prisma, client);

    await expect(
      service.probe({
        id: 'desktop-connection',
        type: 'dingtalk_desktop',
        baseUrl: null,
        config,
        credential: null,
      }),
    ).resolves.toMatchObject({
      healthy: false,
      status: 'configuration_required',
      errorCode: 'DINGTALK_DESKTOP_RECIPIENT_NOT_VISIBLE',
    });
    expect(createRecipient).not.toHaveBeenCalled();
  });

  it('相同桌面事实的重复探测追加新能力与接收群快照，不覆盖历史事实', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T06:00:00.000Z'));
    const createRecipient = vi.fn().mockResolvedValue({ id: 'created' });
    const updateRecipient = vi.fn();
    const prisma = {
      dingTalkRecipientValidation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: createRecipient,
        update: updateRecipient,
      },
    } as unknown as PrismaService;
    const client = {
      probe: vi.fn().mockResolvedValue({
        success: true,
        status: 'healthy',
        recipientVisible: true,
        observedFields: [
          '周报填写日期',
          '近期工作目标',
          '本周工作内容（当前迭代任务及完成情况）',
          '下周工作计划',
          '需要协助或存在的问题',
          '其他补充',
        ],
      }),
    } as unknown as DingTalkDesktopClient;
    const service = new DingTalkDesktopProbeService(new IntegrationProbeRegistry(), prisma, client);
    const target = {
      id: 'desktop-connection',
      type: 'dingtalk_desktop' as const,
      baseUrl: null,
      config,
      credential: null,
    };

    try {
      const first = await service.probe(target);
      vi.advanceTimersByTime(1);
      const second = await service.probe(target);
      const firstDiscovery = first.capabilities.templateDiscovery as { snapshotHash: string };
      const secondDiscovery = second.capabilities.templateDiscovery as { snapshotHash: string };

      expect(secondDiscovery.snapshotHash).not.toBe(firstDiscovery.snapshotHash);
      expect(createRecipient).toHaveBeenCalledTimes(2);
      expect(updateRecipient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
