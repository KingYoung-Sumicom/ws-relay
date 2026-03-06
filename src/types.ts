import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server, ServerResponse } from 'http';

// ── Peer ────────────────────────────────────────────────────────────────

/** A peer's address in the format "channel:id" */
export type PeerAddress = string;

/** A connected peer with its metadata */
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

/** Internal extended WebSocket with tracking metadata */
export interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  peer?: Peer;
  messageCount: number;
  lastMessageReset: number;
}

// ── Channel ─────────────────────────────────────────────────────────────

export interface ChannelConfig {
  /** Channel name — becomes the URL path segment: /{name}/{id} */
  name: string;
  /**
   * Custom ID parser/validator. Receives the raw URL segment after the channel name.
   * Return the parsed ID string, or null to reject the connection.
   * Default: accepts 8-64 alphanumeric chars plus - and _
   */
  parseId?: (raw: string) => string | null;
  /**
   * What to do when a peer connects with an ID already in use on this channel.
   * - 'reject': reject the new connection with an error
   * - 'replace': close the old connection and register the new one
   * Default: 'replace'
   */
  onDuplicate?: 'reject' | 'replace';
}

// ── Hooks ───────────────────────────────────────────────────────────────

export interface RelayHooks {
  /** Called after a peer is registered. */
  onPeerConnect?(peer: Peer, registry: PeerRegistryInterface): void;
  /** Called before a peer is removed from the registry. */
  onPeerDisconnect?(peer: Peer, registry: PeerRegistryInterface): void;
  /**
   * Called when an incoming message is parsed as JSON but has no {from, to} routing fields,
   * and is not a built-in protocol message (watch/unwatch).
   * Return true to indicate the message was handled (suppresses default legacy relay).
   */
  onMessage?(peer: Peer, msg: unknown, raw: Buffer, registry: PeerRegistryInterface): boolean | void;
  /**
   * Called when a routed message ({from, to}) is about to be forwarded.
   * Return false to suppress default forwarding.
   */
  onRoutedMessage?(from: Peer, to: Peer, msg: unknown, raw: Buffer): boolean | void;
  /**
   * Called before built-in HTTP handlers (health, stats, blob).
   * Call next() to pass through to built-in handlers.
   */
  onHttpRequest?(req: IncomingMessage, res: ServerResponse, next: () => void): void;
}

// ── Blob Store ──────────────────────────────────────────────────────────

export interface BlobStoreConfig {
  /** Max blob size in bytes. Default: 8192 */
  maxBlobSize?: number;
  /** URL prefix for HTTP routes. Default: '/blob' */
  routePrefix?: string;
}

export interface BlobStoreInterface {
  get(key: string): string | null;
  put(key: string, data: string): void;
  delete(key: string): boolean;
  readonly stats: { entries: number };
}

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

// ── Registry ────────────────────────────────────────────────────────────

export interface RegistryStats {
  totalConnections: number;
  messagesRelayed: number;
  startTime: number;
  channels: Record<string, { active: number; peak: number }>;
}

export interface PeerRegistryInterface {
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

// ── Relay Config ────────────────────────────────────────────────────────

export interface RelayConfig {
  /** Port to listen on. Default: 8080 */
  port?: number;
  /** Channel definitions. At least one required. */
  channels: ChannelConfig[];
  /** Lifecycle hooks for extending relay behavior. */
  hooks?: RelayHooks;
  /**
   * Blob store configuration.
   * - Object/BlobStoreConfig: enable built-in blob store with config
   * - BlobStoreInterface: use a custom blob store implementation
   * - false: disable blob store entirely
   * Default: enabled with defaults
   */
  blobStore?: BlobStoreConfig | BlobStoreInterface | false;
  /** Heartbeat ping interval in ms. Default: 30000 */
  heartbeatInterval?: number;
  /** Rate limit window in ms. Default: 60000 */
  rateLimitWindow?: number;
  /** Max new connections per IP per window. Default: 10 */
  rateLimitMaxConnections?: number;
  /** Max messages per connection per window. Default: 100 */
  rateLimitMaxMessages?: number;
  /** CORS origin. true = '*', string = specific origin, false = disabled. Default: true */
  cors?: boolean | string;
  /** Attach to an existing HTTP server instead of creating one. */
  server?: Server;
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

// ── Relay Instance ──────────────────────────────────────────────────────

export interface RelayInstance {
  server: Server;
  wss: WebSocketServer;
  registry: PeerRegistryInterface;
  blobStore: BlobStoreInterface | null;
  close(): void;
}
