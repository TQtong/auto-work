import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../src/config/config.module.js';
import {
  LocalSecurityRejection,
  LocalSecurityService,
} from '../src/infrastructure/http/local-security.service.js';

const config: AppConfig = {
  host: '127.0.0.1',
  port: 3760,
  dataDir: 'D:\\temp\\auto-work',
  webDist: 'D:\\temp\\auto-work\\web',
  databaseUrl: 'file:./test.db',
  repositoryRoot: 'D:\\company',
  vaultBackend: 'dpapi',
  vaultKeyFile: 'D:\\temp\\auto-work\\vault-master.key',
  logLevel: 'info',
  environment: 'test',
};

function replyStub(): FastifyReply {
  return { setCookie: vi.fn() } as unknown as FastifyReply;
}

function requestStub(input: {
  method: string;
  host?: string;
  origin?: string;
  sessionId?: string;
  csrfToken?: string;
}): FastifyRequest {
  return {
    method: input.method,
    headers: {
      host: input.host,
      origin: input.origin,
      'x-csrf-token': input.csrfToken,
    },
    cookies: input.sessionId ? { aw_session: input.sessionId } : {},
  } as unknown as FastifyRequest;
}

describe('本机 HTTP 防护', () => {
  it('GET 建立 HttpOnly 会话并派生 CSRF 令牌', () => {
    const security = new LocalSecurityService(config);
    const request = requestStub({ method: 'GET', host: '127.0.0.1:3760' });
    const reply = replyStub();
    security.secure(request, reply, 'correlation-1');
    expect(request.autoWork.sessionId).toMatch(/^[a-f0-9]{64}$/);
    expect(request.autoWork.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(reply.setCookie).toHaveBeenCalledWith(
      'aw_session',
      request.autoWork.sessionId,
      expect.objectContaining({ httpOnly: true, sameSite: 'strict' }),
    );
  });

  it('拒绝 DNS rebinding 风格 Host', () => {
    const security = new LocalSecurityService(config);
    const request = requestStub({ method: 'GET', host: 'attacker.example:3760' });
    expect(() => security.secure(request, replyStub(), 'correlation-2')).toThrow(
      LocalSecurityRejection,
    );
  });

  it('变更请求必须同时满足同源和 CSRF', () => {
    const security = new LocalSecurityService(config);
    const initial = requestStub({ method: 'GET', host: 'localhost:3760' });
    security.secure(initial, replyStub(), 'correlation-3');

    const valid = requestStub({
      method: 'POST',
      host: 'localhost:3760',
      origin: 'http://localhost:3760',
      sessionId: initial.autoWork.sessionId,
      csrfToken: initial.autoWork.csrfToken,
    });
    expect(() => security.secure(valid, replyStub(), 'correlation-4')).not.toThrow();

    const invalid = requestStub({
      method: 'POST',
      host: 'localhost:3760',
      origin: 'https://attacker.example',
      sessionId: initial.autoWork.sessionId,
      csrfToken: initial.autoWork.csrfToken,
    });
    expect(() => security.secure(invalid, replyStub(), 'correlation-5')).toThrow('同源');
  });
});
