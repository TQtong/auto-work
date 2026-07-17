import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { newId, requestHash } from '@auto-work/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { ExcelImportCommitService } from '../src/modules/excel-imports/excel-import-commit.service.js';
import { ExcelImportPreviewService } from '../src/modules/excel-imports/excel-import-preview.service.js';
import type { ExcelContainerGuardService } from '../src/modules/excel-imports/excel-container-guard.service.js';
import type { ExcelWorkbookParserService } from '../src/modules/excel-imports/excel-workbook-parser.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('Excel 修正与单事务提交', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: ExcelImportCommitService;
  let jiraSequence = 0;
  const profileId = 'local-user';

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-excel-commit-'));
    await mkdir(join(temporaryDirectory, 'data'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'commit.db').replaceAll('\\', '/')}`,
    });
    const migrationRoot = resolve('prisma/migrations');
    const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationRoot, migration, 'migration.sql'), 'utf8');
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim())) {
        if (statement) await prisma.$executeRawUnsafe(statement);
      }
    }
    expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    const sessions = { currentProfileId: profileId } as unknown as SessionService;
    const previews = new ExcelImportPreviewService(
      prisma as unknown as PrismaService,
      sessions,
      {} as ExcelContainerGuardService,
      {} as ExcelWorkbookParserService,
    );
    service = new ExcelImportCommitService(prisma as unknown as PrismaService, sessions, previews);
  }, 60_000);

  beforeEach(async () => {
    jiraSequence = 0;
    await prisma.taskFieldProvenance.deleteMany();
    await prisma.excelImportRow.deleteMany();
    await prisma.excelImport.deleteMany();
    await prisma.taskStatusEvent.deleteMany();
    await prisma.taskSourceObservation.deleteMany();
    await prisma.task.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.identityAlias.deleteMany();
    await prisma.userProfile.deleteMany();
    await prisma.integrationConnection.deleteMany();
    await prisma.userProfile.create({
      data: {
        id: profileId,
        windowsSid: 'S-1-5-21-excel-commit',
        displayName: '当前用户',
        workdayHours: 8,
        aliases: {
          create: {
            id: newId(),
            aliasType: 'display_name',
            value: '本人别名',
            normalizedValue: '本人别名',
            source: 'test',
            enabled: true,
            verifiedAt: new Date(),
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('Jira 非空字段保持主事实、空字段由 Excel 补充，空 G 创建任务时仍为 null', async () => {
    const jiraTask = await createJiraTask({
      plannedStartDate: '2026-07-01',
      dueDate: null,
      originalEstimateSeconds: 7_200,
    });
    const excelImport = await createImport([
      {
        action: 'link_jira',
        matchedTaskId: jiraTask.id,
        normalized: normalized({
          plannedStartDate: '2026-07-02',
          dueDate: '2026-07-31',
          estimateHours: 8,
        }),
      },
      {
        action: 'create_excel',
        normalized: normalized({
          title: '空工时任务',
          plannedStartDate: null,
          dueDate: null,
          estimateHours: null,
          personDays: null,
          personDaysSource: 'empty',
        }),
      },
    ]);
    const idempotencyId = await createIdempotency(excelImport.id, 'commit-main-facts');
    const result = await service.commit(
      excelImport.id,
      { previewVersion: 1, acknowledgedWarnings: true },
      idempotencyId,
    );

    expect(result).toMatchObject({
      status: 'committed',
      summary: { created: 1, linked: 1, supplemented: 1, keptJira: 2 },
    });
    const updatedJira = await prisma.task.findUniqueOrThrow({ where: { id: jiraTask.id } });
    expect(updatedJira).toMatchObject({
      plannedStartDate: '2026-07-01',
      dueDate: '2026-07-31',
      originalEstimateSeconds: 7_200,
    });
    const excelTask = await prisma.task.findFirstOrThrow({ where: { primarySource: 'excel' } });
    expect(excelTask.originalEstimateSeconds).toBeNull();
    expect(excelTask.sourceStableKey).toMatch(/^excel:/u);
    const active = await prisma.taskFieldProvenance.findMany({
      where: { taskId: jiraTask.id, active: true },
      orderBy: { fieldName: 'asc' },
    });
    expect(active.map((item) => [item.fieldName, item.sourceType, item.decision])).toEqual([
      ['dueDate', 'excel', 'supplement'],
      ['originalEstimateSeconds', 'jira', 'keep_jira'],
      ['plannedStartDate', 'jira', 'keep_jira'],
    ]);
    expect(await prisma.excelImportRow.count({ where: { commitStatus: 'committed' } })).toBe(2);
    expect(
      (await prisma.idempotencyRecord.findUniqueOrThrow({ where: { id: idempotencyId } })).state,
    ).toBe('completed');
  });

  it('已提交预检使用新幂等键重放也不会重复创建任务、观测或来源', async () => {
    const excelImport = await createImport([
      { action: 'create_excel', normalized: normalized({ title: '稳定任务' }) },
    ]);
    const firstRecord = await createIdempotency(excelImport.id, 'commit-stable-1');
    const first = await service.commit(
      excelImport.id,
      { previewVersion: 1, acknowledgedWarnings: true },
      firstRecord,
    );
    const secondRecord = await createIdempotency(excelImport.id, 'commit-stable-2');
    const second = await service.commit(
      excelImport.id,
      { previewVersion: 1, acknowledgedWarnings: true },
      secondRecord,
    );

    expect(second).toEqual(first);
    expect(await prisma.task.count()).toBe(1);
    expect(await prisma.taskSourceObservation.count()).toBe(1);
    expect(await prisma.taskFieldProvenance.count()).toBe(3);
    expect(
      (await prisma.idempotencyRecord.findUniqueOrThrow({ where: { id: secondRecord } })).state,
    ).toBe('completed');
  });

  it('后续行在事务中失败时，前面已执行的任务、行状态和导入状态全部回滚', async () => {
    const excelImport = await createImport([
      { action: 'create_excel', normalized: normalized({ title: '本应回滚' }) },
      { action: 'link_jira', matchedTaskId: null, normalized: normalized({ title: '无匹配' }) },
    ]);
    const recordId = await createIdempotency(excelImport.id, 'commit-rollback');
    await expect(
      service.commit(excelImport.id, { previewVersion: 1, acknowledgedWarnings: true }, recordId),
    ).rejects.toMatchObject({ code: 'EXCEL_ROW_ACTION_INVALID' });

    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.taskSourceObservation.count()).toBe(0);
    expect(await prisma.taskFieldProvenance.count()).toBe(0);
    expect(await prisma.excelImportRow.count({ where: { commitStatus: 'pending' } })).toBe(2);
    expect(
      (await prisma.excelImport.findUniqueOrThrow({ where: { id: excelImport.id } })).status,
    ).toBe('preview_ready');
  });

  it('冲突修正只接受候选 Jira，并同时校验 import 与 row 乐观版本', async () => {
    const [firstTask, secondTask] = await Promise.all([createJiraTask(), createJiraTask()]);
    const excelImport = await createImport([
      {
        action: 'conflict',
        normalized: normalized({ title: '待选择任务' }),
        diagnostics: [
          {
            severity: 'conflict',
            code: 'EXCEL_JIRA_MATCH_AMBIGUOUS',
            message: '存在多个 Jira 候选',
          },
          {
            severity: 'warning',
            code: 'EXCEL_PERSON_DAYS_MISMATCH',
            message: '人日与工时不一致',
          },
        ],
        candidates: [{ id: firstTask.id }, { id: secondTask.id }],
      },
    ]);
    const row = await prisma.excelImportRow.findFirstOrThrow({
      where: { importId: excelImport.id },
    });
    const detail = await service.saveResolutions(excelImport.id, {
      version: 1,
      rows: [
        {
          id: row.id,
          version: 1,
          action: 'link_jira',
          matchedTaskId: secondTask.id,
          fields: { title: '用户确认后的任务' },
        },
      ],
    });
    expect(detail).toMatchObject({ version: 2, counts: { conflict: 0, warning: 1 } });
    expect(detail.rows[0]).toMatchObject({
      proposedAction: 'link_jira',
      version: 2,
      matchedTask: { id: secondTask.id },
    });
    expect(detail.rows[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EXCEL_PERSON_DAYS_MISMATCH', severity: 'warning' }),
      ]),
    );
    await expect(
      service.saveResolutions(excelImport.id, {
        version: 1,
        rows: [
          {
            id: row.id,
            version: 1,
            action: 'create_excel',
            fields: {},
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'EXCEL_PREVIEW_VERSION_STALE' });
  });

  async function createJiraTask(overrides: Record<string, unknown> = {}) {
    const sequence = ++jiraSequence;
    const connection = await prisma.integrationConnection.upsert({
      where: { id: 'jira-connection' },
      create: { id: 'jira-connection', type: 'jira', name: 'Jira', status: 'healthy' },
      update: {},
    });
    return prisma.task.create({
      data: {
        id: newId(),
        connectionId: connection.id,
        sourceStableKey: `jira:${connection.id}:${newId()}`,
        primarySource: 'jira',
        issueKey: `PROJ-${sequence}`,
        projectKey: 'PROJ',
        parentIssueKey: 'PROJ-100',
        parentTitle: '父任务',
        title: 'Jira 任务',
        assigneeName: '当前用户',
        isCurrentUser: true,
        normalizedStatus: 'in_progress',
        lastObservedAt: new Date(),
        ...overrides,
      },
    });
  }

  async function createImport(
    rows: Array<{
      action: string;
      matchedTaskId?: string | null;
      normalized: ReturnType<typeof normalized>;
      diagnostics?: unknown[];
      candidates?: unknown[];
    }>,
  ) {
    const importId = newId();
    const excelImport = await prisma.excelImport.create({
      data: {
        id: importId,
        fileName: `${importId}.xlsx`,
        fileSha256: requestHash({ importId }),
        fileSizeBytes: 1_024,
        parserVersion: 'test-v1',
        dateSystem: '1900',
        workdayHours: 8,
        status: 'preview_ready',
        taskRowCount: rows.length,
        conflictCount: rows.reduce((count, row) => count + (row.diagnostics?.length ?? 0), 0),
        createdBy: profileId,
        rows: {
          create: rows.map((row, index) => ({
            id: newId(),
            sheetName: '后端开发jira',
            rowNumber: index + 2,
            rowKind: 'task',
            rowFingerprint: requestHash({ importId, index }),
            rawJson: '{}',
            normalizedJson: JSON.stringify(row.normalized),
            diagnosticsJson: JSON.stringify(row.diagnostics ?? []),
            candidatesJson: JSON.stringify(row.candidates ?? []),
            proposedAction: row.action,
            matchedTaskId: row.matchedTaskId ?? null,
          })),
        },
      },
    });
    return excelImport;
  }

  async function createIdempotency(importId: string, key: string) {
    const record = await prisma.idempotencyRecord.create({
      data: {
        id: newId(),
        actorId: profileId,
        route: `/api/v1/excel-imports/${importId}/commit`,
        idempotencyKey: key,
        requestHash: requestHash({ importId, previewVersion: 1, acknowledgedWarnings: true }),
      },
    });
    return record.id;
  }
});

function normalized(overrides: Record<string, unknown> = {}) {
  return {
    parentIssueKey: 'PROJ-100',
    parentTitle: '父任务',
    title: 'Excel 任务',
    assigneeName: '当前用户',
    plannedStartDate: '2026-07-01',
    dueDate: '2026-07-02',
    estimateHours: 8,
    personDays: 1,
    personDaysSource: 'derived' as const,
    isCurrentUser: true,
    ...overrides,
  };
}
