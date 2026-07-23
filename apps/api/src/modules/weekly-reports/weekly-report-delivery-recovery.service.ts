import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { AuditService } from '../audit/audit.service.js';
import { DingTalkLogClient } from '../dingtalk/dingtalk-log.client.js';
import { SessionService } from '../session/session.service.js';
import { buildDingTalkReportContents } from './weekly-report-delivery.payload.js';
import type {
  ReconcileWeeklyReportDeliveryInput,
  ResolveWeeklyReportDeliveryInput,
  RetryWeeklyReportDeliveryInput,
} from './weekly-report.schemas.js';

const queryPageSize = 20;
const maximumQueryPages = 20;
const queryWindowPaddingMs = 2 * 60_000;
const providerVisibilityGraceMs = 2 * 60_000;
const repeatedAbsenceGapMs = 30_000;
const maximumDeliveryAttempts = 3;

interface RecoveryAuditContext {
  correlationId: string;
  sessionId: string;
  idempotencyRecordId: string;
}

@Injectable()
export class WeeklyReportDeliveryRecoveryService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly logClient: DingTalkLogClient,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
  ) {}

  public async reconcile(
    reportId: string,
    intentId: string,
    input: ReconcileWeeklyReportDeliveryInput,
    context: RecoveryAuditContext,
  ) {
    const intent = await this.loadOwnedIntent(reportId, intentId);
    if (intent.version !== input.intentVersion) this.throwVersionConflict();
    if (intent.channel !== 'dingtalk_log' || !['unknown', 'needs_review'].includes(intent.status)) {
      throw new DomainError(
        'DELIVERY_RECOVERY_QUERY_NOT_ALLOWED',
        '只有结果未知或待复核的钉钉正式日志才能执行外部查询恢复',
        { httpStatus: 409, suggestedAction: 'manual_review' },
      );
    }
    const attempt = intent.attempts[0];
    if (!attempt?.completedAt) {
      throw new DomainError('DELIVERY_RECOVERY_ATTEMPT_MISSING', '找不到可核对的已完成交付尝试', {
        httpStatus: 409,
      });
    }
    if (intent.connection.type === 'dingtalk_desktop') {
      throw new DomainError(
        'DINGTALK_DESKTOP_RESULT_QUERY_UNAVAILABLE',
        '无接口权限时不能自动读取公司日志列表；请在钉钉客户端人工核对并使用人工裁决',
        { httpStatus: 422, suggestedAction: 'manual_review' },
      );
    }
    const configuration = this.parseObject(intent.connection.configJson);
    const credential = await this.readCredential(intent.connection.credentialRef);
    if (
      typeof configuration.appKey !== 'string' ||
      typeof configuration.operatorUserId !== 'string' ||
      typeof credential.appSecret !== 'string' ||
      !intent.connection.baseUrl
    ) {
      throw new DomainError(
        'DINGTALK_LOG_CONFIGURATION_REQUIRED',
        '恢复查询需要有效的钉钉应用、操作用户和当前凭证',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }
    const queryWindowStart = new Date(attempt.startedAt.getTime() - queryWindowPaddingMs);
    const queryWindowEnd = new Date();
    const expectedContents = buildDingTalkReportContents({
      fieldsJson: intent.confirmation.templateMappingVersion.fieldsJson,
      version: intent.confirmedVersion,
    });
    let reports: Awaited<ReturnType<DingTalkLogClient['listReports']>>['reports'] = [];
    let cursor = 0;
    let pages = 0;
    let incomplete = false;
    const providerRequestIds: string[] = [];
    try {
      const token = await this.logClient.accessToken({
        appKey: configuration.appKey,
        appSecret: credential.appSecret,
        configuredAccessToken:
          typeof credential.accessToken === 'string' ? credential.accessToken : undefined,
      });
      for (let pageIndex = 0; pageIndex < maximumQueryPages; pageIndex += 1) {
        const page = await this.logClient.listReports({
          baseUrl: intent.connection.baseUrl,
          accessToken: token.value,
          operatorUserId: configuration.operatorUserId,
          templateName: intent.confirmation.templateMappingVersion.templateName,
          startTime: queryWindowStart.getTime(),
          endTime: queryWindowEnd.getTime(),
          cursor,
          size: queryPageSize,
        });
        pages += 1;
        reports = reports.concat(page.reports);
        if (page.requestId) providerRequestIds.push(page.requestId);
        if (!page.hasMore) break;
        if (pageIndex === maximumQueryPages - 1 || page.nextCursor === cursor) {
          incomplete = true;
          break;
        }
        cursor = page.nextCursor;
      }
    } catch (error) {
      return this.persistQueryFailure(intent, queryWindowStart, queryWindowEnd, error, context);
    }

    const exactMatches = reports.filter(
      (report) =>
        report.creatorId === configuration.operatorUserId &&
        report.templateName === intent.confirmation.templateMappingVersion.templateName &&
        report.createTime >= queryWindowStart.getTime() &&
        report.createTime <= queryWindowEnd.getTime() &&
        this.contentsEqual(expectedContents, report.contents),
    );
    const latestNotFound = intent.recoveryChecks.find(
      (check) => check.mode === 'provider_query' && check.outcome === 'not_found',
    );
    const now = new Date();
    const absenceConfirmed =
      !incomplete &&
      exactMatches.length === 0 &&
      Boolean(latestNotFound) &&
      now.getTime() - attempt.completedAt.getTime() >= providerVisibilityGraceMs &&
      now.getTime() - latestNotFound!.createdAt.getTime() >= repeatedAbsenceGapMs;
    const outcome = incomplete
      ? 'ambiguous'
      : exactMatches.length === 1
        ? 'matched'
        : exactMatches.length > 1
          ? 'ambiguous'
          : absenceConfirmed
            ? 'absence_confirmed'
            : 'not_found';
    const matchedExternalId = outcome === 'matched' ? exactMatches[0]!.reportId : null;
    const nextStatus =
      outcome === 'matched'
        ? 'succeeded'
        : outcome === 'absence_confirmed'
          ? 'failed'
          : outcome === 'ambiguous'
            ? 'needs_review'
            : 'unknown';
    const summary = {
      pages,
      incomplete,
      providerRequestIds: providerRequestIds.slice(0, 20),
      matchingExternalIds: exactMatches.slice(0, 3).map((report) => report.reportId),
      visibilityGraceSatisfied:
        now.getTime() - attempt.completedAt.getTime() >= providerVisibilityGraceMs,
      repeatedAbsenceSatisfied: Boolean(latestNotFound),
      // 查询证据只包含数量、标识和哈希，不把周报全文复制到恢复记录。
      expectedContentsHash: requestHash(expectedContents),
    };
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.deliveryIntent.updateMany({
        where: { id: intent.id, version: input.intentVersion, status: intent.status },
        data: {
          status: nextStatus,
          recoveryStatus: outcome,
          lastRecoveryAt: now,
          externalId: matchedExternalId,
          lastErrorCode:
            outcome === 'absence_confirmed'
              ? 'DINGTALK_RECOVERY_ABSENCE_CONFIRMED'
              : outcome === 'ambiguous'
                ? 'DINGTALK_RECOVERY_AMBIGUOUS'
                : outcome === 'not_found'
                  ? 'DINGTALK_RECOVERY_NOT_YET_FOUND'
                  : null,
          lastErrorSummary:
            outcome === 'absence_confirmed'
              ? '连续两次外部查询均未找到精确匹配日志，已允许显式受控重试'
              : outcome === 'ambiguous'
                ? '外部查询不完整或找到多个精确匹配日志，必须人工裁决'
                : outcome === 'not_found'
                  ? '尚未找到精确匹配日志；需要等待可见性宽限后再次查询'
                  : null,
          completedAt: ['matched', 'absence_confirmed', 'ambiguous'].includes(outcome)
            ? now
            : intent.completedAt,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.throwVersionConflict();
      await this.createCheck(tx, intent, {
        mode: 'provider_query',
        outcome,
        queryWindowStart,
        queryWindowEnd,
        candidateCount: reports.length,
        exactMatchCount: exactMatches.length,
        matchedExternalId,
        summary,
      });
      if (outcome === 'matched' || outcome === 'absence_confirmed') {
        await tx.weeklyReport.update({
          where: { id: intent.reportId },
          data: {
            logDeliveryState: outcome === 'matched' ? 'submitted' : 'failed',
            version: { increment: 1 },
          },
        });
      }
      const response = {
        intentId: intent.id,
        status: nextStatus,
        recoveryStatus: outcome,
        externalId: matchedExternalId,
        candidateCount: reports.length,
        exactMatchCount: exactMatches.length,
        retryAllowed: outcome === 'absence_confirmed',
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response, 200);
      await this.recordAudit(tx, context, intent.id, 'weekly_report.delivery_reconciled', {
        outcome,
        candidateCount: reports.length,
        exactMatchCount: exactMatches.length,
        evidenceHash: requestHash(summary),
      });
      return response;
    });
  }

  public async resolve(
    reportId: string,
    intentId: string,
    input: ResolveWeeklyReportDeliveryInput,
    context: RecoveryAuditContext,
  ) {
    const intent = await this.loadOwnedIntent(reportId, intentId);
    if (intent.version !== input.intentVersion) this.throwVersionConflict();
    if (!['unknown', 'needs_review'].includes(intent.status)) {
      throw new DomainError(
        'DELIVERY_MANUAL_RESOLUTION_NOT_ALLOWED',
        '只有结果未知或待复核的交付才能人工裁决',
        { httpStatus: 409 },
      );
    }
    const delivered = input.resolution === 'delivered';
    const now = new Date();
    const recoveryStatus = delivered ? 'manual_succeeded' : 'manual_absence_confirmed';
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.deliveryIntent.updateMany({
        where: { id: intent.id, version: input.intentVersion, status: intent.status },
        data: {
          status: delivered ? 'succeeded' : 'failed',
          recoveryStatus,
          lastRecoveryAt: now,
          resolvedBy: this.sessions.currentProfileId,
          resolvedAt: now,
          resolutionReason: input.reason,
          externalId: input.externalId,
          externalUrl: input.externalUrl,
          lastErrorCode: delivered ? null : 'DINGTALK_MANUAL_ABSENCE_CONFIRMED',
          lastErrorSummary: delivered ? null : '用户已在钉钉人工确认未发生交付',
          completedAt: now,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.throwVersionConflict();
      await this.createCheck(tx, intent, {
        mode: 'manual_resolution',
        outcome: recoveryStatus,
        queryWindowStart: null,
        queryWindowEnd: null,
        candidateCount: 0,
        exactMatchCount: 0,
        matchedExternalId: input.externalId,
        summary: {
          resolution: input.resolution,
          reasonHash: requestHash(input.reason),
          confirmationPhraseAccepted: true,
        },
      });
      await tx.weeklyReport.update({
        where: { id: intent.reportId },
        data: {
          ...(intent.channel === 'dingtalk_log'
            ? { logDeliveryState: delivered ? 'submitted' : 'failed' }
            : { robotDeliveryState: delivered ? 'notified' : 'failed' }),
          version: { increment: 1 },
        },
      });
      const response = {
        intentId: intent.id,
        status: delivered ? 'succeeded' : 'failed',
        recoveryStatus,
        externalId: input.externalId,
        retryAllowed: !delivered,
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response, 200);
      await this.recordAudit(tx, context, intent.id, 'weekly_report.delivery_manually_resolved', {
        resolution: input.resolution,
        recoveryStatus,
        externalId: input.externalId,
        reasonHash: requestHash(input.reason),
      });
      return response;
    });
  }

  public async retry(
    reportId: string,
    intentId: string,
    input: RetryWeeklyReportDeliveryInput,
    context: RecoveryAuditContext,
  ) {
    const intent = await this.loadOwnedIntent(reportId, intentId);
    if (intent.version !== input.intentVersion) this.throwVersionConflict();
    if (intent.status !== 'failed') {
      throw new DomainError('DELIVERY_RETRY_NOT_ALLOWED', '只有明确失败的交付才能受控重试', {
        httpStatus: 409,
        suggestedAction: 'manual_review',
      });
    }
    if (intent.attemptCount >= maximumDeliveryAttempts) {
      throw new DomainError(
        'DELIVERY_RETRY_LIMIT_REACHED',
        `交付最多允许 ${maximumDeliveryAttempts} 次显式尝试，当前必须人工处理`,
        { httpStatus: 409, suggestedAction: 'manual_review' },
      );
    }
    if (
      !intent.connection.enabled ||
      intent.connection.status !== 'healthy' ||
      (intent.connection.type !== 'dingtalk_desktop' && !intent.connection.credentialRef)
    ) {
      throw new DomainError(
        'DELIVERY_CONNECTION_NOT_HEALTHY',
        '请先修复并测试交付连接，再发起重试',
        {
          httpStatus: 422,
          suggestedAction: 'reconfigure',
        },
      );
    }
    if (
      intent.channel === 'dingtalk_log' &&
      ['pending', 'not_found', 'ambiguous'].includes(intent.recoveryStatus)
    ) {
      throw new DomainError(
        'DELIVERY_UNKNOWN_RETRY_FORBIDDEN',
        '正式日志尚未证明失败，禁止自动或手动重放创建请求',
        { httpStatus: 409, suggestedAction: 'manual_review' },
      );
    }
    const mapping = intent.confirmation.templateMappingVersion;
    if (
      intent.channel === 'dingtalk_log' &&
      (mapping.mapping.currentVersionId !== mapping.id || mapping.expiresAt <= new Date())
    ) {
      throw new DomainError(
        'DINGTALK_LOG_CAPABILITY_CHANGED',
        '确认使用的模板映射已变化或过期，请重新确认周报，不能沿用旧意图重试',
        { httpStatus: 422, suggestedAction: 'reconfirm' },
      );
    }
    const jobId = newId();
    const nextAttemptNo = intent.attemptCount + 1;
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.deliveryIntent.updateMany({
        where: { id: intent.id, version: input.intentVersion, status: 'failed' },
        data: {
          status: 'pending',
          jobId,
          completedAt: null,
          lastErrorCode: null,
          lastErrorSummary: null,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.throwVersionConflict();
      await tx.job.create({
        data: {
          id: jobId,
          type: 'weekly-report.delivery',
          payloadRef: intent.id,
          payloadSummary: JSON.stringify({
            reportId: intent.reportId,
            intentId: intent.id,
            channel: intent.channel,
            connectionId: intent.connectionId,
            explicitRetry: true,
            nextAttemptNo,
            reasonHash: requestHash(input.reason),
          }),
          scheduledAt: new Date(),
          maxAttempts: 1,
          dedupeKey: `weekly-report.delivery:${intent.id}:attempt:${nextAttemptNo}`,
        },
      });
      if (intent.channel === 'dingtalk_robot') {
        await tx.robotNotification.updateMany({
          where: { deliveryIntentId: intent.id, status: 'failed' },
          data: {
            status: 'queued',
            jobId,
            lastErrorCode: null,
            lastErrorSummary: null,
            version: { increment: 1 },
          },
        });
      }
      await tx.weeklyReport.update({
        where: { id: intent.reportId },
        data: {
          ...(intent.channel === 'dingtalk_log'
            ? { logDeliveryState: 'submitting' }
            : { robotDeliveryState: 'not_started' }),
          version: { increment: 1 },
        },
      });
      const response = { intentId: intent.id, status: 'pending', jobId, nextAttemptNo };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response, 202);
      await this.recordAudit(tx, context, intent.id, 'weekly_report.delivery_retry_requested', {
        channel: intent.channel,
        nextAttemptNo,
        reasonHash: requestHash(input.reason),
        previousRecoveryStatus: intent.recoveryStatus,
      });
      return response;
    });
  }

  private async persistQueryFailure(
    intent: Awaited<ReturnType<WeeklyReportDeliveryRecoveryService['loadOwnedIntent']>>,
    queryWindowStart: Date,
    queryWindowEnd: Date,
    error: unknown,
    context: RecoveryAuditContext,
  ) {
    const errorCode = error instanceof DomainError ? error.code : 'DINGTALK_RECOVERY_QUERY_FAILED';
    const errorSummary = (error instanceof Error ? error.message : '钉钉恢复查询失败').slice(
      0,
      500,
    );
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.deliveryIntent.updateMany({
        where: { id: intent.id, version: intent.version, status: intent.status },
        data: {
          recoveryStatus: 'pending',
          lastRecoveryAt: new Date(),
          lastErrorCode: errorCode,
          lastErrorSummary: errorSummary,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.throwVersionConflict();
      await this.createCheck(tx, intent, {
        mode: 'provider_query',
        outcome: 'query_failed',
        queryWindowStart,
        queryWindowEnd,
        candidateCount: 0,
        exactMatchCount: 0,
        matchedExternalId: null,
        summary: { errorCode, errorSummaryHash: requestHash(errorSummary) },
      });
      const response = {
        intentId: intent.id,
        status: intent.status,
        recoveryStatus: 'pending',
        outcome: 'query_failed',
        errorCode,
        retryAllowed: false,
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response, 200);
      await this.recordAudit(tx, context, intent.id, 'weekly_report.delivery_reconcile_failed', {
        errorCode,
      });
      return response;
    });
  }

  private async loadOwnedIntent(reportId: string, intentId: string) {
    const intent = await this.prisma.deliveryIntent.findFirst({
      where: {
        id: intentId,
        reportId,
        report: { ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      },
      include: {
        report: true,
        connection: true,
        attempts: { orderBy: { attemptNo: 'desc' }, take: 1 },
        recoveryChecks: { orderBy: { sequenceNo: 'desc' } },
        confirmation: {
          include: { templateMappingVersion: { include: { mapping: true } } },
        },
        confirmedVersion: true,
      },
    });
    if (!intent)
      throw new DomainError(errorCodes.notFound, '周报交付意图不存在', { httpStatus: 404 });
    return intent;
  }

  private async createCheck(
    tx: Prisma.TransactionClient,
    intent: Awaited<ReturnType<WeeklyReportDeliveryRecoveryService['loadOwnedIntent']>>,
    input: {
      mode: 'provider_query' | 'manual_resolution';
      outcome: string;
      queryWindowStart: Date | null;
      queryWindowEnd: Date | null;
      candidateCount: number;
      exactMatchCount: number;
      matchedExternalId: string | null;
      summary: Record<string, unknown>;
    },
  ) {
    const sequenceNo = (intent.recoveryChecks[0]?.sequenceNo ?? 0) + 1;
    await tx.deliveryRecoveryCheck.create({
      data: {
        id: newId(),
        intentId: intent.id,
        sequenceNo,
        mode: input.mode,
        outcome: input.outcome,
        queryWindowStart: input.queryWindowStart,
        queryWindowEnd: input.queryWindowEnd,
        candidateCount: input.candidateCount,
        exactMatchCount: input.exactMatchCount,
        matchedExternalId: input.matchedExternalId,
        evidenceHash: requestHash({
          intentId: intent.id,
          sequenceNo,
          ...input,
        }),
        summaryJson: JSON.stringify(input.summary),
        actorId: this.sessions.currentProfileId,
        createdAt: new Date(),
      },
    });
  }

  private contentsEqual(
    expected: Array<{ key: string; sort: string; type: string; content: string }>,
    actual: Array<{ key: string; sort: string; type: string; value: string }>,
  ): boolean {
    if (expected.length !== actual.length) return false;
    const normalize = <T extends { sort: string }>(values: T[]) =>
      [...values].sort((left, right) =>
        left.sort.localeCompare(right.sort, 'en', { numeric: true }),
      );
    const left = normalize(expected);
    const right = normalize(actual);
    return left.every(
      (field, index) =>
        field.key === right[index]?.key &&
        field.sort === right[index]?.sort &&
        field.type === right[index]?.type &&
        field.content === right[index]?.value,
    );
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

  private async completeIdempotency(
    tx: Prisma.TransactionClient,
    recordId: string,
    response: unknown,
    httpStatus: number,
  ) {
    await tx.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        state: 'completed',
        httpStatus,
        responseJson: JSON.stringify(response),
        errorCode: null,
      },
    });
  }

  private async recordAudit(
    tx: Prisma.TransactionClient,
    context: RecoveryAuditContext,
    intentId: string,
    action: string,
    after: Record<string, unknown>,
  ) {
    await this.audit.recordInTransaction(tx, {
      actorId: this.sessions.currentProfileId,
      action,
      targetType: 'delivery_intent',
      targetId: intentId,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      after,
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
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

  private throwVersionConflict(): never {
    throw new DomainError(errorCodes.versionConflict, '交付恢复状态已变化，请刷新后重试', {
      httpStatus: 409,
      suggestedAction: 'refresh',
    });
  }
}
