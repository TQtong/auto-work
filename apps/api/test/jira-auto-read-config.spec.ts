import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import type { AuditService } from '../src/modules/audit/audit.service.js';
import { JiraMappingService } from '../src/modules/jira/jira-mapping.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('Jira 自动只读配置', () => {
  it('根据 Jira 元数据自动识别字段和状态，不需要用户提交映射', async () => {
    const create = vi.fn(({ data }: { data: Record<string, unknown> }) => data);
    const service = new JiraMappingService(
      {
        integrationConnection: {
          findFirst: vi.fn().mockResolvedValue({ id: 'jira-1', type: 'jira' }),
        },
        fieldMappingVersion: {
          findFirst: vi.fn().mockResolvedValue(null),
          create,
        },
      } as unknown as PrismaService,
      {} as AuditService,
      {} as SessionService,
      {} as LocalSecurityService,
    );

    const result = await service.ensureAutomatic(
      'jira-1',
      [
        { id: 'status', name: '状态', schema: { type: 'status' } },
        { id: 'assignee', name: '经办人', schema: { type: 'user' } },
        { id: 'duedate', name: '到期日', schema: { type: 'date' } },
        { id: 'customfield_10001', name: '计划开始日期', schema: { type: 'date' } },
        { id: 'customfield_10002', name: 'Sprint', schema: { type: 'array' } },
      ],
      [
        { id: '1', name: '待处理', categoryKey: 'new' },
        { id: '2', name: '处理中', categoryKey: 'indeterminate' },
        { id: '3', name: '已完成', categoryKey: 'done' },
        { id: '4', name: '已取消', categoryKey: 'done' },
      ],
    );

    expect(JSON.parse(String(result.fieldMappingsJson))).toMatchObject({
      plannedStartDate: 'customfield_10001',
      dueDate: 'duedate',
      sprint: 'customfield_10002',
      assignee: 'assignee',
      status: 'status',
    });
    expect(JSON.parse(String(result.statusMappingsJson))).toEqual({
      '1': 'planned',
      '2': 'in_progress',
      '3': 'done',
      '4': 'cancelled',
    });
    expect(create).toHaveBeenCalledOnce();
  });
});
