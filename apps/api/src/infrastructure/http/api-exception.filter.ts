import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { DomainError, errorCodes, type ApiErrorBody } from '@auto-work/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { LocalSecurityRejection } from './local-security.service.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const correlationId = request.autoWork?.correlationId ?? 'unavailable';

    const normalized = this.normalize(exception, correlationId);
    if (normalized.status >= 500) {
      this.logger.error({
        correlationId,
        path: request.routeOptions?.url ?? request.url,
        errorClass: exception instanceof Error ? exception.name : typeof exception,
      });
    }
    void reply.status(normalized.status).send(normalized.body);
  }

  private normalize(
    exception: unknown,
    correlationId: string,
  ): { status: number; body: ApiErrorBody } {
    if (exception instanceof LocalSecurityRejection) {
      return {
        status: exception.statusCode,
        body: {
          code: exception.code,
          message: exception.message,
          correlationId,
          retryable: false,
          suggestedAction: 'none',
        },
      };
    }
    if (exception instanceof DomainError) {
      return {
        status: exception.options.httpStatus ?? HttpStatus.UNPROCESSABLE_ENTITY,
        body: {
          code: exception.code,
          message: exception.message,
          details: exception.options.details,
          correlationId,
          retryable: exception.options.retryable ?? false,
          suggestedAction: exception.options.suggestedAction ?? 'none',
        },
      };
    }
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          code: errorCodes.invalidRequest,
          message: '请求参数校验失败',
          details: exception.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          correlationId,
          retryable: false,
          suggestedAction: 'none',
        },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          code: status === 404 ? errorCodes.notFound : errorCodes.invalidRequest,
          message: this.safeHttpMessage(exception),
          correlationId,
          retryable: status >= 500,
          suggestedAction: status === 409 ? 'refresh' : 'none',
        },
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: errorCodes.internal,
        message: '服务发生未预期错误，请使用关联 ID 查看本机诊断',
        correlationId,
        retryable: false,
        suggestedAction: 'manual_review',
      },
    };
  }

  private safeHttpMessage(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (typeof response === 'object' && response !== null && 'message' in response) {
      const message = response.message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message))
        return message.filter((item): item is string => typeof item === 'string').join('；');
    }
    return '请求未能完成';
  }
}
