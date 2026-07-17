import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { newId, sha256 } from '@auto-work/domain';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { ExcelContainerGuardService } from '../src/modules/excel-imports/excel-container-guard.service.js';
import { ExcelImportPreviewService } from '../src/modules/excel-imports/excel-import-preview.service.js';
import { ExcelWorkbookParserService } from '../src/modules/excel-imports/excel-workbook-parser.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('Excel 预检持久化集成', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: ExcelImportPreviewService;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-excel-preview-'));
    await mkdir(join(temporaryDirectory, 'data'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'excel.db').replaceAll('\\', '/')}`,
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
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-excel-test',
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
    const connection = await prisma.integrationConnection.create({
      data: { id: newId(), type: 'jira', name: 'Jira', status: 'healthy' },
    });
    await prisma.task.create({
      data: {
        id: newId(),
        connectionId: connection.id,
        primarySource: 'jira',
        externalId: '101',
        issueKey: 'PROJ-101',
        projectKey: 'PROJ',
        parentIssueKey: 'PROJ-100',
        parentTitle: '服务能力建设',
        title: '实现查询接口',
        assigneeName: '当前用户',
        isCurrentUser: true,
        normalizedStatus: 'in_progress',
        lastObservedAt: new Date(),
      },
    });
    service = new ExcelImportPreviewService(
      prisma as unknown as PrismaService,
      { currentProfileId: 'local-user' } as unknown as SessionService,
      new ExcelContainerGuardService(),
      new ExcelWorkbookParserService(),
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('把唯一 Jira 候选、Excel 新任务、原始单元格和诊断写入同一预检', async () => {
    const buffer = await buildPreviewFixture();
    const result = await service.preview({ buffer, fileName: '三表预检.xlsx', mimeType: xlsxMime });

    expect(result.replayed).toBe(false);
    expect(result.import).toMatchObject({
      fileName: '三表预检.xlsx',
      fileSha256: sha256(buffer),
      status: 'preview_ready',
      counts: { tasks: 2, containers: 1 },
    });
    const detail = await service.detail(result.import.id);
    expect(detail.rows).toHaveLength(3);
    const matched = detail.rows.find((row) => row.rowNumber === 2);
    expect(matched).toMatchObject({
      sheetName: '后端开发jira',
      proposedAction: 'link_jira',
    });
    expect(matched?.matchedTask?.issueKey).toBe('PROJ-101');
    const created = detail.rows.find((row) => row.rowNumber === 3);
    expect(created).toMatchObject({
      sheetName: '后端开发jira',
      proposedAction: 'create_excel',
    });
    expect(created?.normalized).toMatchObject({ parentIssueKey: 'PROJ-100', estimateHours: 8 });
    expect(JSON.stringify(detail.rows)).toContain('G3/8');
  });

  it('相同文件和解析器版本返回原预检，不重复创建行', async () => {
    const buffer = await buildPreviewFixture();
    const first = await service.preview({ buffer, fileName: '第一次.xlsx', mimeType: xlsxMime });
    const replay = await service.preview({ buffer, fileName: '第二次.xlsx', mimeType: xlsxMime });

    expect(replay).toMatchObject({ replayed: true, import: { id: first.import.id } });
    // 同一集成套件还覆盖其他文件，幂等断言必须限定到当前内容哈希与解析器版本。
    expect(
      await prisma.excelImport.count({
        where: { fileSha256: sha256(buffer), parserVersion: first.import.parserVersion },
      }),
    ).toBe(1);
    expect(await prisma.excelImportRow.count({ where: { importId: first.import.id } })).toBe(3);
  });

  it('损坏文件只保留哈希与失败摘要，不保留原文件路径或字节', async () => {
    const buffer = Buffer.from('not-an-xlsx');
    await expect(
      service.preview({ buffer, fileName: '损坏.xlsx', mimeType: xlsxMime }),
    ).rejects.toMatchObject({ code: 'EXCEL_CONTAINER_INVALID' });

    const failed = await prisma.excelImport.findFirstOrThrow({ where: { status: 'failed' } });
    expect(failed).toMatchObject({
      fileName: '损坏.xlsx',
      fileSha256: sha256(buffer),
      errorCode: 'EXCEL_CONTAINER_INVALID',
    });
    expect(JSON.stringify(failed)).not.toContain(buffer.toString('base64'));
    expect(JSON.stringify(failed)).not.toContain(temporaryDirectory);
    await expect(
      service.preview({ buffer, fileName: '再次上传.xlsx', mimeType: xlsxMime }),
    ).rejects.toMatchObject({ code: 'EXCEL_CONTAINER_INVALID' });
    expect(
      await prisma.excelImport.count({
        where: { fileSha256: sha256(buffer), status: 'failed' },
      }),
    ).toBe(1);
  });
});

async function buildPreviewFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const headers = [
    '父任务 id',
    '父任务名称',
    '子任务名称',
    '经办人',
    '开始日期',
    '到期日',
    '预估工时 h',
    '',
  ];
  const backend = workbook.addWorksheet('后端开发jira');
  backend.addRow(headers);
  backend.addRow([
    'PROJ-100',
    '服务能力建设',
    '实现查询接口',
    '当前用户',
    new Date('2026-07-13T00:00:00Z'),
    new Date('2026-07-14T00:00:00Z'),
    16,
    { formula: 'G2/8', result: 2 },
  ]);
  backend.addRow([
    null,
    null,
    '新增缓存策略',
    '本人别名',
    new Date('2026-07-15T00:00:00Z'),
    new Date('2026-07-15T00:00:00Z'),
    8,
    { formula: 'G3/8', result: 1 },
  ]);
  const test = workbook.addWorksheet('系统测试jira');
  test.addRow(headers.slice(0, 7));
  test.addRow(['PROJ-300', '回归测试父任务', null, null, null, null, null]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
