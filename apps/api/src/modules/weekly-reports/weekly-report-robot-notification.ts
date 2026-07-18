export type WeeklyReportRobotNotificationType =
  | 'generation_reminder'
  | 'confirmation_reminder'
  | 'deadline_reminder'
  | 'submission_success'
  | 'submission_failure'
  | 'risk_alert';

const shortText = z.string().min(1).max(500);
export const weeklyReportRobotNotificationFactsSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('generation_reminder'),
    periodStart: shortText,
    periodEnd: shortText,
  }),
  z.object({
    type: z.literal('confirmation_reminder'),
    periodStart: shortText,
    periodEnd: shortText,
    draftStatus: shortText,
  }),
  z.object({
    type: z.literal('submission_success'),
    periodStart: shortText,
    periodEnd: shortText,
    reportDate: shortText,
    formalLogId: shortText,
    projectNames: z.array(shortText).max(3),
  }),
  z.object({
    type: z.literal('deadline_reminder'),
    periodStart: shortText,
    periodEnd: shortText,
    deadlineText: shortText,
    draftStatus: shortText,
  }),
  z.object({
    type: z.literal('submission_failure'),
    periodStart: shortText,
    periodEnd: shortText,
    stage: shortText,
    safeErrorSummary: shortText,
  }),
  z.object({
    type: z.literal('risk_alert'),
    periodStart: shortText,
    periodEnd: shortText,
    riskSummaries: z.array(shortText).min(1).max(3),
  }),
]);
export type WeeklyReportRobotNotificationFacts = z.infer<
  typeof weeklyReportRobotNotificationFactsSchema
>;

/**
 * 机器人正文由固定模板生成，绝不接收六字段全文、附件内容、外部凭证或 localhost 链接。
 */
export function buildWeeklyReportRobotNotification(
  input: WeeklyReportRobotNotificationFacts,
): string {
  const period = `周期：${safeLine(input.periodStart, 20)} 至 ${safeLine(input.periodEnd, 20)}`;
  if (input.type === 'generation_reminder') {
    return [
      'Auto Work 周报生成提醒',
      period,
      '当前状态：尚未生成本周期周报',
      '请在本机 Auto Work 检查来源后生成草稿；本提醒不会自动生成或正式提交。',
    ].join('\n');
  }
  if (input.type === 'confirmation_reminder') {
    return [
      'Auto Work 周报确认提醒',
      period,
      `当前草稿状态：${safeLine(input.draftStatus, 80)}`,
      '请在本机 Auto Work 核对来源、正文和接收范围后确认；本提醒不会自动确认或正式提交。',
    ].join('\n');
  }
  if (input.type === 'submission_success') {
    const projects = normalizeList(input.projectNames, 3, 80);
    return [
      'Auto Work 周报交付通知',
      period,
      `报告日期：${safeLine(input.reportDate, 20)}`,
      '状态：已提交钉钉正式日志',
      ...(projects.length > 0 ? [`主要项目：${projects.join('、')}`] : []),
      `正式日志 ID：${safeLine(input.formalLogId, 200)}`,
      '请在本机 Auto Work 查看交付详情。',
    ].join('\n');
  }
  if (input.type === 'deadline_reminder') {
    return [
      'Auto Work 周报截止提醒',
      period,
      `截止时间：${safeLine(input.deadlineText, 80)}`,
      `当前草稿状态：${safeLine(input.draftStatus, 80)}`,
      '请在本机 Auto Work 完成编辑与确认；本提醒不会自动正式提交。',
    ].join('\n');
  }
  if (input.type === 'submission_failure') {
    return [
      'Auto Work 周报交付失败提醒',
      period,
      `失败阶段：${safeLine(input.stage, 80)}`,
      `简化错误：${safeLine(input.safeErrorSummary, 240)}`,
      '请在本机 Auto Work 查看恢复证据；系统不会盲目重放结果未知的请求。',
    ].join('\n');
  }
  const risks = normalizeList(input.riskSummaries, 3, 160);
  return [
    'Auto Work 周报风险提醒',
    period,
    ...risks.map((risk, index) => `风险 ${index + 1}：${risk}`),
    '请在本机 Auto Work 查看来源与处理建议。',
  ].join('\n');
}

export function projectNamesFromTaskFacts(taskFactsJson: string): string[] {
  let values: unknown = [];
  try {
    values = JSON.parse(taskFactsJson) as unknown;
  } catch {
    values = [];
  }
  if (!Array.isArray(values)) return [];
  const names = values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const name = (value as Record<string, unknown>).projectName;
    return typeof name === 'string' ? [safeLine(name, 80)] : [];
  });
  return [...new Set(names.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .slice(0, 3);
}

function normalizeList(values: string[], limit: number, maximumLength: number): string[] {
  return [...new Set(values.map((value) => safeLine(value, maximumLength)).filter(Boolean))].slice(
    0,
    limit,
  );
}

function safeLine(value: string, maximumLength: number): string {
  return value
    .replace(/[\0\r\n\t]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximumLength);
}
import { z } from 'zod';
