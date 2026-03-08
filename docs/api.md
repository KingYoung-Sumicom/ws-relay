# API Reference

> **Package:** `@sumicom/ws-relay` · **Version:** 0.1.0 · **License:** MIT

## Table of Contents

- [Server API](#server-api)
  - [createRelay(config)](#createrelayconfig)
  - [RelayConfig](#relayconfig)
  - [RelayInstance](#relayinstance)
- [Channels](#channels)
  - [ChannelConfig](#channelconfig)
- [Hooks](#hooks)
  - [RelayHooks](#relayhooks)
- [Access Keys](#access-keys)
  - [KeyStoreInterface](#keystoreinterface)
  - [EnvKeyStore](#envkeystore)
  - [FileKeyStore](#filekeystore)
  - [KEY_FORMAT](#key_format)
- [Blob Store](#blob-store)
  - [BlobStoreConfig](#blobstoreconfig)
  - [BlobStoreInterface](#blobstoreinterface)
- [Traffic Metering](#traffic-metering)
  - [TrafficMeter](#trafficmeter)
  - [KeyWindowStats](#keywindowstats)
- [Client API](#client-api)
  - [RelayClient](#relayclient)
  - [RelayClientConfig](#relayclientconfig)
  - [RelayClientEvents](#relayclientevents)
- [Peer Types](#peer-types)
  - [Peer](#peer)
  - [PeerAddress](#peeraddress)
  - [PeerRegistryInterface](#peerregistryinterface)
  - [RegistryStats](#registrystats)
- [HTTP Endpoints](#http-endpoints)
- [WebSocket Protocol](#websocket-protocol)
- [Utility Functions](#utility-functions)
- [Examples](#examples)

---

## Server API

### `createRelay(config)`

Creates and starts a WebSocket relay server.

```typescript
import { createRelay } from '@sumicom/ws-relay';

const relay = createRelay({
  port: 8080,
  channels: [{ name: 'pwa' }],
  keyStore: false,
});
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `config` | [`RelayConfig`](#relayconfig) | Server configuration object |

**Returns:** [`RelayInstance`](#relayinstance)

**Throws:** `Error` if `keyStore` is omitted (must be explicitly set to `false` or a `KeyStoreInterface`).

---

### `RelayConfig`

```typescript
interface RelayConfig {
  port?: number;
  channels: ChannelConfig[];
  hooks?: RelayHooks;
  blobStore?: BlobStoreConfig | BlobStoreInterface | false;
  heartbeatInterval?: number;
  rateLimitWindow?: number;
  rateLimitMaxConnections?: number;
  rateLimitMaxMessages?: number;
  cors?: boolean | string;
  server?: http.Server;
  keyStore: KeyStoreInterface | false;
  onInvalidKey?: 'reject-upgrade' | 'close-after-connect';
  statsWindow?: number;
  statsHistory?: number;
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `port` | `number` | `8080` | Port to listen on. Ignored when `server` is provided. |
| `channels` | `ChannelConfig[]` | — | **Required.** At least one channel definition. |
| `keyStore` | `KeyStoreInterface \| false` | — | **Required.** Access key validator, or `false` for open access. Omitting throws. |
| `hooks` | `RelayHooks` | `{}` | Lifecycle hooks for extending behavior. |
| `blobStore` | `BlobStoreConfig \| BlobStoreInterface \| false` | enabled | Blob store config, custom implementation, or `false` to disable. |
| `heartbeatInterval` | `number` | `30000` | WebSocket ping interval in ms. |
| `rateLimitWindow` | `number` | `60000` | Rate limiting time window in ms. |
| `rateLimitMaxConnections` | `number` | `10` | Max new connections per IP per window. |
| `rateLimitMaxMessages` | `number` | `100` | Max messages per connection per window. |
| `cors` | `boolean \| string` | `true` | `true` = `*`, string = specific origin, `false` = disabled. |
| `server` | `http.Server` | — | Attach to an existing HTTP server instead of creating one. |
| `onInvalidKey` | `string` | `'close-after-connect'` | `'reject-upgrade'`: reject at HTTP upgrade. `'close-after-connect'`: accept WS, then close with error. |
| `statsWindow` | `number` | `3600000` | Traffic stats window size in ms (1 hour). |
| `statsHistory` | `number` | `24` | Number of historical windows to retain. |

---

### `RelayInstance`

Returned by `createRelay()`. Provides access to the running server components.

```typescript
interface RelayInstance {
  server: http.Server;
  wss: WebSocketServer;
  registry: PeerRegistryInterface;
  blobStore: BlobStoreInterface | null;
  close(): void;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `server` | `http.Server` | The underlying HTTP server. |
| `wss` | `WebSocketServer` | The `ws` WebSocket server instance. |
| `registry` | `PeerRegistryInterface` | Peer registry for querying connected peers. |
| `blobStore` | `BlobStoreInterface \| null` | Blob store instance, or `null` if disabled. |
| `close()` | `() => void` | Gracefully shuts down WebSocket server, HTTP server (if created internally), and key store. |

---

## Channels

### `ChannelConfig`

Defines a named channel that peers connect to via `ws://host/{name}/{id}`.

```typescript
interface ChannelConfig {
  name: string;
  parseId?: (raw: string) => string | null;
  onDuplicate?: 'reject' | 'replace';
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | — | **Required.** Channel name, used as the URL path segment. May contain `/` for nested paths (e.g. `'pwa/key'`). |
| `parseId` | `(raw: string) => string \| null` | Default validator | Custom ID parser. Receives the raw URL segment. Return parsed ID or `null` to reject. Default accepts 8–64 alphanumeric chars plus `-` and `_`. |
| `onDuplicate` | `'reject' \| 'replace'` | `'replace'` | Behavior when a peer ID is already in use. `'reject'` closes the new connection. `'replace'` closes the old connection. |

---

## Hooks

### `RelayHooks`

All hooks are optional. They allow intercepting connections, messages, and HTTP requests without modifying core relay code.

```typescript
interface RelayHooks {
  onPeerConnect?(peer: Peer, registry: PeerRegistryInterface): void;
  onPeerDisconnect?(peer: Peer, registry: PeerRegistryInterface): void;
  onMessage?(peer: Peer, msg: unknown, raw: Buffer, registry: PeerRegistryInterface): boolean | void;
  onRoutedMessage?(from: Peer, to: Peer, msg: unknown, raw: Buffer): boolean | void;
  onHttpRequest?(req: IncomingMessage, res: ServerResponse, next: () => void): void;
}
```

#### `onPeerConnect(peer, registry)`

Called after a peer is registered in the channel.

| Param | Type | Description |
|-------|------|-------------|
| `peer` | `Peer` | The newly connected peer. |
| `registry` | `PeerRegistryInterface` | Peer registry for querying other peers. |

#### `onPeerDisconnect(peer, registry)`

Called before a peer is removed from the registry (on WebSocket close).

| Param | Type | Description |
|-------|------|-------------|
| `peer` | `Peer` | The disconnecting peer. |
| `registry` | `PeerRegistryInterface` | Peer registry. |

#### `onMessage(peer, msg, raw, registry)`

Called when a parsed JSON message has no `{from, to}` routing fields and is not a built-in protocol message (`watch`/`unwatch`). Use this for custom message handling.

| Param | Type | Description |
|-------|------|-------------|
| `peer` | `Peer` | The sender. |
| `msg` | `unknown` | Parsed JSON message. |
| `raw` | `Buffer` | Raw message bytes. |
| `registry` | `PeerRegistryInterface` | Peer registry. |

**Returns:** `true` to indicate the message was handled (suppresses further processing). `false`/`void` to let it fall through.

#### `onRoutedMessage(from, to, msg, raw)`

Called when a routed message (`{from, to}`) is about to be forwarded to the target peer.

| Param | Type | Description |
|-------|------|-------------|
| `from` | `Peer` | The sender peer. |
| `to` | `Peer` | The target peer. |
| `msg` | `unknown` | Parsed JSON message. |
| `raw` | `Buffer` | Raw message bytes. |

**Returns:** `false` to block forwarding. Any other value allows it.

#### `onHttpRequest(req, res, next)`

Called before built-in HTTP handlers (health, stats, blob). Acts as middleware.

| Param | Type | Description |
|-------|------|-------------|
| `req` | `IncomingMessage` | HTTP request. |
| `res` | `ServerResponse` | HTTP response. |
| `next` | `() => void` | Call to pass through to built-in handlers. If not called, the request is considered handled. |

---

## Access Keys

`keyStore` is **required** in `RelayConfig`. Omitting it throws an error to force a conscious decision about access control.

### `KeyStoreInterface`

Interface for implementing custom access key backends.

```typescript
interface KeyStoreInterface {
  validate(key: string): boolean | Promise<boolean>;
  close?(): void;
}
```

| Method | Description |
|--------|-------------|
| `validate(key)` | Return `true` if key is valid. May be async for database-backed stores. |
| `close()` | Optional cleanup (stop watchers, close connections). Called on `relay.close()`. |

---

### `EnvKeyStore`

Reads access keys from an environment variable (comma-separated).

```typescript
import { EnvKeyStore } from '@sumicom/ws-relay';

// Reads process.env.RELAY_ACCESS_KEYS
const store = new EnvKeyStore('RELAY_ACCESS_KEYS');
```

**Constructor:** `new EnvKeyStore(envVarName: string)`

| Param | Type | Description |
|-------|------|-------------|
| `envVarName` | `string` | Name of the environment variable containing comma-separated keys. |

**Throws:**
- If the environment variable is not set.
- If it is empty.
- If any key has invalid format (must match `KEY_FORMAT`).

---

### `FileKeyStore`

Reads access keys from a text file (one per line). Supports hot reload via file watching.

```typescript
import { FileKeyStore } from '@sumicom/ws-relay';

const store = new FileKeyStore('./keys.txt');               // watch: true (default)
const store = new FileKeyStore('./keys.txt', { watch: false }); // no auto-reload
```

**Constructor:** `new FileKeyStore(filePath: string, options?: FileKeyStoreOptions)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `filePath` | `string` | — | Path to the key file. |
| `options.watch` | `boolean` | `true` | Watch file for changes and auto-reload. |

**Methods:**

| Method | Description |
|--------|-------------|
| `reload()` | Manually re-read the key file. Called automatically by the file watcher. Silently keeps existing keys if reload fails. |
| `validate(key)` | Returns `true` if key is in the loaded set. |
| `close()` | Stops the file watcher. |

**File format:** One key per line. Lines starting with `#` are comments. Empty lines are ignored.

```
# keys.txt
key-abc-123
key-xyz-456
```

---

### `KEY_FORMAT`

Regex constant for valid key/ID format.

```typescript
const KEY_FORMAT: RegExp = /^[a-zA-Z0-9_-]{8,64}$/;
```

Matches 8–64 characters consisting of alphanumeric, `-`, and `_`.

---

## Blob Store

### `BlobStoreConfig`

Configuration for the built-in in-memory blob store.

```typescript
interface BlobStoreConfig {
  maxBlobSize?: number;
  routePrefix?: string;
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxBlobSize` | `number` | `8192` | Maximum blob size in bytes. |
| `routePrefix` | `string` | `'/blob'` | URL prefix for HTTP blob routes. |

---

### `BlobStoreInterface`

Interface for custom blob store implementations. Pass to `RelayConfig.blobStore` to replace the built-in store.

```typescript
interface BlobStoreInterface {
  get(key: string): string | null;
  put(key: string, data: string): void;
  delete(key: string): boolean;
  readonly stats: { entries: number };
}
```

| Method | Description |
|--------|-------------|
| `get(key)` | Retrieve a blob by key. Returns `null` if not found. |
| `put(key, data)` | Store a blob. Should throw if data exceeds size limit. |
| `delete(key)` | Delete a blob. Returns `true` if it existed. |
| `stats` | Read-only object with `entries` count. |

---

## Traffic Metering

When `keyStore` is enabled, the relay automatically tracks per-key traffic in rolling time windows.

### `TrafficMeter`

Internal class. Not typically used directly — stats are exposed via `GET /stats`.

```typescript
class TrafficMeter {
  constructor(windowMs: number, maxHistory: number);
  recordIn(key: string, bytes: number): void;
  recordOut(key: string, bytes: number): void;
  addConnection(key: string): void;
  removeConnection(key: string): void;
  getStats(): Record<string, { connections: number; current: KeyWindowStats; history: KeyWindowStats[] }>;
}
```

### `KeyWindowStats`

Traffic stats for a single time window.

```typescript
interface KeyWindowStats {
  bytesIn: number;
  bytesOut: number;
  windowStart: number;  // Unix timestamp (ms)
}
```

---

## Client API

### `RelayClient`

Isomorphic WebSocket client with auto-reconnect, typed events, and presence API. Works in both browser and Node.js.

```typescript
import { RelayClient } from '@sumicom/ws-relay/client';

const client = new RelayClient({
  url: 'ws://localhost:8080',
  channel: 'pwa',
  id: 'my-peer-id',
  key: 'my-access-key',
});
```

**Constructor:** `new RelayClient(config: RelayClientConfig)`

**Throws:** `Error` if `key` is provided but doesn't match `KEY_FORMAT`.

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `channel` | `string` (readonly) | The channel name. |
| `id` | `string` (readonly) | The peer ID. |
| `address` | `string` (readonly) | Full address as `"channel:id"`. |
| `connected` | `boolean` (getter) | Whether the WebSocket is currently open. |

#### Methods

##### `connect()`

Opens the WebSocket connection. If `reconnect` is enabled (default), the client will auto-reconnect with exponential backoff on disconnect.

```typescript
client.connect();
```

##### `close()`

Closes the connection and stops auto-reconnect.

```typescript
client.close();
```

##### `send(to, payload)`

Sends a routed message to a peer address.

| Param | Type | Description |
|-------|------|-------------|
| `to` | `string` | Target peer address (e.g. `"pwa:other-peer"`). |
| `payload` | `unknown` | Message payload (will be JSON-serialized). |

```typescript
client.send('pwa:bob', { type: 'offer', sdp: '...' });
```

Silently does nothing if the WebSocket is not open.

##### `watch(address)`

Subscribes to a peer's online/offline status. Immediately receives the current status.

| Param | Type | Description |
|-------|------|-------------|
| `address` | `string` | Peer address to watch (e.g. `"pwa:bob"`). |

```typescript
client.watch('pwa:bob');
```

##### `unwatch(address)`

Unsubscribes from a peer's status updates.

| Param | Type | Description |
|-------|------|-------------|
| `address` | `string` | Peer address to stop watching. |

##### `on(event, handler)`

Registers an event handler. See [`RelayClientEvents`](#relayclientevents) for event types.

```typescript
client.on('message', (from, payload) => { ... });
```

##### `off(event, handler)`

Removes a previously registered event handler.

---

### `RelayClientConfig`

```typescript
interface RelayClientConfig {
  url: string;
  channel: string;
  id: string;
  reconnect?: boolean;
  maxReconnectDelay?: number;
  key?: string;
  WebSocket?: WebSocketConstructor;
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `url` | `string` | — | **Required.** Relay server URL (e.g. `'ws://localhost:8080'`). |
| `channel` | `string` | — | **Required.** Channel to connect on. |
| `id` | `string` | — | **Required.** Peer ID within the channel. |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect with exponential backoff. |
| `maxReconnectDelay` | `number` | `30000` | Maximum reconnect delay in ms. Backoff starts at 1s and doubles. |
| `key` | `string` | — | Access key. Appended as `?key=...` to the WebSocket URL. |
| `WebSocket` | `WebSocketConstructor` | `globalThis.WebSocket` | WebSocket constructor override (for Node.js < 21). |

---

### `RelayClientEvents`

Event map for `client.on()` / `client.off()`.

| Event | Handler Signature | Description |
|-------|-------------------|-------------|
| `'message'` | `(from: string, payload: unknown) => void` | Received a routed message from another peer. |
| `'peer-status'` | `(address: string, online: boolean) => void` | A watched peer's status changed. |
| `'error'` | `(code: string, message: string) => void` | Server error received (e.g. `RATE_LIMITED`, `INVALID_KEY`). |
| `'open'` | `() => void` | Connected to relay. |
| `'close'` | `() => void` | Disconnected from relay. |

---

## Peer Types

### `Peer`

Represents a connected peer. Passed to hooks.

```typescript
interface Peer {
  ws: WebSocket;
  channel: string;
  id: string;
  address: PeerAddress;  // "channel:id"
  ip: string;
  connectedAt: number;   // Unix timestamp (ms)
  key?: string;           // Validated access key (if keyStore enabled)
  bytesIn: number;
  bytesOut: number;
}
```

### `PeerAddress`

```typescript
type PeerAddress = string;  // Format: "channel:id"
```

### `PeerRegistryInterface`

Passed to hooks for querying and managing connected peers.

```typescript
interface PeerRegistryInterface {
  add(peer: Peer): void;
  remove(peer: Peer): void;
  get(channel: string, id: string): Peer | undefined;
  getByAddress(address: PeerAddress): Peer | undefined;
  has(channel: string, id: string): boolean;

  watch(watchedAddress: PeerAddress, watcherAddress: PeerAddress): void;
  unwatch(watchedAddress: PeerAddress, watcherAddress: PeerAddress): void;
  getWatchers(watchedAddress: PeerAddress): Set<PeerAddress>;
  getWatched(watcherAddress: PeerAddress): PeerAddress[];
  removeAllWatchesFor(watcherAddress: PeerAddress): void;

  incrementMessagesRelayed(): void;
  getStats(): RegistryStats & { uptime: number };
}
```

### `RegistryStats`

```typescript
interface RegistryStats {
  totalConnections: number;
  messagesRelayed: number;
  startTime: number;
  channels: Record<string, { active: number; peak: number }>;
}
```

---

## HTTP Endpoints

All endpoints return JSON. CORS headers are set based on the `cors` config option.

### `GET /health`

Health check. Always available.

**Response:**
```json
{
  "status": "ok",
  "connections": {
    "pwa": { "active": 3, "peak": 10 }
  },
  "uptime": 86400000
}
```

### `GET /stats`

Detailed server statistics including per-channel connections, blob store stats, and per-key traffic.

**Response:**
```json
{
  "totalConnections": 42,
  "messagesRelayed": 1500,
  "startTime": 1709712000000,
  "uptime": 86400000,
  "channels": {
    "pwa": { "active": 3, "peak": 10 }
  },
  "blobStore": { "entries": 5 },
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

`keys` is only present when `keyStore` is enabled. `blobStore` is only present when blob store is enabled.

### `PUT /blob/{key}`

Store a blob. Key must match `KEY_FORMAT` (8–64 alphanumeric chars).

**Request body:** Raw string (the blob content).

**Response (200):**
```json
{ "ok": true }
```

**Response (413):** Blob exceeds `maxBlobSize`.

### `GET /blob/{key}`

Retrieve a blob.

**Response (200):**
```json
{ "data": "blob content here" }
```

**Response (404):**
```json
{ "error": "Not found" }
```

### `DELETE /blob/{key}`

Delete a blob.

**Response (200):**
```json
{ "ok": true }
```

**Response (404):**
```json
{ "ok": false }
```

### `OPTIONS *`

Returns 204 with CORS headers for preflight requests.

---

## WebSocket Protocol

Peers connect via: `ws://host/{channel}/{id}[?key=ACCESS_KEY]`

All messages are JSON.

### Routed Message (peer-to-peer)

Sent by clients to relay messages to another peer. The `from` field must match the sender's address.

```json
{ "from": "pwa:alice", "to": "pwa:bob", "payload": { "type": "offer", "sdp": "..." } }
```

### Watch (client → server)

Subscribe to a peer's online/offline status. Server immediately responds with current status.

```json
{ "type": "watch", "address": "pwa:bob" }
```

### Unwatch (client → server)

Unsubscribe from status updates.

```json
{ "type": "unwatch", "address": "pwa:bob" }
```

### Peer Status (server → client)

Pushed to watchers when a watched peer connects or disconnects.

```json
{ "type": "peer-status", "payload": { "address": "pwa:bob", "online": true } }
```

### Error (server → client)

Pushed when an error occurs.

```json
{ "type": "error", "payload": { "code": "RATE_LIMITED", "message": "Too many messages" } }
```

**Error codes:**

| Code | Description |
|------|-------------|
| `RATE_LIMITED` | Too many connections or messages. |
| `INVALID_KEY` | Missing or rejected access key. |
| `INVALID_URL` | Connection URL doesn't match any channel. |
| `INVALID_FROM` | The `from` field doesn't match sender's identity. |
| `ID_IN_USE` | Peer ID already connected (when `onDuplicate: 'reject'`). |
| `REPLACED` | This connection was replaced by a new one with the same ID. |

---

## Utility Functions

Exported for advanced use. Most users won't need these.

### `sendMessage(ws, message)`

Send a JSON message to a WebSocket if it's open.

```typescript
import { sendMessage } from '@sumicom/ws-relay';

sendMessage(ws, { type: 'error', payload: { code: 'CUSTOM', message: 'Something happened' } });
```

### `parsePeerUrl(channels, url)`

Parse a WebSocket connection URL against configured channels. Returns `{ channel, id }` or `null`.

### `isValidKeyFormat(key)`

Check if a string matches `KEY_FORMAT`. Returns `boolean`.

---

## Examples

### Basic Server with Open Access

```typescript
import { createRelay } from '@sumicom/ws-relay';

const relay = createRelay({
  port: 3000,
  channels: [{ name: 'chat' }],
  keyStore: false,
});

// Graceful shutdown
process.on('SIGINT', () => {
  relay.close();
  process.exit(0);
});
```

### Server with Access Keys and Hooks

```typescript
import { createRelay, EnvKeyStore } from '@sumicom/ws-relay';

// export RELAY_ACCESS_KEYS="app-key-001,app-key-002"
const relay = createRelay({
  port: 8080,
  channels: [
    { name: 'pwa', onDuplicate: 'replace' },
    { name: 'agent', onDuplicate: 'reject' },
  ],
  keyStore: new EnvKeyStore('RELAY_ACCESS_KEYS'),
  onInvalidKey: 'reject-upgrade',
  hooks: {
    onPeerConnect(peer) {
      console.log(`+ ${peer.address} from ${peer.ip}`);
    },
    onPeerDisconnect(peer) {
      console.log(`- ${peer.address}`);
    },
    onRoutedMessage(from, to, msg) {
      console.log(`${from.address} → ${to.address}`);
    },
  },
});
```

### Attaching to an Existing HTTP Server (e.g., Express)

```typescript
import express from 'express';
import { createServer } from 'http';
import { createRelay } from '@sumicom/ws-relay';

const app = express();
const server = createServer(app);

app.get('/api/health', (req, res) => {
  res.json({ api: 'ok' });
});

const relay = createRelay({
  channels: [{ name: 'app' }],
  keyStore: false,
  server, // attach to existing server
});

server.listen(3000);
```

### Custom Key Store (Database-Backed)

```typescript
import { createRelay } from '@sumicom/ws-relay';
import type { KeyStoreInterface } from '@sumicom/ws-relay';

const dbKeyStore: KeyStoreInterface = {
  async validate(key) {
    const row = await db.query('SELECT 1 FROM api_keys WHERE key = ? AND active = true', [key]);
    return row.length > 0;
  },
  close() {
    db.disconnect();
  },
};

const relay = createRelay({
  channels: [{ name: 'app' }],
  keyStore: dbKeyStore,
});
```

### Custom Blob Store (Redis-Backed)

```typescript
import { createRelay } from '@sumicom/ws-relay';
import type { BlobStoreInterface } from '@sumicom/ws-relay';

const redisBlobStore: BlobStoreInterface = {
  get(key) { return redis.get(`blob:${key}`); },
  put(key, data) { redis.set(`blob:${key}`, data, 'EX', 3600); },
  delete(key) { return redis.del(`blob:${key}`) > 0; },
  get stats() { return { entries: redis.dbsize() }; },
};

const relay = createRelay({
  channels: [{ name: 'app' }],
  keyStore: false,
  blobStore: redisBlobStore,
});
```

### Client with Presence Tracking

```typescript
import { RelayClient } from '@sumicom/ws-relay/client';

const client = new RelayClient({
  url: 'ws://localhost:8080',
  channel: 'pwa',
  id: 'alice',
  key: 'app-key-001',
});

client.on('open', () => {
  console.log('Connected as', client.address);

  // Watch for Bob's presence
  client.watch('pwa:bob');
});

client.on('peer-status', (address, online) => {
  console.log(`${address} is ${online ? 'online' : 'offline'}`);
  if (online) {
    client.send(address, { type: 'hello', text: 'Hey Bob!' });
  }
});

client.on('message', (from, payload) => {
  console.log(`Message from ${from}:`, payload);
});

client.on('error', (code, message) => {
  console.error(`Server error [${code}]: ${message}`);
});

client.on('close', () => {
  console.log('Disconnected, will auto-reconnect...');
});

client.connect();
```

### Client in Node.js (< v21)

```typescript
import { WebSocket } from 'ws';
import { RelayClient } from '@sumicom/ws-relay/client';

const client = new RelayClient({
  url: 'ws://localhost:8080',
  channel: 'agent',
  id: 'worker-01',
  WebSocket, // pass ws constructor explicitly
});

client.connect();
```

### Custom HTTP Middleware via Hooks

```typescript
const relay = createRelay({
  channels: [{ name: 'app' }],
  keyStore: false,
  hooks: {
    onHttpRequest(req, res, next) {
      // Add custom auth endpoint
      if (req.url === '/api/token' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: generateToken() }));
        return; // handled — don't call next()
      }

      // Pass through to built-in handlers (health, stats, blob)
      next();
    },
  },
});
```

### Message Filtering with onRoutedMessage

```typescript
const relay = createRelay({
  channels: [{ name: 'chat' }],
  keyStore: false,
  hooks: {
    onRoutedMessage(from, to, msg) {
      // Block messages containing banned words
      const payload = (msg as { payload?: { text?: string } }).payload;
      if (payload?.text && containsBannedWord(payload.text)) {
        sendMessage(from.ws, {
          type: 'error',
          payload: { code: 'BLOCKED', message: 'Message blocked by content filter' },
        });
        return false; // suppress forwarding
      }
    },
  },
});
```
