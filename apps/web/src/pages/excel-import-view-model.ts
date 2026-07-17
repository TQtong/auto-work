import type { ExcelDiagnosticSeverity, ExcelImportRow } from '../api/types.js';

export interface ExcelImportFilters {
  severity?: ExcelDiagnosticSeverity;
  sheetName?: string;
  action?: ExcelImportRow['proposedAction'];
}

export function filterExcelRows(
  rows: ExcelImportRow[],
  filters: ExcelImportFilters,
): ExcelImportRow[] {
  // 多个筛选条件取交集；严重度则在单行的全部诊断中匹配，不能只看最高等级。
  return rows.filter(
    (row) =>
      (!filters.severity ||
        row.diagnostics.some((diagnostic) => diagnostic.severity === filters.severity)) &&
      (!filters.sheetName || row.sheetName === filters.sheetName) &&
      (!filters.action || row.proposedAction === filters.action),
  );
}

export function actionLabel(action: ExcelImportRow['proposedAction']): string {
  return {
    create_excel: '创建 Excel 任务',
    link_jira: '链接并补充 Jira',
    skip: '跳过',
    conflict: '待处理冲突',
    blocked: '阻断',
  }[action];
}

export function diagnosticColor(
  severity: ExcelDiagnosticSeverity,
): 'error' | 'warning' | 'gold' | 'blue' {
  const colors: Record<ExcelDiagnosticSeverity, 'error' | 'warning' | 'gold' | 'blue'> = {
    blocking: 'error',
    conflict: 'warning',
    warning: 'gold',
    info: 'blue',
  };
  return colors[severity];
}
