import { describe, expect, it } from 'vitest';
import type { WeeklyReportDeliveryIntent } from '../api/types.js';
import {
  deliveryRecoveryActions,
  deliveryRecoveryOutcomeLabel,
  deliveryRecoveryStatusLabel,
  canNotifyFormalLogFailure,
  currentLogDeliveryIntent,
  eligibleSevereRiskWarnings,
  latestUnresolvedLogDeliveryIntent,
} from './weekly-report-delivery-view-model.js';

describe('周报交付恢复视图模型', () => {
  it('只用当前提交快照的交付记录控制按钮，旧版本失败不会阻塞新版本', () => {
    const oldFailure = intent({
      id: 'old-failure',
      confirmationId: 'confirmation-old',
      status: 'failed',
    });
    const current = intent({ id: 'current', confirmationId: 'confirmation-current' });
    expect(currentLogDeliveryIntent([oldFailure, current], 'confirmation-current')).toBe(current);
    expect(currentLogDeliveryIntent([oldFailure], 'confirmation-current')).toBeNull();
  });

  it('保留最新的历史未知交付事实供页面告警和防重复门禁使用', () => {
    const older = intent({
      id: 'older-unknown',
      confirmationId: 'confirmation-old',
      status: 'unknown',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const latest = intent({
      id: 'latest-review',
      confirmationId: 'confirmation-newer',
      status: 'needs_review',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    const resolved = intent({
      id: 'resolved',
      status: 'failed',
      updatedAt: '2026-07-20T00:00:00.000Z',
    });

    expect(latestUnresolvedLogDeliveryIntent([older, resolved, latest])).toBe(latest);
    expect(latestUnresolvedLogDeliveryIntent([resolved])).toBeNull();
  });

  it('unknown 正式日志只允许查询或人工裁决，绝不出现直接重试', () => {
    expect(
      deliveryRecoveryActions(intent({ status: 'unknown', recoveryStatus: 'pending' })),
    ).toEqual({
      canReconcile: true,
      canResolve: true,
      canRetry: false,
      retryBlockedReason: '结果尚未证明失败，必须先查询或人工核对，禁止重放创建请求',
    });
  });

  it('桌面正式日志没有外部查询权限时只允许人工裁决', () => {
    expect(
      deliveryRecoveryActions(intent({ status: 'unknown', recoveryStatus: 'pending' }), {
        resultQuerySupported: false,
      }),
    ).toMatchObject({ canReconcile: false, canResolve: true, canRetry: false });
  });

  it('明确失败在三次上限内开放受控重试，达到上限后关闭', () => {
    expect(deliveryRecoveryActions(intent({ status: 'failed', attemptCount: 2 })).canRetry).toBe(
      true,
    );
    expect(deliveryRecoveryActions(intent({ status: 'failed', attemptCount: 3 }))).toMatchObject({
      canRetry: false,
      retryBlockedReason: '已达到三次显式尝试上限',
    });
  });

  it('恢复状态和证据结果使用明确中文，不把首次未找到显示成已失败', () => {
    expect(deliveryRecoveryStatusLabel('not_found')).toBe('首次未找到');
    expect(deliveryRecoveryOutcomeLabel('not_found')).toBe('本次未找到，尚未开放重试');
    expect(deliveryRecoveryOutcomeLabel('absence_confirmed')).toBe('连续查询确认未创建');
  });

  it('只有明确失败的正式日志可生成失败提醒，unknown 和机器人失败均禁止', () => {
    expect(canNotifyFormalLogFailure(intent({ status: 'failed' }))).toBe(true);
    expect(canNotifyFormalLogFailure(intent({ status: 'unknown' }))).toBe(false);
    expect(canNotifyFormalLogFailure(intent({ channel: 'dingtalk_robot', status: 'failed' }))).toBe(
      false,
    );
  });

  it('严重风险选择仅包含机器人已配置且属于当前版本的 warning', () => {
    const warnings = [
      {
        id: 'a'.repeat(64),
        code: 'SOURCE_UNAVAILABLE',
        message: 'Jira 当前不可用',
        blocking: false,
      },
      { id: 'b'.repeat(64), code: 'SOURCE_STALE', message: '缓存过期', blocking: false },
      { id: 'c'.repeat(64), code: 'UNCONFIRMED_EVIDENCE', message: '证据待确认', blocking: false },
    ];
    expect(
      eligibleSevereRiskWarnings(warnings, {
        severeRiskCodes: ['SOURCE_UNAVAILABLE', 'UNSUPPORTED_FORGED_CODE'],
      }),
    ).toEqual([warnings[0]]);
    expect(eligibleSevereRiskWarnings(warnings, { severeRiskCodes: [] })).toEqual([]);
  });

  function intent(override: Partial<WeeklyReportDeliveryIntent> = {}): WeeklyReportDeliveryIntent {
    return {
      id: 'intent-1',
      reportId: 'report-1',
      confirmationId: 'confirmation-1',
      confirmedVersionId: 'version-1',
      connectionId: 'connection-1',
      channel: 'dingtalk_log',
      status: 'pending',
      scheduledFor: '2026-07-18T00:00:00.000Z',
      scheduleApprovedAt: null,
      scheduleApprovalHash: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
      jobId: 'job-1',
      externalId: null,
      externalUrl: null,
      attemptCount: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
      recoveryStatus: 'not_required',
      lastRecoveryAt: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionReason: null,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      attempts: [],
      recoveryChecks: [],
      ...override,
    };
  }
});
