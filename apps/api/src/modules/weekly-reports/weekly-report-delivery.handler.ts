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

const fieldTextColumns = {
  reportDate: 'reportDateText',
  recentGoals: 'recentGoalsText',
  weeklyWork: 'weeklyWorkText',
  nextWeekPlans: 'nextWeekPlansText',
  problems: 'problemsText',
  other: 'otherText',
} as const;

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
    if (!['pending', 'failed'].includes(intent.status)) {
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
      const classification = this.classifyFailure(error);
      await this.finishAttempt(intent.id, attempt.id, {
        status: classification.status,
        externalId: null,
        externalUrl: null,
        providerRequestId: null,
        errorCode: classification.errorCode,
        errorSummary: classification.errorSummary,
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
    const mappedFields = this.parseArray(mapping.fieldsJson).map((value) =>
      this.parseObject(value),
    );
    if (mappedFields.length !== 6) {
      throw new DomainError('DINGTALK_TEMPLATE_MAPPING_INVALID', '确认的钉钉模板映射不是六字段', {
        httpStatus: 422,
      });
    }
    const contents = mappedFields
      .sort((left, right) => Number(left.order) - Number(right.order))
      .map((field) => {
        const internalField = String(field.internalField) as keyof typeof fieldTextColumns;
        const column = fieldTextColumns[internalField];
        if (!column) {
          throw new DomainError(
            'DINGTALK_TEMPLATE_INTERNAL_FIELD_INVALID',
            `模板映射包含未知内部字段 ${String(field.internalField)}`,
            { httpStatus: 422 },
          );
        }
        return {
          key: String(field.externalFieldName),
          sort: String(field.order),
          type: String(field.externalType),
          content: intent.confirmedVersion[column],
        };
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
    const projects = this.projectNames(intent.confirmedVersion.sourceSnapshot.taskFactsJson);
    const message = [
      'Auto Work 周报交付通知',
      `周期：${intent.report.periodStart} 至 ${intent.report.periodEnd}`,
      `报告日期：${intent.report.reportDate}`,
      '状态：已提交钉钉正式日志',
      ...(projects.length > 0 ? [`主要项目：${projects.join('、')}`] : []),
      `正式日志 ID：${formalLog.externalId}`,
      '请在本机 Auto Work 查看交付详情。',
    ].join('\n');
    const result = await this.robotClient.sendText({
      webhook: credential.webhook,
      secret: credential.secret,
      text: message,
    });
    return {
      externalId: formalLog.externalId,
      externalUrl: null,
      providerRequestId: result.requestId,
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
            errorCode: result.errorCode,
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

  private classifyFailure(error: unknown): {
    status: 'failed' | 'unknown';
    errorCode: string;
    errorSummary: string;
  } {
    const domain = error instanceof DomainError ? error : null;
    const errorCode = domain?.code ?? 'DINGTALK_DELIVERY_FAILED';
    const resultUnknown =
      ['EXTERNAL_REQUEST_TIMEOUT', 'EXTERNAL_REQUEST_FAILED'].includes(errorCode) ||
      (domain?.options.retryable === true && !errorCode.includes('RATE_LIMITED'));
    return {
      status: resultUnknown ? 'unknown' : 'failed',
      errorCode,
      errorSummary: (error instanceof Error ? error.message : '钉钉交付失败').slice(0, 500),
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

  private projectNames(taskFactsJson: string): string[] {
    const names = this.parseArray(taskFactsJson).flatMap((value) => {
      const task = this.parseObject(value);
      if (typeof task.projectName !== 'string') return [];
      const normalized = task.projectName
        .replace(/[\r\n\t]/gu, ' ')
        .trim()
        .slice(0, 80);
      return normalized ? [normalized] : [];
    });
    return [...new Set(names)]
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
      .slice(0, 3);
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
