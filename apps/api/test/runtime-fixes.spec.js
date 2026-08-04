import { describe, expect, it, vi } from 'vitest';
import { JiraMappingService } from '../dist/modules/jira/jira-mapping.service.js';
import { JiraSyncService } from '../dist/modules/jira/jira-sync.service.js';
import { WeeklyReportService } from '../dist/modules/weekly-reports/weekly-report.service.js';

describe('Jira parent field compatibility', () => {
  it('maps the system parent field even when Jira /field omits it', async () => {
    let created;
    const prisma = {
      integrationConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'jira-1' }) },
      fieldMappingVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => {
          created = data;
          return data;
        }),
      },
    };
    const service = new JiraMappingService(prisma, {}, {}, {});

    await service.ensureAutomatic(
      'jira-1',
      [{ id: 'customfield_10400', name: 'Parent Link', schema: { type: 'any' } }],
      [],
    );

    expect(JSON.parse(created.fieldMappingsJson).parent).toBe('parent');
    expect(JSON.parse(created.parserRulesJson).parentFallbackFieldId).toBe('customfield_10400');
  });

  it('always requests the standard parent field and de-duplicates fallbacks', () => {
    const service = new JiraSyncService({}, {});
    const fields = service.requestedFields({ parent: null }, { parentFallbackFieldId: 'parent' });

    expect(fields.filter((field) => field === 'parent')).toHaveLength(1);
  });
});

describe('weekly report source refresh before AI', () => {
  it('creates a fresh source baseline while preserving every visible field', async () => {
    const previousTask = {
      id: 'task-1',
      title: 'Existing task',
      lastObservedAt: '2026-07-24T01:00:00.000Z',
    };
    const newTask = {
      id: 'task-2',
      title: 'Newly synced task',
      lastObservedAt: '2026-07-24T06:00:00.000Z',
    };
    const snapshot = {
      id: 'snapshot-old',
      calendarVersionId: null,
      profileId: 'profile-1',
      profileVersion: 1,
      jiraQueryJson: JSON.stringify({ connectionIds: [], projectIds: [] }),
      jiraSyncRunIdsJson: JSON.stringify(['sync-old']),
      taskFactsJson: JSON.stringify([previousTask]),
      evidenceFactsJson: '[]',
      manualInputsJson: '[]',
      freshnessPolicyJson: JSON.stringify({
        mode: 'require_fresh',
        taskMaxAgeMinutes: 1440,
        evidenceMaxAgeMinutes: 1440,
      }),
      warningsJson: '[]',
      ruleVersion: 'weekly-rule-v1',
      templateMappingVersionId: null,
      sanitizationPolicyVersion: 'sanitization-v1',
    };
    const current = {
      id: 'version-old',
      reportDateText: '2026-07-24',
      recentGoalsText: 'Keep recent goals',
      weeklyWorkText: 'Keep manually edited weekly work',
      nextWeekPlansText: 'Keep next week plans',
      problemsText: 'Keep problems',
      otherText: 'Keep other notes',
      fieldsJson: '{}',
      warningsJson: '[]',
      attachmentsJson: '[]',
      recipientScopeJson: '{}',
      templateMappingVersionId: null,
      scheduleAt: null,
      sourceSnapshotId: snapshot.id,
      sourceSnapshot: snapshot,
      sourceLinks: [],
    };
    const report = {
      id: 'report-1',
      ownerProfileId: 'profile-1',
      periodStart: '2026-07-20',
      periodEnd: '2026-07-24',
      reportDate: '2026-07-24',
      timezone: 'Asia/Shanghai',
      currentVersionId: current.id,
      currentVersion: current,
      currentConfirmation: null,
      version: 30,
    };
    let createdSnapshot;
    let createdVersion;
    const tx = {
      weeklyReport: {
        findFirst: vi.fn().mockResolvedValue({ currentConfirmation: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      reportSourceSnapshot: {
        create: vi.fn(async ({ data }) => {
          createdSnapshot = data;
          return data;
        }),
      },
      weeklyReportVersion: {
        aggregate: vi.fn().mockResolvedValue({ _max: { versionNo: 30 } }),
        create: vi.fn(async ({ data }) => {
          createdVersion = data;
          return data;
        }),
      },
      reportSourceLink: { createMany: vi.fn() },
    };
    const prisma = {
      weeklyReport: { findFirst: vi.fn().mockResolvedValue(report) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const service = new WeeklyReportService(
      prisma,
      { currentProfileId: 'profile-1' },
      { recordInTransaction: vi.fn() },
      { sessionHash: vi.fn().mockReturnValue('session-hash') },
      {},
    );
    service.collectSources = vi.fn().mockResolvedValue({
      tasks: [previousTask, newTask],
      evidence: [],
      jiraSyncRunIds: ['sync-new'],
    });

    const result = await service.refreshSourceSnapshotForAi(
      report.id,
      current.id,
      report.version,
      { correlationId: 'correlation-1', sessionId: 'session-1' },
      new Date('2026-07-24T07:00:00.000Z'),
    );

    expect(result).toMatchObject({ reportVersion: 31, refreshed: true });
    expect(JSON.parse(createdSnapshot.taskFactsJson)).toEqual([previousTask, newTask]);
    expect(createdVersion).toMatchObject({
      origin: 'manual',
      reportDateText: current.reportDateText,
      recentGoalsText: current.recentGoalsText,
      weeklyWorkText: current.weeklyWorkText,
      nextWeekPlansText: current.nextWeekPlansText,
      problemsText: current.problemsText,
      otherText: current.otherText,
      sourceSnapshotId: createdSnapshot.id,
    });
  });
});
