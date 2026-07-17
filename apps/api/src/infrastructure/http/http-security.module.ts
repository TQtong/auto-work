import { Global, Module } from '@nestjs/common';
import { LocalSecurityService } from './local-security.service.js';
import { SecureHttpService } from './secure-http.service.js';

@Global()
@Module({
  providers: [LocalSecurityService, SecureHttpService],
  exports: [LocalSecurityService, SecureHttpService],
})
export class HttpSecurityModule {}
