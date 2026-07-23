import { describe, expect, it } from 'vitest';
import type { WeeklyReportVersion } from '../api/types.js';
import { compareWeeklyFields, previousVersionId } from './weekly-report-view-model.js';

describe('周报工作台视图模型', () => {
  it('按六字段生成稳定差异，并选择严格小于当前版本的最近历史', () => {
    const before = version().fields;
    const after = { ...before, weeklyWork: '实现完整周报工作台', other: '完成验收' };
    expect(
      compareWeeklyFields(before, after)
        .filter((item) => item.changed)
        .map((item) => item.field),
    ).toEqual(['weeklyWork', 'other']);
    expect(
      previousVersionId(
        [
          { id: 'v1', versionNo: 1 },
          { id: 'v3', versionNo: 3 },
          { id: 'v2', versionNo: 2 },
        ],
        3,
      ),
    ).toBe('v2');
  });

  function version(): WeeklyReportVersion {
    return {
      id: 'version-1',
      reportId: 'report-1',
      versionNo: 1,
      origin: 'manual',
      parentVersionId: null,
      fields: {
        reportDate: '2026-07-17',
        recentGoals: '完成工作台',
        weeklyWork: '完成后端',
        nextWeekPlans: '完成浏览器验收',
        problems: '暂无',
        other: '无',
      },
      structuredFields: {},
      warnings: [{ id: 'warning-1', code: 'STALE', message: '来源较旧', blocking: false }],
      attachments: [
        {
          id: 'attachment-1',
          originalName: '周报.pdf',
          mimeType: 'application/pdf',
          extension: '.pdf',
          sizeBytes: 100,
          contentHash: 'hash',
        },
      ],
      recipientScope: {
        connectionId: 'connection-1',
        recipients: [
          {
            validationId: 'recipient-1',
            subjectType: 'user',
            externalId: 'user-1',
            displayName: '接收人',
            observedAt: '2026-07-18T00:00:00.000Z',
            expiresAt: '2027-07-18T00:00:00.000Z',
            contentHash: 'recipient-hash',
          },
        ],
      },
      templateMappingVersionId: 'mapping-1',
      scheduleAt: null,
      sourceSnapshot: {} as WeeklyReportVersion['sourceSnapshot'],
      sourceLinks: [],
      contentHash: 'content-hash',
      changeSummary: {},
      createdBy: 'local-user',
      createdAt: '2026-07-18T00:00:00.000Z',
    };
  }
});
