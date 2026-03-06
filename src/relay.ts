import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { RateLimiter } from './rateLimiter.js';
import { PeerRegistry } from './registry.js';
import { BlobStore } from './blobStore.js';
import { parsePeerUrl, sendMessage, isValidKeyFormat, parseQueryKey } from './utils.js';
import { TrafficMeter } from './trafficMeter.js';
import type {
  RelayConfig,
  RelayInstance,
  ExtendedWebSocket,
  Peer,
  BlobStoreInterface,
  BlobStoreConfig,
  ChannelConfig,
  KeyStoreInterface,
} from './types.js';

declare const VERSION: string;

const DEFAULTS = {
  port: 8080,
  heartbeatInterval: 30000,
  rateLimitWindow: 60000,
  rateLimitMaxConnections: 10,
  rateLimitMaxMessages: 100,
} as const;

function isBlobStoreConfig(val: unknown): val is BlobStoreConfig {
  return typeof val === 'object' && val !== null && !('get' in val);
}

export function createRelay(config: RelayConfig): RelayInstance {
  // ── Key Store (required) ──────────────────────────────────────────
  if (config.keyStore === undefined) {
    throw new Error(
      'keyStore is required. Provide a KeyStoreInterface to enable access key validation, ' +
      'or set keyStore: false to explicitly allow open access.'
    );
  }
  const keyStore: KeyStoreInterface | false = config.keyStore;
  const onInvalidKey = config.onInvalidKey ?? 'close-after-connect';

  const port = config.port ?? DEFAULTS.port;
  const heartbeatInterval = config.heartbeatInterval ?? DEFAULTS.heartbeatInterval;
  const rateLimitWindow = config.rateLimitWindow ?? DEFAULTS.rateLimitWindow;
  const rateLimitMaxConnections = config.rateLimitMaxConnections ?? DEFAULTS.rateLimitMaxConnections;
  const rateLimitMaxMessages = config.rateLimitMaxMessages ?? DEFAULTS.rateLimitMaxMessages;
  const corsOrigin = config.cors === false ? null : (config.cors === true || config.cors === undefined ? '*' : config.cors);

  // ── Traffic Meter ─────────────────────────────────────────────────
  const statsWindow = config.statsWindow ?? 3600000;
  const statsHistory = config.statsHistory ?? 24;
  const trafficMeter = keyStore ? new TrafficMeter(statsWindow, statsHistory) : null;

  const registry = new PeerRegistry();
  const rateLimiter = new RateLimiter(rateLimitWindow, rateLimitMaxConnections);
  const hooks = config.hooks ?? {};

  // Sort channels by name length descending so longer prefixes match first
  // e.g., "pwa/key" matches before "pwa"
  const channels: ChannelConfig[] = [...config.channels].sort(
    (a, b) => b.name.length - a.name.length
  );

  // ── Blob Store ──────────────────────────────────────────────────────
  let blobStore: BlobStoreInterface | null = null;
  let blobRoutePrefix = '/blob';

  if (config.blobStore !== false) {
    if (config.blobStore && !isBlobStoreConfig(config.blobStore)) {
      // Custom BlobStore implementation provided
      blobStore = config.blobStore;
    } else {
      const blobConfig = (isBlobStoreConfig(config.blobStore) ? config.blobStore : {}) as BlobStoreConfig;
      blobStore = new BlobStore(blobConfig);
      if (blobConfig.routePrefix) {
        blobRoutePrefix = blobConfig.routePrefix;
      }
    }
  }

  // ── CORS ────────────────────────────────────────────────────────────
  const setCorsHeaders = (res: ServerResponse) => {
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  };

  // ── HTTP Server ─────────────────────────────────────────────────────
  const handleHttpRequest = (req: IncomingMessage, res: ServerResponse) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Hook: let consumers handle custom routes first
    if (hooks.onHttpRequest) {
      let passedThrough = false;
      hooks.onHttpRequest(req, res, () => { passedThrough = true; });
      if (!passedThrough) return;
    }

    // Health check
    if (req.url === '/health') {
      const stats = registry.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        connections: stats.channels,
        uptime: stats.uptime,
      }));
      return;
    }

    // Stats
    if (req.url === '/stats') {
      const stats = registry.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const response: Record<string, unknown> = { ...stats };
      if (blobStore) {
        response.blobStore = blobStore.stats;
      }
      if (trafficMeter) {
        response.keys = trafficMeter.getStats();
      }
      res.end(JSON.stringify(response));
      return;
    }

    // Blob store routes
    if (blobStore) {
      const keyPattern = `^${blobRoutePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([a-zA-Z0-9_-]{8,64})$`;
      const blobMatch = req.url?.match(new RegExp(keyPattern));
      if (blobMatch) {
        const key = blobMatch[1];

        if (req.method === 'GET') {
          const data = blobStore.get(key);
          if (data === null) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data }));
          }
          return;
        }

        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            try {
              blobStore!.put(key, body);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              if (message.includes('exceeds max size')) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
              } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
              }
              res.end(JSON.stringify({ error: message }));
            }
          });
          return;
        }

        if (req.method === 'DELETE') {
          const deleted = blobStore.delete(key);
          res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: deleted }));
          return;
        }
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  };

  const server = config.server ?? createServer();
  server.on('request', handleHttpRequest);

  const wss = new WebSocketServer({ server });

  // ── WebSocket Connection Handling ───────────────────────────────────
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const extWs = ws as ExtendedWebSocket;

    // Get client IP (respect X-Forwarded-For)
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim()
      || req.socket.remoteAddress
      || 'unknown';

    // Rate limit
    if (!rateLimiter.checkConnection(ip)) {
      sendMessage(extWs, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many connections' } });
      ws.close(1008, 'Rate limited');
      return;
    }

    // Key validation
    let validatedKey: string | undefined;
    if (keyStore) {
      const rawKey = parseQueryKey(req.url || '');
      if (!rawKey || !isValidKeyFormat(rawKey)) {
        sendMessage(extWs, { type: 'error', payload: { code: 'INVALID_KEY', message: 'Missing or invalid access key' } });
        ws.close(1008, 'Invalid key');
        return;
      }
      const valid = await keyStore.validate(rawKey);
      if (!valid) {
        sendMessage(extWs, { type: 'error', payload: { code: 'INVALID_KEY', message: 'Access key rejected' } });
        ws.close(1008, 'Invalid key');
        return;
      }
      validatedKey = rawKey;
    }

    // Parse URL against configured channels
    const parsed = parsePeerUrl(channels, req.url || '');
    if (!parsed) {
      sendMessage(extWs, { type: 'error', payload: { code: 'INVALID_URL', message: 'Invalid connection URL' } });
      ws.close(1002, 'Invalid URL');
      return;
    }

    // Check for duplicate
    const channelConfig = channels.find(c => c.name === parsed.channel);
    const onDuplicate = channelConfig?.onDuplicate ?? 'replace';
    const existing = registry.get(parsed.channel, parsed.id);

    if (existing) {
      if (onDuplicate === 'reject') {
        sendMessage(extWs, { type: 'error', payload: { code: 'ID_IN_USE', message: 'ID already connected on this channel' } });
        ws.close(1008, 'ID in use');
        return;
      }
      // Replace: close the old connection
      if (existing.ws.readyState === WebSocket.OPEN) {
        sendMessage(existing.ws, { type: 'error', payload: { code: 'REPLACED', message: 'Replaced by new connection' } });
        existing.ws.close(1000, 'Replaced');
      }
      registry.remove(existing);
    }

    // Create and register peer
    const peer: Peer = {
      ws,
      channel: parsed.channel,
      id: parsed.id,
      address: `${parsed.channel}:${parsed.id}`,
      ip,
      connectedAt: Date.now(),
      key: validatedKey,
      bytesIn: 0,
      bytesOut: 0,
    };

    if (trafficMeter && validatedKey) {
      trafficMeter.addConnection(validatedKey);
    }

    extWs.isAlive = true;
    extWs.peer = peer;
    extWs.messageCount = 0;
    extWs.lastMessageReset = Date.now();

    registry.add(peer);

    // Notify watchers that this peer came online
    const watchers = registry.getWatchers(peer.address);
    for (const watcherAddr of watchers) {
      const watcher = registry.getByAddress(watcherAddr);
      if (watcher && watcher.ws.readyState === WebSocket.OPEN) {
        sendMessage(watcher.ws, { type: 'peer-status', payload: { address: peer.address, online: true } });
      }
    }

    // Hook
    hooks.onPeerConnect?.(peer, registry);

    // ── Message Handling ────────────────────────────────────────────
    ws.on('message', (data: Buffer) => {
      // Per-connection message rate limiting
      const now = Date.now();
      if (now - extWs.lastMessageReset > rateLimitWindow) {
        extWs.messageCount = 0;
        extWs.lastMessageReset = now;
      }
      extWs.messageCount++;

      // Track bytes in
      const messageBytes = data.byteLength;
      peer.bytesIn += messageBytes;
      if (trafficMeter && peer.key) {
        trafficMeter.recordIn(peer.key, messageBytes);
      }

      if (extWs.messageCount > rateLimitMaxMessages) {
        sendMessage(extWs, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many messages' } });
        return;
      }

      // Try to parse as JSON
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        // Not JSON — let hooks or legacy relay handle it
      }

      if (msg && typeof msg === 'object') {
        // Built-in: presence watch
        if (msg.type === 'watch' && typeof msg.address === 'string') {
          registry.watch(msg.address, peer.address);
          const watched = registry.getByAddress(msg.address);
          sendMessage(ws, { type: 'peer-status', payload: { address: msg.address, online: !!watched } });
          return;
        }

        // Built-in: presence unwatch
        if (msg.type === 'unwatch' && typeof msg.address === 'string') {
          registry.unwatch(msg.address, peer.address);
          return;
        }

        // Routed message: { from, to, ... }
        if (typeof msg.from === 'string' && typeof msg.to === 'string') {
          // Validate 'from' matches sender's address
          if (msg.from !== peer.address) {
            sendMessage(ws, { type: 'error', payload: { code: 'INVALID_FROM', message: 'From field does not match sender identity' } });
            return;
          }

          const target = registry.getByAddress(msg.to);
          if (target && target.ws.readyState === WebSocket.OPEN) {
            // Hook
            const targetPeer = target;
            if (hooks.onRoutedMessage) {
              const result = hooks.onRoutedMessage(peer, targetPeer, msg, data);
              if (result === false) return;
            }
            target.ws.send(data);
            // Track bytes out on the target peer
            const targetExt = target.ws as ExtendedWebSocket;
            if (targetExt.peer) {
              const outBytes = (data as Buffer).byteLength;
              targetExt.peer.bytesOut += outBytes;
              if (trafficMeter && targetExt.peer.key) {
                trafficMeter.recordOut(targetExt.peer.key, outBytes);
              }
            }
            registry.incrementMessagesRelayed();
          }
          return;
        }

        // Hook: custom message handling
        if (hooks.onMessage) {
          const handled = hooks.onMessage(peer, msg, data, registry);
          if (handled) return;
        }
      }

      // Fallback: if hook didn't handle, message is dropped silently
      // (consumers can add legacy relay via onMessage hook)
    });

    // ── Heartbeat ───────────────────────────────────────────────────
    ws.on('pong', () => {
      extWs.isAlive = true;
    });

    // ── Disconnect ──────────────────────────────────────────────────
    ws.on('close', () => {
      // Notify watchers that this peer went offline
      const peerWatchers = registry.getWatchers(peer.address);
      for (const watcherAddr of peerWatchers) {
        const watcher = registry.getByAddress(watcherAddr);
        if (watcher && watcher.ws.readyState === WebSocket.OPEN) {
          sendMessage(watcher.ws, { type: 'peer-status', payload: { address: peer.address, online: false } });
        }
      }

      // Track traffic meter disconnect
      if (trafficMeter && peer.key) {
        trafficMeter.removeConnection(peer.key);
      }

      // Clean up watches this peer had
      registry.removeAllWatchesFor(peer.address);

      // Hook (before removal)
      hooks.onPeerDisconnect?.(peer, registry);

      registry.remove(peer);
    });

    ws.on('error', (error) => {
      console.error(`[ws-relay] WebSocket error for ${peer.address}:`, error.message);
    });
  });

  // ── Heartbeat Interval ──────────────────────────────────────────────
  const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;
      if (!extWs.isAlive) {
        return ws.terminate();
      }
      extWs.isAlive = false;
      ws.ping();
    });
  }, heartbeatInterval);

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
  });

  // ── Start Listening ─────────────────────────────────────────────────
  if (!config.server) {
    server.listen(port, () => {
      const v = typeof VERSION !== 'undefined' ? ` v${VERSION}` : '';
      console.log(`ws-relay${v} listening on port ${port}`);
      console.log(`  Health: http://localhost:${port}/health`);
      console.log(`  Channels: ${channels.map(c => `/${c.name}/{id}`).join(', ')}`);
    });
  }

  // ── Graceful Shutdown ───────────────────────────────────────────────
  const close = () => {
    wss.close();
    if (!config.server) {
      server.close();
    }
    if (keyStore && keyStore.close) {
      keyStore.close();
    }
  };

  return { server, wss, registry, blobStore, close };
}
