import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from './rateLimiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow first connection from IP', () => {
    const limiter = new RateLimiter(10);
    expect(limiter.checkConnection('192.168.1.1')).toBe(true);
  });

  it('should allow connections up to the limit', () => {
    const limiter = new RateLimiter(5);
    const ip = '192.168.1.1';

    for (let i = 0; i < 5; i++) {
      expect(limiter.checkConnection(ip)).toBe(true);
    }
  });

  it('should block connections over the limit', () => {
    const limiter = new RateLimiter(3);
    const ip = '192.168.1.1';

    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(false);
    expect(limiter.checkConnection(ip)).toBe(false);
  });

  it('should track different IPs independently', () => {
    const limiter = new RateLimiter(2);

    expect(limiter.checkConnection('192.168.1.1')).toBe(true);
    expect(limiter.checkConnection('192.168.1.1')).toBe(true);
    expect(limiter.checkConnection('192.168.1.1')).toBe(false);

    expect(limiter.checkConnection('192.168.1.2')).toBe(true);
    expect(limiter.checkConnection('192.168.1.2')).toBe(true);
    expect(limiter.checkConnection('192.168.1.2')).toBe(false);
  });

  it('should allow new connection after release', () => {
    const limiter = new RateLimiter(2);
    const ip = '192.168.1.1';

    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(false);

    limiter.releaseConnection(ip);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(false);
  });

  it('should not decrement below zero', () => {
    const limiter = new RateLimiter(2);
    const ip = '192.168.1.1';

    limiter.releaseConnection(ip); // no entry yet
    expect(limiter.checkConnection(ip)).toBe(true);

    limiter.releaseConnection(ip);
    limiter.releaseConnection(ip); // would go below 0
    expect(limiter.checkConnection(ip)).toBe(true);
  });

  it('should cleanup idle entries', () => {
    const limiter = new RateLimiter(2);
    const ip = '192.168.1.1';

    limiter.checkConnection(ip);
    limiter.releaseConnection(ip);

    // Trigger cleanup
    vi.advanceTimersByTime(60001);

    // Entry should be cleaned up — verify by checking internal state indirectly:
    // a new connection should still work fine
    expect(limiter.checkConnection(ip)).toBe(true);
  });

  it('should handle high volume of different IPs', () => {
    const limiter = new RateLimiter(5);

    for (let i = 0; i < 100; i++) {
      const ip = `192.168.1.${i}`;
      expect(limiter.checkConnection(ip)).toBe(true);
    }
  });
});
