import { describe, expect, it } from 'vitest';
import { canRetryFailedDeliveryAttempt } from '../src/modules/weekly-reports/weekly-report-delivery-recovery.service.js';

describe('weekly report delivery retry policy', () => {
  it('keeps the ordinary three-attempt limit', () => {
    expect(
      canRetryFailedDeliveryAttempt({
        attemptCount: 2,
        connectionType: 'dingtalk_api',
        lastErrorCode: 'DINGTALK_RESPONSE_ERROR',
      }),
    ).toBe(true);
    expect(
      canRetryFailedDeliveryAttempt({
        attemptCount: 3,
        connectionType: 'dingtalk_api',
        lastErrorCode: 'DINGTALK_RESPONSE_ERROR',
      }),
    ).toBe(false);
  });

  it('allows a bounded retry after a provably pre-submit desktop date failure', () => {
    expect(
      canRetryFailedDeliveryAttempt({
        attemptCount: 3,
        connectionType: 'dingtalk_desktop',
        lastErrorCode: 'DINGTALK_DESKTOP_CURRENT_DATE_MISMATCH',
      }),
    ).toBe(true);
    expect(
      canRetryFailedDeliveryAttempt({
        attemptCount: 10,
        connectionType: 'dingtalk_desktop',
        lastErrorCode: 'DINGTALK_DESKTOP_CURRENT_DATE_MISMATCH',
      }),
    ).toBe(false);
  });

  it('never relaxes the limit for an uncertain desktop submission result', () => {
    expect(
      canRetryFailedDeliveryAttempt({
        attemptCount: 3,
        connectionType: 'dingtalk_desktop',
        lastErrorCode: 'DINGTALK_DESKTOP_SUBMISSION_RESULT_UNKNOWN',
      }),
    ).toBe(false);
  });
});
