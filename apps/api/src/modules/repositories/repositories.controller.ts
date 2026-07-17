import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { apiResponse, DomainError } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { resolve } from 'node:path';
import { z } from 'zod';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { SessionService } from '../session/session.service.js';
import { RepositoryInspectorService } from './repository-inspector.service.js';
import { RepositoryService } from './repository.service.js';

const discoverSchema = z.object({
  root: z.string().min(3).max(500).optional(),
  includeMissingCheck: z.boolean().default(true),
});
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  alias: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  jiraProjectKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,99}$/u)
    .optional(),
});
const updateProjectSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    alias: z.string().trim().max(120).nullable().optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    jiraProjectKey: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,99}$/u)
      .nullable()
      .optional(),
  })
  .strict();
const confirmSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  alias: z.string().trim().max(120).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  remoteName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._/-]{0,100}$/iu)
    .nullable()
    .optional(),
  gitlabProjectRef: z.string().trim().min(1).max(100).nullable().optional(),
  baselineBranch: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !/[\0\r\n]/u.test(value)),
  discoverySnapshotVersion: z.number().int().positive(),
});
const updateSchema = z.object({
  version: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(120).optional(),
  alias: z.string().trim().max(120).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  baselineBranch: z.string().trim().min(1).max(255).optional(),
});
const versionSchema = z.object({ version: z.number().int().positive() });

@Controller()
export class RepositoriesController {
  public constructor(
    private readonly repositories: RepositoryService,
    private readonly inspector: RepositoryInspectorService,
    private readonly queue: JobQueueService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
  ) {}

  @Post('projects/discover')
  public async discover(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = discoverSchema.parse(body);
    // 在排队前验证调用方不能借 root 参数扩大扫描范围；实际可用性由后台作业复核。
    if (
      input.root &&
      resolve(input.root).toLowerCase() !== resolve(this.inspector.repositoryRoot).toLowerCase()
    ) {
      throw new DomainError('REPOSITORY_ROOT_NOT_ALLOWED', '只能扫描配置允许的仓库根目录', {
        httpStatus: 403,
      });
    }
    const minute = new Date().toISOString().slice(0, 16);
    const job = await this.queue.enqueue({
      type: 'repository.discover',
      payloadSummary: { includeMissingCheck: input.includeMissingCheck },
      priority: 30,
      maxAttempts: 2,
      dedupeKey: `repository.discover:${minute}`,
    });
    await this.recordAudit(request, 'repository.discovery_requested', 'job', job.id);
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
    );
  }

  @Post('projects')
  public async createProject(@Body() body: unknown, @Req() request: FastifyRequest) {
    const project = await this.repositories.createProject(createProjectSchema.parse(body));
    await this.recordAudit(request, 'project.created', 'project', project.id);
    return apiResponse(project, request.autoWork.correlationId);
  }

  @Get('projects')
  public async projects(
    @Query('archived') archived: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const data = await this.repositories.listProjects(archived === 'true');
    return apiResponse(data, request.autoWork.correlationId, { asOf: new Date().toISOString() });
  }

  @Put('projects/:id')
  public async updateProject(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const project = await this.repositories.updateProject(id, updateProjectSchema.parse(body));
    await this.recordAudit(request, 'project.updated', 'project', project.id);
    return apiResponse(project, request.autoWork.correlationId);
  }

  @Get('repositories')
  public async list(@Req() request: FastifyRequest) {
    return apiResponse(await this.repositories.list(), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Post('repositories/sync')
  public async syncAll(@Req() request: FastifyRequest) {
    const minute = new Date().toISOString().slice(0, 16);
    const job = await this.queue.enqueue({
      type: 'repository.sync',
      payloadSummary: { scope: 'all' },
      priority: 40,
      maxAttempts: 2,
      dedupeKey: `repository.sync:all:${minute}`,
    });
    await this.recordAudit(request, 'repository.sync_requested', 'job', job.id);
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
    );
  }

  @Get('repositories/:id')
  public async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.repositories.get(id), request.autoWork.correlationId);
  }

  @Post('repositories/:id/sync')
  public async sync(@Param('id') id: string, @Req() request: FastifyRequest) {
    await this.repositories.get(id);
    const job = await this.queue.enqueue({
      type: 'repository.sync',
      payloadRef: id,
      payloadSummary: { repositoryId: id },
      priority: 20,
      maxAttempts: 2,
      dedupeKey: `repository.sync:${id}`,
    });
    await this.recordAudit(request, 'repository.sync_requested', 'repository', id);
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
    );
  }

  @Post('repositories/:id/confirm')
  public async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.repositories.confirm(id, confirmSchema.parse(body));
    await this.recordAudit(request, 'repository.confirmed', 'repository', id);
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Put('repositories/:id')
  public async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.repositories.update(id, updateSchema.parse(body));
    await this.recordAudit(request, 'repository.updated', 'repository', id);
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Post('repositories/:id/disable')
  public async disable(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.repositories.disable(id, versionSchema.parse(body).version);
    await this.recordAudit(request, 'repository.disabled', 'repository', id);
    return apiResponse(result, request.autoWork.correlationId);
  }

  private async recordAudit(
    request: FastifyRequest,
    action: string,
    targetType: string,
    targetId: string,
  ) {
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action,
      targetType,
      targetId,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
  }
}
