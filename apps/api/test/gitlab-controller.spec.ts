import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import type { AuditService } from '../src/modules/audit/audit.service.js';
import { GitLabController } from '../src/modules/gitlab/gitlab.controller.js';
import type { GitLabReadService } from '../src/modules/gitlab/gitlab-read.service.js';
import type { JobQueueService } from '../src/modules/jobs/job-queue.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('GitLab 控制器边界', () => {
  it('没有本机凭证时在入队前拒绝同步', async () => {
    const enqueue = vi.fn();
    const prisma = {
      integrationConnection: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'connection-1',
          type: 'gitlab',
          enabled: true,
          credentialRef: null,
        }),
      },
    } as unknown as PrismaService;
    const controller = new GitLabController(
      prisma,
      { enqueue } as unknown as JobQueueService,
      {} as AuditService,
      {} as SessionService,
      {} as LocalSecurityService,
      {} as GitLabReadService,
    );

    await expect(
      controller.sync('connection-1', {
        autoWork: { correlationId: 'correlation', sessionId: 'session', csrfToken: 'csrf' },
      } as FastifyRequest),
    ).rejects.toMatchObject({ code: 'GITLAB_CREDENTIAL_REQUIRED' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
