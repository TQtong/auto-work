import { describe, expect, it } from 'vitest';
import {
  buildWeeklyReportRobotNotification,
  projectNamesFromTaskFacts,
} from '../src/modules/weekly-reports/weekly-report-robot-notification.js';

describe('周报机器人安全通知模板', () => {
  it('生成和确认提醒不携带正文、链接或自动执行承诺', () => {
    const generation = buildWeeklyReportRobotNotification({
      type: 'generation_reminder',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
    });
    const confirmation = buildWeeklyReportRobotNotification({
      type: 'confirmation_reminder',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      draftStatus: '编辑中',
    });

    expect(generation).toContain('尚未生成本周期周报');
    expect(generation).toContain('不会自动生成或正式提交');
    expect(confirmation).toContain('当前草稿状态：编辑中');
    expect(confirmation).toContain('不会自动确认或正式提交');
    expect(`${generation}\n${confirmation}`).not.toContain('localhost');
  });

  it('提交成功摘要只含周期、状态、项目和正式日志 ID，不含六字段全文或本机链接', () => {
    const message = buildWeeklyReportRobotNotification({
      type: 'submission_success',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      reportDate: '2026-07-17',
      formalLogId: 'report-1001',
      projectNames: ['项目甲', '项目乙'],
    });
    expect(message).toContain('状态：已提交钉钉正式日志');
    expect(message).toContain('主要项目：项目甲、项目乙');
    expect(message).not.toContain('本周工作');
    expect(message).not.toContain('localhost');
  });

  it('显式测试周报包含五项正文、测试标识，并脱敏凭证与 URL 查询参数', () => {
    const message = buildWeeklyReportRobotNotification({
      type: 'test_report',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      reportDate: '2026-07-17',
      recentGoals: '验证完整测试链路',
      weeklyWork: '完成 AI 填写\ntoken=super-secret-token',
      nextWeekPlans: '测试群机器人发送',
      problems: '接口 https://example.com/path?access_token=should-not-send',
      other: '',
    });

    expect(message).toContain('【测试消息】');
    expect(message).toContain('【本周工作】');
    expect(message).toContain('完成 AI 填写');
    expect(message).toContain('[敏感信息已脱敏]');
    expect(message).toContain('https://example.com/path?[查询参数已脱敏]');
    expect(message).toContain('【其他事项】\n（无）');
    expect(message).not.toContain('super-secret-token');
    expect(message).not.toContain('should-not-send');
  });

  it('截止、失败和风险通知使用固定边界并清理换行注入', () => {
    const deadline = buildWeeklyReportRobotNotification({
      type: 'deadline_reminder',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      deadlineText: '2026-07-17 17:30 Asia/Shanghai',
      draftStatus: '待确认',
    });
    expect(deadline).toContain('本提醒不会自动正式提交');

    const failure = buildWeeklyReportRobotNotification({
      type: 'submission_failure',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      stage: '群摘要\n伪造阶段',
      safeErrorSummary: '权限不足\r\nAuthorization: 不应扩展为新行',
    });
    expect(failure).toContain('失败阶段：群摘要 伪造阶段');
    expect(failure).not.toContain('\n伪造阶段');
    expect(failure).toContain('不会盲目重放');

    const risk = buildWeeklyReportRobotNotification({
      type: 'risk_alert',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      riskSummaries: ['阻断项甲', '阻断项乙', '阻断项丙', '不得发送的第四项'],
    });
    expect(risk).toContain('风险 3：阻断项丙');
    expect(risk).not.toContain('第四项');
  });

  it('项目事实去重、排序并限制为三个安全名称', () => {
    expect(
      projectNamesFromTaskFacts(
        JSON.stringify([
          { projectName: '项目乙' },
          { projectName: '项目甲\n注入' },
          { projectName: '项目乙' },
          { projectName: '项目丙' },
          { projectName: '项目丁' },
        ]),
      ),
    ).toEqual(['项目丙', '项目丁', '项目甲 注入']);
  });
});
