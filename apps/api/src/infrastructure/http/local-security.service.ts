import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';

const SESSION_COOKIE = 'aw_session';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export class LocalSecurityRejection extends Error {
  public constructor(
    public readonly code: 'HOST_REJECTED' | 'ORIGIN_REJECTED' | 'CSRF_REJECTED',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

@Injectable()
export class LocalSecurityService {
  private readonly processSecret = randomBytes(32);
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly allowedOrigins: ReadonlySet<string>;

  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const port = config.port;
    this.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const allowedOrigins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ];
    if (config.environment === 'development') {
      allowedOrigins.push('http://127.0.0.1:5173', 'http://localhost:5173');
    }
    this.allowedOrigins = new Set(allowedOrigins);
  }

  public secure(request: FastifyRequest, reply: FastifyReply, correlationId: string): void {
    this.assertHost(request.headers.host);

    const existingSession = request.cookies[SESSION_COOKIE];
    const sessionId =
      existingSession && TOKEN_PATTERN.test(existingSession)
        ? existingSession
        : randomBytes(32).toString('hex');
    const csrfToken = this.csrfFor(sessionId);

    if (!existingSession || existingSession !== sessionId) {
      reply.setCookie(SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      });
    }

    if (MUTATING_METHODS.has(request.method)) {
      this.assertOrigin(request.headers.origin);
      this.assertCsrf(request.headers['x-csrf-token'], csrfToken);
    }

    request.autoWork = { correlationId, sessionId, csrfToken };
  }

  public sessionHash(sessionId: string): string {
    return createHmac('sha256', this.processSecret).update(`session:${sessionId}`).digest('hex');
  }

  private csrfFor(sessionId: string): string {
    return createHmac('sha256', this.processSecret).update(`csrf:${sessionId}`).digest('hex');
  }

  private assertHost(host: string | undefined): void {
    if (!host || !this.allowedHosts.has(host.toLowerCase())) {
      throw new LocalSecurityRejection('HOST_REJECTED', '请求 Host 不属于本机服务允许范围', 403);
    }
  }

  private assertOrigin(origin: string | undefined): void {
    if (!origin || !this.allowedOrigins.has(origin.toLowerCase())) {
      throw new LocalSecurityRejection('ORIGIN_REJECTED', '变更请求必须来自本机同源页面', 403);
    }
  }

  private assertCsrf(value: string | string[] | undefined, expected: string): void {
    const provided = Array.isArray(value) ? value[0] : value;
    if (!provided || !TOKEN_PATTERN.test(provided)) {
      throw new LocalSecurityRejection('CSRF_REJECTED', 'CSRF 令牌缺失或格式无效', 403);
    }
    const actualBuffer = Buffer.from(provided, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new LocalSecurityRejection('CSRF_REJECTED', 'CSRF 令牌校验失败', 403);
    }
  }
}
