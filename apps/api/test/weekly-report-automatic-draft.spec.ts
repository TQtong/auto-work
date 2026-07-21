import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';
import type { WeeklyReportAiService } from '../src/modules/weekly-reports/weekly-report-ai.service.js';
import { WeeklyReportAutomaticDraftService } from '../src/modules/weekly-reports/weekly-report-automatic-draft.service.js';
import type { WeeklyReportService } from '../src/modules/weekly-reports/weekly-report.service.js';

describe('自动周报草稿', () => {
  it('有个人任务且当天尚未生成时自动创建当前周草稿', async () => {
    const generate = vi.fn().mockResolvedValue({
      report: { id: 'report-1', version: 1 },
      version: { id: 'version-1' },
    });
    const service = new WeeklyReportAutomaticDraftService(
      {
        task: { count: vi.fn().mockResolvedValue(3) },
        weeklyReportVersion: { findFirst: vi.fn().mockResolvedValue(null) },
        integrationConnection: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      { currentProfileId: 'local-user' } as SessionService,
      { generate } as unknown as WeeklyReportService,
      {} as WeeklyReportAiService,
    );
    const now = new Date('2026-07-20T10:30:00.000Z');

    await service.generateForCurrentWeek(now);

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: 'Asia/Shanghai',
        jiraQuery: {},
        existingReportPolicy: 'create_version',
      }),
      expect.objectContaining({ correlationId: 'automatic-weekly:2026-07-20' }),
      now,
    );
  });

  it('无任务或当天已有版本时保持幂等，不调用生成服务', async () => {
    for (const fixture of [
      { taskCount: 0, version: null, reason: 'no_tasks' },
      { taskCount: 2, version: { id: 'version-today' }, reason: 'already_generated_today' },
    ]) {
      const generate = vi.fn();
      const service = new WeeklyReportAutomaticDraftService(
        {
          task: { count: vi.fn().mockResolvedValue(fixture.taskCount) },
          weeklyReportVersion: { findFirst: vi.fn().mockResolvedValue(fixture.version) },
        } as unknown as PrismaService,
        { currentProfileId: 'local-user' } as SessionService,
        { generate } as unknown as WeeklyReportService,
        {} as WeeklyReportAiService,
      );

      await expect(
        service.generateForCurrentWeek(new Date('2026-07-20T10:30:00.000Z')),
      ).resolves.toEqual({ skipped: true, reason: fixture.reason });
      expect(generate).not.toHaveBeenCalled();
    }
  });
});
