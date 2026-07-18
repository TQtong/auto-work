import type { WeeklyReportDeliveryIntent } from '../api/types.js';

export interface DeliveryRecoveryActions {
  canReconcile: boolean;
  canResolve: boolean;
  canRetry: boolean;
  retryBlockedReason: string | null;
}

/** 页面动作矩阵与后端门禁保持同向：unknown 永远不能直接重试。 */
export function deliveryRecoveryActions(
  intent: WeeklyReportDeliveryIntent,
): DeliveryRecoveryActions {
  const unresolved = intent.status === 'unknown' || intent.status === 'needs_review';
  return {
    canReconcile: intent.channel === 'dingtalk_log' && unresolved,
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
