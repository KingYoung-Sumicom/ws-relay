import { describe, it, expect, beforeEach } from 'vitest';
import { BlobStore } from './blobStore.js';

describe('BlobStore', () => {
  let store: BlobStore;

  beforeEach(() => {
    store = new BlobStore({ maxBlobSize: 8192 });
  });

  it('should store and retrieve a blob', () => {
    store.put('abc12345', 'encrypted-data');
    expect(store.get('abc12345')).toBe('encrypted-data');
  });

  it('should return null for missing key', () => {
    expect(store.get('missing1')).toBeNull();
  });

  it('should overwrite existing blob', () => {
    store.put('abc12345', 'old-data');
    store.put('abc12345', 'new-data');
    expect(store.get('abc12345')).toBe('new-data');
  });

  it('should reject blobs exceeding max size', () => {
    const largeBlob = 'x'.repeat(8193);
    expect(() => store.put('abc12345', largeBlob)).toThrow('exceeds max size');
  });

  it('should delete a blob', () => {
    store.put('abc12345', 'data');
    expect(store.delete('abc12345')).toBe(true);
    expect(store.get('abc12345')).toBeNull();
  });

  it('should return false when deleting non-existent key', () => {
    expect(store.delete('missing1')).toBe(false);
  });

  it('should track stats correctly', () => {
    expect(store.stats).toEqual({ entries: 0 });

    store.put('key12345', 'data1');
    store.put('key23456', 'data2');
    expect(store.stats).toEqual({ entries: 2 });

    store.delete('key12345');
    expect(store.stats).toEqual({ entries: 1 });
  });
});
