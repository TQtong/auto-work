import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { aiProviderConfigSchema } from '../ai/ai-provider.config.js';
import { SessionService } from '../session/session.service.js';
import { WeeklyReportAiService } from './weekly-report-ai.service.js';
import { WeeklyReportService } from './weekly-report.service.js';

const AI_FIELDS = ['recentGoals', 'weeklyWork', 'nextWeekPlans', 'problems', 'other'] as const;

@Injectable()
export class WeeklyReportAutomaticDraftService {
  private readonly logger = new Logger(WeeklyReportAutomaticDraftService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly reports: WeeklyReportService,
    private readonly ai: WeeklyReportAiService,
  ) {}

  /** 任务首次进入缓存后十分钟内生成；同一天无论定时重放多少次都只生成一个草稿。 */
  @Cron('0 */10 * * * *', { timeZone: 'Asia/Shanghai' })
  public async generateCurrentWeek(): Promise<void> {
    await this.generateForCurrentWeek().catch((error) => {
      this.logger.warn(
        `自动周报草稿生成失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  public async generateForCurrentWeek(now = new Date()): Promise<unknown> {
    const businessDate = this.shanghaiDate(now);
    const taskCount = await this.prisma.task.count({
      where: { isCurrentUser: true, visibilityState: 'visible' },
    });
    if (taskCount === 0) return { skipped: true, reason: 'no_tasks' };
    const sameDayVersion = await this.prisma.weeklyReportVersion.findFirst({
      where: {
        report: {
          ownerProfileId: this.sessions.currentProfileId,
          archivedAt: null,
          periodStart: { lte: businessDate },
          periodEnd: { gte: businessDate },
        },
        createdAt: { gte: this.shanghaiDayStart(now), lt: this.shanghaiNextDayStart(now) },
      },
      select: { id: true },
    });
    if (sameDayVersion) return { skipped: true, reason: 'already_generated_today' };

    const context = {
      correlationId: `automatic-weekly:${businessDate}`,
      sessionId: 'system:automatic-weekly-draft',
    };
    const generated = await this.reports.generate(
      {
        timezone: 'Asia/Shanghai',
        freshnessPolicy: {
          mode: 'allow_stale',
          taskMaxAgeMinutes: 10_080,
          evidenceMaxAgeMinutes: 10_080,
        },
        includeUnconfirmedEvidence: false,
        aiProviderConfigId: null,
        manualInputs: [],
        jiraQuery: {},
        templateMappingVersionId: null,
        existingReportPolicy: 'create_version',
      },
      context,
      now,
    );
    await this.enhanceWithAi(generated, context, businessDate);
    return generated;
  }

  private async enhanceWithAi(
    generated: Awaited<ReturnType<WeeklyReportService['generate']>>,
    context: { correlationId: string; sessionId: string },
    businessDate: string,
  ): Promise<void> {
    const provider = await this.prisma.integrationConnection.findFirst({
      where: {
        type: 'ai',
        enabled: true,
        status: 'healthy',
        credentialRef: { not: null },
      },
      orderBy: { lastSuccessAt: 'desc' },
    });
    if (!provider) return;
    const parsedConfig = aiProviderConfigSchema.safeParse(JSON.parse(provider.configJson));
    if (!parsedConfig.success || !parsedConfig.data.allowedPurposes.includes('weekly_report'))
      return;

    const report = generated.report;
    const baseVersion = generated.version;
    const existing = await this.prisma.aiGeneration.findFirst({
      where: {
        reportId: report.id,
        baseVersionId: baseVersion.id,
        purpose: 'weekly_report',
        status: 'succeeded',
      },
      select: { id: true },
    });
    if (existing) return;

    const createInput = {
      baseVersionId: baseVersion.id,
      reportVersion: report.version,
      providerConnectionId: provider.id,
      fields: [...AI_FIELDS],
      consent: {
        allowPeopleNames: false,
        allowInternalUrls: false,
        allowDescriptionSummaries: false,
      },
    };
    const createRecordId = await this.createIdempotency(
      `/automatic/weekly-reports/${report.id}/ai-suggestions`,
      `automatic-ai:${businessDate}:${baseVersion.id}`,
      createInput,
    );
    const suggestion = await this.ai.createSuggestion(report.id, createInput, {
      ...context,
      idempotencyRecordId: createRecordId,
    });
    if (
      suggestion.generation.status !== 'succeeded' ||
      !('suggestionVersion' in suggestion) ||
      !suggestion.suggestionVersion
    )
      return;

    const adoptInput = {
      suggestionVersionId: suggestion.suggestionVersion.id,
      baseVersionId: baseVersion.id,
      reportVersion: report.version,
      decisionReason: '后台按任务日期自动生成周报 AI 草稿',
    };
    const adoptRecordId = await this.createIdempotency(
      `/automatic/weekly-reports/${report.id}/ai-suggestions/${suggestion.generation.id}/adopt`,
      `automatic-adopt:${businessDate}:${suggestion.generation.id}`,
      adoptInput,
    );
    await this.ai.adopt(report.id, suggestion.generation.id, adoptInput, {
      ...context,
      idempotencyRecordId: adoptRecordId,
    });
  }

  private async createIdempotency(route: string, idempotencyKey: string, request: unknown) {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        actorId_route_idempotencyKey: {
          actorId: this.sessions.currentProfileId,
          route,
          idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.idempotencyRecord.create({
      data: {
        id: newId(),
        actorId: this.sessions.currentProfileId,
        route,
        idempotencyKey,
        requestHash: requestHash(request),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
      },
      select: { id: true },
    });
    return created.id;
  }

  private shanghaiDate(value: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value);
  }

  private shanghaiDayStart(value: Date): Date {
    return new Date(`${this.shanghaiDate(value)}T00:00:00.000+08:00`);
  }

  private shanghaiNextDayStart(value: Date): Date {
    return new Date(this.shanghaiDayStart(value).getTime() + 24 * 60 * 60_000);
  }
}
