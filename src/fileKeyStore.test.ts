import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileKeyStore } from './fileKeyStore.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileKeyStore', () => {
  let tmpDir: string;
  let keyFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-relay-test-'));
    keyFile = path.join(tmpDir, 'keys.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should validate keys from file', () => {
    fs.writeFileSync(keyFile, 'key-abc-123\nkey-xyz-456\n');
    const store = new FileKeyStore(keyFile, { watch: false });
    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-xyz-456')).toBe(true);
    expect(store.validate('key-unknown')).toBe(false);
  });

  it('should ignore comments and blank lines', () => {
    fs.writeFileSync(keyFile, '# This is a comment\nkey-abc-123\n\n# Another comment\nkey-xyz-456\n');
    const store = new FileKeyStore(keyFile, { watch: false });
    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-xyz-456')).toBe(true);
  });

  it('should trim whitespace', () => {
    fs.writeFileSync(keyFile, '  key-abc-123  \n  key-xyz-456  \n');
    const store = new FileKeyStore(keyFile, { watch: false });
    expect(store.validate('key-abc-123')).toBe(true);
  });

  it('should throw if file does not exist', () => {
    expect(() => new FileKeyStore('/nonexistent/keys.txt', { watch: false })).toThrow();
  });

  it('should throw if any key has invalid format', () => {
    fs.writeFileSync(keyFile, 'key-abc-123\nbad\n');
    expect(() => new FileKeyStore(keyFile, { watch: false })).toThrow('invalid format');
  });

  it('should reload keys when reload() is called', () => {
    fs.writeFileSync(keyFile, 'key-abc-123\n');
    const store = new FileKeyStore(keyFile, { watch: false });

    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-new-4567')).toBe(false);

    fs.writeFileSync(keyFile, 'key-abc-123\nkey-new-4567\n');
    store.reload();

    expect(store.validate('key-new-4567')).toBe(true);
  });

  it('should stop watching after close()', () => {
    fs.writeFileSync(keyFile, 'key-abc-123\n');
    const store = new FileKeyStore(keyFile, { watch: true });
    store.close();
  });
});
