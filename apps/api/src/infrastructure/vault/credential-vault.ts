export interface CredentialVault {
  put(secret: string): Promise<string>;
  get(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

export const CREDENTIAL_VAULT = Symbol('CREDENTIAL_VAULT');
