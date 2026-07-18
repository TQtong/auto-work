import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { DingTalkRobotClient } from '../dingtalk/dingtalk-robot.client.js';
import type { JobExecutionContext, JobHandler } from '../jobs/job-registry.service.js';
import { JobRegistryService } from '../jobs/job-registry.service.js';
import {
  buildWeeklyReportRobotNotification,
  weeklyReportRobotNotificationFactsSchema,
} from './weekly-report-robot-notification.js';

@Injectable()
export class WeeklyReportNotificationHandler implements JobHandler, OnModuleInit {
  public readonly type = 'weekly-report.notification';
  public readonly concurrency = 1;
  // 网络中断后无法查询 Custom Webhook 是否收取，租约恢复必须保守进入人工复核。
  public readonly recovery = 'manual_review' as const;

  public constructor(
    private readonly jobs: JobRegistryService,
    private readonly prisma: PrismaService,
    private readonly robotClient: DingTalkRobotClient,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
  ) {}

  public onModuleInit(): void {
    this.jobs.register(this);
  }

  public async execute(context: JobExecutionContext): Promise<unknown> {
    if (!context.payloadRef) {
      throw new DomainError('ROBOT_NOTIFICATION_ID_MISSING', '机器人通知作业缺少账本 ID');
    }
    const notification = await this.prisma.robotNotification.findUnique({
      where: { id: context.payloadRef },
      include: { connection: true },
    });
    if (!notification) {
      throw new DomainError('ROBOT_NOTIFICATION_NOT_FOUND', '机器人通知账本不存在', {
        httpStatus: 404,
      });
    }
    if (notification.status === 'succeeded') {
      return { notificationId: notification.id, status: 'succeeded', replayed: true };
    }
    if (!['pending', 'queued'].includes(notification.status)) {
      throw new DomainError(
        'ROBOT_NOTIFICATION_NOT_EXECUTABLE',
        `机器人通知当前状态 ${notification.status} 不能自动执行`,
        { httpStatus: 409, suggestedAction: 'manual_review' },
      );
    }
    const claimed = await this.prisma.robotNotification.updateMany({
      where: { id: notification.id, version: notification.version, status: notification.status },
      data: { status: 'sending', lastAttemptAt: new Date(), version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new DomainError('ROBOT_NOTIFICATION_VERSION_CONFLICT', '通知已由其他作业处理', {
        httpStatus: 409,
        suggestedAction: 'manual_review',
      });
    }
    await context.reportProgress(20);
    try {
      this.assertConnection(notification.connection);
      const credential = await this.readCredential(notification.connection.credentialRef);
      const facts = weeklyReportRobotNotificationFactsSchema.parse(
        JSON.parse(notification.messageFactsJson) as unknown,
      );
      const message = buildWeeklyReportRobotNotification(facts);
      if (
        requestHash({ notificationType: notification.notificationType, message }) !==
        notification.contentHash
      ) {
        throw new DomainError(
          'ROBOT_NOTIFICATION_CONTENT_HASH_MISMATCH',
          '通知冻结事实与正文哈希不一致，拒绝发送',
          { httpStatus: 409, suggestedAction: 'manual_review' },
        );
      }
      const result = await this.robotClient.sendText({
        webhook: String(credential.webhook),
        secret: String(credential.secret),
        text: message,
      });
      await this.finish(notification.id, 'succeeded', {
        providerRequestId: result.requestId,
        providerCallCount: result.providerCallCount,
        retryDelaysMs: result.retryDelaysMs,
        errorCode: null,
        errorSummary: null,
      });
      return { notificationId: notification.id, status: 'succeeded', replayed: false };
    } catch (error) {
      const failure = this.classify(error);
      await this.finish(notification.id, failure.status, failure);
      if (failure.status === 'unknown') {
        throw new DomainError(
          'DINGTALK_NOTIFICATION_RESULT_UNKNOWN',
          '机器人通知结果未知，禁止自动重放',
          { httpStatus: 503, suggestedAction: 'manual_review' },
        );
      }
      return { notificationId: notification.id, status: 'failed', errorCode: failure.errorCode };
    }
  }

  private assertConnection(connection: {
    type: string;
    enabled: boolean;
    status: string;
    credentialRef: string | null;
  }): void {
    if (
      connection.type !== 'dingtalk_robot' ||
      !connection.enabled ||
      connection.status !== 'healthy' ||
      !connection.credentialRef
    ) {
      throw new DomainError(
        'DINGTALK_ROBOT_NOT_HEALTHY',
        '通知发送前机器人连接已失效，请重新测试配置',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }
  }

  private async readCredential(reference: string | null): Promise<Record<string, unknown>> {
    if (!reference) return {};
    try {
      const parsed = JSON.parse(await this.vault.get(reference)) as unknown;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).webhook !== 'string' ||
        typeof (parsed as Record<string, unknown>).secret !== 'string'
      ) {
        throw new Error('invalid credential');
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw new DomainError('DELIVERY_CREDENTIAL_UNAVAILABLE', '机器人当前凭证不可用', {
        httpStatus: 422,
      });
    }
  }

  private async finish(
    id: string,
    status: 'succeeded' | 'failed' | 'unknown',
    result: {
      providerRequestId: string | null;
      providerCallCount: number;
      retryDelaysMs: number[];
      errorCode: string | null;
      errorSummary: string | null;
    },
  ): Promise<void> {
    const changed = await this.prisma.robotNotification.updateMany({
      where: { id, status: 'sending' },
      data: {
        status,
        providerRequestId: result.providerRequestId,
        providerCallCount: result.providerCallCount,
        retryDelaysJson: JSON.stringify(result.retryDelaysMs),
        lastErrorCode: result.errorCode,
        lastErrorSummary: result.errorSummary,
        sentAt: status === 'succeeded' ? new Date() : null,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      throw new DomainError('ROBOT_NOTIFICATION_RESULT_CONFLICT', '通知结果落库发生并发冲突', {
        httpStatus: 409,
        suggestedAction: 'manual_review',
      });
    }
  }

  private classify(error: unknown) {
    const domain = error instanceof DomainError ? error : null;
    const details =
      domain?.options.details && typeof domain.options.details === 'object'
        ? (domain.options.details as Record<string, unknown>)
        : {};
    const errorCode = domain?.code ?? 'DINGTALK_NOTIFICATION_FAILED';
    const resultUnknown = ['EXTERNAL_REQUEST_TIMEOUT', 'EXTERNAL_REQUEST_FAILED'].includes(
      errorCode,
    );
    const providerCallCount =
      typeof details.providerCallCount === 'number' &&
      Number.isInteger(details.providerCallCount) &&
      details.providerCallCount >= 0 &&
      details.providerCallCount <= 3
        ? details.providerCallCount
        : 1;
    const retryDelaysMs = Array.isArray(details.retryDelaysMs)
      ? details.retryDelaysMs.filter(
          (value): value is number =>
            typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 30_000,
        )
      : [];
    return {
      status: resultUnknown ? ('unknown' as const) : ('failed' as const),
      providerRequestId: null,
      providerCallCount,
      retryDelaysMs,
      errorCode,
      errorSummary: (error instanceof Error ? error.message : '机器人通知失败').slice(0, 500),
    };
  }
}
