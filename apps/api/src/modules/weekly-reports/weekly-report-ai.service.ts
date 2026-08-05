import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import {
  newId,
  requestHash,
  weeklyTaskHasWorklog,
  type WeeklyEvidenceFact,
  type WeeklyManualInput,
  type WeeklyReportField,
  type WeeklyTaskFact,
} from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { CredentialVault } from '../../infrastructure/vault/credential-vault.js';
import { CREDENTIAL_VAULT } from '../../infrastructure/vault/credential-vault.js';
import { AiProviderClient } from '../ai/ai-provider.client.js';
import { aiProviderConfigSchema } from '../ai/ai-provider.config.js';
import type { AiProviderConfig, AiUsage } from '../ai/ai-provider.types.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import type {
  AdoptWeeklyAiSuggestionInput,
  CreateWeeklyAiSuggestionInput,
  RejectWeeklyAiSuggestionInput,
} from './weekly-report.schemas.js';
import {
  buildWeeklyAiGenerationRequest,
  sanitizeWeeklyAiInput,
  validateWeeklyAiOutput,
  weeklyAiMaximumRawOutputBytes,
  weeklyAiPromptTemplateVersion,
  weeklyAiSanitizationPolicyVersion,
  type WeeklyAiSanitizationResult,
  type WeeklyAiValidatedOutput,
} from './weekly-report-ai.policy.js';

const weeklyAiTransactionOptions = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;
const weeklyAiMinimumTimeoutMs = 180_000;

interface MutationContext {
  correlationId: string;
  sessionId: string;
  idempotencyRecordId: string;
}

type AiGenerationWithVersions = Prisma.AiGenerationGetPayload<{
  include: { generatedVersions: true };
}>;

type BaseVersion = Prisma.WeeklyReportVersionGetPayload<{
  include: { sourceSnapshot: true; sourceLinks: true };
}>;

interface GenerationAttemptFacts {
  generationId: string;
  reportId: string;
  baseVersionId: string;
  baseReportVersion: number;
  connection: {
    id: string;
    version: number;
    baseUrl: string;
    credentialRef: string;
  };
  config: AiProviderConfig;
  requestedFields: WeeklyReportField[];
  policy: WeeklyAiSanitizationResult | null;
  startedAt: number;
}

@Injectable()
export class WeeklyReportAiService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly provider: AiProviderClient,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
  ) {}

  public async createSuggestion(
    reportId: string,
    input: CreateWeeklyAiSuggestionInput,
    context: MutationContext,
  ) {
    const startedAt = Date.now();
    const report = await this.prisma.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      include: {
        currentVersion: { include: { sourceSnapshot: true, sourceLinks: true } },
      },
    });
    if (!report?.currentVersion) {
      throw new DomainError(errorCodes.notFound, '周报或当前版本不存在', { httpStatus: 404 });
    }
    this.assertBase(
      report.currentVersionId,
      report.version,
      input.baseVersionId,
      input.reportVersion,
    );
    const connection = await this.resolveConnection(input.providerConnectionId);
    const requestedFields = this.normalizeFields(input.fields);
    const generationId = newId();
    const attempt: GenerationAttemptFacts = {
      generationId,
      reportId,
      baseVersionId: report.currentVersion.id,
      baseReportVersion: report.version,
      connection,
      config: connection.config,
      requestedFields,
      policy: null,
      startedAt,
    };

    const weeklyTasks = this.parseFacts<WeeklyTaskFact>(
      report.currentVersion.sourceSnapshot.taskFactsJson,
    ).filter((task) => this.isTaskInPeriod(task, report.periodStart, report.periodEnd));
    const weeklyTaskIds = new Set(weeklyTasks.map((task) => task.id));
    const weeklyEvidence = this.parseFacts<WeeklyEvidenceFact>(
      report.currentVersion.sourceSnapshot.evidenceFactsJson,
    ).filter((item) =>
      item.taskId
        ? weeklyTaskIds.has(item.taskId)
        : Boolean(
            item.eventAt &&
            item.eventAt.slice(0, 10) >= report.periodStart &&
            item.eventAt.slice(0, 10) <= report.periodEnd,
          ),
    );
    // AI 改写始终以当前周报（含已应用的正文模板）为基线。任务事实只用于补充和优化，
    // 不能因为本周存在任务就丢弃模板原文，否则模型返回空栏位时会把正文清空。
    const generationBaseFields = this.baseFields(report.currentVersion);

    let policy: WeeklyAiSanitizationResult;
    try {
      // 净化与秘密扫描必须先于凭证读取；命中禁区时，调用链不会接触密钥或外部网络。
      policy = sanitizeWeeklyAiInput({
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        reportDate: report.reportDate,
        timezone: report.timezone,
        selectedFields: requestedFields,
        baseFields: generationBaseFields,
        tasks: weeklyTasks,
        evidence: weeklyEvidence,
        manualInputs: this.parseFacts<WeeklyManualInput>(
          report.currentVersion.sourceSnapshot.manualInputsJson,
        ),
        consent: input.consent,
      });
      attempt.policy = policy;
    } catch (error) {
      return this.recordNonSuccess(
        attempt,
        'blocked',
        this.safeErrorCode(error, 'AI_INPUT_SANITIZATION_FAILED'),
        this.securityCategories(error, 'sanitization_policy'),
        context,
      );
    }

    const request = buildWeeklyAiGenerationRequest(policy);
    if (request.estimatedInputTokens > connection.config.maxInputTokens) {
      return this.recordNonSuccess(
        attempt,
        'blocked',
        'AI_INPUT_TOKEN_LIMIT_EXCEEDED',
        ['input_token_limit'],
        context,
      );
    }

    let apiKey: string;
    try {
      const credential = JSON.parse(await this.vault.get(connection.credentialRef)) as unknown;
      if (!this.isObject(credential) || typeof credential.apiKey !== 'string') {
        throw new DomainError('AI_CREDENTIAL_INVALID', 'AI 凭证结构无效', { httpStatus: 422 });
      }
      apiKey = credential.apiKey;
    } catch (error) {
      return this.recordNonSuccess(
        attempt,
        'failed',
        this.safeErrorCode(error, 'AI_CREDENTIAL_UNAVAILABLE'),
        [],
        context,
      );
    }

    let providerResponse;
    try {
      providerResponse = await this.provider.generate({
        baseUrl: connection.baseUrl,
        apiKey,
        config: connection.config,
        request: {
          purpose: 'weekly_report',
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          outputSchema: request.outputSchema,
          maxOutputTokens: connection.config.maxOutputTokens,
        },
      });
    } catch (error) {
      return this.recordNonSuccess(
        attempt,
        'failed',
        this.safeErrorCode(error, 'AI_PROVIDER_REQUEST_FAILED'),
        [],
        context,
      );
    }

    let validated: WeeklyAiValidatedOutput;
    try {
      // 供应商输出仍是不可信输入，先做秘密/主动内容扫描，再校验 JSON、引用和事实。
      validated = validateWeeklyAiOutput(providerResponse.outputText, policy, generationBaseFields);
    } catch (error) {
      const outputSecurityBlocked =
        error instanceof DomainError && error.code === 'AI_OUTPUT_SECURITY_BLOCKED';
      return this.recordNonSuccess(
        attempt,
        outputSecurityBlocked ? 'blocked' : 'failed',
        this.safeErrorCode(error, 'AI_OUTPUT_VALIDATION_FAILED'),
        outputSecurityBlocked ? this.securityCategories(error, 'provider_output') : [],
        context,
        {
          rawOutput:
            !outputSecurityBlocked &&
            Buffer.byteLength(providerResponse.outputText, 'utf8') <= weeklyAiMaximumRawOutputBytes
              ? providerResponse.outputText
              : null,
          protocol: providerResponse.protocol,
          model: providerResponse.model,
          providerRequestId: providerResponse.providerRequestId,
          stopReason: providerResponse.stopReason,
          usage: providerResponse.usage,
        },
      );
    }

    try {
      return await this.persistSuggestion(
        report.currentVersion,
        attempt,
        validated,
        providerResponse,
        context,
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === 'AI_BASE_VERSION_CHANGED') {
        return this.recordNonSuccess(attempt, 'failed', error.code, [], context, {
          rawOutput: providerResponse.outputText,
          parsedOutput: validated,
          protocol: providerResponse.protocol,
          model: providerResponse.model,
          providerRequestId: providerResponse.providerRequestId,
          stopReason: providerResponse.stopReason,
          usage: providerResponse.usage,
        });
      }
      throw error;
    }
  }

  public async list(reportId: string) {
    await this.assertOwnedReport(reportId);
    const where = { reportId, ownerProfileId: this.sessions.currentProfileId };
    const [rows, total, report] = await Promise.all([
      this.prisma.aiGeneration.findMany({
        where,
        include: { generatedVersions: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      // 历史列表只返回最近 100 次，但总数必须反映完整留痕，不能用当前页长度冒充。
      this.prisma.aiGeneration.count({ where }),
      this.prisma.weeklyReport.findUniqueOrThrow({ where: { id: reportId } }),
    ]);
    return {
      items: rows.map((row) => this.serializeGeneration(row, false, report.currentVersionId)),
      total,
    };
  }

  public async get(reportId: string, generationId: string) {
    const row = await this.prisma.aiGeneration.findFirst({
      where: {
        id: generationId,
        reportId,
        ownerProfileId: this.sessions.currentProfileId,
        report: { archivedAt: null },
      },
      include: { generatedVersions: true },
    });
    if (!row) throw new DomainError(errorCodes.notFound, 'AI 生成记录不存在', { httpStatus: 404 });
    const report = await this.prisma.weeklyReport.findUniqueOrThrow({ where: { id: reportId } });
    return this.serializeGeneration(row, true, report.currentVersionId);
  }

  public async adopt(
    reportId: string,
    generationId: string,
    input: AdoptWeeklyAiSuggestionInput,
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const generation = await tx.aiGeneration.findFirst({
        where: { id: generationId, reportId, ownerProfileId: this.sessions.currentProfileId },
        include: { generatedVersions: true },
      });
      if (!generation) {
        throw new DomainError(errorCodes.notFound, 'AI 生成记录不存在', { httpStatus: 404 });
      }
      if (generation.adoptionStatus === 'adopted' && generation.adoptedVersionId) {
        const response = {
          replayed: true,
          generation: this.serializeGeneration(generation, true, generation.baseVersionId),
          adoptedVersion: this.versionSummary(
            await tx.weeklyReportVersion.findUniqueOrThrow({
              where: { id: generation.adoptedVersionId },
            }),
          ),
        };
        await this.completeIdempotency(tx, context.idempotencyRecordId, response);
        return response;
      }
      if (generation.adoptionStatus !== 'pending') {
        throw new DomainError('AI_SUGGESTION_DECISION_FINAL', 'AI 建议已经拒绝，不能再次采纳', {
          httpStatus: 409,
        });
      }
      const report = await tx.weeklyReport.findFirst({
        where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
        include: { currentVersion: true, currentConfirmation: true },
      });
      if (!report?.currentVersion) {
        throw new DomainError(errorCodes.notFound, '周报或当前版本不存在', { httpStatus: 404 });
      }
      this.assertBase(
        report.currentVersionId,
        report.version,
        input.baseVersionId,
        input.reportVersion,
      );
      if (generation.baseVersionId !== report.currentVersion.id) {
        throw new DomainError('AI_SUGGESTION_STALE', '当前正文已变化，请重新生成 AI 建议', {
          httpStatus: 409,
          suggestedAction: 'refresh',
        });
      }
      const suggestion = await tx.weeklyReportVersion.findFirst({
        where: {
          id: input.suggestionVersionId,
          reportId,
          origin: 'ai',
          aiGenerationId: generation.id,
        },
        include: { sourceLinks: true },
      });
      if (!suggestion) {
        throw new DomainError('AI_SUGGESTION_VERSION_INVALID', 'AI 建议版本不属于本次生成', {
          httpStatus: 422,
        });
      }
      const latest = await tx.weeklyReportVersion.aggregate({
        where: { reportId },
        _max: { versionNo: true },
      });
      // 采纳也不修改 AI 原建议，而是新建可追溯的人工派生版本并复制逐段来源。
      const adopted = await tx.weeklyReportVersion.create({
        data: {
          id: newId(),
          reportId,
          versionNo: (latest._max.versionNo ?? 0) + 1,
          origin: 'manual',
          parentVersionId: report.currentVersion.id,
          reportDateText: suggestion.reportDateText,
          recentGoalsText: suggestion.recentGoalsText,
          weeklyWorkText: suggestion.weeklyWorkText,
          nextWeekPlansText: suggestion.nextWeekPlansText,
          problemsText: suggestion.problemsText,
          otherText: suggestion.otherText,
          fieldsJson: suggestion.fieldsJson,
          warningsJson: suggestion.warningsJson,
          attachmentsJson: suggestion.attachmentsJson,
          recipientScopeJson: suggestion.recipientScopeJson,
          templateMappingVersionId: suggestion.templateMappingVersionId,
          scheduleAt: suggestion.scheduleAt,
          sourceSnapshotId: suggestion.sourceSnapshotId,
          aiGenerationId: generation.id,
          contentHash: suggestion.contentHash,
          changeSummaryJson: JSON.stringify({
            kind: 'ai_suggestion_adopted',
            generationId: generation.id,
            suggestionVersionId: suggestion.id,
            reason: input.decisionReason,
          }),
          createdBy: this.sessions.currentProfileId,
        },
      });
      await this.copyLinks(tx, suggestion.sourceLinks, adopted.id);
      if (report.currentConfirmation?.status === 'active') {
        await tx.weeklyReportConfirmation.update({
          where: { id: report.currentConfirmation.id },
          data: {
            status: 'invalidated',
            invalidatedAt: new Date(),
            invalidationReason: '已显式采纳 AI 建议并生成人工派生版本',
          },
        });
      }
      const changed = await tx.weeklyReport.updateMany({
        where: {
          id: reportId,
          version: report.version,
          currentVersionId: report.currentVersion.id,
        },
        data: {
          reportDate: adopted.reportDateText,
          currentVersionId: adopted.id,
          confirmedVersionId: null,
          currentConfirmationId: null,
          status: 'editing',
          logDeliveryState: 'not_started',
          robotDeliveryState: 'not_started',
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.throwBaseChanged();
      const decided = await tx.aiGeneration.update({
        where: { id: generation.id },
        data: {
          adoptionStatus: 'adopted',
          adoptedVersionId: adopted.id,
          decisionReason: input.decisionReason,
          decidedAt: new Date(),
        },
        include: { generatedVersions: true },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.ai_suggestion_adopted',
        targetType: 'ai_generation',
        targetId: generation.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: { reportVersion: report.version, currentVersionId: report.currentVersion.id },
        after: { reportVersion: report.version + 1, adoptedVersionId: adopted.id },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      const response = {
        replayed: false,
        generation: this.serializeGeneration(decided, true, adopted.id),
        adoptedVersion: this.versionSummary(adopted),
        report: {
          id: reportId,
          currentVersionId: adopted.id,
          version: report.version + 1,
          status: 'editing',
        },
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response);
      return response;
    }, weeklyAiTransactionOptions);
  }

  public async reject(
    reportId: string,
    generationId: string,
    input: RejectWeeklyAiSuggestionInput,
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const generation = await tx.aiGeneration.findFirst({
        where: { id: generationId, reportId, ownerProfileId: this.sessions.currentProfileId },
        include: { generatedVersions: true },
      });
      if (!generation) {
        throw new DomainError(errorCodes.notFound, 'AI 生成记录不存在', { httpStatus: 404 });
      }
      if (generation.adoptionStatus === 'rejected') {
        const response = {
          replayed: true,
          generation: this.serializeGeneration(generation, true, generation.baseVersionId),
        };
        await this.completeIdempotency(tx, context.idempotencyRecordId, response);
        return response;
      }
      if (generation.adoptionStatus !== 'pending') {
        throw new DomainError('AI_SUGGESTION_DECISION_FINAL', 'AI 建议已经采纳，不能再次拒绝', {
          httpStatus: 409,
        });
      }
      const decided = await tx.aiGeneration.update({
        where: { id: generation.id },
        data: {
          adoptionStatus: 'rejected',
          decisionReason: input.decisionReason,
          decidedAt: new Date(),
        },
        include: { generatedVersions: true },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.ai_suggestion_rejected',
        targetType: 'ai_generation',
        targetId: generation.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: { decisionReason: input.decisionReason },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      const response = {
        replayed: false,
        generation: this.serializeGeneration(decided, true, decided.baseVersionId),
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response);
      return response;
    }, weeklyAiTransactionOptions);
  }

  private async persistSuggestion(
    base: BaseVersion,
    attempt: GenerationAttemptFacts,
    validated: WeeklyAiValidatedOutput,
    providerResponse: {
      protocol: AiProviderConfig['protocol'];
      model: string;
      outputText: string;
      stopReason: string;
      providerRequestId: string | null;
      usage: AiUsage;
    },
    context: MutationContext,
  ) {
    let persistenceStage = 'transaction_start';
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 这里只预留聚合版本并创建独立建议；当前正文指针必须保持在人工核对前的基线。
        persistenceStage = 'reserve_report_version';
        const reserved = await tx.weeklyReport.updateMany({
          where: {
            id: attempt.reportId,
            ownerProfileId: this.sessions.currentProfileId,
            archivedAt: null,
            currentVersionId: attempt.baseVersionId,
            version: attempt.baseReportVersion,
          },
          data: { version: { increment: 1 } },
        });
        if (reserved.count !== 1) this.throwBaseChanged();

        persistenceStage = 'create_generation_record';
        const generation = await tx.aiGeneration.create({
          data: {
            ...this.generationBaseData(attempt),
            rawOutput: providerResponse.outputText,
            parsedOutputJson: JSON.stringify(validated),
            protocol: providerResponse.protocol,
            model: providerResponse.model,
            providerRequestId: providerResponse.providerRequestId,
            stopReason: providerResponse.stopReason,
            usageJson: JSON.stringify(providerResponse.usage),
            durationMs: Date.now() - attempt.startedAt,
            status: 'succeeded',
            errorCode: null,
            securityBlocksJson: '[]',
            adoptionStatus: 'pending',
            completedAt: new Date(),
          },
        });
        persistenceStage = 'read_latest_version';
        const latest = await tx.weeklyReportVersion.aggregate({
          where: { reportId: attempt.reportId },
          _max: { versionNo: true },
        });
        const structured = this.structuredSuggestion(base.fieldsJson, validated, attempt.policy!);
        const warnings = [
          ...this.parseArray(base.warningsJson),
          {
            code: 'AI_GENERATED_CONTENT',
            message: '本版本包含 AI 建议，确认前必须逐段核对引用和事实并显式知悉。',
            sourceRefs: [],
            blocking: false,
            aiGenerationId: generation.id,
          },
        ];
        const fields = validated.fieldTexts;
        const contentHash = requestHash({
          fields: { reportDate: base.reportDateText, ...fields },
          structured: structured.fields,
          warnings,
          attachments: this.parseArray(base.attachmentsJson),
          recipientScope: this.parseObject(base.recipientScopeJson),
          templateMappingVersionId: base.templateMappingVersionId,
          scheduleAt: base.scheduleAt?.toISOString() ?? null,
          sourceSnapshotId: base.sourceSnapshotId,
        });
        persistenceStage = 'create_suggestion_version';
        const suggestion = await tx.weeklyReportVersion.create({
          data: {
            id: newId(),
            reportId: attempt.reportId,
            versionNo: (latest._max.versionNo ?? 0) + 1,
            origin: 'ai',
            parentVersionId: base.id,
            reportDateText: base.reportDateText,
            recentGoalsText: fields.recentGoals,
            weeklyWorkText: fields.weeklyWork,
            nextWeekPlansText: fields.nextWeekPlans,
            problemsText: fields.problems,
            otherText: fields.other,
            fieldsJson: JSON.stringify(structured.fields),
            warningsJson: JSON.stringify(warnings),
            attachmentsJson: base.attachmentsJson,
            recipientScopeJson: base.recipientScopeJson,
            templateMappingVersionId: base.templateMappingVersionId,
            scheduleAt: base.scheduleAt,
            sourceSnapshotId: base.sourceSnapshotId,
            aiGenerationId: generation.id,
            contentHash,
            changeSummaryJson: JSON.stringify({
              kind: 'ai_suggestion',
              generationId: generation.id,
              baseVersionId: base.id,
              requestedFields: attempt.requestedFields,
              promptTemplateVersion: weeklyAiPromptTemplateVersion,
              sanitizationPolicyVersion: weeklyAiSanitizationPolicyVersion,
            }),
            createdBy: this.sessions.currentProfileId,
          },
        });
        persistenceStage = 'create_suggestion_links';
        await this.createSuggestionLinks(
          tx,
          base,
          suggestion.id,
          validated.fields
            .filter((field) => field.paragraphs.length > 0)
            .map((field) => field.field),
          structured.blocks,
          attempt.policy!,
        );
        persistenceStage = 'write_audit_event';
        await this.audit.recordInTransaction(tx, {
          actorId: this.sessions.currentProfileId,
          action: 'weekly_report.ai_suggestion_created',
          targetType: 'ai_generation',
          targetId: generation.id,
          correlationId: context.correlationId,
          outcome: 'succeeded',
          before: {
            reportVersion: attempt.baseReportVersion,
            baseVersionId: attempt.baseVersionId,
          },
          after: {
            reportVersion: attempt.baseReportVersion + 1,
            suggestionVersionId: suggestion.id,
            suggestionVersionNo: suggestion.versionNo,
            sanitizedInputHash: attempt.policy!.sanitizedInputHash,
          },
          clientSessionHash: this.security.sessionHash(context.sessionId),
        });
        persistenceStage = 'read_persisted_generation';
        const fullGeneration = await tx.aiGeneration.findUniqueOrThrow({
          where: { id: generation.id },
          include: { generatedVersions: true },
        });
        const response = {
          replayed: false,
          fallback: false,
          generation: this.serializeGeneration(fullGeneration, true, attempt.baseVersionId),
          suggestionVersion: this.versionSummary(suggestion),
          report: {
            id: attempt.reportId,
            currentVersionId: attempt.baseVersionId,
            version: attempt.baseReportVersion + 1,
          },
        };
        persistenceStage = 'complete_idempotency';
        await this.completeIdempotency(tx, context.idempotencyRecordId, response);
        return response;
      }, weeklyAiTransactionOptions);
    } catch (error) {
      throw new DomainError(
        'AI_SUGGESTION_PERSIST_FAILED',
        `AI 建议已生成，但保存建议版本失败（${persistenceStage}）`,
        {
          httpStatus: 500,
          details: {
            stage: persistenceStage,
            errorClass: error instanceof Error ? error.name : typeof error,
          },
          retryable: true,
          suggestedAction: 'manual_review',
        },
      );
    }
  }

  private async recordNonSuccess(
    attempt: GenerationAttemptFacts,
    status: 'failed' | 'blocked',
    errorCode: string,
    securityBlocks: string[],
    context: MutationContext,
    providerFacts: {
      rawOutput?: string | null;
      parsedOutput?: WeeklyAiValidatedOutput;
      protocol?: AiProviderConfig['protocol'];
      model?: string;
      providerRequestId?: string | null;
      stopReason?: string | null;
      usage?: AiUsage;
    } = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 失败和安全阻断都冻结为结束态事实，但明确回退当前版本，不制造半成品建议。
      const generation = await tx.aiGeneration.create({
        data: {
          ...this.generationBaseData(attempt),
          rawOutput: providerFacts.rawOutput ?? null,
          parsedOutputJson: providerFacts.parsedOutput
            ? JSON.stringify(providerFacts.parsedOutput)
            : null,
          protocol: providerFacts.protocol ?? attempt.config.protocol,
          model: providerFacts.model ?? attempt.config.model,
          providerRequestId: providerFacts.providerRequestId ?? null,
          stopReason: providerFacts.stopReason ?? null,
          usageJson: JSON.stringify(providerFacts.usage ?? this.emptyUsage()),
          durationMs: Date.now() - attempt.startedAt,
          status,
          errorCode,
          securityBlocksJson: JSON.stringify(status === 'blocked' ? securityBlocks : []),
          adoptionStatus: 'not_applicable',
          completedAt: new Date(),
        },
        include: { generatedVersions: true },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action:
          status === 'blocked'
            ? 'weekly_report.ai_generation_blocked'
            : 'weekly_report.ai_generation_failed',
        targetType: 'ai_generation',
        targetId: generation.id,
        correlationId: context.correlationId,
        outcome: status === 'blocked' ? 'rejected' : 'failed',
        after: {
          errorCode,
          securityBlocks,
          sanitizedInputHash: attempt.policy?.sanitizedInputHash ?? null,
          fallbackVersionId: attempt.baseVersionId,
        },
        errorCode,
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      const response = {
        replayed: false,
        fallback: true,
        fallbackReasonCode: errorCode,
        fallbackVersion: {
          id: attempt.baseVersionId,
          reportId: attempt.reportId,
        },
        generation: this.serializeGeneration(generation, true, attempt.baseVersionId),
      };
      await this.completeIdempotency(tx, context.idempotencyRecordId, response);
      return response;
    }, weeklyAiTransactionOptions);
  }

  private generationBaseData(attempt: GenerationAttemptFacts) {
    return {
      id: attempt.generationId,
      ownerProfileId: this.sessions.currentProfileId,
      providerConnectionId: attempt.connection.id,
      providerConfigVersion: attempt.connection.version,
      reportId: attempt.reportId,
      baseVersionId: attempt.baseVersionId,
      baseReportVersion: attempt.baseReportVersion,
      purpose: 'weekly_report',
      promptTemplateVersion: weeklyAiPromptTemplateVersion,
      sanitizationPolicyVersion: weeklyAiSanitizationPolicyVersion,
      retentionMode: 'hash_only',
      requestedFieldsJson: JSON.stringify(attempt.requestedFields),
      inputRefsJson: JSON.stringify(attempt.policy?.storedReferences ?? []),
      inputCategoriesJson: JSON.stringify(attempt.policy?.inputCategories ?? []),
      removedCategoriesJson: JSON.stringify(attempt.policy?.removedCategories ?? []),
      sanitizedInputHash: attempt.policy?.sanitizedInputHash ?? null,
      sanitizedInputJson: null,
      createdBy: this.sessions.currentProfileId,
    };
  }

  private structuredSuggestion(
    baseFieldsJson: string,
    validated: WeeklyAiValidatedOutput,
    policy: WeeklyAiSanitizationResult,
  ): {
    fields: Record<string, unknown>;
    blocks: Map<string, { field: WeeklyReportField; citations: string[] }>;
  } {
    const fields = this.parseObject(baseFieldsJson);
    const blocks = new Map<string, { field: WeeklyReportField; citations: string[] }>();
    const references = new Map(
      policy.storedReferences.map((reference) => [reference.refId, reference]),
    );
    for (const field of validated.fields) {
      // AI 没有产出有效段落时，正文文本、结构化模板块和原有引用必须一起保留。
      if (field.paragraphs.length === 0) continue;
      fields[field.field] = field.paragraphs.map((paragraph) => {
        const id = newId();
        blocks.set(id, { field: field.field, citations: paragraph.citations });
        return {
          id,
          field: field.field,
          projectName: paragraph.projectName,
          title: paragraph.parentTitle ?? paragraph.projectName ?? 'AI 建议',
          body: paragraph.text,
          sourceRefs: paragraph.citations.map((citation) => {
            const reference = references.get(citation)!;
            return {
              type:
                reference.sourceType === 'task'
                  ? 'task'
                  : reference.sourceType === 'evidence'
                    ? 'evidence'
                    : 'manual',
              id: reference.sourceId,
              aiRefId: reference.refId,
            };
          }),
          actualHours: null,
          estimatedHours: null,
          pinned: false,
          sortKey: `ai:${field.field}:${id}`,
        };
      });
    }
    return { fields, blocks };
  }

  private async createSuggestionLinks(
    tx: Prisma.TransactionClient,
    base: BaseVersion,
    suggestionVersionId: string,
    replacedFields: WeeklyReportField[],
    blocks: Map<string, { field: WeeklyReportField; citations: string[] }>,
    policy: WeeklyAiSanitizationResult,
  ): Promise<void> {
    const data: Prisma.ReportSourceLinkCreateManyInput[] = base.sourceLinks
      .filter((link) => !replacedFields.includes(link.fieldName as WeeklyReportField))
      .map((link) => ({
        id: newId(),
        snapshotId: link.snapshotId,
        versionId: suggestionVersionId,
        fieldName: link.fieldName,
        blockId: link.blockId,
        sourceType: link.sourceType,
        sourceId: link.sourceId,
        taskId: link.taskId,
        evidenceId: link.evidenceId,
        sourceContentHash: link.sourceContentHash,
        sourceSummaryJson: link.sourceSummaryJson,
      }));
    const references = new Map(
      policy.storedReferences.map((reference) => [reference.refId, reference]),
    );
    for (const [blockId, block] of blocks) {
      for (const citation of block.citations) {
        const reference = references.get(citation)!;
        // report_source_link 的历史数据库约束只允许 task/evidence/manual。
        // 周报原正文属于本地人工事实，在持久化引用图中按 manual 保存；
        // aiRefId 与原始 sourceType 仍保留在摘要中供诊断和审计。
        const persistedSourceType =
          reference.sourceType === 'base_field' ? 'manual' : reference.sourceType;
        data.push({
          id: newId(),
          snapshotId: base.sourceSnapshotId,
          versionId: suggestionVersionId,
          fieldName: block.field,
          blockId,
          sourceType: persistedSourceType,
          sourceId: reference.sourceId,
          taskId: persistedSourceType === 'task' ? reference.sourceId : null,
          evidenceId: persistedSourceType === 'evidence' ? reference.sourceId : null,
          sourceContentHash: reference.contentHash,
          sourceSummaryJson: JSON.stringify({
            aiRefId: reference.refId,
            sourceType: reference.sourceType,
            contentHash: reference.contentHash,
          }),
        });
      }
    }
    if (data.length > 0) await tx.reportSourceLink.createMany({ data });
  }

  private async copyLinks(
    tx: Prisma.TransactionClient,
    links: Array<{
      snapshotId: string;
      fieldName: string;
      blockId: string;
      sourceType: string;
      sourceId: string;
      taskId: string | null;
      evidenceId: string | null;
      sourceContentHash: string;
      sourceSummaryJson: string;
    }>,
    versionId: string,
  ): Promise<void> {
    if (links.length === 0) return;
    await tx.reportSourceLink.createMany({
      data: links.map((link) => ({
        id: newId(),
        snapshotId: link.snapshotId,
        versionId,
        fieldName: link.fieldName,
        blockId: link.blockId,
        sourceType: link.sourceType,
        sourceId: link.sourceId,
        taskId: link.taskId,
        evidenceId: link.evidenceId,
        sourceContentHash: link.sourceContentHash,
        sourceSummaryJson: link.sourceSummaryJson,
      })),
    });
  }

  private async resolveConnection(connectionId: string) {
    const row = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, type: 'ai', enabled: true },
    });
    if (!row) {
      throw new DomainError('AI_CONNECTION_NOT_FOUND', 'AI 连接不存在或已停用', {
        httpStatus: 404,
      });
    }
    if (row.status !== 'healthy') {
      throw new DomainError('AI_CONNECTION_NOT_HEALTHY', 'AI 连接尚未通过真实连接测试', {
        httpStatus: 422,
      });
    }
    if (!row.baseUrl || !row.credentialRef) {
      throw new DomainError('AI_CONNECTION_INCOMPLETE', 'AI 连接缺少地址或凭证', {
        httpStatus: 422,
      });
    }
    const configInput: unknown = JSON.parse(row.configJson);
    const parsedConfig = aiProviderConfigSchema.parse(configInput);
    const config = {
      ...parsedConfig,
      timeoutMs: Math.max(parsedConfig.timeoutMs, weeklyAiMinimumTimeoutMs),
    };
    if (!config.allowedPurposes.includes('weekly_report')) {
      throw new DomainError('AI_PURPOSE_NOT_ALLOWED', 'AI 连接未允许周报用途', {
        httpStatus: 403,
      });
    }
    return {
      id: row.id,
      version: row.version,
      baseUrl: row.baseUrl,
      credentialRef: row.credentialRef,
      config,
    };
  }

  private serializeGeneration(
    row: AiGenerationWithVersions,
    detailed: boolean,
    currentVersionId: string | null,
  ) {
    return {
      id: row.id,
      reportId: row.reportId,
      baseVersionId: row.baseVersionId,
      baseReportVersion: row.baseReportVersion,
      providerConnectionId: row.providerConnectionId,
      providerConfigVersion: row.providerConfigVersion,
      purpose: row.purpose,
      promptTemplateVersion: row.promptTemplateVersion,
      sanitizationPolicyVersion: row.sanitizationPolicyVersion,
      retentionMode: row.retentionMode,
      requestedFields: this.parseArray(row.requestedFieldsJson),
      inputCategories: this.parseArray(row.inputCategoriesJson),
      removedCategories: this.parseArray(row.removedCategoriesJson),
      sanitizedInputHash: row.sanitizedInputHash,
      protocol: row.protocol,
      model: row.model,
      providerRequestId: row.providerRequestId,
      stopReason: row.stopReason,
      usage: this.parseObject(row.usageJson),
      durationMs: row.durationMs,
      status: row.status,
      errorCode: row.errorCode,
      securityBlocks: this.parseArray(row.securityBlocksJson),
      adoptionStatus: row.adoptionStatus,
      adoptedVersionId: row.adoptedVersionId,
      decisionReason: row.decisionReason,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      stale: row.adoptionStatus === 'pending' && row.baseVersionId !== currentVersionId,
      suggestionVersions: row.generatedVersions
        .filter((version) => version.origin === 'ai')
        .map((version) => this.versionSummary(version)),
      ...(detailed
        ? {
            inputRefs: this.parseArray(row.inputRefsJson),
            rawOutput: row.rawOutput,
            parsedOutput: row.parsedOutputJson ? this.parseJson(row.parsedOutputJson) : null,
          }
        : {}),
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private versionSummary(version: {
    id: string;
    reportId: string;
    versionNo: number;
    origin: string;
    contentHash: string;
    createdAt: Date;
  }) {
    return {
      id: version.id,
      reportId: version.reportId,
      versionNo: version.versionNo,
      origin: version.origin,
      contentHash: version.contentHash,
      createdAt: version.createdAt.toISOString(),
    };
  }

  private baseFields(version: BaseVersion): Record<WeeklyReportField, string> {
    return {
      recentGoals: version.recentGoalsText,
      weeklyWork: version.weeklyWorkText,
      nextWeekPlans: version.nextWeekPlansText,
      problems: version.problemsText,
      other: version.otherText,
    };
  }

  private isTaskInPeriod(task: WeeklyTaskFact, periodStart: string, periodEnd: string): boolean {
    const plannedStart = task.plannedStartDate ?? null;
    const dueDate = task.dueDate ?? null;
    const statusChangedDate = task.statusChangedAt?.slice(0, 10) ?? null;
    const dateInPeriod = (value: string | null) =>
      Boolean(value && value >= periodStart && value <= periodEnd);
    return (
      weeklyTaskHasWorklog(task) ||
      dateInPeriod(plannedStart) ||
      dateInPeriod(dueDate) ||
      dateInPeriod(statusChangedDate) ||
      Boolean(plannedStart && dueDate && plannedStart <= periodEnd && dueDate >= periodStart)
    );
  }

  private parseFacts<T>(value: string): T[] {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new DomainError('AI_SOURCE_SNAPSHOT_INVALID', '周报冻结来源结构无效', {
        httpStatus: 422,
      });
    }
    return parsed as T[];
  }

  private normalizeFields(fields: WeeklyReportField[]): WeeklyReportField[] {
    const order: WeeklyReportField[] = [
      'recentGoals',
      'weeklyWork',
      'nextWeekPlans',
      'problems',
      'other',
    ];
    return order.filter((field) => fields.includes(field));
  }

  private assertBase(
    currentVersionId: string | null,
    reportVersion: number,
    expectedVersionId: string,
    expectedReportVersion: number,
  ): void {
    if (currentVersionId !== expectedVersionId || reportVersion !== expectedReportVersion) {
      this.throwBaseChanged();
    }
  }

  private throwBaseChanged(): never {
    throw new DomainError('AI_BASE_VERSION_CHANGED', '周报正文或聚合版本已变化，请刷新后重试', {
      httpStatus: 409,
      suggestedAction: 'refresh',
    });
  }

  private safeErrorCode(error: unknown, fallback: string): string {
    return error instanceof DomainError ? error.code : fallback;
  }

  private securityCategories(error: unknown, fallback: string): string[] {
    if (!(error instanceof DomainError)) return [fallback];
    const details = error.options.details;
    if (!this.isObject(details) || !Array.isArray(details.categories)) return [fallback];
    const categories = details.categories.filter(
      (category): category is string => typeof category === 'string' && category.length <= 100,
    );
    return categories.length > 0 ? [...new Set(categories)].sort() : [fallback];
  }

  private emptyUsage(): AiUsage {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
  }

  private async assertOwnedReport(reportId: string): Promise<void> {
    const report = await this.prisma.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      select: { id: true },
    });
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
  }

  private async completeIdempotency(
    tx: Prisma.TransactionClient,
    recordId: string,
    response: unknown,
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        state: 'completed',
        httpStatus: 200,
        responseJson: JSON.stringify(response),
        errorCode: null,
      },
    });
  }

  private parseArray(value: string): unknown[] {
    const parsed = this.parseJson(value);
    return Array.isArray(parsed) ? parsed : [];
  }

  private parseObject(value: string): Record<string, unknown> {
    const parsed = this.parseJson(value);
    return this.isObject(parsed) ? parsed : {};
  }

  private parseJson(value: string): unknown {
    return JSON.parse(value) as unknown;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
