import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { DomainError } from '@auto-work/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';
import { WeeklyReportExportCopyService } from '../src/modules/weekly-reports/weekly-report-export-copy.service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('周报六字段复制与附件导出降级', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: WeeklyReportExportCopyService;
  let sequence = 0;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-weekly-export-copy-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'export-copy.db').replaceAll('\\', '/')}`,
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
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-weekly-export-copy',
        displayName: '导出验收用户',
        timezone: 'Asia/Shanghai',
      },
    });
    const audit = new AuditService(prisma as unknown as PrismaService);
    service = new WeeklyReportExportCopyService(
      prisma as unknown as PrismaService,
      { currentProfileId: 'local-user' } as SessionService,
      audit,
      { sessionHash: (sessionId: string) => hash(sessionId) } as LocalSecurityService,
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('按冻结模板顺序生成首尾标记的文本和 UTF-8 BOM 附件，但不创建任何外部动作', async () => {
    const fixture = await seedReport({ withMapping: true });
    const before = await externalFactCounts();

    const result = await service.generate(
      fixture.reportId,
      { versionId: fixture.versionId, reportVersion: fixture.reportVersion },
      { correlationId: `corr-${fixture.suffix}`, sessionId: 'session-export-copy' },
    );

    expect(result).toMatchObject({
      reportId: fixture.reportId,
      versionId: fixture.versionId,
      mappingSource: 'frozen_mapping',
      submitted: false,
      formalLogState: 'not_started',
      warnings: [],
    });
    expect(result.fields).toHaveLength(6);
    expect(result.fields.map((field) => field.label)).toEqual([
      '填写日期(钉钉)',
      '近期目标(钉钉)',
      '本周内容(钉钉)',
      '下周计划(钉钉)',
      '协助问题(钉钉)',
      '其他补充(钉钉)',
    ]);
    expect(result.copyText.startsWith('【未正式提交】')).toBe(true);
    expect(result.copyText.endsWith('【未正式提交】请在钉钉中人工核对六字段和最终提交结果。')).toBe(
      true,
    );
    expect(result.copyText).toContain('本周完成不可变导出与哈希审计');
    const attachment = Buffer.from(result.attachment.contentBase64, 'base64');
    expect(attachment.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(attachment.subarray(3).toString('utf8')).toBe(result.copyText);
    expect(createHash('sha256').update(attachment).digest('hex')).toBe(result.attachment.sha256);
    expect(await externalFactCounts()).toEqual(before);

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'weekly_report.export_copy_generated', targetId: fixture.versionId },
    });
    expect(audit.outcome).toBe('succeeded');
    expect(audit.afterSummaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(audit)).not.toContain('本周完成不可变导出与哈希审计');
  });

  it('模板映射缺失时仍完整导出标准六字段，并明确空字段 warning', async () => {
    const fixture = await seedReport({ withMapping: false, emptyOther: true });
    const result = await service.generate(
      fixture.reportId,
      { versionId: fixture.versionId, reportVersion: fixture.reportVersion },
      { correlationId: `corr-${fixture.suffix}`, sessionId: 'session-canonical-fallback' },
    );

    expect(result.mappingSource).toBe('canonical_fallback');
    expect(result.fields.map((field) => field.label)).toEqual([
      '周报填写日期',
      '近期工作目标',
      '本周工作内容',
      '下周工作计划',
      '需要协助或存在的问题',
      '其他补充',
    ]);
    expect(result.warnings).toContain('当前版本没有冻结的钉钉模板映射，已使用标准六字段名称');
    expect(result.warnings).toContain('以下字段尚未填写：其他补充');
    expect(result.copyText).toContain('6. 其他补充\r\n（未填写）');
  });

  it('冻结模板字段名重复时拒绝使用歧义映射并安全回退', async () => {
    const fixture = await seedReport({ withMapping: true, duplicateMappingLabels: true });
    const result = await service.generate(
      fixture.reportId,
      { versionId: fixture.versionId, reportVersion: fixture.reportVersion },
      { correlationId: `corr-${fixture.suffix}`, sessionId: 'session-invalid-mapping' },
    );

    expect(result.mappingSource).toBe('canonical_fallback');
    expect(result.warnings).toContain('冻结的钉钉模板映射无效，已使用标准六字段名称');
    expect(result.fields[0]?.label).toBe('周报填写日期');
  });

  it('页面聚合版本或当前版本变化时拒绝生成旧材料', async () => {
    const fixture = await seedReport({ withMapping: true });
    const auditCount = await prisma.auditEvent.count({
      where: { action: 'weekly_report.export_copy_generated' },
    });

    await expect(
      service.generate(
        fixture.reportId,
        { versionId: fixture.versionId, reportVersion: fixture.reportVersion - 1 },
        { correlationId: `corr-${fixture.suffix}`, sessionId: 'session-stale' },
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' } satisfies Partial<DomainError>);
    expect(
      await prisma.auditEvent.count({ where: { action: 'weekly_report.export_copy_generated' } }),
    ).toBe(auditCount);
  });

  it('不能读取其他本机身份的周报材料', async () => {
    const fixture = await seedReport({ withMapping: false, ownerProfileId: 'other-user' });
    await expect(
      service.generate(
        fixture.reportId,
        { versionId: fixture.versionId, reportVersion: fixture.reportVersion },
        { correlationId: `corr-${fixture.suffix}`, sessionId: 'session-other-user' },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' } satisfies Partial<DomainError>);
  });

  async function seedReport(options: {
    withMapping: boolean;
    duplicateMappingLabels?: boolean;
    emptyOther?: boolean;
    ownerProfileId?: string;
  }) {
    const suffix = String(++sequence);
    const ownerProfileId = options.ownerProfileId ?? 'local-user';
    if (ownerProfileId !== 'local-user') {
      await prisma.userProfile.upsert({
        where: { id: ownerProfileId },
        update: {},
        create: {
          id: ownerProfileId,
          windowsSid: `S-1-5-21-weekly-export-copy-${suffix}`,
          displayName: '其他用户',
          timezone: 'Asia/Shanghai',
        },
      });
    }
    const reportId = `export-report-${suffix}`;
    const versionId = `export-version-${suffix}`;
    const snapshotId = `export-snapshot-${suffix}`;
    const reportDate = `2026-07-${String(10 + sequence).padStart(2, '0')}`;
    let mappingVersionId: string | null = null;
    if (options.withMapping) {
      const connectionId = `export-dingtalk-${suffix}`;
      const mappingId = `export-mapping-${suffix}`;
      mappingVersionId = `export-mapping-version-${suffix}`;
      await prisma.integrationConnection.create({
        data: { id: connectionId, type: 'dingtalk_log', name: `钉钉日志 ${suffix}` },
      });
      await prisma.dingTalkTemplateMapping.create({
        data: { id: mappingId, connectionId },
      });
      await prisma.dingTalkTemplateMappingVersion.create({
        data: {
          id: mappingVersionId,
          mappingId,
          versionNo: 1,
          templateId: `template-${suffix}`,
          templateName: 'uTwin产研创新部周报',
          templateHash: hash(`template-${suffix}`),
          fieldsJson: JSON.stringify(
            [
              ['reportDate', '填写日期（钉钉）'],
              ['recentGoals', '近期目标（钉钉）'],
              ['weeklyWork', '本周内容（钉钉）'],
              ['nextWeekPlans', '下周计划（钉钉）'],
              ['problems', '协助问题（钉钉）'],
              ['other', '其他补充（钉钉）'],
            ].map(([internalField, externalFieldName], index) => ({
              internalField,
              externalFieldName: options.duplicateMappingLabels ? '重复字段名' : externalFieldName,
              externalType: 'text',
              order: index + 1,
            })),
          ),
          capabilitySnapshotHash: hash(`capability-${suffix}`),
          observedAt: new Date('2026-07-18T08:00:00.000Z'),
          expiresAt: new Date('2026-08-18T08:00:00.000Z'),
          contentHash: hash(`mapping-${suffix}`),
          createdBy: ownerProfileId,
        },
      });
      await prisma.dingTalkTemplateMapping.update({
        where: { id: mappingId },
        data: { currentVersionId: mappingVersionId },
      });
    }
    await prisma.weeklyReport.create({
      data: {
        id: reportId,
        ownerProfileId,
        periodStart: reportDate,
        periodEnd: reportDate,
        reportDate,
        templateMappingVersionId: mappingVersionId,
        status: 'editing',
        version: 3,
      },
    });
    await prisma.reportSourceSnapshot.create({
      data: {
        id: snapshotId,
        reportId,
        periodStart: reportDate,
        periodEnd: reportDate,
        reportDate,
        timezone: 'Asia/Shanghai',
        profileId: ownerProfileId,
        profileVersion: 1,
        taskFactsJson: '[]',
        evidenceFactsJson: '[]',
        freshnessPolicyJson: '{}',
        ruleVersion: 'weekly-rule-v1',
        templateMappingVersionId: mappingVersionId,
        sanitizationPolicyVersion: 'weekly-ai-metadata-v1',
        generationHash: hash(`generation-${suffix}`),
        sourceContentHash: hash(`source-${suffix}`),
        createdBy: ownerProfileId,
      },
    });
    const textFields = {
      reportDateText: reportDate,
      recentGoalsText: '近期目标保持稳定交付',
      weeklyWorkText: '本周完成不可变导出与哈希审计',
      nextWeekPlansText: '下周开展季度绩效收集',
      problemsText: '暂无',
      otherText: options.emptyOther ? '' : '补充完成 Windows 中文附件验证',
    };
    await prisma.weeklyReportVersion.create({
      data: {
        id: versionId,
        reportId,
        versionNo: 2,
        origin: 'manual',
        ...textFields,
        fieldsJson: '{}',
        templateMappingVersionId: mappingVersionId,
        sourceSnapshotId: snapshotId,
        contentHash: hash(JSON.stringify(textFields)),
        createdBy: ownerProfileId,
      },
    });
    await prisma.weeklyReport.update({
      where: { id: reportId },
      data: { currentVersionId: versionId },
    });
    return { suffix, reportId, versionId, mappingVersionId, reportVersion: 3 };
  }

  async function externalFactCounts() {
    const [deliveryIntents, jobs, notifications] = await Promise.all([
      prisma.deliveryIntent.count(),
      prisma.job.count(),
      prisma.robotNotification.count(),
    ]);
    return { deliveryIntents, jobs, notifications };
  }
});
