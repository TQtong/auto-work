import { DomainError, type NormalizedTaskStatus } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import type { JiraIssue } from './jira.schemas.js';

export interface JiraFieldMappings {
  plannedStartDate: string | null;
  dueDate: string | null;
  sprint: string | null;
  parent: string | null;
  originalEstimateSeconds: string | null;
  remainingEstimateSeconds: string | null;
  timeSpentSeconds: string | null;
  assignee: string | null;
  status: string | null;
  priority: string | null;
  labels: string | null;
  components: string | null;
}

export interface NormalizedJiraTask {
  externalId: string;
  issueKey: string;
  projectKey: string;
  issueType: string | null;
  parentIssueKey: string | null;
  parentTitle: string | null;
  title: string;
  priority: string | null;
  assigneeExternalId: string | null;
  assigneeName: string | null;
  isCurrentUser: boolean;
  rawStatusId: string | null;
  rawStatusName: string | null;
  normalizedStatus: NormalizedTaskStatus;
  plannedStartDate: string | null;
  dueDate: string | null;
  originalEstimateSeconds: number | null;
  remainingEstimateSeconds: number | null;
  timeSpentSeconds: number | null;
  sprintIds: Array<{ id: string | null; name: string | null; raw?: string }>;
  labels: string[];
  components: string[];
  externalUpdatedAt: Date;
  contentHash: string;
  observationFields: Record<string, unknown>;
  warnings: Array<{ code: string; fieldId?: string; message: string }>;
}

export function normalizeJiraIssue(input: {
  issue: JiraIssue;
  mappings: JiraFieldMappings;
  statusMappings: Record<string, NormalizedTaskStatus>;
  currentIdentity: { id: string; username?: string | null; name?: string | null };
  parentFallbackFieldId?: string | null;
}): NormalizedJiraTask {
  const { issue, mappings } = input;
  const fields = issue.fields;
  const warnings: NormalizedJiraTask['warnings'] = [];
  const title = requiredString(fields.summary, 'summary', issue.key);
  const updatedRaw = requiredString(fields.updated, 'updated', issue.key);
  const externalUpdatedAt = new Date(updatedRaw);
  if (Number.isNaN(externalUpdatedAt.getTime())) {
    throw mappingError(issue.key, 'updated', 'Jira 更新时间不是有效日期');
  }
  const project = objectValue(fields.project);
  const projectKey = stringValue(project?.key) ?? issue.key.split('-')[0]!;
  const issueType = stringValue(objectValue(fields.issuetype)?.name);
  const statusValue = objectValue(mappedValue(fields, mappings.status));
  const rawStatusId = stringValue(statusValue?.id);
  const rawStatusName = stringValue(statusValue?.name);
  const normalizedStatus =
    (rawStatusId ? input.statusMappings[rawStatusId] : undefined) ??
    (rawStatusName ? input.statusMappings[rawStatusName] : undefined) ??
    'other';
  if (
    normalizedStatus === 'other' &&
    rawStatusId &&
    input.statusMappings[rawStatusId] === undefined
  ) {
    warnings.push({
      code: 'JIRA_STATUS_UNMAPPED',
      ...(mappings.status ? { fieldId: mappings.status } : {}),
      message: `状态 ${rawStatusName ?? rawStatusId} 未映射，保留原状态并归入 other`,
    });
  }
  const assignee = objectValue(mappedValue(fields, mappings.assignee));
  const assigneeExternalId =
    stringValue(assignee?.accountId) ?? stringValue(assignee?.key) ?? stringValue(assignee?.name);
  const assigneeName = stringValue(assignee?.displayName) ?? stringValue(assignee?.name);
  const identityCandidates = new Set(
    [input.currentIdentity.id, input.currentIdentity.username, input.currentIdentity.name]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLocaleLowerCase()),
  );
  const parent =
    objectValue(mappedValue(fields, mappings.parent)) ??
    (input.parentFallbackFieldId ? objectValue(fields[input.parentFallbackFieldId]) : null);
  const plannedStartDate = businessDate(
    fields[mappings.plannedStartDate ?? ''],
    issue.key,
    mappings.plannedStartDate,
    warnings,
  );
  const dueDate = businessDate(
    mappedValue(fields, mappings.dueDate),
    issue.key,
    mappings.dueDate,
    warnings,
  );
  const originalEstimateSeconds = nonnegativeInteger(
    mappedValue(fields, mappings.originalEstimateSeconds),
    issue.key,
    mappings.originalEstimateSeconds,
  );
  const remainingEstimateSeconds = nonnegativeInteger(
    mappedValue(fields, mappings.remainingEstimateSeconds),
    issue.key,
    mappings.remainingEstimateSeconds,
  );
  const timeSpentSeconds = nonnegativeInteger(
    mappedValue(fields, mappings.timeSpentSeconds),
    issue.key,
    mappings.timeSpentSeconds,
  );
  const sprintIds = parseSprint(
    mappings.sprint ? fields[mappings.sprint] : null,
    mappings.sprint,
    warnings,
  );
  const priority = stringValue(objectValue(mappedValue(fields, mappings.priority))?.name);
  const labels = stringArray(mappedValue(fields, mappings.labels));
  const componentsValue = mappedValue(fields, mappings.components);
  const components = Array.isArray(componentsValue)
    ? componentsValue
        .map((value) => stringValue(objectValue(value)?.name) ?? stringValue(value))
        .filter((value): value is string => Boolean(value))
    : [];
  const observationFields = {
    issueKey: issue.key,
    projectKey,
    title,
    issueType,
    parentIssueKey: stringValue(parent?.key),
    parentTitle: stringValue(objectValue(parent?.fields)?.summary) ?? stringValue(parent?.summary),
    status: { id: rawStatusId, name: rawStatusName, normalized: normalizedStatus },
    assignee: { id: assigneeExternalId, name: assigneeName },
    priority,
    plannedStartDate,
    dueDate,
    originalEstimateSeconds,
    remainingEstimateSeconds,
    timeSpentSeconds,
    sprintIds,
    labels,
    components,
    updatedAt: externalUpdatedAt.toISOString(),
  };
  return {
    externalId: issue.id,
    issueKey: issue.key,
    projectKey,
    issueType,
    parentIssueKey: stringValue(parent?.key),
    parentTitle: stringValue(objectValue(parent?.fields)?.summary) ?? stringValue(parent?.summary),
    title,
    priority,
    assigneeExternalId,
    assigneeName,
    isCurrentUser: [assigneeExternalId, assigneeName]
      .filter((value): value is string => Boolean(value))
      .some((value) => identityCandidates.has(value.toLocaleLowerCase())),
    rawStatusId,
    rawStatusName,
    normalizedStatus,
    plannedStartDate,
    dueDate,
    originalEstimateSeconds,
    remainingEstimateSeconds,
    timeSpentSeconds,
    sprintIds,
    labels,
    components,
    externalUpdatedAt,
    contentHash: requestHash(observationFields),
    observationFields,
    warnings,
  };
}

function requiredString(value: unknown, fieldId: string, issueKey: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw mappingError(issueKey, fieldId, 'Jira 必填字段缺失或类型变化');
  return parsed;
}

function businessDate(
  value: unknown,
  issueKey: string,
  fieldId: string | null,
  warnings: NormalizedJiraTask['warnings'],
): string | null {
  if (!fieldId || value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw mappingError(issueKey, fieldId, '日期字段类型变化');
  const candidate = value.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(candidate) ||
    Number.isNaN(Date.parse(`${candidate}T00:00:00Z`))
  ) {
    warnings.push({
      code: 'JIRA_DATE_INVALID',
      fieldId,
      message: `日期值 ${value.slice(0, 100)} 无法解析`,
    });
    return null;
  }
  return candidate;
}

function nonnegativeInteger(
  value: unknown,
  issueKey: string,
  fieldId: string | null,
): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!fieldId) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw mappingError(issueKey, fieldId, '工时字段必须是非负整数秒');
  }
  return value;
}

function parseSprint(
  value: unknown,
  fieldId: string | null,
  warnings: NormalizedJiraTask['warnings'],
): NormalizedJiraTask['sprintIds'] {
  if (!fieldId || value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    const object = objectValue(item);
    if (object) {
      return [{ id: stringValue(object.id), name: stringValue(object.name) }];
    }
    if (typeof item === 'string') {
      const id = /(?:^|[,[])id=(\d+)(?:,|\])/u.exec(item)?.[1] ?? null;
      const name = /(?:^|,)name=([^,\]]+)/u.exec(item)?.[1]?.trim() ?? null;
      if (!id && !name) {
        warnings.push({
          code: 'JIRA_SPRINT_RAW_PRESERVED',
          fieldId,
          message: 'Sprint 字符串无法完整解析，已保留原值',
        });
      }
      return [{ id, name, raw: item.slice(0, 500) }];
    }
    warnings.push({
      code: 'JIRA_SPRINT_TYPE_UNKNOWN',
      fieldId,
      message: 'Sprint 值类型未知，已忽略',
    });
    return [];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

function mappedValue(fields: Record<string, unknown>, fieldId: string | null): unknown {
  return fieldId ? fields[fieldId] : undefined;
}

function mappingError(issueKey: string, fieldId: string, message: string): DomainError {
  return new DomainError('JIRA_MAPPING_INVALID', `${issueKey}：${message}`, {
    httpStatus: 422,
    details: { issueKey, fieldId },
  });
}
