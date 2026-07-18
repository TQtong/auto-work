import { Injectable } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import yauzl, { type Entry } from 'yauzl';
import type { QuarterlyExportFacts, QuarterlyGeneratedArtifact } from './quarterly-export.types.js';

const BLUE = '2E74B5';
const DARK_BLUE = '1F4D78';
const LIGHT_GRAY = 'F2F4F7';
const TABLE_WIDTH = 9_360;

@Injectable()
export class QuarterlyExportDocxService {
  public async generate(facts: QuarterlyExportFacts): Promise<QuarterlyGeneratedArtifact> {
    // 页面、边距、表格宽度和字体在代码中显式固定，保证不同 Office 环境下仍有稳定分页基线。
    const document = new Document({
      creator: 'Auto Work',
      title: `${facts.review.name}季度绩效自评`,
      subject: '已确认的季度绩效自评不可变快照',
      description: `确认快照 ${facts.confirmation.snapshotHash}`,
      styles: this.styles(),
      sections: [
        {
          properties: {
            page: {
              size: { width: 12_240, height: 15_840 },
              margin: {
                top: 1_440,
                right: 1_440,
                bottom: 1_440,
                left: 1_440,
                header: 708,
                footer: 708,
              },
            },
          },
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: 'AUTO WORK', bold: true, color: BLUE, size: 18 }),
                    new TextRun({ text: '  /  已确认季度绩效自评', color: '667085', size: 18 }),
                  ],
                  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BLUE } },
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({ text: '内部材料  ·  第 ', color: '667085', size: 18 }),
                    new TextRun({ children: [PageNumber.CURRENT], color: '667085', size: 18 }),
                    new TextRun({ text: ' 页 / 共 ', color: '667085', size: 18 }),
                    new TextRun({ children: [PageNumber.TOTAL_PAGES], color: '667085', size: 18 }),
                    new TextRun({ text: ' 页', color: '667085', size: 18 }),
                  ],
                }),
              ],
            }),
          },
          children: this.content(facts),
        },
      ],
    });
    const buffer = await Packer.toBuffer(document);
    // 直接检查 OOXML 部件与关系，确保正文、页眉页脚和证据外链确实写入最终 DOCX。
    const qaReport = await this.inspect(buffer, facts);
    return {
      buffer,
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      rendererFacts: {
        engine: 'docx',
        designPreset: 'standard_business_brief',
        headerPattern: 'editorial_cover',
        pageSize: 'Letter portrait',
        usableWidthDxa: TABLE_WIDTH,
        frozenConfirmationSnapshotHash: facts.confirmation.snapshotHash,
      },
      qaReport,
    };
  }

  private content(facts: QuarterlyExportFacts): Array<Paragraph | Table> {
    const output: Array<Paragraph | Table> = [
      new Paragraph({
        spacing: { before: 560, after: 120 },
        children: [
          new TextRun({
            text: 'QUARTERLY REVIEW',
            color: BLUE,
            bold: true,
            size: 20,
            characterSpacing: 60,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 180 },
        children: [
          new TextRun({ text: facts.review.name, bold: true, color: DARK_BLUE, size: 44 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 420 },
        children: [
          new TextRun({
            text: `${facts.review.periodStart} — ${facts.review.periodEnd}`,
            color: '475467',
            size: 24,
          }),
        ],
      }),
      this.factTable([
        ['最终得分', String(facts.calculation.finalTotal)],
        ['确认时间', this.dateTime(facts.confirmation.confirmedAt)],
        ['正文来源', this.originLabel(facts.narrative.origin)],
        ['确认快照', facts.confirmation.snapshotHash],
      ]),
      new Paragraph({ children: [new PageBreak()] }),
      this.heading('总体概述', HeadingLevel.HEADING_1),
      this.body(facts.narrative.content.overallOverview),
      this.heading('核心成果', HeadingLevel.HEADING_1),
    ];

    const achievementById = new Map(
      facts.achievements.map((achievement) => [achievement.id, achievement]),
    );
    const metricById = new Map(facts.template.metrics.map((metric) => [metric.id, metric.name]));
    for (const section of facts.narrative.content.coreAchievements) {
      output.push(this.heading(section.heading, HeadingLevel.HEADING_2));
      output.push(this.body(section.body));
      const references = section.achievementIds
        .map((id) => achievementById.get(id)?.title)
        .filter((value): value is string => Boolean(value));
      const metrics = section.metricIds
        .map((id) => metricById.get(id))
        .filter((value): value is string => Boolean(value));
      if (references.length > 0 || metrics.length > 0) {
        output.push(
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun({ text: '引用成果：', bold: true, color: DARK_BLUE }),
              new TextRun(references.join('、') || '无'),
              new TextRun({ text: '    关联指标：', bold: true, color: DARK_BLUE }),
              new TextRun(metrics.join('、') || '无'),
            ],
          }),
        );
      }
    }

    output.push(this.heading('指标评分', HeadingLevel.HEADING_1));
    output.push(this.scoreTable(facts));
    output.push(
      new Paragraph({
        spacing: { before: 100, after: 160 },
        children: [
          new TextRun({ text: '评分口径：', bold: true }),
          new TextRun(
            `${facts.template.formulaType}；舍入规则：${facts.template.roundingRule}；最终得分：${facts.calculation.finalTotal}`,
          ),
        ],
      }),
    );

    output.push(this.heading('成果与贡献边界', HeadingLevel.HEADING_1));
    for (const [index, achievement] of facts.achievements.entries()) {
      output.push(this.heading(`${index + 1}. ${achievement.title}`, HeadingLevel.HEADING_2));
      output.push(this.labelBody('项目', achievement.projectName ?? '未归属项目'));
      output.push(this.labelBody('情境', achievement.situation));
      output.push(this.labelBody('行动', achievement.action));
      output.push(this.labelBody('结果', achievement.result));
      output.push(this.labelBody('影响', achievement.impact));
      output.push(this.labelBody('贡献边界', achievement.contributionBoundary));
    }

    output.push(this.heading('协作与成长', HeadingLevel.HEADING_1));
    output.push(this.body(facts.narrative.content.collaborationAndGrowth));
    output.push(this.heading('问题与改进', HeadingLevel.HEADING_1));
    output.push(this.body(facts.narrative.content.problemsAndImprovements));
    output.push(this.heading('下周期计划', HeadingLevel.HEADING_1));
    output.push(this.body(facts.narrative.content.nextPeriodPlan));
    output.push(this.heading('证据附录', HeadingLevel.HEADING_1));
    output.push(...this.evidenceAppendix(facts));
    output.push(this.heading('生成与完整性说明', HeadingLevel.HEADING_1));
    output.push(
      this.body(
        '本文档仅根据确认时冻结的成果、证据、指标、用户评分、正文与完整性快照生成。后续源数据或季度自评的修改不会改写本制品。AI 仅提供建议分数或正文草稿；用户评分及最终确认由用户明确完成。',
      ),
    );
    output.push(this.labelBody('完整性事实', JSON.stringify(facts.completeness, null, 2)));
    output.push(this.labelBody('确认快照哈希', facts.confirmation.snapshotHash));
    output.push(this.labelBody('成果快照哈希', facts.confirmation.achievementsHash));
    output.push(this.labelBody('评分快照哈希', facts.confirmation.scoresHash));
    return output;
  }

  private scoreTable(facts: QuarterlyExportFacts): Table {
    const scoreByMetric = new Map(facts.scores.map((score) => [score.metricId, score]));
    const header = this.tableRow(
      ['指标', '权重', 'AI 建议', '用户评分', '用户理由', '贡献'],
      [2_100, 850, 1_050, 1_050, 3_050, 1_260],
      true,
    );
    const rows = facts.template.metrics
      .filter((metric) => metric.enabled)
      .map((metric) => {
        const score = scoreByMetric.get(metric.id);
        return this.tableRow(
          [
            metric.name,
            String(metric.weight),
            score?.aiSuggestedScore == null ? '未生成' : `${score.aiSuggestedScore}（仅建议）`,
            score?.userScore == null ? '未填写' : String(score.userScore),
            score?.userReason ?? '',
            score?.rawContribution == null ? '—' : String(score.rawContribution),
          ],
          [2_100, 850, 1_050, 1_050, 3_050, 1_260],
          false,
        );
      });
    return new Table({
      width: { size: TABLE_WIDTH, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      indent: { size: 120, type: WidthType.DXA },
      rows: [header, ...rows],
    });
  }

  private factTable(rows: Array<[string, string]>): Table {
    return new Table({
      width: { size: TABLE_WIDTH, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      indent: { size: 120, type: WidthType.DXA },
      rows: rows.map(
        ([label, value]) =>
          new TableRow({
            cantSplit: true,
            children: [this.cell(label, 1_600, true), this.cell(value, 7_760, false)],
          }),
      ),
    });
  }

  private evidenceAppendix(facts: QuarterlyExportFacts): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    let index = 0;
    for (const achievement of facts.achievements) {
      for (const evidence of achievement.evidences) {
        index += 1;
        const children: Array<TextRun | ExternalHyperlink> = [
          new TextRun({ text: `${index}. ${evidence.title}`, bold: true, color: DARK_BLUE }),
          new TextRun({
            text: `\n成果：${achievement.title}｜类型：${evidence.sourceType}｜状态：${evidence.availabilityState}`,
          }),
          new TextRun({ text: `\n贡献角度：${evidence.contributionAngle}` }),
        ];
        if (evidence.url) {
          children.push(new TextRun('\n'));
          children.push(
            new ExternalHyperlink({
              link: evidence.url,
              children: [new TextRun({ text: evidence.url, color: '0563C1', underline: {} })],
            }),
          );
        }
        paragraphs.push(new Paragraph({ children, spacing: { after: 140 }, keepNext: false }));
      }
    }
    if (paragraphs.length === 0) paragraphs.push(this.body('确认快照中没有证据条目。'));
    return paragraphs;
  }

  private tableRow(values: string[], widths: number[], header: boolean): TableRow {
    return new TableRow({
      tableHeader: header,
      cantSplit: true,
      children: values.map((value, index) => this.cell(value, widths[index] ?? 1_000, header)),
    });
  }

  private cell(value: string, width: number, header: boolean): TableCell {
    return new TableCell({
      width: { size: width, type: WidthType.DXA },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      ...(header ? { shading: { type: ShadingType.CLEAR, fill: LIGHT_GRAY, color: 'auto' } } : {}),
      children: [
        new Paragraph({
          spacing: { after: 0 },
          children: [
            new TextRun({ text: value, bold: header, color: header ? DARK_BLUE : '111827' }),
          ],
        }),
      ],
    });
  }

  private heading(
    text: string,
    level: (typeof HeadingLevel)[keyof typeof HeadingLevel],
  ): Paragraph {
    return new Paragraph({ text, heading: level, keepNext: true });
  }

  private body(text: string): Paragraph {
    return new Paragraph({ children: [new TextRun(text)], spacing: { after: 120, line: 264 } });
  }

  private labelBody(label: string, text: string): Paragraph {
    return new Paragraph({
      spacing: { after: 100, line: 264 },
      children: [
        new TextRun({ text: `${label}：`, bold: true, color: DARK_BLUE }),
        new TextRun(text),
      ],
    });
  }

  private styles(): NonNullable<ConstructorParameters<typeof Document>[0]['styles']> {
    return {
      default: {
        document: {
          run: {
            font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei' },
            size: 22,
            color: '111827',
          },
          paragraph: { spacing: { after: 120, line: 264 } },
        },
      },
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 32, bold: true, color: BLUE },
          paragraph: { spacing: { before: 320, after: 160 }, keepNext: true, outlineLevel: 0 },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 26, bold: true, color: DARK_BLUE },
          paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 1 },
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 24, bold: true, color: DARK_BLUE },
          paragraph: { spacing: { before: 160, after: 80 }, keepNext: true, outlineLevel: 2 },
        },
      ],
    };
  }

  private async inspect(buffer: Buffer, facts: QuarterlyExportFacts) {
    const entries = await this.readEntries(buffer, [
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/header1.xml',
      'word/footer1.xml',
    ]);
    const documentXml = entries.get('word/document.xml')?.toString('utf8') ?? '';
    const relationshipXml = entries.get('word/_rels/document.xml.rels')?.toString('utf8') ?? '';
    const externalUrls = facts.achievements.flatMap((achievement) =>
      achievement.evidences.flatMap((evidence) => (evidence.url ? [evidence.url] : [])),
    );
    const checks = [
      {
        name: 'zip_magic',
        passed: buffer.subarray(0, 2).toString('hex') === '504b',
        detail: `magic=${buffer.subarray(0, 4).toString('hex')}`,
      },
      {
        name: 'required_ooxml_parts',
        passed: ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'].every((name) =>
          entries.has(name),
        ),
        detail: [...entries.keys()].join(','),
      },
      {
        name: 'confirmed_narrative_present',
        passed: this.xmlContains(documentXml, facts.narrative.content.overallOverview),
        detail: '总体概述来自确认正文快照',
      },
      {
        name: 'snapshot_hash_present',
        passed: documentXml.includes(facts.confirmation.snapshotHash),
        detail: facts.confirmation.snapshotHash,
      },
      {
        name: 'external_links_present',
        passed: externalUrls.every((url) => relationshipXml.includes(this.escapeXmlAttribute(url))),
        detail: `expected=${externalUrls.length}`,
      },
    ];
    return { passed: checks.every((check) => check.passed), checks };
  }

  private readEntries(buffer: Buffer, wanted: string[]): Promise<Map<string, Buffer>> {
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) return reject(error ?? new Error('无法打开 DOCX ZIP'));
        const result = new Map<string, Buffer>();
        zip.on('error', reject);
        zip.on('end', () => resolve(result));
        zip.on('entry', (entry: Entry) => {
          if (!wanted.includes(entry.fileName)) return zip.readEntry();
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream)
              return reject(streamError ?? new Error('无法读取 DOCX 条目'));
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', reject);
            stream.on('end', () => {
              result.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      });
    });
  }

  private xmlContains(xml: string, text: string): boolean {
    const fragment = text.trim().slice(0, 80);
    return fragment.length === 0 || xml.replace(/<[^>]+>/gu, '').includes(fragment);
  }

  private escapeXmlAttribute(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  private originLabel(origin: string): string {
    if (origin === 'manual') return '人工编写';
    if (origin === 'ai') return '用户采纳的 AI 草稿';
    if (origin === 'rule') return '规则生成';
    return origin;
  }

  private dateTime(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Asia/Shanghai',
    }).format(new Date(value));
  }
}
