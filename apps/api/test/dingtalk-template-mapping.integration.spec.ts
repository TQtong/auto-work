import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { saveDingTalkTemplateMappingSchema } from '../src/modules/integrations/dingtalk-template-mapping.schemas.js';
import { DingTalkTemplateMappingService } from '../src/modules/integrations/dingtalk-template-mapping.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('钉钉模板映射不可变版本与能力快照约束', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let mappings: DingTalkTemplateMappingService;
  const capabilitySnapshotHash = 'a'.repeat(64);
  const context = { correlationId: 'mapping-correlation', sessionId: 'mapping-session' };

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-dingtalk-mapping-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'mapping.db').replaceAll('\\', '/')}`,
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
    const prismaService = prisma as unknown as PrismaService;
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    const audit = new AuditService(prismaService);
    const security = {
      sessionHash: () => 'mapping-session-hash',
    } as unknown as LocalSecurityService;
    mappings = new DingTalkTemplateMappingService(prismaService, sessions, audit, security);
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-mapping-test',
        displayName: '模板管理员',
        timezone: 'Asia/Shanghai',
      },
    });
    await prisma.integrationConnection.create({
      data: {
        id: 'dingtalk-log-1',
        type: 'dingtalk_log',
        name: '研发日志',
        status: 'healthy',
        enabled: true,
        capabilitiesJson: capabilitiesFor(mappingInput()),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('只接受当前健康连接的真实能力快照，并按内容生成不可变版本', async () => {
    const firstInput = mappingInput();
    const first = await mappings.save('dingtalk-log-1', firstInput, context);
    expect(first).toMatchObject({ replayed: false, version: { versionNo: 1 } });
    expect(await mappings.list('dingtalk-log-1')).toMatchObject({
      connectionId: 'dingtalk-log-1',
      currentVersionId: first.version.id,
      aggregateVersion: 2,
      versions: [{ id: first.version.id, connectionId: 'dingtalk-log-1', versionNo: 1 }],
    });

    const replay = await mappings.save('dingtalk-log-1', firstInput, context);
    expect(replay).toMatchObject({ replayed: true, version: { id: first.version.id } });
    const secondInput = mappingInput({
      connectionVersion: 2,
      externalTemplateVersion: '2026-08',
      templateHash: 'c'.repeat(64),
      capabilitySnapshotHash: 'd'.repeat(64),
    });
    await prisma.integrationConnection.update({
      where: { id: 'dingtalk-log-1' },
      data: { capabilitiesJson: capabilitiesFor(secondInput), version: { increment: 1 } },
    });
    const second = await mappings.save('dingtalk-log-1', secondInput, context);
    expect(second).toMatchObject({ replayed: false, version: { versionNo: 2 } });
    expect(await prisma.dingTalkTemplateMappingVersion.count()).toBe(2);
    expect(
      await prisma.auditEvent.count({
        where: { action: 'dingtalk.template_mapping_version_saved' },
      }),
    ).toBe(2);
    await expect(
      prisma.dingTalkTemplateMappingVersion.update({
        where: { id: first.version.id },
        data: { templateName: '覆盖历史' },
      }),
    ).rejects.toThrow();
  });

  it('拒绝伪造的能力快照、错序字段与非日志连接', async () => {
    const currentVersion = 3;
    const discoveredInput = mappingInput({ connectionVersion: currentVersion });
    await prisma.integrationConnection.update({
      where: { id: 'dingtalk-log-1' },
      data: { capabilitiesJson: capabilitiesFor(discoveredInput), version: { increment: 1 } },
    });
    await expect(
      mappings.save(
        'dingtalk-log-1',
        mappingInput({ connectionVersion: currentVersion, capabilitySnapshotHash: 'f'.repeat(64) }),
        context,
      ),
    ).rejects.toMatchObject({ code: 'DINGTALK_TEMPLATE_CAPABILITY_SNAPSHOT_MISMATCH' });
    const forgedField = mappingInput({ connectionVersion: currentVersion });
    forgedField.fields[0]!.externalFieldName = '伪造字段';
    await expect(mappings.save('dingtalk-log-1', forgedField, context)).rejects.toMatchObject({
      code: 'DINGTALK_TEMPLATE_DISCOVERED_FACTS_MISMATCH',
    });
    const wrongOrder = mappingInput({ connectionVersion: currentVersion });
    wrongOrder.fields[0]!.order = 5;
    wrongOrder.fields[5]!.order = 0;
    await expect(mappings.save('dingtalk-log-1', wrongOrder, context)).rejects.toMatchObject({
      code: 'DINGTALK_TEMPLATE_FIELD_ORDER_INVALID',
    });
    await expect(mappings.list('missing')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  function mappingInput(overrides: Record<string, unknown> = {}) {
    return saveDingTalkTemplateMappingSchema.parse({
      connectionVersion: 1,
      templateId: 'weekly-template',
      templateName: '研发周报',
      externalTemplateVersion: '2026-07',
      templateHash: 'b'.repeat(64),
      capabilitySnapshotHash,
      observedAt: '2026-07-18T08:00:00+08:00',
      expiresAt: '2027-07-18T08:00:00+08:00',
      fields: ['reportDate', 'recentGoals', 'weeklyWork', 'nextWeekPlans', 'problems', 'other'].map(
        (internalField, order) => ({
          internalField,
          externalFieldId: `field-${order}`,
          externalFieldName: `字段 ${order}`,
          externalType: 'text',
          order,
          required: true,
          maxLength: 50_000,
        }),
      ),
      ...overrides,
    });
  }

  function capabilitiesFor(input: ReturnType<typeof mappingInput>): string {
    return JSON.stringify({
      templateDiscovery: {
        supported: true,
        snapshotHash: input.capabilitySnapshotHash,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        selectedTemplate: {
          templateId: input.templateId,
          templateName: input.templateName,
          externalTemplateVersion: input.externalTemplateVersion,
          templateHash: input.templateHash,
          fields: input.fields.map((field) => ({
            externalFieldId: field.externalFieldId,
            externalFieldName: field.externalFieldName,
            externalType: field.externalType,
            order: field.order,
            required: field.required,
            maxLength: field.maxLength,
          })),
        },
      },
    });
  }
});
