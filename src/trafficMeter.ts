import type { KeyWindowStats } from './types.js';

interface KeyTraffic {
  connections: number;
  current: KeyWindowStats;
  history: KeyWindowStats[];
}

export class TrafficMeter {
  private data = new Map<string, KeyTraffic>();
  private windowMs: number;
  private maxHistory: number;

  constructor(windowMs: number, maxHistory: number) {
    this.windowMs = windowMs;
    this.maxHistory = maxHistory;
  }

  private ensureKey(key: string): KeyTraffic {
    let entry = this.data.get(key);
    if (!entry) {
      entry = {
        connections: 0,
        current: { bytesIn: 0, bytesOut: 0, windowStart: Date.now() },
        history: [],
      };
      this.data.set(key, entry);
    }
    this.rollIfNeeded(entry);
    return entry;
  }

  private rollIfNeeded(entry: KeyTraffic): void {
    const now = Date.now();
    while (now - entry.current.windowStart >= this.windowMs) {
      entry.history.push({ ...entry.current });
      entry.current = {
        bytesIn: 0,
        bytesOut: 0,
        windowStart: entry.current.windowStart + this.windowMs,
      };
      while (entry.history.length > this.maxHistory) {
        entry.history.shift();
      }
    }
  }

  recordIn(key: string, bytes: number): void {
    this.ensureKey(key).current.bytesIn += bytes;
  }

  recordOut(key: string, bytes: number): void {
    this.ensureKey(key).current.bytesOut += bytes;
  }

  addConnection(key: string): void {
    this.ensureKey(key).connections++;
  }

  removeConnection(key: string): void {
    const entry = this.data.get(key);
    if (entry && entry.connections > 0) {
      entry.connections--;
    }
  }

  getStats(): Record<string, { connections: number; current: KeyWindowStats; history: KeyWindowStats[] }> {
    const result: Record<string, { connections: number; current: KeyWindowStats; history: KeyWindowStats[] }> = {};
    for (const [key, entry] of this.data) {
      this.rollIfNeeded(entry);
      result[key] = {
        connections: entry.connections,
        current: { ...entry.current },
        history: entry.history.map(h => ({ ...h })),
      };
    }
    return result;
  }
}
