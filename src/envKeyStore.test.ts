import { describe, it, expect, afterEach } from 'vitest';
import { EnvKeyStore } from './envKeyStore.js';

describe('EnvKeyStore', () => {
  const ENV_VAR = 'TEST_RELAY_KEYS';

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('should validate a key present in env var', () => {
    process.env[ENV_VAR] = 'key-abc-123,key-xyz-456';
    const store = new EnvKeyStore(ENV_VAR);
    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-xyz-456')).toBe(true);
  });

  it('should reject a key not in env var', () => {
    process.env[ENV_VAR] = 'key-abc-123';
    const store = new EnvKeyStore(ENV_VAR);
    expect(store.validate('key-unknown')).toBe(false);
  });

  it('should trim whitespace around keys', () => {
    process.env[ENV_VAR] = ' key-abc-123 , key-xyz-456 ';
    const store = new EnvKeyStore(ENV_VAR);
    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-xyz-456')).toBe(true);
  });

  it('should throw if env var is not set', () => {
    expect(() => new EnvKeyStore(ENV_VAR)).toThrow('not set');
  });

  it('should throw if env var is empty', () => {
    process.env[ENV_VAR] = '';
    expect(() => new EnvKeyStore(ENV_VAR)).toThrow('empty');
  });

  it('should throw if any key has invalid format', () => {
    process.env[ENV_VAR] = 'key-abc-123,bad';
    expect(() => new EnvKeyStore(ENV_VAR)).toThrow('invalid format');
  });

  it('should ignore empty segments from trailing commas', () => {
    process.env[ENV_VAR] = 'key-abc-123,key-xyz-456,';
    const store = new EnvKeyStore(ENV_VAR);
    expect(store.validate('key-abc-123')).toBe(true);
  });
});
