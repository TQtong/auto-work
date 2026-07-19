import { Global, Module } from '@nestjs/common';
import { CREDENTIAL_VAULT } from './credential-vault.js';
import { WindowsDpapiVaultService } from './windows-dpapi-vault.service.js';
import { SealedFileVaultService } from './sealed-file-vault.service.js';
import { CredentialVaultRouterService } from './credential-vault-router.service.js';

@Global()
@Module({
  providers: [
    WindowsDpapiVaultService,
    SealedFileVaultService,
    CredentialVaultRouterService,
    { provide: CREDENTIAL_VAULT, useExisting: CredentialVaultRouterService },
  ],
  exports: [CREDENTIAL_VAULT],
})
export class VaultModule {}
