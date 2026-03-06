# Access Key & Traffic Metering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add access key validation and per-key traffic metering to ws-relay, with built-in env and file-based key store adapters.

**Architecture:** Hook-based `KeyStoreInterface` validated at WebSocket connection time. Two built-in adapters (EnvKeyStore, FileKeyStore) ship with core. Traffic metered per-peer with windowed per-key aggregation exposed via `/stats`. `keyStore` is a required config field — omitting it throws, forcing a conscious decision.

**Tech Stack:** TypeScript, Node.js `fs.watch()`, `URL` API for query parsing. Zero new dependencies.

**Design doc:** `docs/plans/2026-03-06-access-key-design.md`

---

### Task 1: Types — KeyStoreInterface & config additions

**Files:**
- Modify: `src/types.ts`

**Step 1: Write the failing test**

No test file for types (they're compile-time). Skip to implementation.

**Step 2: Add types to `src/types.ts`**

Add these after the existing `BlobStoreInterface` block (after line 86):

```typescript
// ── Key Store ──────────────────────────────────────────────────────────

/** Regex for valid access key format: 8-64 alphanumeric chars plus - and _ */
export const KEY_FORMAT = /^[a-zA-Z0-9_-]{8,64}$/;

/** Per-key traffic stats for a single time window */
export interface KeyWindowStats {
  bytesIn: number;
  bytesOut: number;
  windowStart: number;
}

/** Interface for access key validation backends */
export interface KeyStoreInterface {
  /** Return true if key is valid. May be async for DB-backed stores. */
  validate(key: string): boolean | Promise<boolean>;
  /** Optional cleanup (e.g., stop file watchers). */
  close?(): void;
}
```

Update the `Peer` interface (lines 10-17) to add:

```typescript
export interface Peer {
  ws: WebSocket;
  channel: string;
  id: string;
  address: PeerAddress;
  ip: string;
  connectedAt: number;
  key?: string;
  bytesIn: number;
  bytesOut: number;
}
```

Update `RelayConfig` (lines 116-143) to add the new fields:

```typescript
export interface RelayConfig {
  // ...all existing fields stay...

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

**Step 3: Update exports in `src/index.ts`**

Add to the type exports:

```typescript
export type {
  // ...existing exports...
  KeyStoreInterface,
  KeyWindowStats,
} from './types.js';

export { KEY_FORMAT } from './types.js';
```

**Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Type errors in `relay.ts` (existing tests pass `RelayConfig` without `keyStore`). This is expected — we'll fix in subsequent tasks.

**Step 5: Commit**

```bash
git add src/types.ts src/index.ts
git commit -m "feat: add KeyStoreInterface, key stats types, and Peer bytes tracking"
```

---

### Task 2: Key format validation utility

**Files:**
- Modify: `src/utils.ts`
- Modify: `src/utils.test.ts`

**Step 1: Write the failing tests**

Add to `src/utils.test.ts`:

```typescript
import { isValidKeyFormat } from './utils.js';

describe('isValidKeyFormat', () => {
  it('should accept valid key (8 chars)', () => {
    expect(isValidKeyFormat('abcd1234')).toBe(true);
  });

  it('should accept valid key (64 chars)', () => {
    expect(isValidKeyFormat('a'.repeat(64))).toBe(true);
  });

  it('should accept key with dashes and underscores', () => {
    expect(isValidKeyFormat('my_key-12345')).toBe(true);
  });

  it('should reject key shorter than 8 chars', () => {
    expect(isValidKeyFormat('short')).toBe(false);
  });

  it('should reject key longer than 64 chars', () => {
    expect(isValidKeyFormat('a'.repeat(65))).toBe(false);
  });

  it('should reject key with special characters', () => {
    expect(isValidKeyFormat('key@with!dots')).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidKeyFormat('')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils.test.ts`
Expected: FAIL — `isValidKeyFormat` is not exported

**Step 3: Write implementation**

Add to `src/utils.ts`:

```typescript
import { KEY_FORMAT } from './types.js';

export function isValidKeyFormat(key: string): boolean {
  return KEY_FORMAT.test(key);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils.test.ts`
Expected: All PASS

**Step 5: Update `src/index.ts` exports**

```typescript
export { sendMessage, parsePeerUrl, isValidKeyFormat } from './utils.js';
```

**Step 6: Commit**

```bash
git add src/utils.ts src/utils.test.ts src/index.ts
git commit -m "feat: add isValidKeyFormat utility"
```

---

### Task 3: EnvKeyStore adapter

**Files:**
- Create: `src/envKeyStore.ts`
- Create: `src/envKeyStore.test.ts`

**Step 1: Write the failing tests**

Create `src/envKeyStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnvKeyStore } from './envKeyStore.js';

describe('EnvKeyStore', () => {
  const ENV_VAR = 'TEST_RELAY_KEYS';

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('should validate a key present in env var', () => {
    process.env[ENV_VAR] = 'key-abc-123,key-xyz-456';
    const store = new EnvKeyStore(ENV_VAR);
    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-xyz-456')).toBe(true);
  });

  it('should reject a key not in env var', () => {
    process.env[ENV_VAR] = 'key-abc-123';
    const store = new EnvKeyStore(ENV_VAR);
    expect(store.validate('key-unknown')).toBe(false);
  });

  it('should trim whitespace around keys', () => {
    process.env[ENV_VAR] = ' key-abc-123 , key-xyz-456 ';
    const store = new EnvKeyStore(ENV_VAR);
    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-xyz-456')).toBe(true);
  });

  it('should throw if env var is not set', () => {
    expect(() => new EnvKeyStore(ENV_VAR)).toThrow('not set');
  });

  it('should throw if env var is empty', () => {
    process.env[ENV_VAR] = '';
    expect(() => new EnvKeyStore(ENV_VAR)).toThrow('empty');
  });

  it('should throw if any key has invalid format', () => {
    process.env[ENV_VAR] = 'key-abc-123,bad';
    expect(() => new EnvKeyStore(ENV_VAR)).toThrow('invalid format');
  });

  it('should ignore empty segments from trailing commas', () => {
    process.env[ENV_VAR] = 'key-abc-123,key-xyz-456,';
    const store = new EnvKeyStore(ENV_VAR);
    expect(store.validate('key-abc-123')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/envKeyStore.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/envKeyStore.ts`:

```typescript
import { isValidKeyFormat } from './utils.js';
import type { KeyStoreInterface } from './types.js';

export class EnvKeyStore implements KeyStoreInterface {
  private keys: Set<string>;

  constructor(envVarName: string) {
    const raw = process.env[envVarName];
    if (raw === undefined) {
      throw new Error(`Environment variable "${envVarName}" is not set. Set it to a comma-separated list of access keys.`);
    }
    if (raw.trim() === '') {
      throw new Error(`Environment variable "${envVarName}" is empty. Set it to a comma-separated list of access keys.`);
    }

    const keys = raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
    for (const key of keys) {
      if (!isValidKeyFormat(key)) {
        throw new Error(`Key "${key}" has invalid format. Keys must match /^[a-zA-Z0-9_-]{8,64}$/.`);
      }
    }

    this.keys = new Set(keys);
  }

  validate(key: string): boolean {
    return this.keys.has(key);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/envKeyStore.test.ts`
Expected: All PASS

**Step 5: Export from `src/index.ts`**

```typescript
export { EnvKeyStore } from './envKeyStore.js';
```

**Step 6: Commit**

```bash
git add src/envKeyStore.ts src/envKeyStore.test.ts src/index.ts
git commit -m "feat: add EnvKeyStore adapter"
```

---

### Task 4: FileKeyStore adapter

**Files:**
- Create: `src/fileKeyStore.ts`
- Create: `src/fileKeyStore.test.ts`

**Step 1: Write the failing tests**

Create `src/fileKeyStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileKeyStore } from './fileKeyStore.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileKeyStore', () => {
  let tmpDir: string;
  let keyFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-relay-test-'));
    keyFile = path.join(tmpDir, 'keys.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should validate keys from file', () => {
    fs.writeFileSync(keyFile, 'key-abc-123\nkey-xyz-456\n');
    const store = new FileKeyStore(keyFile, { watch: false });
    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-xyz-456')).toBe(true);
    expect(store.validate('key-unknown')).toBe(false);
  });

  it('should ignore comments and blank lines', () => {
    fs.writeFileSync(keyFile, '# This is a comment\nkey-abc-123\n\n# Another comment\nkey-xyz-456\n');
    const store = new FileKeyStore(keyFile, { watch: false });
    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-xyz-456')).toBe(true);
  });

  it('should trim whitespace', () => {
    fs.writeFileSync(keyFile, '  key-abc-123  \n  key-xyz-456  \n');
    const store = new FileKeyStore(keyFile, { watch: false });
    expect(store.validate('key-abc-123')).toBe(true);
  });

  it('should throw if file does not exist', () => {
    expect(() => new FileKeyStore('/nonexistent/keys.txt', { watch: false })).toThrow();
  });

  it('should throw if any key has invalid format', () => {
    fs.writeFileSync(keyFile, 'key-abc-123\nbad\n');
    expect(() => new FileKeyStore(keyFile, { watch: false })).toThrow('invalid format');
  });

  it('should reload keys when file changes (watch mode)', async () => {
    fs.writeFileSync(keyFile, 'key-abc-123\n');
    const store = new FileKeyStore(keyFile, { watch: true });

    expect(store.validate('key-abc-123')).toBe(true);
    expect(store.validate('key-new-4567')).toBe(false);

    // Modify file
    fs.writeFileSync(keyFile, 'key-abc-123\nkey-new-4567\n');

    // Wait for fs.watch to fire (give it a moment)
    await new Promise(r => setTimeout(r, 200));

    expect(store.validate('key-new-4567')).toBe(true);

    store.close!();
  });

  it('should stop watching after close()', () => {
    fs.writeFileSync(keyFile, 'key-abc-123\n');
    const store = new FileKeyStore(keyFile, { watch: true });
    store.close!();
    // Should not throw or error after close
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/fileKeyStore.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/fileKeyStore.ts`:

```typescript
import { readFileSync, watch, type FSWatcher } from 'fs';
import { isValidKeyFormat } from './utils.js';
import type { KeyStoreInterface } from './types.js';

export interface FileKeyStoreOptions {
  /** Watch file for changes and auto-reload. Default: true */
  watch?: boolean;
}

function parseKeyFile(filePath: string): Set<string> {
  const content = readFileSync(filePath, 'utf-8');
  const keys = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  for (const key of keys) {
    if (!isValidKeyFormat(key)) {
      throw new Error(`Key "${key}" has invalid format. Keys must match /^[a-zA-Z0-9_-]{8,64}$/.`);
    }
  }

  return new Set(keys);
}

export class FileKeyStore implements KeyStoreInterface {
  private keys: Set<string>;
  private watcher: FSWatcher | null = null;

  constructor(filePath: string, options: FileKeyStoreOptions = {}) {
    const shouldWatch = options.watch ?? true;

    this.keys = parseKeyFile(filePath);

    if (shouldWatch) {
      this.watcher = watch(filePath, () => {
        try {
          this.keys = parseKeyFile(filePath);
        } catch {
          // Keep existing keys if reload fails (e.g., file temporarily empty during write)
        }
      });
    }
  }

  validate(key: string): boolean {
    return this.keys.has(key);
  }

  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/fileKeyStore.test.ts`
Expected: All PASS

**Step 5: Export from `src/index.ts`**

```typescript
export { FileKeyStore } from './fileKeyStore.js';
export type { FileKeyStoreOptions } from './fileKeyStore.js';
```

**Step 6: Commit**

```bash
git add src/fileKeyStore.ts src/fileKeyStore.test.ts src/index.ts
git commit -m "feat: add FileKeyStore adapter with hot reload"
```

---

### Task 5: Traffic metering — TrafficMeter class

**Files:**
- Create: `src/trafficMeter.ts`
- Create: `src/trafficMeter.test.ts`

**Step 1: Write the failing tests**

Create `src/trafficMeter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TrafficMeter } from './trafficMeter.js';

describe('TrafficMeter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should record bytes for a key', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.recordIn('key-abc-123', 100);
    meter.recordOut('key-abc-123', 50);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].current.bytesIn).toBe(100);
    expect(stats['key-abc-123'].current.bytesOut).toBe(50);
  });

  it('should accumulate bytes in current window', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.recordIn('key-abc-123', 100);
    meter.recordIn('key-abc-123', 200);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].current.bytesIn).toBe(300);
  });

  it('should track multiple keys independently', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.recordIn('key-abc-123', 100);
    meter.recordIn('key-xyz-456', 200);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].current.bytesIn).toBe(100);
    expect(stats['key-xyz-456'].current.bytesIn).toBe(200);
  });

  it('should roll current into history when window expires', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.recordIn('key-abc-123', 100);

    vi.advanceTimersByTime(60001);
    meter.recordIn('key-abc-123', 50);

    const stats = meter.getStats();
    expect(stats['key-abc-123'].current.bytesIn).toBe(50);
    expect(stats['key-abc-123'].history).toHaveLength(1);
    expect(stats['key-abc-123'].history[0].bytesIn).toBe(100);
  });

  it('should prune history beyond max windows', () => {
    const meter = new TrafficMeter(60000, 2);

    meter.recordIn('key-abc-123', 100);
    vi.advanceTimersByTime(60001);
    meter.recordIn('key-abc-123', 200);
    vi.advanceTimersByTime(60001);
    meter.recordIn('key-abc-123', 300);
    vi.advanceTimersByTime(60001);
    meter.recordIn('key-abc-123', 400);

    const stats = meter.getStats();
    // Current = 400, history should only have 2 entries (200 and 300)
    expect(stats['key-abc-123'].history).toHaveLength(2);
    expect(stats['key-abc-123'].history[0].bytesIn).toBe(200);
    expect(stats['key-abc-123'].history[1].bytesIn).toBe(300);
  });

  it('should track connections per key', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.addConnection('key-abc-123');
    meter.addConnection('key-abc-123');
    meter.addConnection('key-xyz-456');

    const stats = meter.getStats();
    expect(stats['key-abc-123'].connections).toBe(2);
    expect(stats['key-xyz-456'].connections).toBe(1);
  });

  it('should decrement connections on remove', () => {
    const meter = new TrafficMeter(60000, 3);
    meter.addConnection('key-abc-123');
    meter.addConnection('key-abc-123');
    meter.removeConnection('key-abc-123');

    const stats = meter.getStats();
    expect(stats['key-abc-123'].connections).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/trafficMeter.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/trafficMeter.ts`:

```typescript
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
      // Prune old history
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/trafficMeter.test.ts`
Expected: All PASS

**Step 5: Export from `src/index.ts`**

```typescript
export { TrafficMeter } from './trafficMeter.js';
```

**Step 6: Commit**

```bash
git add src/trafficMeter.ts src/trafficMeter.test.ts src/index.ts
git commit -m "feat: add TrafficMeter with windowed per-key stats"
```

---

### Task 6: Integrate key validation into relay.ts

**Files:**
- Modify: `src/relay.ts`
- Modify: `src/utils.ts`

**Step 1: Add `parseQueryKey` to `src/utils.ts`**

```typescript
/** Extract the 'key' query parameter from a URL string */
export function parseQueryKey(url: string): string | null {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return null;
  const params = new URLSearchParams(url.slice(qIdx));
  return params.get('key');
}
```

Add test to `src/utils.test.ts`:

```typescript
import { parseQueryKey } from './utils.js';

describe('parseQueryKey', () => {
  it('should extract key from query string', () => {
    expect(parseQueryKey('/pwa/abc12345?key=my-key-123')).toBe('my-key-123');
  });

  it('should return null when no query string', () => {
    expect(parseQueryKey('/pwa/abc12345')).toBeNull();
  });

  it('should return null when key param missing', () => {
    expect(parseQueryKey('/pwa/abc12345?foo=bar')).toBeNull();
  });

  it('should decode URL-encoded key', () => {
    expect(parseQueryKey('/pwa/abc12345?key=my%2Dkey%2D123')).toBe('my-key-123');
  });
});
```

Run: `npx vitest run src/utils.test.ts`

**Step 2: Integrate into `relay.ts`**

Changes to `src/relay.ts`:

1. Import new modules at the top:

```typescript
import { TrafficMeter } from './trafficMeter.js';
import { parsePeerUrl, sendMessage, isValidKeyFormat, parseQueryKey } from './utils.js';
import type { ..., KeyStoreInterface } from './types.js';
```

2. Add `keyStore` validation at the start of `createRelay()` (after line 31):

```typescript
if (config.keyStore === undefined) {
  throw new Error(
    'keyStore is required. Provide a KeyStoreInterface to enable access key validation, ' +
    'or set keyStore: false to explicitly allow open access.'
  );
}
const keyStore: KeyStoreInterface | false = config.keyStore;
const onInvalidKey = config.onInvalidKey ?? 'close-after-connect';
```

3. Add TrafficMeter initialization:

```typescript
const statsWindow = config.statsWindow ?? 3600000;
const statsHistory = config.statsHistory ?? 24;
const trafficMeter = keyStore ? new TrafficMeter(statsWindow, statsHistory) : null;
```

4. In `wss.on('connection')` handler, after rate limit check (after line 189), add key validation:

```typescript
// Key validation
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
  // Store key on peer (set below when peer is created)
  (extWs as unknown as { _validatedKey: string })._validatedKey = rawKey;
}
```

**Note:** The connection handler callback needs to become `async` to support `await keyStore.validate()`. Change line 176 from:

```typescript
wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
```
to:
```typescript
wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
```

5. When creating the `Peer` object (around line 219-226), add the new fields:

```typescript
const validatedKey = keyStore ? (extWs as unknown as { _validatedKey: string })._validatedKey : undefined;

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
```

6. In the `ws.on('message')` handler, add bytes tracking (after `extWs.messageCount++`, around line 255):

```typescript
// Track bytes in
const messageBytes = data.byteLength;
peer.bytesIn += messageBytes;
if (trafficMeter && peer.key) {
  trafficMeter.recordIn(peer.key, messageBytes);
}
```

7. Where `target.ws.send(data)` is called for routed messages (around line 301), add bytes out tracking:

```typescript
target.ws.send(data);
// Track bytes out on the target peer
const targetPeerObj = (target.ws as ExtendedWebSocket).peer;
if (targetPeerObj) {
  targetPeerObj.bytesOut += (data as Buffer).byteLength;
  if (trafficMeter && targetPeerObj.key) {
    trafficMeter.recordOut(targetPeerObj.key, (data as Buffer).byteLength);
  }
}
registry.incrementMessagesRelayed();
```

8. In the `ws.on('close')` handler (around line 324), add connection tracking:

```typescript
if (trafficMeter && peer.key) {
  trafficMeter.removeConnection(peer.key);
}
```

9. Update `/stats` endpoint (around line 105-114) to include key stats:

```typescript
if (req.url === '/stats') {
  const stats = registry.getStats();
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
```

10. In the `close()` function, clean up keyStore:

```typescript
const close = () => {
  wss.close();
  if (!config.server) {
    server.close();
  }
  if (keyStore && keyStore.close) {
    keyStore.close();
  }
};
```

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: Some existing tests may fail because they don't pass `keyStore`. Fix by adding `keyStore: false` to existing test configs.

**Step 4: Commit**

```bash
git add src/relay.ts src/utils.ts src/utils.test.ts
git commit -m "feat: integrate key validation and traffic metering into relay"
```

---

### Task 7: Fix existing tests for breaking change

**Files:**
- Modify: any test files that create a `RelayConfig` without `keyStore`

Grep for `createRelay` in test files. Add `keyStore: false` to all existing relay config objects in tests. This is a mechanical change.

Run: `npx vitest run`
Expected: All PASS

**Step 1: Commit**

```bash
git add -u
git commit -m "fix: add keyStore: false to existing tests for backwards compat"
```

---

### Task 8: Client — add key support to RelayClient

**Files:**
- Modify: `src/client/types.ts`
- Modify: `src/client/index.ts`
- Modify: `src/client/index.test.ts`

**Step 1: Write the failing tests**

Add to `src/client/index.test.ts`:

```typescript
describe('access key', () => {
  it('should append key as query param to URL', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      key: 'my-key-123',
      WebSocket: mock.Ctor,
    });
    client.connect();
    const ws = mock.getInstance();
    expect((ws as unknown as { url: string }).url).toBe(
      'ws://localhost:8080/server/abc12345?key=my-key-123'
    );
  });

  it('should not append query param when no key', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      WebSocket: mock.Ctor,
    });
    client.connect();
    const ws = mock.getInstance();
    expect((ws as unknown as { url: string }).url).toBe(
      'ws://localhost:8080/server/abc12345'
    );
  });

  it('should throw on invalid key format at construction', () => {
    expect(() => new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      key: 'bad',
      WebSocket: mock.Ctor,
    })).toThrow('invalid');
  });

  it('should URL-encode the key', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      key: 'key_with-dashes',
      WebSocket: mock.Ctor,
    });
    client.connect();
    const ws = mock.getInstance();
    expect((ws as unknown as { url: string }).url).toContain('?key=key_with-dashes');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/client/index.test.ts`
Expected: FAIL — `key` not recognized

**Step 3: Update `src/client/types.ts`**

Add to `RelayClientConfig`:

```typescript
/** Access key for authentication */
key?: string;
```

**Step 4: Update `src/client/index.ts`**

Add import at top:

```typescript
import { KEY_FORMAT } from '../types.js';
```

Add to constructor (after existing field assignments):

```typescript
if (config.key !== undefined) {
  if (!KEY_FORMAT.test(config.key)) {
    throw new Error(`Access key has invalid format. Keys must match /^[a-zA-Z0-9_-]{8,64}$/.`);
  }
}
this.key = config.key;
```

Add field declaration:

```typescript
private key?: string;
```

Update `doConnect()` URL building:

```typescript
private doConnect(): void {
  const base = this.url.replace(/\/$/, '');
  const encodedId = encodeURIComponent(this.id);
  let wsUrl = `${base}/${this.channel}/${encodedId}`;
  if (this.key) {
    wsUrl += `?key=${encodeURIComponent(this.key)}`;
  }

  const ws = new this.WsCtor(wsUrl);
  // ...rest unchanged
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/client/index.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/client/types.ts src/client/index.ts src/client/index.test.ts
git commit -m "feat: add access key support to RelayClient"
```

---

### Task 9: Update README

**Files:**
- Modify: `README.md`

Add an **Access Keys** section after the existing **Configuration** section covering:

- `keyStore` required field
- `EnvKeyStore` usage example
- `FileKeyStore` usage example
- `onInvalidKey` option
- Client-side `key` config
- `/stats` per-key output format
- `statsWindow` / `statsHistory` config
- Custom `KeyStoreInterface` example

**Step 1: Write the docs**

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add access keys and traffic metering to README"
```

---

### Task 10: Full test pass & typecheck

**Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS, no type errors

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: All PASS

**Step 3: Run build**

Run: `npm run build`
Expected: PASS, no errors

**Step 4: Commit if any fixes were needed**

```bash
git add -u
git commit -m "fix: resolve type and test issues from full verification pass"
```
