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

  // ── HTTP Endpoints ──────────────────────────────────────────────────

  describe('HTTP endpoints', () => {
    async function setupHttp(): Promise<number> {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        server,
      });
      return listenOnRandomPort(server);
    }

    it('should respond to CORS OPTIONS preflight', async () => {
      const port = await setupHttp();
      const res = await fetch(`http://localhost:${port}/health`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('should return 404 for unknown routes', async () => {
      const port = await setupHttp();
      const res = await fetch(`http://localhost:${port}/unknown`);
      expect(res.status).toBe(404);
    });

    it('should return health check', async () => {
      const port = await setupHttp();
      const data = await fetchJson(port, '/health');
      expect(data.status).toBe('ok');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should disable CORS when cors: false', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        cors: false,
        server,
      });
      const port = await listenOnRandomPort(server);
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  // ── Blob Store HTTP Routes ──────────────────────────────────────────

  describe('blob store HTTP', () => {
    async function setupBlob(): Promise<number> {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        server,
      });
      return listenOnRandomPort(server);
    }

    const BLOB_KEY = 'test-blob-key1';

    it('should PUT and GET a blob', async () => {
      const port = await setupBlob();

      const putRes = await fetch(`http://localhost:${port}/blob/${BLOB_KEY}`, {
        method: 'PUT',
        body: JSON.stringify({ sdp: 'test-offer' }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await fetchJson(port, `/blob/${BLOB_KEY}`);
      expect(getRes.data).toBe(JSON.stringify({ sdp: 'test-offer' }));
    });

    it('should return 404 for missing blob', async () => {
      const port = await setupBlob();
      const res = await fetch(`http://localhost:${port}/blob/${BLOB_KEY}`);
      expect(res.status).toBe(404);
    });

    it('should DELETE a blob', async () => {
      const port = await setupBlob();

      // Create then delete
      await fetch(`http://localhost:${port}/blob/${BLOB_KEY}`, {
        method: 'PUT',
        body: 'data',
      });
      const delRes = await fetch(`http://localhost:${port}/blob/${BLOB_KEY}`, {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);

      // Verify gone
      const getRes = await fetch(`http://localhost:${port}/blob/${BLOB_KEY}`);
      expect(getRes.status).toBe(404);
    });

    it('should return 404 when deleting non-existent blob', async () => {
      const port = await setupBlob();
      const res = await fetch(`http://localhost:${port}/blob/${BLOB_KEY}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('should return 413 when blob exceeds max size', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        blobStore: { maxBlobSize: 16 },
        server,
      });
      const port = await listenOnRandomPort(server);

      const res = await fetch(`http://localhost:${port}/blob/${BLOB_KEY}`, {
        method: 'PUT',
        body: 'x'.repeat(100),
      });
      expect(res.status).toBe(413);
    });

    it('should not expose blob routes when blobStore: false', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        blobStore: false,
        server,
      });
      const port = await listenOnRandomPort(server);

      const res = await fetch(`http://localhost:${port}/blob/${BLOB_KEY}`);
      expect(res.status).toBe(404);
    });
  });

  // ── Duplicate Peer Handling ─────────────────────────────────────────

  describe('duplicate peer handling', () => {
    it('should replace existing peer by default', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test', onDuplicate: 'replace' }],
        keyStore: false,
        server,
      });
      const port = await listenOnRandomPort(server);

      // Connect first peer
      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
      const replacedMsg = nextMessage(ws1);
      const closePromise = waitForClose(ws1);

      // Connect second peer with same ID — should replace first
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
      expect(ws2.readyState).toBe(WebSocket.OPEN);

      // First peer should get REPLACED error and be closed
      const msg = await replacedMsg;
      expect((msg.payload as Record<string, unknown>).code).toBe('REPLACED');
      const close = await closePromise;
      expect(close.code).toBe(1000);
    });

    it('should reject duplicate when onDuplicate is reject', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test', onDuplicate: 'reject' }],
        keyStore: false,
        server,
      });
      const port = await listenOnRandomPort(server);

      // Connect first peer
      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));

      // Connect second peer with same ID — should be rejected
      const ws2 = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}`));
      const msg = await nextMessage(ws2);
      expect((msg.payload as Record<string, unknown>).code).toBe('ID_IN_USE');

      // First peer should still be open
      expect(ws1.readyState).toBe(WebSocket.OPEN);
    });
  });

  // ── Message Rate Limiting ───────────────────────────────────────────

  describe('message rate limiting', () => {
    it('should rate limit messages per connection', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        rateLimitMaxMessages: 3,
        rateLimitWindow: 60000,
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));

      // Send messages up to limit + 1
      for (let i = 0; i < 4; i++) {
        ws.send(JSON.stringify({ type: 'watch', address: `test:peer-${i.toString().padStart(8, '0')}` }));
      }

      // Collect all messages — last should be a rate limit error
      const messages: Record<string, unknown>[] = [];
      await new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          messages.push(JSON.parse(data.toString()));
          // 3 peer-status responses + 1 rate limit error = 4
          if (messages.length >= 4) resolve();
        });
        setTimeout(resolve, 500);
      });

      const rateLimited = messages.find(
        m => m.type === 'error' && (m.payload as Record<string, unknown>).code === 'RATE_LIMITED'
      );
      expect(rateLimited).toBeDefined();
    });
  });

  // ── Connection Rate Limiting ────────────────────────────────────────

  describe('connection rate limiting', () => {
    it('should reject connections exceeding per-IP limit', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        rateLimitMaxConnections: 2,
        rateLimitWindow: 60000,
        server,
      });
      const port = await listenOnRandomPort(server);

      // Connect up to the limit
      const ws1 = track(await connectWs(`ws://localhost:${port}/test/peer-id-0001`));
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/peer-id-0002`));
      expect(ws1.readyState).toBe(WebSocket.OPEN);
      expect(ws2.readyState).toBe(WebSocket.OPEN);

      // Third connection should be rate limited
      const ws3 = track(new WebSocket(`ws://localhost:${port}/test/peer-id-0003`));
      const msg = await nextMessage(ws3);
      expect((msg.payload as Record<string, unknown>).code).toBe('RATE_LIMITED');
    });
  });

  // ── Spoofed From Address ────────────────────────────────────────────

  describe('spoofed from address', () => {
    it('should reject messages with mismatched from field', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
      track(await connectWs(`ws://localhost:${port}/test/${PEER_ID_2}`));

      // Send with spoofed from
      ws1.send(JSON.stringify({
        from: `test:someone-else-id`,
        to: `test:${PEER_ID_2}`,
        payload: 'spoofed',
      }));

      const msg = await nextMessage(ws1);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('INVALID_FROM');
    });
  });

  // ── Invalid URL ─────────────────────────────────────────────────────

  describe('invalid connection URL', () => {
    it('should reject connection to unknown channel', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws = track(new WebSocket(`ws://localhost:${port}/unknown/${PEER_ID}`));
      const msg = await nextMessage(ws);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('INVALID_URL');
    });
  });

  // ── Hooks ───────────────────────────────────────────────────────────

  describe('hooks', () => {
    it('should call onPeerConnect and onPeerDisconnect', async () => {
      server = createServer();
      const connected: string[] = [];
      const disconnected: string[] = [];
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        hooks: {
          onPeerConnect(peer) { connected.push(peer.address); },
          onPeerDisconnect(peer) { disconnected.push(peer.address); },
        },
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
      expect(connected).toEqual([`test:${PEER_ID}`]);

      ws.close();
      await new Promise(r => setTimeout(r, 50));
      expect(disconnected).toEqual([`test:${PEER_ID}`]);
    });

    it('should allow onRoutedMessage to block messages', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        hooks: {
          onRoutedMessage() { return false; },
        },
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID_2}`));

      // Send a routed message — should be blocked by hook
      ws1.send(JSON.stringify({
        from: `test:${PEER_ID}`,
        to: `test:${PEER_ID_2}`,
        payload: 'blocked',
      }));

      // ws2 should NOT receive the message
      await expect(nextMessage(ws2, 300)).rejects.toThrow('Timed out');
    });

    it('should allow onHttpRequest to handle custom routes', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        hooks: {
          onHttpRequest(req, res, next) {
            if (req.url === '/custom') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ custom: true }));
            } else {
              next();
            }
          },
        },
        server,
      });
      const port = await listenOnRandomPort(server);

      // Custom route handled by hook
      const custom = await fetchJson(port, '/custom');
      expect(custom.custom).toBe(true);

      // Built-in route still works (hook calls next())
      const health = await fetchJson(port, '/health');
      expect(health.status).toBe('ok');
    });

    it('should call onMessage for unrecognized JSON messages', async () => {
      server = createServer();
      const customMessages: unknown[] = [];
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        hooks: {
          onMessage(_peer, msg) {
            customMessages.push(msg);
            return true;
          },
        },
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
      ws.send(JSON.stringify({ type: 'custom-action', data: 123 }));
      await new Promise(r => setTimeout(r, 50));

      expect(customMessages).toHaveLength(1);
      expect((customMessages[0] as Record<string, unknown>).type).toBe('custom-action');
    });
  });

  // ── Peer Offline Notification ───────────────────────────────────────

  describe('peer offline notification', () => {
    it('should notify watchers when a peer disconnects', async () => {
      server = createServer();
      relay = createRelay({
        channels: [{ name: 'test' }],
        keyStore: false,
        server,
      });
      const port = await listenOnRandomPort(server);

      const ws1 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
      const ws2 = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID_2}`));

      // ws1 watches ws2
      ws1.send(JSON.stringify({ type: 'watch', address: `test:${PEER_ID_2}` }));
      await nextMessage(ws1); // consume online status

      // ws2 disconnects — ws1 should get offline notification
      const offlinePromise = nextMessage(ws1);
      ws2.close();
      const offline = await offlinePromise;
      expect(offline.type).toBe('peer-status');
      expect((offline.payload as Record<string, unknown>).online).toBe(false);
    });
  });
});
