export const weeklyReportWarningRuleCatalog = [
  {
    code: 'SOURCE_UNAVAILABLE',
    label: '来源不可用',
    description: '任务或证据来源当前不可用，周报可能缺少最新事实。',
  },
  {
    code: 'SOURCE_STALE',
    label: '来源数据过期',
    description: '任务或证据不是最新数据，需要人工判断是否仍可使用。',
  },
  {
    code: 'UNCONFIRMED_EVIDENCE',
    label: '证据尚未确认',
    description: '周报引用了仍待人工确认归属的证据。',
  },
  {
    code: 'WORKDAY_CALENDAR_FALLBACK',
    label: '工作日历降级',
    description: '系统正在使用周一至周五兜底日历，未应用企业节假日。',
  },
  {
    code: 'AI_GENERATED_CONTENT',
    label: '包含 AI 建议',
    description: '当前版本包含 AI 建议，需要逐段核对引用和事实。',
  },
] as const;

export type WeeklyReportWarningRuleCode = (typeof weeklyReportWarningRuleCatalog)[number]['code'];

export const weeklyReportWarningRuleCodes = weeklyReportWarningRuleCatalog.map(
  (rule) => rule.code,
) as [WeeklyReportWarningRuleCode, ...WeeklyReportWarningRuleCode[]];
