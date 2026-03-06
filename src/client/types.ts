/** Configuration for RelayClient */
export interface RelayClientConfig {
  /** Relay server URL (e.g., 'wss://relay.example.com' or 'ws://localhost:8080') */
  url: string;
  /** Channel to connect on */
  channel: string;
  /** Peer ID within the channel */
  id: string;
  /** Auto-reconnect on disconnect. Default: true */
  reconnect?: boolean;
  /** Max reconnect delay in ms. Default: 30000 */
  maxReconnectDelay?: number;
  /** Access key for authentication */
  key?: string;
  /** WebSocket constructor override (for Node.js < 21). Default: globalThis.WebSocket */
  WebSocket?: WebSocketConstructor;
}

/** Minimal WebSocket constructor interface for cross-platform compat */
export interface WebSocketConstructor {
  new(url: string): WebSocketLike;
}

/** Minimal WebSocket interface that both browser and Node.js implement */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Event map for typed event emitter */
export interface RelayClientEvents {
  /** Received a routed message from another peer */
  message: (from: string, payload: unknown) => void;
  /** Peer presence status changed */
  'peer-status': (address: string, online: boolean) => void;
  /** Server error received */
  error: (code: string, message: string) => void;
  /** Connected to relay */
  open: () => void;
  /** Disconnected from relay */
  close: () => void;
}
