# @sumicom/ws-relay

A minimal WebSocket relay server for peer-to-peer communication behind NAT/firewalls. Handles signaling, presence, and blob exchange so your clients can find each other and negotiate direct connections.

Extracted from [Quicksave](https://github.com/KingYoung-Sumicom/quicksave) — a remote git-control PWA with E2E encryption — into a standalone package for reuse across console and mobile applications.

## Features

- **Channel-based routing** — peers connect to named channels (`/pwa`, `/agent`, etc.) and message each other by address
- **Presence watching** — subscribe to peer online/offline status in real time
- **Blob store** — lightweight HTTP key-value store for exchanging signaling data (SDP offers, etc.)
- **Access keys** — app-level authentication with built-in env and file-based key stores
- **Traffic metering** — per-key windowed byte stats via `/stats` for external monitoring
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
import { createRelay, EnvKeyStore } from '@sumicom/ws-relay';

const relay = createRelay({
  port: 8080,
  channels: [
    { name: 'pwa', onDuplicate: 'replace' },
    { name: 'agent' },
  ],
  keyStore: new EnvKeyStore('RELAY_ACCESS_KEYS'),
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

const client = new RelayClient({
  url: 'ws://localhost:8080',
  channel: 'pwa',
  id: 'my-peer-id',
  key: 'my-access-key',
});
client.connect();

client.on('open', () => {
  client.send('pwa:other-peer', { type: 'hello' });
});

client.on('message', (from, payload) => {
  console.log(`From ${from}:`, payload);
});

client.on('peer-status', (address, online) => {
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
  keyStore: new EnvKeyStore('KEYS'),   // required: KeyStoreInterface | false
  channels: [                          // required, at least one
    {
      name: 'pwa',
      onDuplicate: 'replace',          // 'reject' | 'replace' (default)
      parseId: (raw) => raw || null,   // custom ID validation
    },
  ],
  onInvalidKey: 'close-after-connect', // or 'reject-upgrade'
  heartbeatInterval: 30000,            // ping interval in ms
  rateLimitWindow: 60000,              // rate limit window in ms
  rateLimitMaxConnections: 10,         // max connections per IP per window
  rateLimitMaxMessages: 100,           // max messages per connection per window
  statsWindow: 3600000,               // traffic stats window (default: 1 hour)
  statsHistory: 24,                    // historical windows to keep (default: 24)
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

## Access Keys

`keyStore` is **required**. Omitting it throws an error, forcing a conscious decision.

### Open access (no key validation)

```typescript
createRelay({ channels: [...], keyStore: false });
```

### EnvKeyStore

Reads keys from an environment variable (comma-separated).

```bash
export RELAY_ACCESS_KEYS="key-abc-123,key-xyz-456"
```

```typescript
import { createRelay, EnvKeyStore } from '@sumicom/ws-relay';

createRelay({
  channels: [{ name: 'pwa' }],
  keyStore: new EnvKeyStore('RELAY_ACCESS_KEYS'),
});
```

### FileKeyStore

Reads keys from a text file, one per line. Supports hot reload.

```
# keys.txt
key-abc-123
key-xyz-456
```

```typescript
import { createRelay, FileKeyStore } from '@sumicom/ws-relay';

createRelay({
  channels: [{ name: 'pwa' }],
  keyStore: new FileKeyStore('./keys.txt'),          // watch: true (default)
  // keyStore: new FileKeyStore('./keys.txt', { watch: false }),
});
```

Add/remove keys by editing the file — changes take effect immediately without restart. Call `store.reload()` to trigger a manual reload.

### Custom key store

Implement `KeyStoreInterface`:

```typescript
import type { KeyStoreInterface } from '@sumicom/ws-relay';

const myStore: KeyStoreInterface = {
  validate(key) { return myDb.hasKey(key); },
  close() { myDb.disconnect(); },  // optional
};
```

### Key format

Keys must match `/^[a-zA-Z0-9_-]{8,64}$/` — same rules as peer IDs.

### Client usage

```typescript
const client = new RelayClient({
  url: 'ws://localhost:8080',
  channel: 'pwa',
  id: 'my-peer-id',
  key: 'my-access-key',  // appended as ?key=... to the WebSocket URL
});
```

## Traffic Metering

When `keyStore` is enabled, the relay tracks per-key traffic in time windows. `GET /stats` includes:

```json
{
  "keys": {
    "key-abc-123": {
      "connections": 3,
      "current": { "bytesIn": 12800, "bytesOut": 11520, "windowStart": 1709712000000 },
      "history": [
        { "bytesIn": 102400, "bytesOut": 98304, "windowStart": 1709708400000 }
      ]
    }
  }
}
```

Configure with `statsWindow` (default: 1 hour) and `statsHistory` (default: 24 windows). Use external monitoring tools to poll `/stats` and set alerting rules.

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
