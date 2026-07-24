import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import type { CredentialVault } from './credential-vault.js';
import { SealedFileVaultService } from './sealed-file-vault.service.js';
import { WindowsDpapiVaultService } from './windows-dpapi-vault.service.js';

/** 新凭据按配置选择后端，已有凭据始终按引用前缀读取，保证切换后端时可平滑共存。 */
@Injectable()
export class CredentialVaultRouterService implements CredentialVault {
  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly dpapi: WindowsDpapiVaultService,
    private readonly sealed: SealedFileVaultService,
  ) {}

  public async put(secret: string): Promise<string> {
    return this.writeBackend().put(secret);
  }

  public async get(reference: string): Promise<string> {
    return this.referenceBackend(reference).get(reference);
  }

  public async delete(reference: string): Promise<void> {
    return this.referenceBackend(reference).delete(reference);
  }

  private writeBackend(): CredentialVault {
    const backend =
      this.config.vaultBackend === 'auto'
        ? process.platform === 'win32'
          ? 'dpapi'
          : 'sealed'
        : this.config.vaultBackend;
    if (backend === 'dpapi' && process.platform !== 'win32') {
      throw new DomainError('DPAPI_UNAVAILABLE', '当前系统无法创建 Windows DPAPI 凭证', {
        httpStatus: 503,
        suggestedAction: 'reconfigure',
      });
    }
    return backend === 'dpapi' ? this.dpapi : this.sealed;
  }

  private referenceBackend(reference: string): CredentialVault {
    if (reference.startsWith('dpapi:')) return this.dpapi;
    if (reference.startsWith('sealed:')) return this.sealed;
    throw new DomainError('CREDENTIAL_REFERENCE_INVALID', '凭证引用格式无效', {
      httpStatus: 422,
    });
  }
}
