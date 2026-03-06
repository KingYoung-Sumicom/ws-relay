import { isValidKeyFormat } from './utils.js';
import type { KeyStoreInterface } from './types.js';

export class EnvKeyStore implements KeyStoreInterface {
  private keys: Set<string>;

  constructor(envVarName: string) {
    const raw = process.env[envVarName];
    if (raw === undefined) {
      throw new Error(`Environment variable "${envVarName}" is not set. Set it to a comma-separated list of access keys.`);
    }
    if (raw.trim() === '') {
      throw new Error(`Environment variable "${envVarName}" is empty. Set it to a comma-separated list of access keys.`);
    }

    const keys = raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
    for (const key of keys) {
      if (!isValidKeyFormat(key)) {
        throw new Error(`Key "${key}" has invalid format. Keys must match /^[a-zA-Z0-9_-]{8,64}$/.`);
      }
    }

    this.keys = new Set(keys);
  }

  validate(key: string): boolean {
    return this.keys.has(key);
  }
}
