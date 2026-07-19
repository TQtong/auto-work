import { Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { sha256 } from '@auto-work/domain';
import ExcelJS from 'exceljs';
import type {
  ExcelDiagnostic,
  NormalizedExcelRow,
  ParsedExcelRow,
  ParsedExcelWorkbook,
  RawExcelCell,
} from './excel-import.types.js';

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 10_000;
const MAX_COLUMNS_PER_SHEET = 64;
const MAX_TOTAL_CELLS = 100_000;
const MAX_ESTIMATE_HOURS = 10_000;
const EXPECTED_SHEETS = new Set(['后端开发jira', '前端开发jira', '系统测试jira']);
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,99}-[1-9][0-9]*$/u;

type ColumnPurpose =
  | 'parentIssueKey'
  | 'parentTitle'
  | 'title'
  | 'assigneeName'
  | 'plannedStartDate'
  | 'dueDate'
  | 'estimateHours'
  | 'personDays';

const HEADER_ALIASES: Record<ColumnPurpose, string[]> = {
  parentIssueKey: ['父任务id', '父任务编号', '父任务key', '父级任务id'],
  parentTitle: ['父任务名称', '父任务标题', '父级任务名称'],
  title: ['子任务名称', '子任务标题', '任务名称', '工作项名称'],
  assigneeName: ['经办人', '负责人', '处理人', '执行人'],
  plannedStartDate: ['开始日期', '计划开始日期', '计划开始'],
  dueDate: ['到期日', '到期日期', '结束日期', '计划完成日期'],
  estimateHours: ['预估工时h', '预估工时', '预计工时h', '预计工时'],
  personDays: ['人日', '预估人日', '工作量人日'],
};

const REQUIRED_PURPOSES: ColumnPurpose[] = [
  'parentIssueKey',
  'parentTitle',
  'title',
  'assigneeName',
  'plannedStartDate',
  'dueDate',
  'estimateHours',
];

interface HeaderDetection {
  columns: Map<ColumnPurpose, number>;
  ignoredColumns: Array<{ column: number; header: string | null }>;
  diagnostics: ExcelDiagnostic[];
}

@Injectable()
export class ExcelWorkbookParserService {
  public async parse(buffer: Buffer, workdayHours: number): Promise<ParsedExcelWorkbook> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
    } catch (error) {
      throw new DomainError('EXCEL_PARSE_FAILED', 'ExcelJS 无法读取 XLSX 工作簿', {
        httpStatus: 422,
        details: { reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
      });
    }
    if (workbook.worksheets.length === 0 || workbook.worksheets.length > MAX_SHEETS) {
      throw new DomainError('EXCEL_SHEET_COUNT_INVALID', '工作表数量必须在 1 到 20 之间', {
        httpStatus: 422,
      });
    }
    const dateSystem: '1900' | '1904' = workbook.properties.date1904 ? '1904' : '1900';
    const rows: ParsedExcelRow[] = [];
    const sheetSummaries: ParsedExcelWorkbook['sheetSummaries'] = [];
    const ignoredColumns: ParsedExcelWorkbook['ignoredColumns'] = [];
    let totalCells = 0;

    for (const worksheet of workbook.worksheets) {
      const normalizedName = normalizeSheetName(worksheet.name);
      const exactName = EXPECTED_SHEETS.has(normalizedName);
      const header = this.detectHeaders(worksheet);
      const headerUsable = REQUIRED_PURPOSES.every((purpose) => header.columns.has(purpose));
      if (!exactName && !headerUsable) continue;
      if (
        worksheet.actualRowCount > MAX_ROWS_PER_SHEET ||
        worksheet.actualColumnCount > MAX_COLUMNS_PER_SHEET
      ) {
        throw new DomainError(
          'EXCEL_DIMENSION_LIMIT',
          `工作表 ${worksheet.name} 超过行列安全上限`,
          {
            httpStatus: 422,
          },
        );
      }
      totalCells += worksheet.actualRowCount * Math.max(worksheet.actualColumnCount, 1);
      if (totalCells > MAX_TOTAL_CELLS) {
        throw new DomainError('EXCEL_CELL_LIMIT', '工作簿有效单元格规模超过 100,000', {
          httpStatus: 422,
        });
      }
      const parsedRows = headerUsable
        ? this.parseSheet(worksheet, header.columns, dateSystem, workdayHours)
        : [];
      ignoredColumns.push(
        ...header.ignoredColumns.map((column) => ({ sheetName: worksheet.name, ...column })),
      );
      sheetSummaries.push({
        name: worksheet.name,
        normalizedName,
        matchedBy: exactName ? 'exact_name' : 'header',
        rowCount: parsedRows.length,
        taskRowCount: parsedRows.filter((row) => row.rowKind === 'task').length,
        containerRowCount: parsedRows.filter((row) => row.rowKind === 'container').length,
        ignoredColumns: header.ignoredColumns,
        diagnostics: header.diagnostics,
      });
      rows.push(...parsedRows);
    }
    if (sheetSummaries.length === 0) {
      throw new DomainError('EXCEL_SHEET_NOT_RECOGNIZED', '未找到目标工作表或可识别的 A:G 表头', {
        httpStatus: 422,
      });
    }
    if (rows.length === 0) {
      throw new DomainError('EXCEL_NO_DATA_ROWS', '目标工作表没有可预检的数据行', {
        httpStatus: 422,
      });
    }
    return { dateSystem, rows, sheetSummaries, ignoredColumns };
  }

  private detectHeaders(worksheet: ExcelJS.Worksheet): HeaderDetection {
    const columns = new Map<ColumnPurpose, number>();
    const ignoredColumns: HeaderDetection['ignoredColumns'] = [];
    const diagnostics: ExcelDiagnostic[] = [];
    const headerRow = worksheet.getRow(1);
    const maximum = Math.min(Math.max(worksheet.actualColumnCount, 8), MAX_COLUMNS_PER_SHEET);
    for (let column = 1; column <= maximum; column += 1) {
      const text = this.textValue(headerRow.getCell(column));
      const normalized = normalizeHeader(text);
      const purpose = (Object.entries(HEADER_ALIASES) as Array<[ColumnPurpose, string[]]>).find(
        ([, aliases]) => aliases.includes(normalized),
      )?.[0];
      if (purpose && !columns.has(purpose)) {
        columns.set(purpose, column);
      } else if (column === 8 && !normalized && !columns.has('personDays')) {
        // 已知样表 H 列可以没有标题，但以 G/8 公式保存人日缓存。
        columns.set('personDays', column);
        diagnostics.push({
          severity: 'info',
          code: 'EXCEL_HEADER_H_INFERRED',
          cell: 'H1',
          message: 'H 列无标题，已按样表结构识别为人日校验列',
        });
      } else if (text !== null) {
        ignoredColumns.push({ column, header: text });
      }
    }
    for (const purpose of REQUIRED_PURPOSES) {
      if (!columns.has(purpose)) {
        diagnostics.push({
          severity: 'blocking',
          code: 'EXCEL_REQUIRED_HEADER_MISSING',
          message: `缺少必需表头：${this.purposeLabel(purpose)}`,
          suggestedAction: '修正表头后重新上传',
        });
      }
    }
    return { columns, ignoredColumns, diagnostics };
  }

  private parseSheet(
    worksheet: ExcelJS.Worksheet,
    columns: Map<ColumnPurpose, number>,
    dateSystem: '1900' | '1904',
    workdayHours: number,
  ): ParsedExcelRow[] {
    const result: ParsedExcelRow[] = [];
    let lastParent: { issueKey: string; title: string } | null = null;
    for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const cells = Object.fromEntries(
        [...columns.entries()].map(([purpose, column]) => [purpose, row.getCell(column)]),
      ) as Partial<Record<ColumnPurpose, ExcelJS.Cell>>;
      if (Object.values(cells).every((cell) => !cell || this.isEmpty(cell))) continue;
      const diagnostics: ExcelDiagnostic[] = [];
      const parentKeyRaw = this.textValue(cells.parentIssueKey);
      const parentTitleRaw = this.textValue(cells.parentTitle);
      let parentIssueKey: string | null = null;
      let parentTitle: string | null = null;
      if (parentKeyRaw && parentTitleRaw) {
        const candidateKey = parentKeyRaw.toLocaleUpperCase();
        if (!ISSUE_KEY_PATTERN.test(candidateKey)) {
          diagnostics.push({
            severity: 'blocking',
            code: 'EXCEL_PARENT_KEY_INVALID',
            cell: cells.parentIssueKey?.address,
            message: '父任务 ID 不符合可配置 Jira issue key 基线格式',
            suggestedAction: '在预检修正父任务 ID',
          });
        } else {
          lastParent = { issueKey: candidateKey, title: parentTitleRaw };
          parentIssueKey = candidateKey;
          parentTitle = parentTitleRaw;
        }
      } else if (!parentKeyRaw && !parentTitleRaw) {
        if (lastParent) {
          parentIssueKey = lastParent.issueKey;
          parentTitle = lastParent.title;
          diagnostics.push({
            severity: 'info',
            code: 'EXCEL_PARENT_INHERITED',
            message: `已继承最近父任务 ${lastParent.issueKey}`,
          });
        } else {
          diagnostics.push({
            severity: 'blocking',
            code: 'EXCEL_PARENT_MISSING',
            message: '当前行之前没有可继承的父任务',
            suggestedAction: '在预检补全父任务 ID 和名称',
          });
        }
      } else {
        diagnostics.push({
          severity: 'conflict',
          code: 'EXCEL_PARENT_HALF_EMPTY',
          cell: parentKeyRaw ? cells.parentTitle?.address : cells.parentIssueKey?.address,
          message: '父任务 ID 与名称必须同时填写，系统不会自动拼接',
          suggestedAction: '在预检补全或清空这两个字段',
        });
      }

      const title = this.textValue(cells.title);
      const assigneeName = this.textValue(cells.assigneeName);
      if (!title && assigneeName) {
        diagnostics.push({
          severity: 'blocking',
          code: 'EXCEL_TITLE_MISSING',
          cell: cells.title?.address,
          message: '经办人存在但子任务名称为空，不能创建工作项',
          suggestedAction: '补充子任务名称或清空经办人',
        });
      } else if (title && !assigneeName) {
        diagnostics.push({
          severity: 'warning',
          code: 'EXCEL_ASSIGNEE_EMPTY',
          cell: cells.assigneeName?.address,
          message: '任务未分配，默认不进入当前用户周报',
        });
      }
      if (title && title.length > 4_000) {
        diagnostics.push({
          severity: 'blocking',
          code: 'EXCEL_TITLE_TOO_LONG',
          cell: cells.title?.address,
          message: '子任务名称超过 4,000 字符',
        });
      }

      const planned = this.dateValue(cells.plannedStartDate, dateSystem, diagnostics);
      const due = this.dateValue(cells.dueDate, dateSystem, diagnostics);
      if (planned && due && due < planned) {
        diagnostics.push({
          severity: 'blocking',
          code: 'EXCEL_DATE_RANGE_INVALID',
          message: '到期日早于开始日期',
          suggestedAction: '在预检修正开始日期或到期日',
        });
      } else if (!planned && due) {
        diagnostics.push({
          severity: 'warning',
          code: 'EXCEL_START_DATE_EMPTY',
          cell: cells.plannedStartDate?.address,
          message: '有到期日但没有计划开始日期',
        });
      }
      const effort = this.effortValues(
        cells.estimateHours,
        cells.personDays,
        workdayHours,
        diagnostics,
      );
      const rowKind: 'task' | 'container' = !title && !assigneeName ? 'container' : 'task';
      if (rowKind === 'container') {
        diagnostics.push({
          severity: 'info',
          code: 'EXCEL_PARENT_CONTAINER_SKIPPED',
          message: '父任务容器行只用于继承，不创建个人子任务',
        });
      }
      const normalized: NormalizedExcelRow = {
        parentIssueKey,
        parentTitle,
        title,
        assigneeName,
        plannedStartDate: planned,
        dueDate: due,
        estimateHours: effort.estimateHours,
        personDays: effort.personDays,
        personDaysSource: effort.personDaysSource,
        isCurrentUser: false,
      };
      const raw = Object.fromEntries(
        (Object.keys(HEADER_ALIASES) as ColumnPurpose[]).map((purpose) => [
          purpose,
          cells[purpose] ? this.rawCell(cells[purpose]) : null,
        ]),
      );
      result.push({
        sheetName: worksheet.name,
        rowNumber,
        rowKind,
        raw,
        normalized,
        diagnostics,
        fingerprint: sha256(
          JSON.stringify({
            parentIssueKey,
            title: normalizeMatchText(title),
            assignee: normalizeMatchText(assigneeName),
            planned,
            due,
          }),
        ),
      });
    }
    return result;
  }

  private dateValue(
    cell: ExcelJS.Cell | undefined,
    dateSystem: '1900' | '1904',
    diagnostics: ExcelDiagnostic[],
  ): string | null {
    if (!cell || this.isEmpty(cell)) return null;
    const value = this.effectiveValue(cell, diagnostics, 'EXCEL_DATE_FORMULA_CACHE_MISSING');
    if (value === null || value === undefined) return null;
    let parsed: string | null = null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      parsed = this.formatUtcDate(value);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      const epoch = Date.UTC(
        dateSystem === '1904' ? 1904 : 1899,
        dateSystem === '1904' ? 0 : 11,
        dateSystem === '1904' ? 1 : 30,
      );
      parsed = this.formatUtcDate(new Date(epoch + Math.trunc(value) * 86_400_000));
      if (!Number.isInteger(value)) {
        diagnostics.push({
          severity: 'info',
          code: 'EXCEL_DATE_TIME_TRUNCATED',
          cell: cell.address,
          message: '日期单元格含时间部分，已按业务日期截断',
        });
      }
    } else if (typeof value === 'string') {
      const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?$/u.exec(value.trim());
      if (match) {
        const candidate = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
        const date = new Date(`${candidate}T00:00:00.000Z`);
        if (!Number.isNaN(date.getTime()) && this.formatUtcDate(date) === candidate)
          parsed = candidate;
      }
    }
    const maximum = `${new Date().getUTCFullYear() + 10}-12-31`;
    if (!parsed || parsed < '2000-01-01' || parsed > maximum) {
      diagnostics.push({
        severity: 'blocking',
        code: 'EXCEL_DATE_INVALID',
        cell: cell.address,
        message: '日期无法按严格格式解析，或超出 2000 年至当前年份后 10 年范围',
        suggestedAction: '使用真实日期单元格或 YYYY-MM-DD',
      });
      return null;
    }
    return parsed;
  }

  private effortValues(
    estimateCell: ExcelJS.Cell | undefined,
    personDaysCell: ExcelJS.Cell | undefined,
    workdayHours: number,
    diagnostics: ExcelDiagnostic[],
  ): Pick<NormalizedExcelRow, 'estimateHours' | 'personDays' | 'personDaysSource'> {
    const estimateValue = estimateCell
      ? this.effectiveValue(estimateCell, diagnostics, 'EXCEL_ESTIMATE_FORMULA_CACHE_MISSING')
      : null;
    if (estimateValue === null || estimateValue === undefined || estimateValue === '') {
      if (personDaysCell && !this.isEmpty(personDaysCell)) {
        diagnostics.push({
          severity: 'info',
          code: 'EXCEL_EMPTY_HOURS_KEEP_NULL',
          cell: estimateCell?.address,
          message: '预估工时为空，即使人日公式缓存为 0 也保持工时和人日为 null',
        });
      }
      return { estimateHours: null, personDays: null, personDaysSource: 'empty' };
    }
    if (
      typeof estimateValue !== 'number' ||
      !Number.isFinite(estimateValue) ||
      estimateValue < 0 ||
      estimateValue > MAX_ESTIMATE_HOURS
    ) {
      diagnostics.push({
        severity: 'blocking',
        code: 'EXCEL_ESTIMATE_INVALID',
        cell: estimateCell?.address,
        message: '预估工时必须是 0 到 10,000 之间的数值，空值与 0 不同',
      });
      return { estimateHours: null, personDays: null, personDaysSource: 'empty' };
    }
    const derived = estimateValue / workdayHours;
    if (!personDaysCell || this.isEmpty(personDaysCell)) {
      diagnostics.push({
        severity: 'info',
        code: 'EXCEL_PERSON_DAYS_DERIVED',
        cell: personDaysCell?.address,
        message: `人日为空，按 ${workdayHours} 小时/人日派生`,
      });
      return { estimateHours: estimateValue, personDays: derived, personDaysSource: 'derived' };
    }
    const personDaysValue = this.effectiveValue(
      personDaysCell,
      diagnostics,
      'EXCEL_PERSON_DAYS_FORMULA_CACHE_MISSING',
    );
    if (typeof personDaysValue !== 'number' || !Number.isFinite(personDaysValue)) {
      diagnostics.push({
        severity: 'warning',
        code: 'EXCEL_PERSON_DAYS_INVALID',
        cell: personDaysCell.address,
        message: '人日不是有效数值，提交时使用按工时派生的值',
      });
      return { estimateHours: estimateValue, personDays: derived, personDaysSource: 'derived' };
    }
    if (Math.abs(personDaysValue - derived) > 0.01) {
      diagnostics.push({
        severity: 'warning',
        code: 'EXCEL_PERSON_DAYS_MISMATCH',
        cell: personDaysCell.address,
        message: `人日 ${personDaysValue} 与工时换算值 ${derived.toFixed(4)} 不一致，默认采用工时换算`,
        suggestedAction: '在预检确认工时或换算参数',
      });
    }
    return {
      estimateHours: estimateValue,
      personDays: derived,
      personDaysSource: cellFormula(personDaysCell) ? 'formula_cache' : 'provided',
    };
  }

  private effectiveValue(
    cell: ExcelJS.Cell,
    diagnostics: ExcelDiagnostic[],
    missingFormulaCode: string,
  ): unknown {
    const formula = cellFormula(cell);
    if (!formula) return cell.value;
    const result = cell.result;
    if (
      result === null ||
      result === undefined ||
      (typeof result === 'object' && 'error' in result)
    ) {
      diagnostics.push({
        severity: 'blocking',
        code: missingFormulaCode,
        cell: cell.address,
        message: '公式单元格缺少可用缓存结果，系统不会调用 Excel 或重算外部公式',
        suggestedAction: '在可信 Excel 中计算并保存后重新上传，或在预检填写本次值',
      });
      return null;
    }
    return result;
  }

  private rawCell(cell: ExcelJS.Cell): RawExcelCell {
    return {
      address: cell.address,
      type: String(cell.type),
      value: serializableCellValue(cell.value),
      formula: cellFormula(cell),
      cachedResult: serializableCellValue(cell.result),
      numberFormat: cell.numFmt || null,
    };
  }

  private textValue(cell: ExcelJS.Cell | undefined): string | null {
    if (!cell || this.isEmpty(cell)) return null;
    const value = cellFormula(cell) ? cell.result : cell.value;
    if (typeof value === 'string' || typeof value === 'number') {
      const result = String(value).normalize('NFC').trim();
      return result || null;
    }
    if (value && typeof value === 'object') {
      if ('text' in value && typeof value.text === 'string')
        return value.text.normalize('NFC').trim();
      if ('richText' in value && Array.isArray(value.richText)) {
        const result = value.richText
          .map((part) =>
            part && typeof part === 'object' && 'text' in part ? String(part.text) : '',
          )
          .join('')
          .normalize('NFC')
          .trim();
        return result || null;
      }
    }
    return null;
  }

  private isEmpty(cell: ExcelJS.Cell): boolean {
    if (cellFormula(cell)) return false;
    const value = cell.value;
    return value === null || value === undefined || value === '';
  }

  private formatUtcDate(value: Date): string {
    return `${value.getUTCFullYear().toString().padStart(4, '0')}-${(value.getUTCMonth() + 1).toString().padStart(2, '0')}-${value.getUTCDate().toString().padStart(2, '0')}`;
  }

  private purposeLabel(purpose: ColumnPurpose): string {
    return {
      parentIssueKey: '父任务 ID',
      parentTitle: '父任务名称',
      title: '子任务名称',
      assigneeName: '经办人',
      plannedStartDate: '开始日期',
      dueDate: '到期日',
      estimateHours: '预估工时 h',
      personDays: '人日',
    }[purpose];
  }
}

export function normalizeMatchText(value: string | null): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
}

function normalizeSheetName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function normalizeHeader(value: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s()（）【】:：._-]+/gu, '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .toLocaleLowerCase('zh-CN');
}

function cellFormula(cell: ExcelJS.Cell): string | null {
  return typeof cell.formula === 'string' && cell.formula ? cell.formula : null;
}

function serializableCellValue(value: unknown): unknown {
  if (value instanceof Date) return { kind: 'date', iso: value.toISOString() };
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => serializableCellValue(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [key, serializableCellValue(item)]),
    );
  }
  return typeof value === 'bigint' ? value.toString() : null;
}
