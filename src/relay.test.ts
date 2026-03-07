import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { createRelay } from './relay.js';
import type { RelayInstance, KeyStoreInterface } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** A simple in-memory key store for tests */
function createKeyStore(keys: string[]): KeyStoreInterface {
  const set = new Set(keys);
  return { validate: (key: string) => set.has(key) };
}

/** Start an HTTP server on a random port and return the port */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

/** Connect a WebSocket client. Resolves on open, rejects on error. */
function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

/** Wait for the next message on a WebSocket, parsed as JSON */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/** Wait for a WebSocket close event */
function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Fetch JSON from a local HTTP endpoint */
async function fetchJson(port: number, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://localhost:${port}${path}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Test Suite ───────────────────────────────────────────────────────────

const VALID_KEY = 'test-key-12345';
const VALID_KEY_2 = 'test-key-67890';
const PEER_ID = 'peer-id-abcd';
const PEER_ID_2 = 'peer-id-efgh';

describe('relay integration', () => {
  let relay: RelayInstance | null = null;
  let server: Server | null = null;
  const openSockets: WebSocket[] = [];

  afterEach(() => {
    // Close all test sockets
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets.length = 0;

    // Close relay and server
    if (relay) {
      relay.close();
      relay = null;
    }
    if (server) {
      server.close();
      server = null;
    }
  });

  /** Helper to track WebSocket for cleanup */
  function track(ws: WebSocket): WebSocket {
    openSockets.push(ws);
    return ws;
  }

  // ── Config Validation ────────────────────────────────────────────────

  describe('config validation', () => {
    it('should throw when keyStore is omitted', () => {
      const s = createServer();
      expect(() =>
        createRelay({
          channels: [{ name: 'test' }],
          server: s,
        } as any)
      ).toThrow('keyStore is required');
      s.close();
    });

    it('should not throw when keyStore is false', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        server,
      });
      expect(relay).toBeDefined();
    });
  });

  // ── Open Access (keyStore: false) ────────────────────────────────────

  describe('open access (keyStore: false)', () => {
    it('should allow connections without key', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        server,
      });
      const port = await listenOnRandomPort(server);
      const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });
  });

  // ── Close-After-Connect Mode (default) ──────────────────────────────

  describe('close-after-connect mode', () => {
    async function setup(): Promise<number> {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: createKeyStore([VALID_KEY, VALID_KEY_2]),
        server,
      });
      return listenOnRandomPort(server);
    }

    it('should accept connection with valid key', async () => {
      const port = await setup();
      const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('should reject connection with missing key', async () => {
      const port = await setup();
      const ws = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}`));
      const msg = await nextMessage(ws);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('INVALID_KEY');

      const close = await waitForClose(ws);
      expect(close.code).toBe(1008);
    });

    it('should reject connection with invalid format key', async () => {
      const port = await setup();
      const ws = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=bad`));
      const msg = await nextMessage(ws);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('INVALID_KEY');

      const close = await waitForClose(ws);
      expect(close.code).toBe(1008);
    });

    it('should reject connection with unknown key', async () => {
      const port = await setup();
      const ws = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=unknown-key-999`));
      const msg = await nextMessage(ws);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('INVALID_KEY');

      const close = await waitForClose(ws);
      expect(close.code).toBe(1008);
    });
  });

  // ── Reject-Upgrade Mode ─────────────────────────────────────────────

  describe('reject-upgrade mode', () => {
    async function setup(): Promise<number> {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: createKeyStore([VALID_KEY]),
        onInvalidKey: 'reject-upgrade',
        server,
      });
      return listenOnRandomPort(server);
    }

    it('should accept upgrade with valid key', async () => {
      const port = await setup();
      const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('should reject upgrade with missing key', async () => {
      const port = await setup();
      const ws = new WebSocket(`ws://localhost:${port}/test/${PEER_ID}`);
      track(ws);
      await expect(
        new Promise((_, reject) => {
          ws.on('error', reject);
          ws.on('open', () => reject(new Error('Should not open')));
        })
      ).rejects.toThrow();
    });

    it('should reject upgrade with invalid key', async () => {
      const port = await setup();
      const ws = new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=wrong-key-9999`);
      track(ws);
      await expect(
        new Promise((_, reject) => {
          ws.on('error', reject);
          ws.on('open', () => reject(new Error('Should not open')));
        })
      ).rejects.toThrow();
    });
  });

  // ── Async Key Store ─────────────────────────────────────────────────

  describe('async key store', () => {
    it('should support async validate()', async () => {
      server = createServer();
      const asyncStore: KeyStoreInterface = {
        validate: (key: string) => Promise.resolve(key === VALID_KEY),
      };
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: asyncStore,
        server,
      });
      const port = await listenOnRandomPort(server);

      // Valid key — should connect
      const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('should reject when async validate returns false', async () => {
      server = createServer();
      const asyncStore: KeyStoreInterface = {
        validate: (key: string) => Promise.resolve(key === VALID_KEY),
      };
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: asyncStore,
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=wrong-key-9999`));
      const msg = await nextMessage(ws);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('INVALID_KEY');
    });
  });

  // ── Traffic Metering ────────────────────────────────────────────────

  describe('traffic metering', () => {
    async function setupWithTraffic(): Promise<number> {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: createKeyStore([VALID_KEY, VALID_KEY_2]),
        statsWindow: 3600000,
        statsHistory: 2,
        server,
      });
      return listenOnRandomPort(server);
    }

    it('should include key stats in /stats endpoint', async () => {
      const port = await setupWithTraffic();

      // Connect a peer
      const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Check /stats
      const stats = await fetchJson(port, '/stats');
      const keys = stats.keys as Record<string, Record<string, unknown>>;
      expect(keys).toBeDefined();
      expect(keys[VALID_KEY]).toBeDefined();
      expect(keys[VALID_KEY].connections).toBe(1);
    });

    it('should not include key stats when keyStore is false', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        server,
      });
      const port = await listenOnRandomPort(server);
      const stats = await fetchJson(port, '/stats');
      expect(stats.keys).toBeUndefined();
    });

    it('should track bytes on messages', async () => {
      const port = await setupWithTraffic();

      // Connect two peers on the same key
      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID_2}?key=${VALID_KEY}`));

      // Send a routed message from peer1 to peer2
      const msgPromise = nextMessage(ws2);
      ws1.send(JSON.stringify({
        from: `test:${PEER_ID}`,
        to: `test:${PEER_ID_2}`,
        payload: { hello: 'world' },
      }));
      await msgPromise;

      // Small delay for bytes to be tracked
      await new Promise(r => setTimeout(r, 50));

      // Check /stats — bytesIn should be > 0 for the key
      const stats = await fetchJson(port, '/stats');
      const keys = stats.keys as Record<string, { current: { bytesIn: number; bytesOut: number } }>;
      expect(keys[VALID_KEY].current.bytesIn).toBeGreaterThan(0);
      expect(keys[VALID_KEY].current.bytesOut).toBeGreaterThan(0);
    });

    it('should track connections per key across multiple peers', async () => {
      const port = await setupWithTraffic();

      // Connect two peers with the same key
      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID_2}?key=${VALID_KEY}`));

      let stats = await fetchJson(port, '/stats');
      let keys = stats.keys as Record<string, { connections: number }>;
      expect(keys[VALID_KEY].connections).toBe(2);

      // Disconnect one
      ws1.close();
      await new Promise(r => setTimeout(r, 50));

      stats = await fetchJson(port, '/stats');
      keys = stats.keys as Record<string, { connections: number }>;
      expect(keys[VALID_KEY].connections).toBe(1);
    });

    it('should separate traffic by key', async () => {
      const port = await setupWithTraffic();

      // Two peers, different keys
      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID_2}?key=${VALID_KEY_2}`));

      // Send a message from ws1 (key1) — not routed, just tracked as bytesIn
      ws1.send(JSON.stringify({ type: 'watch', address: `test:${PEER_ID_2}` }));
      await new Promise(r => setTimeout(r, 50));

      const stats = await fetchJson(port, '/stats');
      const keys = stats.keys as Record<string, { connections: number; current: { bytesIn: number } }>;

      // Each key should have 1 connection
      expect(keys[VALID_KEY].connections).toBe(1);
      expect(keys[VALID_KEY_2].connections).toBe(1);

      // Only key1 should have bytesIn from the watch message
      expect(keys[VALID_KEY].current.bytesIn).toBeGreaterThan(0);
      expect(keys[VALID_KEY_2].current.bytesIn).toBe(0);
    });
  });

  // ── Key Store Cleanup ───────────────────────────────────────────────

  describe('key store cleanup', () => {
    it('should call keyStore.close() on relay close', () => {
      server = createServer();
      let closed = false;
      const store: KeyStoreInterface = {
        validate: () => true,
        close: () => { closed = true; },
      };
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: store,
        server,
      });
      relay.close();
      relay = null;
      expect(closed).toBe(true);
    });
  });

  // ── Message Routing with Keys ───────────────────────────────────────

  describe('message routing with keys', () => {
    it('should route messages between peers with valid keys', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: createKeyStore([VALID_KEY]),
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID_2}?key=${VALID_KEY}`));

      const msgPromise = nextMessage(ws2);
      ws1.send(JSON.stringify({
        from: `test:${PEER_ID}`,
        to: `test:${PEER_ID_2}`,
        payload: { type: 'offer', sdp: 'test-sdp' },
      }));

      const received = await msgPromise;
      expect(received.from).toBe(`test:${PEER_ID}`);
      expect(received.to).toBe(`test:${PEER_ID_2}`);
      expect((received.payload as Record<string, unknown>).type).toBe('offer');
    });

    it('should support presence watch/unwatch with keys', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: createKeyStore([VALID_KEY]),
        server,
      });
      const port = await listenOnRandomPort(server);

      // ws1 connects and watches ws2's address (ws2 not yet connected)
      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));

      const statusPromise = nextMessage(ws1);
      ws1.send(JSON.stringify({ type: 'watch', address: `test:${PEER_ID_2}` }));

      // Should get offline status immediately
      const offlineStatus = await statusPromise;
      expect(offlineStatus.type).toBe('peer-status');
      expect((offlineStatus.payload as Record<string, unknown>).online).toBe(false);

      // Now ws2 connects — ws1 should get online status
      const onlinePromise = nextMessage(ws1);
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID_2}?key=${VALID_KEY}`));
      const onlineStatus = await onlinePromise;
      expect(onlineStatus.type).toBe('peer-status');
      expect((onlineStatus.payload as Record<string, unknown>).online).toBe(true);
    });
  });
});
