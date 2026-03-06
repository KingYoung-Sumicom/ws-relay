import { readFileSync, watch, type FSWatcher } from 'fs';
import { isValidKeyFormat } from './utils.js';
import type { KeyStoreInterface } from './types.js';

export interface FileKeyStoreOptions {
  /** Watch file for changes and auto-reload. Default: true */
  watch?: boolean;
}

function parseKeyFile(filePath: string): Set<string> {
  const content = readFileSync(filePath, 'utf-8');
  const keys = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  for (const key of keys) {
    if (!isValidKeyFormat(key)) {
      throw new Error(`Key "${key}" has invalid format. Keys must match /^[a-zA-Z0-9_-]{8,64}$/.`);
    }
  }

  return new Set(keys);
}

export class FileKeyStore implements KeyStoreInterface {
  private keys: Set<string>;
  private filePath: string;
  private watcher: FSWatcher | null = null;

  constructor(filePath: string, options: FileKeyStoreOptions = {}) {
    const shouldWatch = options.watch ?? true;
    this.filePath = filePath;
    this.keys = parseKeyFile(filePath);

    if (shouldWatch) {
      this.watcher = watch(filePath, () => this.reload());
    }
  }

  /** Re-read the key file. Called automatically by the file watcher, or manually. */
  reload(): void {
    try {
      this.keys = parseKeyFile(this.filePath);
    } catch {
      // Keep existing keys if reload fails
    }
  }

  validate(key: string): boolean {
    return this.keys.has(key);
  }

  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
