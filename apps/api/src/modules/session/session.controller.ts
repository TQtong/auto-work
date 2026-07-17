import { Controller, Get, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { SessionService } from './session.service.js';

@Controller('session')
export class SessionController {
  public constructor(private readonly sessions: SessionService) {}

  @Get()
  public getSession(@Req() request: FastifyRequest) {
    return apiResponse(
      this.sessions.describe(request.autoWork.csrfToken),
      request.autoWork.correlationId,
    );
  }
}
