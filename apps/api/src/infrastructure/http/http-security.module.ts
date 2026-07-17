import { Global, Module } from '@nestjs/common';
import { LocalSecurityService } from './local-security.service.js';

@Global()
@Module({
  providers: [LocalSecurityService],
  exports: [LocalSecurityService],
})
export class HttpSecurityModule {}
