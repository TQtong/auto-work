import type {
  DingTalkTemplateMappingVersion,
  WeeklyReport,
  WeeklyReportVersion,
} from '../api/types.js';

export const weeklyReportFields = [
  { key: 'reportDate', label: '填写日期', multiline: false },
  { key: 'recentGoals', label: '近期目标', multiline: true },
  { key: 'weeklyWork', label: '本周工作', multiline: true },
  { key: 'nextWeekPlans', label: '下周计划', multiline: true },
  { key: 'problems', label: '问题与风险', multiline: true },
  { key: 'other', label: '其他事项', multiline: true },
] as const;

export type WeeklyReportFieldKey = (typeof weeklyReportFields)[number]['key'];

export interface WeeklyFieldDifference {
  field: WeeklyReportFieldKey;
  label: string;
  changed: boolean;
  before: string;
  after: string;
}

export function compareWeeklyFields(
  before: WeeklyReportVersion['fields'],
  after: WeeklyReportVersion['fields'],
): WeeklyFieldDifference[] {
  return weeklyReportFields.map((definition) => ({
    field: definition.key,
    label: definition.label,
    changed: before[definition.key] !== after[definition.key],
    before: before[definition.key],
    after: after[definition.key],
  }));
}

export function previousVersionId(
  versions: Array<{ id: string; versionNo: number }>,
  currentVersionNo: number,
): string | null {
  // 撤销只能指向严格早于当前版本号的最近事实，不能依赖接口返回顺序。
  return (
    [...versions]
      .filter((version) => version.versionNo < currentVersionNo)
      .sort((left, right) => right.versionNo - left.versionNo)[0]?.id ?? null
  );
}

export function reportWorkflowStep(report: WeeklyReport): number {
  // “确认”与“已提交钉钉”是两个独立事实，步骤条不得把确认成功伪装成外部提交成功。
  if (report.logDeliveryState === 'submitted' && report.robotDeliveryState === 'notified') return 5;
  if (report.logDeliveryState === 'submitted') return 4;
  if (report.status === 'confirmed') return 3;
  if (report.status === 'editing') return 2;
  if (report.status === 'generated') return 1;
  return 0;
}

export interface ConfirmationGateItem {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
}

export function confirmationGate(input: {
  report: WeeklyReport;
  version: WeeklyReportVersion;
  mapping: DingTalkTemplateMappingVersion | null;
  acknowledgedWarningIds: string[];
  availableAttachmentIds: string[];
}): { ready: boolean; items: ConfirmationGateItem[] } {
  const { report, version, mapping } = input;
  const missingFields = weeklyReportFields
    .filter((field) => !version.fields[field.key].trim())
    .map((field) => field.label);
  const reportDateValid =
    version.fields.reportDate >= report.periodStart &&
    version.fields.reportDate <= report.periodEnd;
  const mappingValid =
    Boolean(mapping) &&
    mapping?.id === version.templateMappingVersionId &&
    mapping?.id === report.templateMappingVersionId &&
    !mapping.expired;
  const recipients = version.recipientScope.recipients ?? [];
  const recipientValid =
    recipients.length > 0 &&
    Boolean(mapping) &&
    version.recipientScope.connectionId === mapping?.connectionId;
  const blockingWarnings = version.warnings.filter((warning) => warning.blocking);
  const acknowledged = new Set(input.acknowledgedWarningIds);
  const missingAcknowledgements = version.warnings.filter(
    (warning) => !warning.blocking && !acknowledged.has(warning.id),
  );
  const availableAttachments = new Set(input.availableAttachmentIds);
  const missingAttachments = version.attachments.filter(
    (attachment) => !availableAttachments.has(attachment.id),
  );
  const scheduleValid = !version.scheduleAt || new Date(version.scheduleAt).getTime() > Date.now();
  // 前端预检用于提前解释阻断原因；后端确认接口仍会在事务内重复全部安全校验。
  const items: ConfirmationGateItem[] = [
    {
      key: 'fields',
      label: '六字段完整',
      passed: missingFields.length === 0,
      detail: missingFields.length === 0 ? '六个字段均已填写' : `缺少：${missingFields.join('、')}`,
    },
    {
      key: 'date',
      label: '周期与日期有效',
      passed: reportDateValid,
      detail: reportDateValid
        ? `${report.periodStart} 至 ${report.periodEnd}`
        : '填写日期不在周报周期内',
    },
    {
      key: 'warnings',
      label: 'warning 已处理',
      passed: blockingWarnings.length === 0 && missingAcknowledgements.length === 0,
      detail:
        blockingWarnings.length > 0
          ? `${blockingWarnings.length} 条阻断 warning`
          : missingAcknowledgements.length > 0
            ? `${missingAcknowledgements.length} 条尚未知悉`
            : '无阻断项，非阻断项均已知悉',
    },
    {
      key: 'mapping',
      label: '模板映射有效',
      passed: mappingValid,
      detail: mappingValid
        ? `${mapping?.templateName} · v${mapping?.versionNo}`
        : '未选择当前有效模板映射',
    },
    {
      key: 'recipients',
      label: '接收范围有效',
      passed: recipientValid,
      detail: recipientValid ? `${recipients.length} 个已验证接收主体` : '至少选择一个已验证收件人',
    },
    {
      key: 'attachments',
      label: '附件事实有效',
      passed: missingAttachments.length === 0,
      detail:
        missingAttachments.length === 0
          ? `${version.attachments.length} 个附件可用`
          : `${missingAttachments.length} 个附件已删除或不可用`,
    },
    {
      key: 'schedule',
      label: '计划时间有效',
      passed: scheduleValid,
      detail: scheduleValid ? (version.scheduleAt ?? '立即提交') : '计划提交时间已过期',
    },
    {
      key: 'concurrency',
      label: '当前版本未变化',
      passed: report.currentVersionId === version.id,
      detail:
        report.currentVersionId === version.id
          ? `聚合版本 ${report.version}`
          : '页面不是当前版本，请刷新',
    },
  ];
  return { ready: items.every((item) => item.passed), items };
}
