import { describe, expect, it } from 'vitest';
import { businessDateAt } from '../src/modules/weekly-reports/weekly-report-delivery-date.js';

describe('周报桌面提交日期', () => {
  it('使用任务实际执行时在周报时区中的当天日期', () => {
    expect(businessDateAt(new Date('2026-08-08T19:03:03.000Z'), 'Asia/Shanghai')).toBe(
      '2026-08-09',
    );
  });

  it('提交日期不受 UTC 日期边界影响', () => {
    const instant = new Date('2026-08-08T16:30:00.000Z');
    expect(businessDateAt(instant, 'Asia/Shanghai')).toBe('2026-08-09');
    expect(businessDateAt(instant, 'UTC')).toBe('2026-08-08');
  });
});
