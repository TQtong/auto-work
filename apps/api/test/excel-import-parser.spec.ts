import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ExcelContainerGuardService } from '../src/modules/excel-imports/excel-container-guard.service.js';
import { ExcelWorkbookParserService } from '../src/modules/excel-imports/excel-workbook-parser.service.js';

const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('Excel 安全容器与三表解析', () => {
  it('读取与 artifact-tool 视觉样例同结构的三表 fixture，保留公式、继承与空工时语义', async () => {
    const buffer = await buildThreeSheetFixture();
    const guard = new ExcelContainerGuardService();
    const facts = await guard.inspect({
      buffer,
      fileName: 'P_Manager_脱敏样例.xlsx',
      mimeType: xlsxMime,
    });
    expect(facts).toMatchObject({ fileName: 'P_Manager_脱敏样例.xlsx' });
    expect(facts.entryCount).toBeGreaterThan(5);

    const parsed = await new ExcelWorkbookParserService().parse(buffer, 8);
    expect(parsed.dateSystem).toBe('1900');
    expect(parsed.sheetSummaries.map((sheet) => sheet.name)).toEqual([
      '后端开发jira',
      '前端开发jira',
      '系统测试jira',
    ]);
    expect(parsed.rows).toHaveLength(5);
    const inherited = parsed.rows.find(
      (row) => row.sheetName === '后端开发jira' && row.rowNumber === 3,
    )!;
    expect(inherited.normalized.parentIssueKey).toBe('PROJ-100');
    expect(inherited.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'EXCEL_PARENT_INHERITED', severity: 'info' }),
    );
    const formulaRow = parsed.rows.find(
      (row) => row.sheetName === '后端开发jira' && row.rowNumber === 2,
    )!;
    expect(formulaRow.raw.personDays).toMatchObject({ formula: 'G2/8', cachedResult: 2 });
    expect(formulaRow.normalized).toMatchObject({ estimateHours: 16, personDays: 2 });
    const emptyHours = parsed.rows.find(
      (row) => row.sheetName === '前端开发jira' && row.rowNumber === 2,
    )!;
    expect(emptyHours.normalized).toMatchObject({ estimateHours: null, personDays: null });
    expect(emptyHours.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'EXCEL_EMPTY_HOURS_KEEP_NULL' }),
    );
    expect(parsed.rows.at(-1)).toMatchObject({ rowKind: 'container' });
  });

  it('显式按 1904 日期系统转换序列值，不经过本机时区午夜换算', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = true;
    const sheet = workbook.addWorksheet('后端开发jira');
    sheet.addRow([
      '父任务 id',
      '父任务名称',
      '子任务名称',
      '经办人',
      '开始日期',
      '到期日',
      '预估工时 h',
    ]);
    const serial = (Date.UTC(2026, 6, 17) - Date.UTC(1904, 0, 1)) / 86_400_000;
    sheet.addRow(['PROJ-1', '父任务', '子任务', '用户', serial, serial + 1, 8]);
    sheet.getCell('E2').numFmt = 'yyyy-mm-dd';
    sheet.getCell('F2').numFmt = 'yyyy-mm-dd';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await new ExcelWorkbookParserService().parse(buffer, 8);

    expect(parsed.dateSystem).toBe('1904');
    expect(parsed.rows[0]?.normalized).toMatchObject({
      plannedStartDate: '2026-07-17',
      dueDate: '2026-07-18',
    });
  });

  it('公式没有缓存、半空父任务和歧义日期都产生可定位阻断/冲突，不猜测值', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('前端开发jira');
    sheet.addRow([
      '父任务 id',
      '父任务名称',
      '子任务名称',
      '经办人',
      '开始日期',
      '到期日',
      '预估工时 h',
      '',
    ]);
    sheet.addRow([
      'PROJ-2',
      null,
      '任务',
      '用户',
      '07/08/2026',
      { formula: 'E2+1', result: 0 },
      8,
      { formula: 'G2/8', result: 1 },
    ]);
    const buffer = await removeFormulaCaches(Buffer.from(await workbook.xlsx.writeBuffer()), [
      'F2',
      'H2',
    ]);

    const parsed = await new ExcelWorkbookParserService().parse(buffer, 8);
    const codes = parsed.rows[0]!.diagnostics.map((item) => item.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'EXCEL_PARENT_HALF_EMPTY',
        'EXCEL_DATE_INVALID',
        'EXCEL_DATE_FORMULA_CACHE_MISSING',
        'EXCEL_PERSON_DAYS_FORMULA_CACHE_MISSING',
      ]),
    );
    expect(parsed.rows[0]?.normalized).toMatchObject({
      parentIssueKey: null,
      plannedStartDate: null,
      dueDate: null,
    });
  });

  it('拒绝伪扩展名、宏条目和高压缩比 ZIP，且不依赖文件名判断容器', async () => {
    const fixture = await buildThreeSheetFixture();
    const guard = new ExcelContainerGuardService();
    await expect(
      guard.inspect({ buffer: fixture, fileName: '../越界.xlsx', mimeType: xlsxMime }),
    ).rejects.toMatchObject({ code: 'EXCEL_FILE_NAME_INVALID' });
    await expect(
      guard.inspect({ buffer: Buffer.from('not-xlsx'), fileName: '伪造.xlsx', mimeType: xlsxMime }),
    ).rejects.toMatchObject({ code: 'EXCEL_CONTAINER_INVALID' });

    const macroZip = await JSZip.loadAsync(fixture);
    macroZip.file('xl/vbaProject.bin', Buffer.from('fixture-macro'));
    const macro = await macroZip.generateAsync({ type: 'nodebuffer' });
    await expect(
      guard.inspect({ buffer: macro, fileName: '宏伪装.xlsx', mimeType: xlsxMime }),
    ).rejects.toMatchObject({ code: 'EXCEL_MACRO_REJECTED' });

    const macroTypeZip = await JSZip.loadAsync(fixture);
    const contentTypesEntry = macroTypeZip.file('[Content_Types].xml');
    if (!contentTypesEntry) throw new Error('fixture content types missing');
    const contentTypes = await contentTypesEntry.async('string');
    macroTypeZip.file(
      '[Content_Types].xml',
      contentTypes.replace(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
        'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
      ),
    );
    const macroType = await macroTypeZip.generateAsync({ type: 'nodebuffer' });
    await expect(
      guard.inspect({ buffer: macroType, fileName: '宏类型伪装.xlsx', mimeType: xlsxMime }),
    ).rejects.toMatchObject({ code: 'EXCEL_MACRO_REJECTED' });

    const bombZip = new JSZip();
    bombZip.file('[Content_Types].xml', '<Types />');
    bombZip.file('_rels/.rels', '<Relationships />');
    bombZip.file('xl/workbook.xml', '<workbook />');
    bombZip.file('xl/sharedStrings.xml', 'x'.repeat(2 * 1024 * 1024));
    const bomb = await bombZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await expect(
      guard.inspect({ buffer: bomb, fileName: '压缩炸弹.xlsx', mimeType: xlsxMime }),
    ).rejects.toMatchObject({ code: 'EXCEL_ZIP_RATIO_REJECTED' });
  });
});

async function buildThreeSheetFixture(): Promise<Buffer> {
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
    '补充数据库索引',
    '其他同事',
    new Date('2026-07-15T00:00:00Z'),
    new Date('2026-07-15T00:00:00Z'),
    8,
    { formula: 'G3/8', result: 1 },
  ]);
  const frontend = workbook.addWorksheet('前端开发jira');
  frontend.addRow(headers);
  frontend.addRow([
    'PROJ-200',
    '任务中心交互',
    '实现筛选面板',
    '当前用户',
    null,
    null,
    null,
    { formula: 'G2/8', result: 0 },
  ]);
  frontend.addRow([
    null,
    null,
    '实现详情抽屉',
    null,
    new Date('2026-07-16T00:00:00Z'),
    new Date('2026-07-17T00:00:00Z'),
    0,
    { formula: 'G3/8', result: 0 },
  ]);
  const test = workbook.addWorksheet('系统测试jira');
  test.addRow(headers.slice(0, 7));
  test.addRow(['PROJ-300', '回归测试父任务', null, null, null, null, null]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function removeFormulaCaches(buffer: Buffer, addresses: string[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('xl/worksheets/sheet1.xml');
  if (!entry) throw new Error('fixture worksheet XML missing');
  let xml = await entry.async('string');
  for (const address of addresses) {
    const pattern = new RegExp(
      `(<c[^>]*r="${address}"[^>]*>[\\s\\S]*?<f[^>]*>[\\s\\S]*?</f>)<v>[\\s\\S]*?</v>(</c>)`,
      'u',
    );
    xml = xml.replace(pattern, '$1$2');
  }
  zip.file('xl/worksheets/sheet1.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}
