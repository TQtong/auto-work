import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { QuarterlyExportFacts, QuarterlyGeneratedArtifact } from './quarterly-export.types.js';

const COLORS = {
  blue: '2E74B5',
  paleBlue: 'D9EAF7',
  paleGray: 'F2F4F7',
  dark: '1F2937',
  white: 'FFFFFF',
  amber: 'FFF2CC',
};

@Injectable()
export class QuarterlyExportXlsxService {
  public async generate(facts: QuarterlyExportFacts): Promise<QuarterlyGeneratedArtifact> {
    // 工作簿的创建/修改时间固定为确认时间，避免安全重放因当前时钟产生无意义差异。
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Auto Work';
    workbook.company = 'Auto Work';
    workbook.subject = `${facts.review.name}季度绩效自评`;
    workbook.title = facts.review.name;
    workbook.created = new Date(facts.confirmation.confirmedAt);
    workbook.modified = new Date(facts.confirmation.confirmedAt);
    workbook.calcProperties.fullCalcOnLoad = true;

    // 五张表分别服务阅读、复核和机器分析；数值、日期、公式与超链接均保留原生单元格类型。
    this.addReviewSheet(workbook, facts);
    this.addScoreSheet(workbook, facts);
    this.addAchievementSheet(workbook, facts);
    this.addEvidenceSheet(workbook, facts);
    this.addDataNotesSheet(workbook, facts);

    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    // 生成后重新载入真实字节做结构验收，不把“生成调用未抛错”等同于文件可交付。
    const qaReport = await this.inspect(bytes, facts);
    return {
      buffer: bytes,
      extension: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      rendererFacts: {
        engine: 'exceljs',
        sheetNames: workbook.worksheets.map((sheet) => sheet.name),
        formulaRecalculationOnOpen: true,
        frozenConfirmationSnapshotHash: facts.confirmation.snapshotHash,
      },
      qaReport,
    };
  }

  private addReviewSheet(workbook: ExcelJS.Workbook, facts: QuarterlyExportFacts): void {
    const sheet = workbook.addWorksheet('绩效自评', {
      views: [{ state: 'frozen', ySplit: 3 }],
      pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    sheet.columns = [
      { key: 'label', width: 22 },
      { key: 'content', width: 92 },
    ];
    this.title(sheet, `${facts.review.name}｜季度绩效自评`, 2);
    const rows: Array<[string, string | number | Date]> = [
      ['周期', `${facts.review.periodStart} 至 ${facts.review.periodEnd}`],
      ['确认时间', new Date(facts.confirmation.confirmedAt)],
      ['确认快照', facts.confirmation.snapshotHash],
      ['最终得分', facts.calculation.finalTotal],
      ['总体概述', facts.narrative.content.overallOverview],
      ['协作与成长', facts.narrative.content.collaborationAndGrowth],
      ['问题与改进', facts.narrative.content.problemsAndImprovements],
      ['下周期计划', facts.narrative.content.nextPeriodPlan],
      ['完整性说明', JSON.stringify(facts.completeness, null, 2)],
      ['已确认知情项', JSON.stringify(facts.acknowledgements, null, 2)],
    ];
    for (const [label, content] of rows) {
      const row = sheet.addRow([label, content]);
      row.getCell(1).font = { bold: true, color: { argb: COLORS.dark } };
      row.getCell(1).fill = this.fill(COLORS.paleGray);
      row.getCell(2).alignment = { vertical: 'top', wrapText: true };
      row.height = label === '完整性说明' ? 64 : label === '已确认知情项' ? 30 : 28;
    }
    sheet.getCell('B5').numFmt = '0.0';
    sheet.getCell('B3').numFmt = 'yyyy-mm-dd hh:mm';
    sheet.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
    });
  }

  private addScoreSheet(workbook: ExcelJS.Workbook, facts: QuarterlyExportFacts): void {
    const sheet = workbook.addWorksheet('指标评分', {
      views: [{ state: 'frozen', ySplit: 2 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    sheet.columns = [
      { header: '指标编码', key: 'code', width: 15 },
      { header: '指标名称', key: 'name', width: 23 },
      { header: '定义', key: 'definition', width: 38 },
      { header: '权重', key: 'weight', width: 12 },
      { header: 'AI 建议（非用户评分）', key: 'aiScore', width: 20 },
      { header: 'AI 建议范围', key: 'aiRange', width: 18 },
      { header: 'AI 理由与不确定性', key: 'aiReason', width: 38 },
      { header: '用户评分', key: 'userScore', width: 14 },
      { header: '用户理由', key: 'userReason', width: 40 },
      { header: '未舍入贡献', key: 'contribution', width: 16 },
      { header: '校验状态', key: 'validation', width: 14 },
    ];
    this.header(sheet.getRow(1));
    const scoreByMetric = new Map(facts.scores.map((score) => [score.metricId, score]));
    const metrics = facts.template.metrics.filter((metric) => metric.enabled);
    for (const metric of metrics) {
      const score = scoreByMetric.get(metric.id);
      const row = sheet.addRow({
        code: metric.code,
        name: metric.name,
        definition: metric.definition,
        weight: metric.weight,
        aiScore: score?.aiSuggestedScore ?? null,
        aiRange:
          score?.aiSuggestedMinimum == null || score.aiSuggestedMaximum == null
            ? ''
            : `${score.aiSuggestedMinimum} ～ ${score.aiSuggestedMaximum}`,
        aiReason: score?.aiReason
          ? `${score.aiReason}\n不确定性：${score.aiUncertainty ?? '未说明'}\n证据缺口：${this.listText(score.aiEvidenceGaps)}`
          : '',
        userScore: score?.userScore ?? null,
        userReason: score?.userReason ?? '',
        validation: score?.validationStatus ?? 'missing',
      });
      row.getCell('J').value = {
        formula: this.contributionFormula(facts.template.formulaType, row.number),
        result: score?.rawContribution ?? 0,
      };
      row.getCell('D').numFmt = '0.00';
      row.getCell('E').numFmt = '0.00';
      row.getCell('H').numFmt = '0.00';
      row.getCell('J').numFmt = '0.0000';
      row.getCell('H').dataValidation = {
        type: 'decimal',
        operator: 'between',
        allowBlank: !metric.required,
        showErrorMessage: true,
        errorTitle: '评分超出范围',
        error: `请输入 ${metric.minimum} 至 ${metric.maximum} 之间的分数，步长 ${metric.step}`,
        formulae: [metric.minimum, metric.maximum],
      };
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true };
      });
      row.getCell('E').fill = this.fill(COLORS.amber);
      row.height = 58;
    }

    const totalRow = sheet.addRow({
      name: '合计',
      userReason: `口径：${facts.template.formulaType}；舍入：${facts.template.roundingRule}`,
    });
    const firstDataRow = 2;
    const lastDataRow = Math.max(firstDataRow, totalRow.number - 1);
    totalRow.getCell('J').value = {
      formula: this.roundingFormula(
        facts.template.roundingRule,
        `SUM(J${firstDataRow}:J${lastDataRow})`,
      ),
      result: facts.calculation.finalTotal,
    };
    totalRow.getCell('J').numFmt = '0.0';
    totalRow.font = { bold: true };
    totalRow.fill = this.fill(COLORS.paleBlue);
    totalRow.alignment = { vertical: 'middle', wrapText: true };
    totalRow.height = 38;
    sheet.autoFilter = { from: 'A1', to: `K${lastDataRow}` };
  }

  private addAchievementSheet(workbook: ExcelJS.Workbook, facts: QuarterlyExportFacts): void {
    const sheet = workbook.addWorksheet('成果明细', {
      views: [{ state: 'frozen', ySplit: 1 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    sheet.columns = [
      { header: '成果标题', key: 'title', width: 28 },
      { header: '项目', key: 'project', width: 20 },
      { header: '情境', key: 'situation', width: 30 },
      { header: '行动', key: 'action', width: 36 },
      { header: '结果', key: 'result', width: 36 },
      { header: '影响', key: 'impact', width: 36 },
      { header: '贡献边界', key: 'boundary', width: 30 },
      { header: '开始日期', key: 'start', width: 13 },
      { header: '结束日期', key: 'end', width: 13 },
      { header: '关联指标', key: 'metrics', width: 28 },
    ];
    this.header(sheet.getRow(1));
    const metricById = new Map(facts.template.metrics.map((metric) => [metric.id, metric.name]));
    for (const achievement of facts.achievements) {
      const row = sheet.addRow({
        title: achievement.title,
        project: achievement.projectName ?? '未归属项目',
        situation: achievement.situation,
        action: achievement.action,
        result: achievement.result,
        impact: achievement.impact,
        boundary: achievement.contributionBoundary,
        start: this.businessDate(achievement.periodStart),
        end: this.businessDate(achievement.periodEnd),
        metrics: achievement.metricLinks
          .map((link) => metricById.get(link.metricId) ?? link.metricId)
          .join('、'),
      });
      row.getCell('H').numFmt = 'yyyy-mm-dd';
      row.getCell('I').numFmt = 'yyyy-mm-dd';
      row.eachCell((cell) => (cell.alignment = { vertical: 'top', wrapText: true }));
      row.height = 54;
    }
    sheet.autoFilter = { from: 'A1', to: `J${Math.max(1, sheet.rowCount)}` };
  }

  private addEvidenceSheet(workbook: ExcelJS.Workbook, facts: QuarterlyExportFacts): void {
    const sheet = workbook.addWorksheet('证据索引', {
      views: [{ state: 'frozen', ySplit: 1 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    sheet.columns = [
      { header: '成果', key: 'achievement', width: 28 },
      { header: '证据类型', key: 'type', width: 16 },
      { header: '外部键', key: 'externalKey', width: 22 },
      { header: '证据标题', key: 'title', width: 34 },
      { header: '发生时间', key: 'eventAt', width: 20 },
      { header: '贡献角度', key: 'angle', width: 36 },
      { header: '可用状态', key: 'availability', width: 15 },
      { header: '链接', key: 'url', width: 42 },
      { header: '内容哈希', key: 'hash', width: 68 },
    ];
    this.header(sheet.getRow(1));
    for (const achievement of facts.achievements) {
      for (const evidence of achievement.evidences) {
        const row = sheet.addRow({
          achievement: achievement.title,
          type: evidence.sourceType,
          externalKey: evidence.externalKey ?? '',
          title: evidence.title,
          eventAt: evidence.eventAt ? new Date(evidence.eventAt) : null,
          angle: evidence.contributionAngle,
          availability: evidence.availabilityState,
          url: evidence.url ?? '',
          hash: evidence.sourceContentHash,
        });
        if (evidence.url) {
          row.getCell('H').value = {
            text: evidence.url,
            hyperlink: evidence.url,
            tooltip: evidence.title,
          };
          row.getCell('H').font = { color: { argb: '0563C1' }, underline: true };
        }
        row.getCell('E').numFmt = 'yyyy-mm-dd hh:mm';
        row.eachCell((cell) => (cell.alignment = { vertical: 'top', wrapText: true }));
        row.height = 38;
      }
    }
    sheet.autoFilter = { from: 'A1', to: `I${Math.max(1, sheet.rowCount)}` };
  }

  private addDataNotesSheet(workbook: ExcelJS.Workbook, facts: QuarterlyExportFacts): void {
    const sheet = workbook.addWorksheet('数据说明', {
      views: [{ state: 'frozen', ySplit: 2 }],
      pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    sheet.columns = [
      { key: 'item', width: 28 },
      { key: 'value', width: 96 },
    ];
    this.title(sheet, '数据口径、快照与 AI 使用说明', 2);
    const rows: Array<[string, string]> = [
      ['确认状态', facts.confirmation.status],
      ['确认快照哈希', facts.confirmation.snapshotHash],
      ['成果快照哈希', facts.confirmation.achievementsHash],
      ['评分快照哈希', facts.confirmation.scoresHash],
      ['指标模板版本', `${facts.template.id} / v${facts.template.versionNo}`],
      ['指标模板内容哈希', facts.template.contentHash],
      ['计算公式', facts.template.formulaType],
      ['舍入规则', facts.template.roundingRule],
      ['完整性事实', JSON.stringify(facts.completeness, null, 2)],
      [
        'AI 使用声明',
        'AI 仅生成建议分数或正文草稿；用户评分、用户理由和最终确认均由用户明确操作。黄色单元格为 AI 建议，不等同于用户评分。',
      ],
      [
        '不可变性声明',
        '本文件只使用确认时冻结的成果、证据、指标、评分、正文和完整性快照生成；确认后的源数据变化不会改写本文件内容。',
      ],
    ];
    for (const [item, value] of rows) {
      const row = sheet.addRow([item, value]);
      row.getCell(1).font = { bold: true };
      row.getCell(1).fill = this.fill(COLORS.paleGray);
      row.alignment = { vertical: 'top', wrapText: true };
      row.height = item === '完整性事实' ? 64 : item.endsWith('声明') ? 54 : 28;
    }
  }

  private async inspect(buffer: Buffer, facts: QuarterlyExportFacts) {
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
    checks.push({
      name: 'zip_magic',
      passed: buffer.subarray(0, 2).toString('hex') === '504b',
      detail: `magic=${buffer.subarray(0, 4).toString('hex')}`,
    });
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const requiredSheets = ['绩效自评', '指标评分', '成果明细', '证据索引', '数据说明'];
    checks.push({
      name: 'required_sheets',
      passed: requiredSheets.every((name) => loaded.getWorksheet(name)),
      detail: loaded.worksheets.map((sheet) => sheet.name).join(','),
    });
    const scoreSheet = loaded.getWorksheet('指标评分');
    const totalCell = scoreSheet?.getCell(
      `J${(facts.template.metrics.filter((metric) => metric.enabled).length || 1) + 2}`,
    );
    const totalValue = totalCell?.value;
    const cachedResult =
      totalValue && typeof totalValue === 'object' && 'result' in totalValue
        ? Number(totalValue.result)
        : Number.NaN;
    checks.push({
      name: 'score_formula_reconciled',
      passed:
        Boolean(totalValue && typeof totalValue === 'object' && 'formula' in totalValue) &&
        Math.abs(cachedResult - facts.calculation.finalTotal) < 1e-9,
      detail: `cached=${cachedResult}; confirmed=${facts.calculation.finalTotal}`,
    });
    const typedDates = loaded
      .getWorksheet('成果明细')
      ?.getColumn('H')
      .values.slice(2)
      .every((value) => value instanceof Date);
    checks.push({
      name: 'typed_business_dates',
      passed: typedDates !== false,
      detail: typedDates === false ? '存在文本日期' : '成果日期均为 Excel 日期类型',
    });
    return { passed: checks.every((check) => check.passed), checks };
  }

  private contributionFormula(
    formulaType: QuarterlyExportFacts['template']['formulaType'],
    row: number,
  ) {
    if (formulaType === 'weighted_average_100') return `IF(H${row}="",0,H${row}*D${row}/100)`;
    if (formulaType === 'weighted_sum') return `IF(H${row}="",0,H${row}*D${row})`;
    return `IF(H${row}="",0,H${row})`;
  }

  private roundingFormula(rule: QuarterlyExportFacts['template']['roundingRule'], raw: string) {
    if (rule === 'half_up_integer') return `ROUND(${raw},0)`;
    if (rule === 'half_up_1_decimal') return `ROUND(${raw},1)`;
    if (rule === 'floor_integer') return `ROUNDDOWN(${raw},0)`;
    if (rule === 'ceil_integer') return `ROUNDUP(${raw},0)`;
    return raw;
  }

  private title(sheet: ExcelJS.Worksheet, value: string, columns: number): void {
    sheet.mergeCells(1, 1, 1, columns);
    const cell = sheet.getCell(1, 1);
    cell.value = value;
    cell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: COLORS.white } };
    cell.fill = this.fill(COLORS.blue);
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    sheet.getRow(1).height = 30;
  }

  private header(row: ExcelJS.Row): void {
    row.font = { name: 'Calibri', size: 11, bold: true, color: { argb: COLORS.white } };
    row.fill = this.fill(COLORS.blue);
    row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    row.height = 28;
  }

  private fill(argb: string): ExcelJS.Fill {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  }

  private businessDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }

  private listText(values: unknown[]): string {
    return values
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join('；');
  }
}
