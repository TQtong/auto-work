import { Global, Module } from '@nestjs/common';
import { CREDENTIAL_VAULT } from './credential-vault.js';
import { WindowsDpapiVaultService } from './windows-dpapi-vault.service.js';

@Global()
@Module({
  providers: [
    WindowsDpapiVaultService,
    { provide: CREDENTIAL_VAULT, useExisting: WindowsDpapiVaultService },
  ],
  exports: [CREDENTIAL_VAULT],
})
export class VaultModule {}
