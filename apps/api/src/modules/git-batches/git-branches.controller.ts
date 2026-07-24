import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { createBranchesSchema, deleteBranchSchema } from './git-branches.schemas.js';
import { GitBranchesService } from './git-branches.service.js';

@Controller('git/branches')
export class GitBranchesController {
  public constructor(
    private readonly branches: GitBranchesService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
  ) {}

  @Get(':repositoryId')
  public async list(@Param('repositoryId') repositoryId: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.branches.list(repositoryId), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Post('batch')
  public async create(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = createBranchesSchema.parse(body);
    const result = await this.branches.create(input);
    await Promise.all(
      result.repositories.map((repository) =>
        this.audit.record({
          actorId: this.sessions.currentProfileId,
          action: 'git.branches.batch_created',
          targetType: 'repository',
          targetId: repository.repositoryId,
          correlationId: request.autoWork.correlationId,
          outcome: repository.status === 'failed' ? 'failed' : 'succeeded',
          clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
        }),
      ),
    );
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Post('delete')
  public async delete(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = deleteBranchSchema.parse(body);
    const result = await this.branches.delete(input);
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'git.branch.deleted',
      targetType: 'repository',
      targetId: input.repositoryId,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(result, request.autoWork.correlationId);
  }
}
