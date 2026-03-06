import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerRegistry } from './registry.js';
import { WebSocket } from 'ws';
import type { Peer } from './types.js';

function createMockPeer(channel: string, id: string): Peer {
  return {
    ws: {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WebSocket,
    channel,
    id,
    address: `${channel}:${id}`,
    ip: '127.0.0.1',
    connectedAt: Date.now(),
  };
}

describe('PeerRegistry', () => {
  let registry: PeerRegistry;

  beforeEach(() => {
    registry = new PeerRegistry();
  });

  describe('peer management', () => {
    it('should add and retrieve peer', () => {
      const peer = createMockPeer('server', 'abc123');
      registry.add(peer);

      expect(registry.has('server', 'abc123')).toBe(true);
      expect(registry.get('server', 'abc123')).toBe(peer);
    });

    it('should remove peer', () => {
      const peer = createMockPeer('server', 'abc123');
      registry.add(peer);
      registry.remove(peer);

      expect(registry.has('server', 'abc123')).toBe(false);
      expect(registry.get('server', 'abc123')).toBeUndefined();
    });

    it('should return undefined for non-existent peer', () => {
      expect(registry.has('server', 'nonexistent')).toBe(false);
      expect(registry.get('server', 'nonexistent')).toBeUndefined();
    });

    it('should handle multiple channels independently', () => {
      const server = createMockPeer('server', 'abc123');
      const client = createMockPeer('client', 'abc123');
      registry.add(server);
      registry.add(client);

      expect(registry.get('server', 'abc123')).toBe(server);
      expect(registry.get('client', 'abc123')).toBe(client);
    });

    it('should replace peer with same channel and id', () => {
      const peer1 = createMockPeer('server', 'abc123');
      const peer2 = createMockPeer('server', 'abc123');
      registry.add(peer1);
      registry.add(peer2);

      expect(registry.get('server', 'abc123')).toBe(peer2);
    });
  });

  describe('getByAddress', () => {
    it('should look up peer by address', () => {
      const peer = createMockPeer('server', 'myId');
      registry.add(peer);

      expect(registry.getByAddress('server:myId')).toBe(peer);
    });

    it('should return undefined for invalid address format', () => {
      expect(registry.getByAddress('invalid')).toBeUndefined();
      expect(registry.getByAddress('')).toBeUndefined();
    });

    it('should return undefined for non-existent address', () => {
      expect(registry.getByAddress('server:nonexistent')).toBeUndefined();
    });

    it('should handle address with colons in the id', () => {
      const peer = createMockPeer('client', 'key:with:colons');
      registry.add(peer);

      expect(registry.getByAddress('client:key:with:colons')).toBe(peer);
    });
  });

  describe('presence watching', () => {
    it('should register a watcher', () => {
      registry.watch('server:abc', 'client:xyz');
      const watchers = registry.getWatchers('server:abc');
      expect(watchers.has('client:xyz')).toBe(true);
    });

    it('should unwatch', () => {
      registry.watch('server:abc', 'client:xyz');
      registry.unwatch('server:abc', 'client:xyz');
      const watchers = registry.getWatchers('server:abc');
      expect(watchers.size).toBe(0);
    });

    it('should return empty set for unwatched address', () => {
      const watchers = registry.getWatchers('server:unknown');
      expect(watchers.size).toBe(0);
    });

    it('should track multiple watchers for one address', () => {
      registry.watch('server:abc', 'client:one');
      registry.watch('server:abc', 'client:two');
      const watchers = registry.getWatchers('server:abc');
      expect(watchers.size).toBe(2);
    });

    it('should get all watched addresses for a watcher', () => {
      registry.watch('server:abc', 'client:xyz');
      registry.watch('server:def', 'client:xyz');
      const watched = registry.getWatched('client:xyz');
      expect(watched).toContain('server:abc');
      expect(watched).toContain('server:def');
      expect(watched.length).toBe(2);
    });

    it('should remove all watches for a watcher', () => {
      registry.watch('server:abc', 'client:xyz');
      registry.watch('server:def', 'client:xyz');
      registry.removeAllWatchesFor('client:xyz');

      expect(registry.getWatchers('server:abc').size).toBe(0);
      expect(registry.getWatchers('server:def').size).toBe(0);
      expect(registry.getWatched('client:xyz').length).toBe(0);
    });
  });

  describe('stats tracking', () => {
    it('should track total connections', () => {
      expect(registry.getStats().totalConnections).toBe(0);

      registry.add(createMockPeer('server', 'a'));
      expect(registry.getStats().totalConnections).toBe(1);

      registry.add(createMockPeer('client', 'b'));
      expect(registry.getStats().totalConnections).toBe(2);
    });

    it('should track peak connections per channel', () => {
      registry.add(createMockPeer('server', 'a'));
      registry.add(createMockPeer('server', 'b'));
      registry.add(createMockPeer('server', 'c'));

      expect(registry.getStats().channels['server'].peak).toBe(3);

      registry.remove(createMockPeer('server', 'a'));
      registry.remove(createMockPeer('server', 'b'));

      // Peak stays at high-water mark
      expect(registry.getStats().channels['server'].peak).toBe(3);
      expect(registry.getStats().channels['server'].active).toBe(1);
    });

    it('should include uptime in stats', () => {
      expect(registry.getStats().uptime).toBeGreaterThanOrEqual(0);
    });

    it('should track messages relayed', () => {
      expect(registry.getStats().messagesRelayed).toBe(0);
      registry.incrementMessagesRelayed();
      registry.incrementMessagesRelayed();
      expect(registry.getStats().messagesRelayed).toBe(2);
    });
  });
});
