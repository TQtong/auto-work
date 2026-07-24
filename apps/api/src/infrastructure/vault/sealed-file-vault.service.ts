import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import type { CredentialVault } from './credential-vault.js';

const REFERENCE_PATTERN = /^sealed:([0-9a-f-]{36})$/i;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

interface SealedEnvelope {
  version: 1;
  algorithm: typeof ALGORITHM;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * 使用持久化主密钥加密凭据。密钥和密文分开存储，Docker 可把密钥文件单独挂载为只读 secret。
 * AES-GCM 同时提供机密性和完整性，引用 ID 作为附加认证数据，阻止密文文件被调包。
 */
@Injectable()
export class SealedFileVaultService implements CredentialVault {
  private readonly vaultDirectory: string;
  private readonly keyFile: string;
  private keyPromise: Promise<Buffer> | undefined;

  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.vaultDirectory = join(config.dataDir, 'vault');
    this.keyFile = config.vaultKeyFile;
  }

  public async put(secret: string): Promise<string> {
    if (!secret) throw new DomainError('CREDENTIAL_EMPTY', '凭证不能为空', { httpStatus: 422 });
    await mkdir(this.vaultDirectory, { recursive: true, mode: 0o700 });
    const id = newId();
    const key = await this.loadKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(this.additionalData(id));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const envelope: SealedEnvelope = {
      version: 1,
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await writeFile(join(this.vaultDirectory, `${id}.sealed`), `${JSON.stringify(envelope)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return `sealed:${id}`;
  }

  public async get(reference: string): Promise<string> {
    const { id, path } = this.resolveReference(reference);
    try {
      const envelope = this.parseEnvelope(await readFile(path, 'utf8'));
      const decipher = createDecipheriv(ALGORITHM, await this.loadKey(), envelope.iv);
      decipher.setAAD(this.additionalData(id));
      decipher.setAuthTag(envelope.authTag);
      return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString(
        'utf8',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      if (error instanceof DomainError) throw error;
      // 不返回加密库原始错误，避免泄露文件内容、路径或密钥校验细节。
      throw new DomainError('CREDENTIAL_DECRYPT_FAILED', '凭证解密或完整性校验失败', {
        httpStatus: 503,
        suggestedAction: 'reconfigure',
      });
    }
  }

  public async delete(reference: string): Promise<void> {
    const { path } = this.resolveReference(reference);
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private resolveReference(reference: string): { id: string; path: string } {
    const match = REFERENCE_PATTERN.exec(reference);
    if (!match?.[1]) {
      throw new DomainError('CREDENTIAL_REFERENCE_INVALID', '凭证引用格式无效', {
        httpStatus: 422,
      });
    }
    const id = match[1].toLowerCase();
    return { id, path: join(this.vaultDirectory, `${id}.sealed`) };
  }

  private additionalData(id: string): Buffer {
    return Buffer.from(`auto-work-vault:v1:${id}`, 'utf8');
  }

  private parseEnvelope(source: string): {
    iv: Buffer;
    authTag: Buffer;
    ciphertext: Buffer;
  } {
    try {
      const value = JSON.parse(source) as Partial<SealedEnvelope>;
      if (value.version !== 1 || value.algorithm !== ALGORITHM) throw new Error('版本无效');
      const iv = this.decodeBase64(value.iv, IV_BYTES);
      const authTag = this.decodeBase64(value.authTag, 16);
      const ciphertext = this.decodeBase64(value.ciphertext);
      return { iv, authTag, ciphertext };
    } catch {
      throw new DomainError('CREDENTIAL_ENVELOPE_INVALID', '凭证密文格式无效', {
        httpStatus: 503,
        suggestedAction: 'reconfigure',
      });
    }
  }

  private decodeBase64(value: unknown, expectedLength?: number): Buffer {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error('Base64 格式无效');
    }
    const decoded = Buffer.from(value, 'base64');
    if (
      decoded.toString('base64') !== value ||
      (expectedLength && decoded.length !== expectedLength)
    ) {
      throw new Error('Base64 内容无效');
    }
    return decoded;
  }

  private async loadKey(): Promise<Buffer> {
    if (!this.keyPromise) {
      this.keyPromise = this.readOrCreateKey().catch((error) => {
        this.keyPromise = undefined;
        throw error;
      });
    }
    return this.keyPromise;
  }

  private async readOrCreateKey(): Promise<Buffer> {
    try {
      return this.parseKey(await readFile(this.keyFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(this.keyFile), { recursive: true, mode: 0o700 });
    const encoded = `${randomBytes(KEY_BYTES).toString('base64')}\n`;
    try {
      // wx 保证并发首启时只有一个实例创建主密钥，其他实例随后读取相同文件。
      await writeFile(this.keyFile, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return this.parseKey(await readFile(this.keyFile, 'utf8'));
  }

  private parseKey(source: string): Buffer {
    try {
      return this.decodeBase64(source.trim(), KEY_BYTES);
    } catch {
      throw new DomainError('VAULT_KEY_INVALID', '凭证保险箱主密钥格式无效', {
        httpStatus: 503,
        suggestedAction: 'reconfigure',
      });
    }
  }
}
