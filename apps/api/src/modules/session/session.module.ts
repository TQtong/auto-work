import { Global, Module } from '@nestjs/common';
import { SessionController } from './session.controller.js';
import { SessionService } from './session.service.js';

@Global()
@Module({
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
