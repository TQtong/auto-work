import type { DingTalkRecipientValidation, WeeklyReportVersion } from '../api/types.js';

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

export interface CurrentRecipientValidationResolution {
  ids: string[];
  ready: boolean;
  replaced: boolean;
}

export function resolveCurrentRecipientValidationIds(
  selectedIds: string[],
  savedRecipients: WeeklyReportVersion['recipientScope']['recipients'],
  latestValidations: DingTalkRecipientValidation[],
): CurrentRecipientValidationResolution {
  if (selectedIds.length === 0) return { ids: [], ready: false, replaced: false };

  const selectable = latestValidations.filter(
    (validation) => validation.available && !validation.expired,
  );
  const currentById = new Map(selectable.map((validation) => [validation.id, validation]));
  const savedById = new Map(
    (savedRecipients ?? []).map((recipient) => [recipient.validationId, recipient]),
  );
  const resolvedIds: string[] = [];

  for (const selectedId of selectedIds) {
    const current = currentById.get(selectedId);
    if (current) {
      resolvedIds.push(current.id);
      continue;
    }
    const saved = savedById.get(selectedId);
    const replacement = saved
      ? selectable.find(
          (validation) =>
            validation.subjectType === saved.subjectType &&
            validation.externalId === saved.externalId,
        )
      : undefined;
    if (!replacement) return { ids: selectedIds, ready: false, replaced: false };
    resolvedIds.push(replacement.id);
  }

  if (new Set(resolvedIds).size !== resolvedIds.length) {
    return { ids: selectedIds, ready: false, replaced: false };
  }
  return {
    ids: resolvedIds,
    ready: true,
    replaced: resolvedIds.some((id, index) => id !== selectedIds[index]),
  };
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
