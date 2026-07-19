import { describe, expect, it } from 'vitest';
import type {
  DingTalkTemplateMappingVersion,
  WeeklyReport,
  WeeklyReportVersion,
} from '../api/types.js';
import {
  compareWeeklyFields,
  confirmationGate,
  previousVersionId,
  reportWorkflowStep,
} from './weekly-report-view-model.js';

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

  it('确认门禁同时检查字段、warning、模板、收件人、附件、计划时间和当前版本', () => {
    const report = reportFact();
    const current = version();
    const mapping = mappingFact();
    const ready = confirmationGate({
      report,
      version: current,
      mapping,
      acknowledgedWarningIds: ['warning-1'],
      availableAttachmentIds: ['attachment-1'],
    });
    expect(ready.ready).toBe(true);
    expect(ready.items.every((item) => item.passed)).toBe(true);

    const blocked = confirmationGate({
      report,
      version: {
        ...current,
        fields: { ...current.fields, problems: '' },
        warnings: [{ id: 'block', code: 'BLOCK', message: '阻断', blocking: true }],
      },
      mapping: { ...mapping, expired: true },
      acknowledgedWarningIds: [],
      availableAttachmentIds: [],
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.items.filter((item) => !item.passed).map((item) => item.key)).toEqual(
      expect.arrayContaining(['fields', 'warnings', 'mapping', 'attachments']),
    );
  });

  it('状态步骤不会把已确认误标为已经正式提交', () => {
    const report = reportFact();
    expect(reportWorkflowStep(report)).toBe(2);
    expect(reportWorkflowStep({ ...report, status: 'confirmed' })).toBe(3);
    expect(
      reportWorkflowStep({ ...report, status: 'confirmed', logDeliveryState: 'submitted' }),
    ).toBe(4);
  });

  function reportFact(): WeeklyReport {
    return {
      id: 'report-1',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      reportDate: '2026-07-17',
      timezone: 'Asia/Shanghai',
      templateName: '研发周报',
      templateMappingVersionId: 'mapping-1',
      status: 'editing',
      logDeliveryState: 'not_started',
      robotDeliveryState: 'not_started',
      currentVersionId: 'version-1',
      confirmedVersionId: null,
      currentVersion: null,
      confirmedVersion: null,
      currentConfirmation: null,
      recipientScopeVersion: 1,
      scheduleAt: null,
      versionCount: 1,
      sourceSnapshotCount: 1,
      confirmationCount: 0,
      attachmentCount: 1,
      version: 3,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      delivery: { log: 'not_started', robot: 'not_started', partial: false },
    };
  }

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

  function mappingFact(): DingTalkTemplateMappingVersion {
    return {
      id: 'mapping-1',
      connectionId: 'connection-1',
      versionNo: 1,
      templateId: 'weekly',
      templateName: '研发周报',
      externalTemplateVersion: '1',
      templateHash: 'hash',
      fields: [],
      capabilitySnapshotHash: 'capability',
      observedAt: '2026-07-18T00:00:00.000Z',
      expiresAt: '2027-07-18T00:00:00.000Z',
      expired: false,
      contentHash: 'mapping-hash',
      createdBy: 'local-user',
      createdAt: '2026-07-18T00:00:00.000Z',
    };
  }
});
