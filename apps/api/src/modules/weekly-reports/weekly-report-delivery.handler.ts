import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { DeliveryIntent } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { DingTalkLogClient } from '../dingtalk/dingtalk-log.client.js';
import { DingTalkRobotClient } from '../dingtalk/dingtalk-robot.client.js';
import type { JobExecutionContext, JobHandler } from '../jobs/job-registry.service.js';
import { JobRegistryService } from '../jobs/job-registry.service.js';
import { buildDingTalkReportContents } from './weekly-report-delivery.payload.js';
import {
  buildWeeklyReportRobotNotification,
  projectNamesFromTaskFacts,
} from './weekly-report-robot-notification.js';

@Injectable()
export class WeeklyReportDeliveryHandler implements JobHandler, OnModuleInit {
  public readonly type = 'weekly-report.delivery';
  public readonly concurrency = 1;
  // 正式日志创建和机器人通知都有外部副作用，租约丢失后必须先核对，禁止自动重放。
  public readonly recovery = 'manual_review' as const;

  public constructor(
    private readonly jobs: JobRegistryService,
    private readonly prisma: PrismaService,
    private readonly logClient: DingTalkLogClient,
    private readonly robotClient: DingTalkRobotClient,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
  ) {}

  public onModuleInit(): void {
    this.jobs.register(this);
  }

  public async execute(context: JobExecutionContext): Promise<unknown> {
    if (!context.payloadRef) {
      throw new DomainError('DELIVERY_INTENT_ID_MISSING', '交付作业缺少意图 ID');
    }
    const intent = await this.loadIntent(context.payloadRef);
    if (intent.status === 'succeeded') return this.result(intent, true);
    // 明确失败必须先经过受控重试 API 创建新作业并重置为 pending；handler 自身不接受 failed 直跑。
    if (intent.status !== 'pending') {
      throw new DomainError(
        'DELIVERY_INTENT_NOT_EXECUTABLE',
        `交付意图当前状态 ${intent.status} 不能自动执行`,
        { httpStatus: 409, suggestedAction: 'manual_review' },
      );
    }
    await context.reportProgress(10);
    const attempt = await this.startAttempt(intent);
    try {
      const providerResult =
        intent.channel === 'dingtalk_log'
          ? await this.submitFormalLog(intent)
          : await this.sendRobotSummary(intent);
      await context.reportProgress(85);
      await this.finishAttempt(intent.id, attempt.id, {
        status: 'succeeded',
        externalId: providerResult.externalId,
        externalUrl: providerResult.externalUrl,
        providerRequestId: providerResult.providerRequestId,
        errorCode: null,
        errorSummary: null,
        providerCallCount: providerResult.providerCallCount,
        retryDelaysMs: providerResult.retryDelaysMs,
      });
      return {
        intentId: intent.id,
        channel: intent.channel,
        status: 'succeeded',
        externalId: providerResult.externalId,
        externalUrl: providerResult.externalUrl,
        attemptNo: attempt.attemptNo,
      };
    } catch (error) {
      const classification = this.classifyFailure(error, intent.channel);
      await this.finishAttempt(intent.id, attempt.id, {
        status: classification.status,
        externalId: null,
        externalUrl: null,
        providerRequestId: null,
        errorCode: classification.errorCode,
        errorSummary: classification.errorSummary,
        providerCallCount: classification.providerCallCount,
        retryDelaysMs: classification.retryDelaysMs,
      });
      if (classification.status === 'unknown') {
        // 外部平台可能已经创建日志。先固定 unknown 事实，再让 manual_review 作业进入人工复核，绝不正常返回为成功。
        throw new DomainError(
          'DINGTALK_DELIVERY_RESULT_UNKNOWN',
          '钉钉交付结果未知，必须先查询或人工核对，禁止自动重放',
          {
            httpStatus: 503,
            suggestedAction: 'manual_review',
            details: { providerErrorCode: classification.errorCode },
          },
        );
      }
      return {
        intentId: intent.id,
        channel: intent.channel,
        status: classification.status,
        attemptNo: attempt.attemptNo,
        errorCode: classification.errorCode,
        suggestedAction: 'reconfigure',
      };
    }
  }

  private async submitFormalLog(
    intent: Awaited<ReturnType<WeeklyReportDeliveryHandler['loadIntent']>>,
  ) {
    const credential = await this.readCredential(intent.connection.credentialRef);
    const config = this.parseObject(intent.connection.configJson);
    if (
      typeof config.appKey !== 'string' ||
      typeof config.operatorUserId !== 'string' ||
      typeof credential.appSecret !== 'string' ||
      !intent.connection.baseUrl
    ) {
      throw new DomainError(
        'DINGTALK_LOG_CONFIGURATION_REQUIRED',
        '钉钉正式日志连接缺少应用、操作用户或凭证配置',
        { httpStatus: 422 },
      );
    }
    const token = await this.logClient.accessToken({
      appKey: config.appKey,
      appSecret: credential.appSecret,
      configuredAccessToken:
        typeof credential.accessToken === 'string' ? credential.accessToken : undefined,
    });
    const mapping = intent.confirmation.templateMappingVersion;
    const contents = buildDingTalkReportContents({
      fieldsJson: mapping.fieldsJson,
      version: intent.confirmedVersion,
    });
    const scope = this.parseObject(intent.confirmedVersion.recipientScopeJson);
    const recipients = this.parseArray(scope.recipients);
    const toUserIds = recipients.flatMap((value) => {
      const recipient = this.parseObject(value);
      return recipient.subjectType === 'user' && typeof recipient.externalId === 'string'
        ? [recipient.externalId]
        : [];
    });
    const result = await this.logClient.createReport({
      baseUrl: intent.connection.baseUrl,
      accessToken: token.value,
      operatorUserId: config.operatorUserId,
      templateId: mapping.templateId,
      contents,
      toUserIds,
      toChat: false,
      source: 'auto-work',
    });
    return {
      externalId: result.reportId,
      externalUrl: null,
      providerRequestId: result.requestId,
      providerCallCount: 1,
      retryDelaysMs: [] as number[],
    };
  }

  private async sendRobotSummary(
    intent: Awaited<ReturnType<WeeklyReportDeliveryHandler['loadIntent']>>,
  ) {
    const credential = await this.readCredential(intent.connection.credentialRef);
    if (typeof credential.webhook !== 'string' || typeof credential.secret !== 'string') {
      throw new DomainError(
        'DINGTALK_ROBOT_CONFIGURATION_REQUIRED',
        '钉钉机器人缺少当前 Webhook 或加签 Secret',
        { httpStatus: 422 },
      );
    }
    const formalLog = await this.prisma.deliveryIntent.findFirst({
      where: {
        reportId: intent.reportId,
        confirmationId: intent.confirmationId,
        channel: 'dingtalk_log',
        status: 'succeeded',
      },
      orderBy: { completedAt: 'desc' },
    });
    if (!formalLog?.externalId) {
      throw new DomainError(
        'DINGTALK_LOG_SUCCESS_FACT_MISSING',
        '找不到正式日志成功事实，机器人不能发送成功摘要',
        { httpStatus: 409 },
      );
    }
    const message = buildWeeklyReportRobotNotification({
      type: 'submission_success',
      periodStart: intent.report.periodStart,
      periodEnd: intent.report.periodEnd,
      reportDate: intent.report.reportDate,
      formalLogId: formalLog.externalId,
      projectNames: projectNamesFromTaskFacts(intent.confirmedVersion.sourceSnapshot.taskFactsJson),
    });
    const result = await this.robotClient.sendText({
      webhook: credential.webhook,
      secret: credential.secret,
      text: message,
    });
    return {
      externalId: formalLog.externalId,
      externalUrl: null,
      providerRequestId: result.requestId,
      providerCallCount: result.providerCallCount,
      retryDelaysMs: result.retryDelaysMs,
    };
  }

  private async startAttempt(intent: DeliveryIntent) {
    return this.prisma.$transaction(async (tx) => {
      const attemptNo = intent.attemptCount + 1;
      const attempt = await tx.deliveryAttempt.create({
        data: {
          id: newId(),
          intentId: intent.id,
          attemptNo,
          requestSummaryHash: requestHash({
            intentId: intent.id,
            requestHash: intent.requestHash,
            attemptNo,
          }),
        },
      });
      const changed = await tx.deliveryIntent.updateMany({
        where: { id: intent.id, version: intent.version, status: intent.status },
        data: {
          status: 'running',
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
          lastErrorCode: null,
          lastErrorSummary: null,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new DomainError(
          'DELIVERY_INTENT_VERSION_CONFLICT',
          '交付意图已被其他作业处理，当前作业不会重复调用外部平台',
          { httpStatus: 409, suggestedAction: 'manual_review' },
        );
      }
      if (intent.channel === 'dingtalk_robot') {
        await tx.robotNotification.updateMany({
          where: { deliveryIntentId: intent.id, status: { in: ['pending', 'queued', 'failed'] } },
          data: {
            status: 'sending',
            lastAttemptAt: new Date(),
            lastErrorCode: null,
            lastErrorSummary: null,
            version: { increment: 1 },
          },
        });
      }
      return attempt;
    });
  }

  private async finishAttempt(
    intentId: string,
    attemptId: string,
    result: {
      status: 'succeeded' | 'failed' | 'unknown';
      externalId: string | null;
      externalUrl: string | null;
      providerRequestId: string | null;
      errorCode: string | null;
      errorSummary: string | null;
      providerCallCount: number;
      retryDelaysMs: number[];
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const intent = await tx.deliveryIntent.findUniqueOrThrow({ where: { id: intentId } });
      await tx.deliveryAttempt.update({
        where: { id: attemptId },
        data: {
          status: result.status,
          providerErrorCode: result.errorCode,
          providerRequestId: result.providerRequestId,
          externalId: result.externalId,
          externalUrl: result.externalUrl,
          responseSummaryJson: JSON.stringify({
            status: result.status,
            hasExternalId: Boolean(result.externalId),
            providerRequestId: result.providerRequestId,
            providerCallCount: result.providerCallCount,
            errorCode: result.errorCode,
            retryDelaysMs: result.retryDelaysMs,
          }),
          completedAt: new Date(),
        },
      });
      const changed = await tx.deliveryIntent.updateMany({
        where: { id: intent.id, version: intent.version, status: 'running' },
        data: {
          status: result.status,
          externalId: result.externalId,
          externalUrl: result.externalUrl,
          providerRequestId: result.providerRequestId,
          lastErrorCode: result.errorCode,
          lastErrorSummary: result.errorSummary,
          recoveryStatus: result.status === 'unknown' ? 'pending' : 'not_required',
          completedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new DomainError(
          'DELIVERY_INTENT_VERSION_CONFLICT',
          '交付结果落库时发生并发冲突，必须人工核对外部结果',
          { httpStatus: 409, suggestedAction: 'manual_review' },
        );
      }
      if (intent.channel === 'dingtalk_robot') {
        const notification = await tx.robotNotification.findUnique({
          where: { deliveryIntentId: intent.id },
        });
        // 即使数据库中的历史证据被异常数据污染，也只允许追加合法的退避毫秒数。
        const priorDelays = notification
          ? this.parseArray(notification.retryDelaysJson).flatMap((value) =>
              typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 30_000
                ? [value]
                : [],
            )
          : [];
        await tx.robotNotification.updateMany({
          where: { deliveryIntentId: intent.id, status: 'sending' },
          data: {
            status: result.status,
            providerRequestId: result.providerRequestId,
            providerCallCount: { increment: result.providerCallCount },
            retryDelaysJson: JSON.stringify([...priorDelays, ...result.retryDelaysMs]),
            lastErrorCode: result.errorCode,
            lastErrorSummary: result.errorSummary,
            sentAt: result.status === 'succeeded' ? new Date() : null,
            version: { increment: 1 },
          },
        });
      }
      const deliveryState =
        intent.channel === 'dingtalk_log'
          ? result.status === 'succeeded'
            ? 'submitted'
            : result.status
          : result.status === 'succeeded'
            ? 'notified'
            : 'failed';
      await tx.weeklyReport.update({
        where: { id: intent.reportId },
        data: {
          ...(intent.channel === 'dingtalk_log'
            ? { logDeliveryState: deliveryState }
            : { robotDeliveryState: deliveryState }),
          version: { increment: 1 },
        },
      });
    });
  }

  private classifyFailure(
    error: unknown,
    channel: string,
  ): {
    status: 'failed' | 'unknown';
    errorCode: string;
    errorSummary: string;
    providerCallCount: number;
    retryDelaysMs: number[];
  } {
    const domain = error instanceof DomainError ? error : null;
    const errorCode = domain?.code ?? 'DINGTALK_DELIVERY_FAILED';
    const details = this.parseObject(domain?.options.details);
    const providerCallCount =
      typeof details.providerCallCount === 'number' &&
      Number.isInteger(details.providerCallCount) &&
      details.providerCallCount >= 1 &&
      details.providerCallCount <= 3
        ? details.providerCallCount
        : 1;
    const retryDelaysMs = this.parseArray(details.retryDelaysMs).flatMap((value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 30_000
        ? [value]
        : [],
    );
    const explicitRobotFailure =
      channel === 'dingtalk_robot' &&
      [
        'DINGTALK_ROBOT_RATE_LIMITED',
        'DINGTALK_ROBOT_RESPONSE_ERROR',
        'DINGTALK_ROBOT_PERMISSION_DENIED',
        'DINGTALK_ROBOT_SIGNATURE_INVALID',
        'DINGTALK_ROBOT_API_ERROR',
      ].includes(errorCode);
    const resultUnknown =
      !explicitRobotFailure &&
      (['EXTERNAL_REQUEST_TIMEOUT', 'EXTERNAL_REQUEST_FAILED'].includes(errorCode) ||
        (domain?.options.retryable === true && !errorCode.includes('RATE_LIMITED')));
    return {
      status: resultUnknown ? 'unknown' : 'failed',
      errorCode,
      errorSummary: (error instanceof Error ? error.message : '钉钉交付失败').slice(0, 500),
      providerCallCount,
      retryDelaysMs,
    };
  }

  private async loadIntent(intentId: string) {
    const intent = await this.prisma.deliveryIntent.findUnique({
      where: { id: intentId },
      include: {
        report: true,
        connection: true,
        confirmation: { include: { templateMappingVersion: true } },
        confirmedVersion: { include: { sourceSnapshot: true } },
      },
    });
    if (!intent) {
      throw new DomainError('DELIVERY_INTENT_NOT_FOUND', '交付意图不存在', { httpStatus: 404 });
    }
    return intent;
  }

  private async readCredential(reference: string | null): Promise<Record<string, unknown>> {
    if (!reference) return {};
    try {
      return this.parseObject(await this.vault.get(reference));
    } catch {
      throw new DomainError('DELIVERY_CREDENTIAL_UNAVAILABLE', '交付连接的当前凭证不可用', {
        httpStatus: 422,
      });
    }
  }

  private result(intent: DeliveryIntent, replayed: boolean) {
    return {
      intentId: intent.id,
      channel: intent.channel,
      status: intent.status,
      externalId: intent.externalId,
      externalUrl: intent.externalUrl,
      replayed,
    };
  }

  private parseObject(value: unknown): Record<string, unknown> {
    try {
      const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private parseArray(value: unknown): unknown[] {
    try {
      const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
