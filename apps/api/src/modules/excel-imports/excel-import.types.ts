export type ExcelDiagnosticSeverity = 'blocking' | 'conflict' | 'warning' | 'info';

export interface ExcelDiagnostic {
  severity: ExcelDiagnosticSeverity;
  code: string;
  message: string;
  cell?: string | undefined;
  suggestedAction?: string;
}

export interface RawExcelCell {
  address: string;
  type: string;
  value: unknown;
  formula: string | null;
  cachedResult: unknown;
  numberFormat: string | null;
}

export interface NormalizedExcelRow {
  parentIssueKey: string | null;
  parentTitle: string | null;
  title: string | null;
  assigneeName: string | null;
  plannedStartDate: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  personDays: number | null;
  personDaysSource: 'empty' | 'formula_cache' | 'provided' | 'derived';
  isCurrentUser: boolean;
}

export interface ParsedExcelRow {
  sheetName: string;
  rowNumber: number;
  rowKind: 'task' | 'container';
  raw: Record<string, RawExcelCell | null>;
  normalized: NormalizedExcelRow;
  diagnostics: ExcelDiagnostic[];
  fingerprint: string;
}

export interface ParsedExcelWorkbook {
  dateSystem: '1900' | '1904';
  rows: ParsedExcelRow[];
  sheetSummaries: Array<{
    name: string;
    normalizedName: string;
    matchedBy: 'exact_name' | 'header';
    rowCount: number;
    taskRowCount: number;
    containerRowCount: number;
    ignoredColumns: Array<{ column: number; header: string | null }>;
    diagnostics: ExcelDiagnostic[];
  }>;
  ignoredColumns: Array<{ sheetName: string; column: number; header: string | null }>;
}

export interface ExcelContainerFacts {
  fileName: string;
  entryCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  hasExternalLinks: boolean;
  hasConnections: boolean;
}
