import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/config.module.js';
import { loadAppConfig } from './config/app-config.js';
import { applyPendingRestore } from './infrastructure/database/pending-restore.js';
import { ApiExceptionFilter } from './infrastructure/http/api-exception.filter.js';
import {
  LocalSecurityRejection,
  LocalSecurityService,
} from './infrastructure/http/local-security.service.js';

const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

async function bootstrap(): Promise<void> {
  const pendingRestore = await applyPendingRestore(loadAppConfig());
  if (pendingRestore) {
    Logger.warn(
      `已在数据库连接前应用恢复 ${pendingRestore.restoreId}；原数据库保存在紧急安全副本`,
      'Bootstrap',
    );
  }
  const adapter = new FastifyAdapter({
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    abortOnError: true,
    bufferLogs: true,
  });
  const config = app.get<AppConfig>(APP_CONFIG);
  await mkdir(config.dataDir, { recursive: true });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    throwFileSizeLimit: true,
    limits: {
      fieldNameSize: 100,
      fieldSize: 1_024,
      fields: 0,
      fileSize: 8 * 1024 * 1024,
      files: 1,
      headerPairs: 128,
      parts: 1,
    },
  });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  const security = app.get(LocalSecurityService);
  const instance = app.getHttpAdapter().getInstance();
  instance.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = request.headers['x-correlation-id'];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
    const correlationId =
      candidate && CORRELATION_PATTERN.test(candidate) ? candidate : randomUUID();
    reply.header('X-Correlation-Id', correlationId);
    try {
      security.secure(request, reply, correlationId);
    } catch (error) {
      if (!(error instanceof LocalSecurityRejection)) throw error;
      await reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        correlationId,
        retryable: false,
        suggestedAction: 'none',
      });
    }
  });
  try {
    await access(config.webDist);
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: false });
    instanceSpaFallback(instance);
  } catch {
    Logger.warn(`未找到前端构建目录 ${config.webDist}，当前仅提供 API`, 'Bootstrap');
  }

  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
  Logger.log(`Auto Work 已安全监听 http://${config.host}:${config.port}`, 'Bootstrap');
}

function instanceSpaFallback(instance: FastifyInstance): void {
  instance.get('/*', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      await reply.status(404).send({
        code: 'RESOURCE_NOT_FOUND',
        message: 'API 资源不存在',
        correlationId: request.autoWork?.correlationId ?? 'unavailable',
        retryable: false,
        suggestedAction: 'none',
      });
      return;
    }
    await reply.sendFile('index.html');
  });
}

void bootstrap();
