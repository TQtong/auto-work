import { DomainError } from '@auto-work/contracts';

export const weeklyReportDeliveryTextColumns = {
  reportDate: 'reportDateText',
  recentGoals: 'recentGoalsText',
  weeklyWork: 'weeklyWorkText',
  nextWeekPlans: 'nextWeekPlansText',
  problems: 'problemsText',
  other: 'otherText',
} as const;

type WeeklyReportDeliveryColumn =
  (typeof weeklyReportDeliveryTextColumns)[keyof typeof weeklyReportDeliveryTextColumns];

/**
 * 从确认时冻结的模板映射和周报版本构造正式日志六字段。
 * 交付、结果恢复和测试必须共用这一实现，避免查询匹配与真实请求发生字段漂移。
 */
export function buildDingTalkReportContents(input: {
  fieldsJson: string;
  version: Record<WeeklyReportDeliveryColumn, string>;
}): Array<{ key: string; sort: string; type: string; content: string }> {
  const mappedFields = parseArray(input.fieldsJson).map((value) => parseObject(value));
  if (mappedFields.length !== 6) {
    throw new DomainError('DINGTALK_TEMPLATE_MAPPING_INVALID', '确认的钉钉模板映射不是六字段', {
      httpStatus: 422,
    });
  }
  const contents = mappedFields
    .sort((left, right) => Number(left.order) - Number(right.order))
    .map((field) => {
      const internalField = String(
        field.internalField,
      ) as keyof typeof weeklyReportDeliveryTextColumns;
      const column = weeklyReportDeliveryTextColumns[internalField];
      if (!column) {
        throw new DomainError(
          'DINGTALK_TEMPLATE_INTERNAL_FIELD_INVALID',
          `模板映射包含未知内部字段 ${String(field.internalField)}`,
          { httpStatus: 422 },
        );
      }
      return {
        key: String(field.externalFieldName),
        sort: String(field.order),
        type: String(field.externalType),
        content: input.version[column],
      };
    });
  if (
    new Set(contents.map((field) => field.key)).size !== 6 ||
    new Set(contents.map((field) => field.sort)).size !== 6
  ) {
    throw new DomainError(
      'DINGTALK_TEMPLATE_MAPPING_INVALID',
      '确认的钉钉模板映射包含重复字段名或顺序',
      { httpStatus: 422 },
    );
  }
  return contents;
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): unknown[] {
  try {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
