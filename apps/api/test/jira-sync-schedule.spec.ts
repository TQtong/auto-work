import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { JiraSyncSchedule } from '../src/modules/jira/jira-sync.schedule.js';
import type { JobQueueService } from '../src/modules/jobs/job-queue.service.js';

describe('Jira 每日只读同步调度', () => {
  it('启动时重新探测旧版遗留的需配置连接，让自动读取配置和首次全量同步能够自愈', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'probe-job' });
    const schedule = new JiraSyncSchedule(
      {
        integrationConnection: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'jira-1',
              credentialRef: 'vault:jira-1',
              configJson: '{"mode":"read_only"}',
            },
          ]),
        },
        fieldMappingVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      { enqueue } as unknown as JobQueueService,
    );

    await schedule.onApplicationBootstrap();

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'integration.test',
        payloadRef: 'jira-1',
        maxAttempts: 2,
      }),
    );
  });

  it('已有自动读取配置时排入每日增量同步', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'sync-job' });
    const create = vi.fn(
      (input: {
        data: {
          connectionId: string;
          scope: string;
          trigger: string;
          mappingVersionId: string;
        };
      }) => {
        void input;
        return Promise.resolve({ id: 'run-1' });
      },
    );
    const schedule = new JiraSyncSchedule(
      {
        integrationConnection: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'jira-1',
              credentialRef: 'vault:jira-1',
              configJson: '{}',
            },
          ]),
        },
        fieldMappingVersion: { findFirst: vi.fn().mockResolvedValue({ id: 'mapping-1' }) },
        job: { findFirst: vi.fn().mockResolvedValue(null) },
        jiraSyncRun: { create },
      } as unknown as PrismaService,
      { enqueue } as unknown as JobQueueService,
    );

    await schedule.enqueueDueConnections();

    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      connectionId: 'jira-1',
      scope: 'incremental',
      trigger: 'scheduled',
      mappingVersionId: 'mapping-1',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'jira.sync',
        payloadRef: 'run-1',
        dedupeKey: 'jira.sync:jira-1:incremental',
      }),
    );
  });
});
