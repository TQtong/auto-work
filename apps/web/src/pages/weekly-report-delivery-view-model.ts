import { weeklyReportWarningRuleCatalog } from '@auto-work/contracts';
import type { WeeklyReportDeliveryIntent, WeeklyReportWarning } from '../api/types.js';

export interface DeliveryRecoveryActions {
  canReconcile: boolean;
  canResolve: boolean;
  canRetry: boolean;
  retryBlockedReason: string | null;
}

export function currentLogDeliveryIntent(
  intents: WeeklyReportDeliveryIntent[],
  confirmationId: string | null | undefined,
): WeeklyReportDeliveryIntent | null {
  if (!confirmationId) return null;
  return (
    intents.find(
      (intent) => intent.channel === 'dingtalk_log' && intent.confirmationId === confirmationId,
    ) ?? null
  );
}

export function latestUnresolvedLogDeliveryIntent(
  intents: WeeklyReportDeliveryIntent[],
): WeeklyReportDeliveryIntent | null {
  return (
    intents
      .filter(
        (intent) =>
          intent.channel === 'dingtalk_log' &&
          (intent.status === 'unknown' || intent.status === 'needs_review'),
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null
  );
}

/** 页面动作矩阵与后端门禁保持同向：unknown 永远不能直接重试。 */
export function deliveryRecoveryActions(
  intent: WeeklyReportDeliveryIntent,
  options: { resultQuerySupported?: boolean } = {},
): DeliveryRecoveryActions {
  const unresolved = intent.status === 'unknown' || intent.status === 'needs_review';
  const resultQuerySupported = options.resultQuerySupported ?? true;
  return {
    canReconcile: intent.channel === 'dingtalk_log' && unresolved && resultQuerySupported,
    canResolve: unresolved,
    canRetry: intent.status === 'failed' && intent.attemptCount < 3,
    retryBlockedReason:
      unresolved && intent.channel === 'dingtalk_log'
        ? '结果尚未证明失败，必须先查询或人工核对，禁止重放创建请求'
        : intent.attemptCount >= 3
          ? '已达到三次显式尝试上限'
          : null,
  };
}

export function deliveryRecoveryStatusLabel(status: string): string {
  return (
    {
      not_required: '无需恢复',
      pending: '等待核对',
      not_found: '首次未找到',
      absence_confirmed: '连续查询确认未创建',
      matched: '查询唯一命中',
      ambiguous: '查询结果有歧义',
      manual_succeeded: '人工确认已交付',
      manual_absence_confirmed: '人工确认未交付',
    }[status] ?? status
  );
}

export function deliveryRecoveryOutcomeLabel(outcome: string): string {
  return (
    {
      matched: '唯一命中并恢复成功',
      not_found: '本次未找到，尚未开放重试',
      absence_confirmed: '连续查询确认未创建',
      ambiguous: '多命中或分页不完整',
      query_failed: '只读查询失败',
      manual_succeeded: '人工确认已交付',
      manual_absence_confirmed: '人工确认未交付',
    }[outcome] ?? outcome
  );
}

/** 失败提醒不能把 unknown/needs_review 误表述成已经失败。 */
export function canNotifyFormalLogFailure(intent: WeeklyReportDeliveryIntent | null): boolean {
  return intent?.channel === 'dingtalk_log' && intent.status === 'failed';
}

/** 页面只展示机器人已配置且确实存在于当前版本的 warning，最终仍由服务端重新校验。 */
export function eligibleSevereRiskWarnings(
  warnings: WeeklyReportWarning[],
  robotConfig: Record<string, unknown> | null,
): WeeklyReportWarning[] {
  const knownCodes = new Set<string>(weeklyReportWarningRuleCatalog.map((rule) => rule.code));
  const configured = new Set(
    Array.isArray(robotConfig?.severeRiskCodes)
      ? robotConfig.severeRiskCodes.filter(
          (code): code is string => typeof code === 'string' && knownCodes.has(code),
        )
      : [],
  );
  return warnings.filter(
    (warning) =>
      configured.has(warning.code) &&
      typeof warning.message === 'string' &&
      warning.message.trim().length > 0,
  );
}
