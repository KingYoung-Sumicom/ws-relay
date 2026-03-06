# @sumicom/ws-relay

A minimal WebSocket relay server for peer-to-peer communication behind NAT/firewalls. Handles signaling, presence, and blob exchange so your clients can find each other and negotiate direct connections.

Extracted from [Quicksave](https://github.com/nicosalm/quicksave) — a remote git-control PWA with E2E encryption — into a standalone package for reuse across console and mobile applications.

## Features

- **Channel-based routing** — peers connect to named channels (`/pwa`, `/agent`, etc.) and message each other by address
- **Presence watching** — subscribe to peer online/offline status in real time
- **Blob store** — lightweight HTTP key-value store for exchanging signaling data (SDP offers, etc.)
- **Rate limiting** — per-IP connection limits and per-connection message limits
- **Lifecycle hooks** — intercept connections, messages, and HTTP requests without modifying core code
- **Client library** — isomorphic `RelayClient` with auto-reconnect, typed events, and presence API
- **Minimal footprint** — single runtime dependency (`ws`)

## Install

```bash
npm install @sumicom/ws-relay
```

Requires Node.js >= 18.

## Quick Start

### Server

```typescript
import { createRelay } from '@sumicom/ws-relay';

const relay = createRelay({
  port: 8080,
  channels: [
    { name: 'pwa', onDuplicate: 'replace' },
    { name: 'agent' },
  ],
  hooks: {
    onPeerConnect(peer) {
      console.log(`${peer.address} connected from ${peer.ip}`);
    },
  },
});
```

### Client

```typescript
import { RelayClient } from '@sumicom/ws-relay/client';

const client = new RelayClient('ws://localhost:8080/pwa/my-peer-id');

client.on('open', () => {
  client.send('pwa:other-peer', { type: 'hello' });
});

client.on('message', (msg) => {
  console.log(`From ${msg.from}:`, msg.payload);
});

client.on('peer-status', ({ address, online }) => {
  console.log(`${address} is now ${online ? 'online' : 'offline'}`);
});
```

## Protocol

### Connection

Peers connect via WebSocket URL: `ws://host/{channel}/{id}`

- **channel** — a configured channel name (e.g. `pwa`, `agent`)
- **id** — a peer identifier (8–64 alphanumeric characters by default, customizable via `parseId`)

### Messages

All messages are JSON. The relay understands these types:

**Routed message** (peer-to-peer):
```json
{ "from": "pwa:alice", "to": "pwa:bob", "payload": { "type": "offer", "sdp": "..." } }
```

**Watch / unwatch** (presence):
```json
{ "type": "watch", "address": "pwa:bob" }
{ "type": "unwatch", "address": "pwa:bob" }
```

**Peer status** (server push):
```json
{ "type": "peer-status", "payload": { "address": "pwa:bob", "online": true } }
```

**Error** (server push):
```json
{ "type": "error", "payload": { "code": "RATE_LIMITED", "message": "..." } }
```

### Blob HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/blob/{key}` | Store a blob (max 8KB default) |
| `GET` | `/blob/{key}` | Retrieve a blob |
| `DELETE` | `/blob/{key}` | Delete a blob |

### Health & Stats

- `GET /health` — uptime, connection count
- `GET /stats` — detailed per-channel stats, blob store stats

## Configuration

```typescript
createRelay({
  port: 8080,                          // default: 8080
  channels: [                          // required, at least one
    {
      name: 'pwa',
      onDuplicate: 'replace',          // 'reject' | 'replace' (default)
      parseId: (raw) => raw || null,   // custom ID validation
    },
  ],
  heartbeatInterval: 30000,            // ping interval in ms
  rateLimitWindow: 60000,              // rate limit window in ms
  rateLimitMaxConnections: 10,         // max connections per IP per window
  rateLimitMaxMessages: 100,           // max messages per connection per window
  cors: true,                          // true | false | origin string
  server: existingHttpServer,          // attach to existing server
  blobStore: { maxSize: 8192 },        // configure, or `false` to disable
  hooks: { /* see below */ },
});
```

### Hooks

```typescript
hooks: {
  onPeerConnect(peer, registry) { },
  onPeerDisconnect(peer, registry) { },
  onMessage(peer, msg, raw, registry) { },
  onRoutedMessage(from, to, msg, raw) {
    // return false to block the message
  },
  onHttpRequest(req, res, next) {
    // call next() to pass through
  },
}
```

## Development

```bash
npm install
npm run dev          # watch mode
npm test             # run tests
npm run typecheck    # type check only
npm run build        # compile + bundle
npm start            # run bundled server
```

## License

MIT
