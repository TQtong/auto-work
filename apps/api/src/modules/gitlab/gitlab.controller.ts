import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { apiResponse, cursorQuerySchema, DomainError, errorCodes } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { SessionService } from '../session/session.service.js';
import { deriveGitLabFreshness } from './gitlab-freshness.js';
import { GitLabReadService } from './gitlab-read.service.js';

const resourceSchema = z.enum([
  'branches',
  'commits',
  'merge-requests',
  'pipelines',
  'tags',
  'releases',
  'members',
]);

@Controller('integrations/:id/gitlab')
export class GitLabController {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
    private readonly readService: GitLabReadService,
  ) {}

  @Post('sync')
  public async sync(@Param('id') id: string, @Req() request: FastifyRequest) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection || connection.type !== 'gitlab')
      throw new DomainError(errorCodes.notFound, 'GitLab 连接不存在', { httpStatus: 404 });
    if (!connection.enabled)
      throw new DomainError('GITLAB_CONNECTION_DISABLED', 'GitLab 连接已禁用', {
        httpStatus: 409,
      });
    if (!connection.credentialRef) {
      throw new DomainError('GITLAB_CREDENTIAL_REQUIRED', '请先配置并验证 GitLab Token', {
        httpStatus: 422,
        suggestedAction: 'reconfigure',
      });
    }
    const job = await this.queue.enqueue({
      type: 'gitlab.sync',
      payloadRef: id,
      payloadSummary: { connectionId: id, mode: 'configured_projects' },
      priority: 45,
      maxAttempts: 3,
      dedupeKey: `gitlab.sync:${id}`,
    });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'gitlab.sync_requested',
      targetType: 'integration_connection',
      targetId: id,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
    );
  }

  @Get('projects')
  public async projects(@Param('id') id: string, @Req() request: FastifyRequest) {
    await this.assertConnection(id);
    const projects = await this.prisma.gitLabProject.findMany({
      where: { connectionId: id, stale: false },
      include: {
        _count: {
          select: {
            branches: { where: { stale: false } },
            commits: true,
            mergeRequests: true,
            pipelines: true,
            tags: { where: { stale: false } },
            releases: { where: { stale: false } },
            members: { where: { stale: false } },
          },
        },
        pipelines: { orderBy: { updatedExternalAt: 'desc' }, take: 1 },
        commits: { orderBy: { committedAt: 'desc' }, take: 1 },
        mergeRequests: { where: { state: 'opened' }, select: { id: true } },
      },
      orderBy: { pathWithNamespace: 'asc' },
    });
    return apiResponse(
      projects.map((project) => ({
        id: project.id,
        externalId: project.externalId,
        name: project.name,
        pathWithNamespace: project.pathWithNamespace,
        webUrl: project.webUrl,
        defaultBranch: project.defaultBranch,
        visibility: project.visibility,
        archived: project.archived,
        syncStatus: deriveGitLabFreshness(project.syncStatus, project.syncedAt),
        syncError: project.syncError,
        lastActivityAt: project.lastActivityAt?.toISOString() ?? null,
        syncedAt: project.syncedAt?.toISOString() ?? null,
        counts: project._count,
        openMergeRequestCount: project.mergeRequests.length,
        latestPipeline: project.pipelines[0]
          ? {
              status: project.pipelines[0].status,
              sha: project.pipelines[0].sha,
              ref: project.pipelines[0].ref,
              updatedAt: project.pipelines[0].updatedExternalAt?.toISOString() ?? null,
              webUrl: project.pipelines[0].webUrl,
            }
          : null,
        latestCommit: project.commits[0]
          ? {
              sha: project.commits[0].sha,
              title: project.commits[0].title,
              authorName: project.commits[0].authorName,
              committedAt: project.commits[0].committedAt.toISOString(),
              webUrl: project.commits[0].webUrl,
            }
          : null,
      })),
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }

  @Get('sync-runs')
  public async runs(@Param('id') id: string, @Req() request: FastifyRequest) {
    await this.assertConnection(id);
    const runs = await this.prisma.gitLabSyncRun.findMany({
      where: { connectionId: id },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    return apiResponse(
      runs.map((run) => ({
        id: run.id,
        status: run.status,
        scope: JSON.parse(run.scopeJson) as unknown,
        counts: JSON.parse(run.countsJson) as unknown,
        errorCode: run.errorCode,
        errorSummary: run.errorSummary,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
      })),
      request.autoWork.correlationId,
    );
  }

  @Get('projects/:projectId/resources/:resource')
  public async resources(
    @Param('id') connectionId: string,
    @Param('projectId') projectId: string,
    @Param('resource') resourceInput: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    const resource = resourceSchema.parse(resourceInput);
    const pagination = cursorQuerySchema.parse(query);
    const offset = this.decodeCursor(pagination.cursor);
    const result = await this.readService.list(
      connectionId,
      projectId,
      resource,
      offset,
      pagination.limit,
    );
    const hasMore = offset + result.items.length < result.total;
    return {
      ...apiResponse(result.items, request.autoWork.correlationId, {
        asOf: new Date().toISOString(),
      }),
      page: {
        ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
        ...(hasMore ? { nextCursor: this.encodeCursor(offset + result.items.length) } : {}),
        hasMore,
        limit: pagination.limit,
      },
      total: result.total,
    };
  }

  private async assertConnection(id: string): Promise<void> {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id, type: 'gitlab' },
      select: { id: true },
    });
    if (!connection) {
      throw new DomainError(errorCodes.notFound, 'GitLab 连接不存在', { httpStatus: 404 });
    }
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const match = /^offset:(\d+)$/u.exec(decoded);
      if (!match) throw new Error('invalid cursor');
      const offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid offset');
      return offset;
    } catch {
      throw new DomainError('PAGINATION_CURSOR_INVALID', '分页游标无效', { httpStatus: 422 });
    }
  }
}
