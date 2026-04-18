import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { createRelay } from './relay.js';
import type {
  RelayInstance,
  KeyStoreInterface,
  VerifyPeerContext,
  VerifyPeerResult,
  Peer,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function createKeyStore(keys: string[]): KeyStoreInterface {
  const set = new Set(keys);
  return { validate: (key: string) => set.has(key) };
}

function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

const VALID_KEY = 'test-key-12345';
const PEER_ID = 'peer-id-abcd';

describe('verifyPeer hook', () => {
  let relay: RelayInstance | null = null;
  let server: Server | null = null;
  const openSockets: WebSocket[] = [];

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets.length = 0;
    if (relay) {
      relay.close();
      relay = null;
    }
    if (server) {
      server.close();
      server = null;
    }
  });

  function track(ws: WebSocket): WebSocket {
    openSockets.push(ws);
    return ws;
  }

  it('allows connection when verifyPeer returns {ok: true}', async () => {
    server = createServer();
    const onPeerConnect = vi.fn();
    relay = createRelay({
      channels: [{ name: 'test' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: {
        verifyPeer: () => ({ ok: true }),
        onPeerConnect,
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    // Give the event loop a tick for the onPeerConnect callback to fire.
    await new Promise(r => setTimeout(r, 20));
    expect(onPeerConnect).toHaveBeenCalledTimes(1);
  });

  it('sync reject: closes ws, sends error frame, does not register', async () => {
    server = createServer();
    const onPeerConnect = vi.fn();
    relay = createRelay({
      channels: [{ name: 'test' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: {
        verifyPeer: () => ({ ok: false, reason: 'bad sig', closeCode: 4001, errorCode: 'BAD_SIG' }),
        onPeerConnect,
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    const ws = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    expect((msg.payload as Record<string, unknown>).code).toBe('BAD_SIG');
    expect((msg.payload as Record<string, unknown>).message).toBe('bad sig');

    const close = await waitForClose(ws);
    expect(close.code).toBe(4001);
    expect(close.reason).toBe('bad sig');

    // Registry must not contain the peer
    expect(relay.registry.has('test', PEER_ID)).toBe(false);
    expect(onPeerConnect).not.toHaveBeenCalled();
  });

  it('sync reject: uses defaults when reason/closeCode/errorCode omitted', async () => {
    server = createServer();
    relay = createRelay({
      channels: [{ name: 'test' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: { verifyPeer: () => ({ ok: false }) },
      server,
    });
    const port = await listenOnRandomPort(server);

    const ws = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    const msg = await nextMessage(ws);
    expect((msg.payload as Record<string, unknown>).code).toBe('VERIFY_FAILED');
    const close = await waitForClose(ws);
    expect(close.code).toBe(1008);
  });

  it('async reject works the same', async () => {
    server = createServer();
    relay = createRelay({
      channels: [{ name: 'test' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: {
        verifyPeer: async (): Promise<VerifyPeerResult> => {
          await new Promise(r => setTimeout(r, 5));
          return { ok: false, reason: 'async nope' };
        },
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    const ws = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    const msg = await nextMessage(ws);
    expect((msg.payload as Record<string, unknown>).code).toBe('VERIFY_FAILED');
    const close = await waitForClose(ws);
    expect(close.code).toBe(1008);
    expect(close.reason).toBe('async nope');
    expect(relay.registry.has('test', PEER_ID)).toBe(false);
  });

  it('thrown error closes with 1011 and logs', async () => {
    server = createServer();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    relay = createRelay({
      channels: [{ name: 'test' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: {
        verifyPeer: () => {
          throw new Error('boom');
        },
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    const ws = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    const close = await waitForClose(ws);
    expect(close.code).toBe(1011);
    expect(relay.registry.has('test', PEER_ID)).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('critical invariant: verifyPeer reject does NOT evict existing peer under onDuplicate: replace', async () => {
    server = createServer();
    // Let the first peer in, then start rejecting
    let acceptNext = true;
    relay = createRelay({
      channels: [{ name: 'test', onDuplicate: 'replace' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: {
        verifyPeer: () => (acceptNext ? { ok: true } : { ok: false, reason: 'evict attempt' }),
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    // Legit peer connects
    const legit = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    expect(relay.registry.has('test', PEER_ID)).toBe(true);

    // Attacker tries to re-use the same id; verify rejects
    acceptNext = false;
    const attacker = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    const attackerClose = await waitForClose(attacker);
    expect(attackerClose.code).toBe(1008);

    // Legit peer must still be connected and registered
    await new Promise(r => setTimeout(r, 30));
    expect(legit.readyState).toBe(WebSocket.OPEN);
    expect(relay.registry.has('test', PEER_ID)).toBe(true);
  });

  it('critical invariant: verifyPeer reject does NOT touch existing peer under onDuplicate: reject', async () => {
    server = createServer();
    let acceptNext = true;
    relay = createRelay({
      channels: [{ name: 'test', onDuplicate: 'reject' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: {
        verifyPeer: () => (acceptNext ? { ok: true } : { ok: false, reason: 'verify nope', errorCode: 'BAD_SIG' }),
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    const legit = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    expect(relay.registry.has('test', PEER_ID)).toBe(true);

    acceptNext = false;
    const attacker = track(new WebSocket(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    const msg = await nextMessage(attacker);
    // Must be verify failure, NOT ID_IN_USE — verify runs before duplicate check
    expect((msg.payload as Record<string, unknown>).code).toBe('BAD_SIG');

    await new Promise(r => setTimeout(r, 30));
    expect(legit.readyState).toBe(WebSocket.OPEN);
    expect(relay.registry.has('test', PEER_ID)).toBe(true);
  });

  it('absent hook: behavior is unchanged (0.1.1 compat)', async () => {
    server = createServer();
    relay = createRelay({
      channels: [{ name: 'test' }],
      keyStore: createKeyStore([VALID_KEY]),
      server,
    });
    const port = await listenOnRandomPort(server);

    const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(relay.registry.has('test', PEER_ID)).toBe(true);
  });

  it('ctx contains parsed/req/ip/key/registry', async () => {
    server = createServer();
    let captured: VerifyPeerContext | null = null;
    relay = createRelay({
      channels: [{ name: 'test' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: {
        verifyPeer: (ctx) => {
          captured = ctx;
          return { ok: true };
        },
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    expect(captured).not.toBeNull();
    const ctx = captured as unknown as VerifyPeerContext;
    expect(ctx.parsed).toEqual({ channel: 'test', id: PEER_ID });
    expect(ctx.key).toBe(VALID_KEY);
    expect(ctx.ip).toBeTruthy();
    expect(ctx.req.url).toContain(PEER_ID);
    expect(typeof ctx.registry.has).toBe('function');
  });

  it('ctx.key is undefined when keyStore is disabled', async () => {
    server = createServer();
    let captured: VerifyPeerContext | null = null;
    relay = createRelay({
      channels: [{ name: 'test' }],
      keyStore: false,
      hooks: {
        verifyPeer: (ctx) => {
          captured = ctx;
          return { ok: true };
        },
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    const ws = track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}`));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const ctx = captured as unknown as VerifyPeerContext;
    expect(ctx.key).toBeUndefined();
  });

  it('verifyPeer can see existing peers via registry', async () => {
    server = createServer();
    const seen: Peer[] = [];
    relay = createRelay({
      channels: [{ name: 'test', onDuplicate: 'replace' }],
      keyStore: createKeyStore([VALID_KEY]),
      hooks: {
        verifyPeer: (ctx) => {
          const existing = ctx.registry.get(ctx.parsed.channel, ctx.parsed.id);
          if (existing) seen.push(existing);
          return { ok: true };
        },
      },
      server,
    });
    const port = await listenOnRandomPort(server);

    track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));
    // Second connection: verifyPeer sees the existing peer before replacement
    track(await connectWs(`ws://localhost:${port}/test/${PEER_ID}?key=${VALID_KEY}`));

    expect(seen.length).toBe(1);
    expect(seen[0].address).toBe(`test:${PEER_ID}`);
  });
});
