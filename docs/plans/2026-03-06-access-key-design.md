# Access Key & Traffic Metering Design

## Problem

The relay protocol is public. Anyone can write a conforming client and use our server to relay their own app's traffic. We need access control without compromising user anonymity.

## Strategy

- **Access keys** identify apps, not users — preserves anonymity
- **Traffic metering** exposes per-key stats for external monitoring
- Keys are required by default; users must explicitly opt out (`keyStore: false`)

## Key Format

```
/^[a-zA-Z0-9_-]{8,64}$/
```

Same rules as peer ID: 8–64 chars, alphanumeric plus `-` and `_`.

## KeyStoreInterface

```typescript
interface KeyStoreInterface {
  validate(key: string): boolean | Promise<boolean>;
  close?(): void;
}
```

## RelayConfig Changes

```typescript
interface RelayConfig {
  // ...existing fields...

  /**
   * Access key store.
   * - KeyStoreInterface: enable key validation
   * - false: explicitly disable (open access)
   * - omitted: createRelay() throws, forcing a conscious decision
   */
  keyStore: KeyStoreInterface | false;

  /** Behavior on invalid key. Default: 'close-after-connect' */
  onInvalidKey?: 'reject-upgrade' | 'close-after-connect';

  /** Traffic stats window size in ms. Default: 3600000 (1 hour) */
  statsWindow?: number;

  /** Number of historical windows to retain. Default: 24 */
  statsHistory?: number;
}
```

## Authentication Flow

```
Client connects: ws://host/channel/id?key=xxx

Server:
  1. keyStore not configured → throw Error at startup
  2. keyStore === false → skip validation, allow connection
  3. keyStore provided →
     a. Extract ?key from URL query string
     b. Validate format: /^[a-zA-Z0-9_-]{8,64}$/ → reject if invalid
     c. Call keyStore.validate(key)
     d. If valid → proceed with connection
     e. If invalid →
        - 'close-after-connect' (default): complete handshake,
          send { type: "error", payload: { code: "INVALID_KEY" } }, close
        - 'reject-upgrade': respond HTTP 403, no handshake
```

## Built-in Adapters

### EnvKeyStore

Reads keys from an environment variable (comma-separated).

```typescript
import { EnvKeyStore } from '@sumicom/ws-relay';

// process.env.RELAY_ACCESS_KEYS = "key-abc-123,key-xyz-456"
const store = new EnvKeyStore('RELAY_ACCESS_KEYS');
```

- One-time read at construction, stored in `Set<string>`
- Validates each key's format on load; throws if env var missing/empty
- No hot reload (restart to update — expected for env vars)

### FileKeyStore

Reads keys from a text file, one per line, with optional hot reload.

```typescript
import { FileKeyStore } from '@sumicom/ws-relay';

const store = new FileKeyStore('./keys.txt');
// or without hot reload:
const store = new FileKeyStore('./keys.txt', { watch: false });
```

**File format:**
```
# Comments (lines starting with #)
key-abc-123
key-xyz-456

# Blank lines ignored
```

- Parses into `Set<string>`, validates format on load
- `watch: true` (default): `fs.watch()` on file, auto-reload on change
- `close()`: stops the file watcher
- Throws if file doesn't exist

## Client Changes

### RelayClientConfig

```typescript
interface RelayClientConfig {
  // ...existing fields...

  /** Access key for authentication */
  key?: string;
}
```

- If `key` provided, validate format at construction (fail fast)
- Append `?key=<encoded>` to WebSocket URL during connect
- If no `key`, connect without query param (server with `keyStore: false`)

## Traffic Metering

### Peer Extension

```typescript
interface Peer {
  // ...existing fields...
  key?: string;       // the access key used to connect
  bytesIn: number;    // total bytes received from this peer
  bytesOut: number;   // total bytes sent to this peer
}
```

`bytesIn` incremented on every `ws.on('message')` using `raw.byteLength`.
`bytesOut` incremented on every `ws.send()` / `sendMessage()`.

### Windowed Per-Key Stats

Stats are aggregated per key in time windows.

```typescript
interface KeyWindowStats {
  bytesIn: number;
  bytesOut: number;
  windowStart: number;  // epoch ms
}
```

- `current` window accumulates live traffic
- When window expires, `current` rolls into `history` array
- Oldest entries pruned when `history.length > statsHistory`

### /stats Endpoint Output

```json
{
  "uptime": 3600,
  "totalConnections": 42,
  "messagesRelayed": 1234,
  "channels": { "pwa": { "active": 5, "peak": 12 } },
  "keys": {
    "key-abc": {
      "connections": 3,
      "current": { "bytesIn": 12800, "bytesOut": 11520, "windowStart": 1709712000000 },
      "history": [
        { "bytesIn": 102400, "bytesOut": 98304, "windowStart": 1709708400000 }
      ]
    }
  }
}
```

External monitoring tools (Prometheus, Grafana, Datadog, custom scripts) poll `/stats` and define their own alerting rules. The relay core does metering, not decision-making.

### Config Defaults

| Field | Default | Description |
|-------|---------|-------------|
| `statsWindow` | `3600000` (1h) | Window size in ms |
| `statsHistory` | `24` | Windows to retain |

## Validation Points

Key format is validated at three layers:

1. **Client** — `RelayClient` constructor throws if key format invalid
2. **Server** — `relay.ts` checks format before calling `keyStore.validate()`
3. **Adapter** — `EnvKeyStore`/`FileKeyStore` validate each key on load

## Breaking Change

`keyStore` is now a required field in `RelayConfig`. Existing code that calls `createRelay()` without it will get a clear error message directing them to set `keyStore: false` for open access or provide a `KeyStoreInterface`.

## Out of Scope

- SQLite adapter (future: separate `@sumicom/ws-relay-keystore-sqlite` package)
- Prometheus exporter format
- Alerting / anomaly detection logic
- Admin HTTP API for key management
