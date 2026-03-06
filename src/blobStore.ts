import type { BlobStoreConfig, BlobStoreInterface } from './types.js';

interface BlobEntry {
  data: string;
  updatedAt: number;
}

export class BlobStore implements BlobStoreInterface {
  private entries = new Map<string, BlobEntry>();
  private maxBlobSize: number;

  constructor(config: BlobStoreConfig = {}) {
    this.maxBlobSize = config.maxBlobSize ?? 8192;
  }

  get(key: string): string | null {
    const entry = this.entries.get(key);
    return entry ? entry.data : null;
  }

  put(key: string, data: string): void {
    if (data.length > this.maxBlobSize) {
      throw new Error(`Blob exceeds max size (${this.maxBlobSize} bytes)`);
    }
    this.entries.set(key, { data, updatedAt: Date.now() });
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  get stats() {
    return { entries: this.entries.size };
  }
}
