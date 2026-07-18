import { describe, expect, it } from 'vitest';
import type { WeeklyReportDeliveryIntent } from '../api/types.js';
import {
  deliveryRecoveryActions,
  deliveryRecoveryOutcomeLabel,
  deliveryRecoveryStatusLabel,
} from './weekly-report-delivery-view-model.js';

describe('周报交付恢复视图模型', () => {
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

  function intent(override: Partial<WeeklyReportDeliveryIntent> = {}): WeeklyReportDeliveryIntent {
    return {
      id: 'intent-1',
      reportId: 'report-1',
      confirmationId: 'confirmation-1',
      confirmedVersionId: 'version-1',
      connectionId: 'connection-1',
      channel: 'dingtalk_log',
      status: 'pending',
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
