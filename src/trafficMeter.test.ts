import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TrafficMeter } from './trafficMeter.js';

describe('TrafficMeter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should record bytes for a key', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.recordIn('key-abc-123', 100);
    meter.recordOut('key-abc-123', 50);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].current.bytesIn).toBe(100);
    expect(stats['key-abc-123'].current.bytesOut).toBe(50);
  });

  it('should accumulate bytes in current window', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.recordIn('key-abc-123', 100);
    meter.recordIn('key-abc-123', 200);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].current.bytesIn).toBe(300);
  });

  it('should track multiple keys independently', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.recordIn('key-abc-123', 100);
    meter.recordIn('key-xyz-456', 200);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].current.bytesIn).toBe(100);
    expect(stats['key-xyz-456'].current.bytesIn).toBe(200);
  });

  it('should roll current into history when window expires', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.recordIn('key-abc-123', 100);

    vi.advanceTimersByTime(60001);
    meter.recordIn('key-abc-123', 50);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].current.bytesIn).toBe(50);
    expect(stats['key-abc-123'].history).toHaveLength(1);
    expect(stats['key-abc-123'].history[0].bytesIn).toBe(100);
  });

  it('should prune history beyond max windows', () => {
    const meter = new TrafficMeter(60000, 2);

    meter.recordIn('key-abc-123', 100);
    vi.advanceTimersByTime(60001);
    meter.recordIn('key-abc-123', 200);
    vi.advanceTimersByTime(60001);
    meter.recordIn('key-abc-123', 300);
    vi.advanceTimersByTime(60001);
    meter.recordIn('key-abc-123', 400);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].history).toHaveLength(2);
    expect(stats['key-abc-123'].history[0].bytesIn).toBe(200);
    expect(stats['key-abc-123'].history[1].bytesIn).toBe(300);
  });

  it('should track connections per key', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.addConnection('key-abc-123');
    meter.addConnection('key-abc-123');
    meter.addConnection('key-xyz-456');

    const stats = meter.getStats();
    expect(stats['key-abc-123'].connections).toBe(2);
    expect(stats['key-xyz-456'].connections).toBe(1);
  });

  it('should decrement connections on remove', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.addConnection('key-abc-123');
    meter.addConnection('key-abc-123');
    meter.removeConnection('key-abc-123');

    const stats = meter.getStats();
    expect(stats['key-abc-123'].connections).toBe(1);
  });
});
