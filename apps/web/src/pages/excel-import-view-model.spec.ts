import { describe, expect, it } from 'vitest';
import type { ExcelImportRow } from '../api/types.js';
import { actionLabel, diagnosticColor, filterExcelRows } from './excel-import-view-model.js';

const rows = [
  {
    id: 'blocking',
    sheetName: '后端开发jira',
    proposedAction: 'blocked',
    diagnostics: [{ severity: 'blocking', code: 'DATE', message: '日期错误' }],
  },
  {
    id: 'warning',
    sheetName: '前端开发jira',
    proposedAction: 'create_excel',
    diagnostics: [{ severity: 'warning', code: 'ASSIGNEE', message: '身份未匹配' }],
  },
] as ExcelImportRow[];

describe('Excel 预检页面筛选', () => {
  it('严重度、工作表和动作条件同时生效', () => {
    expect(filterExcelRows(rows, { severity: 'blocking' }).map((row) => row.id)).toEqual([
      'blocking',
    ]);
    expect(filterExcelRows(rows, { sheetName: '前端开发jira' }).map((row) => row.id)).toEqual([
      'warning',
    ]);
    expect(filterExcelRows(rows, { action: 'create_excel' }).map((row) => row.id)).toEqual([
      'warning',
    ]);
  });

  it('用户可读标签与严重度颜色保持稳定', () => {
    expect(actionLabel('link_jira')).toBe('链接并补充 Jira');
    expect(diagnosticColor('conflict')).toBe('warning');
  });
});
