import type {
  RelayClientConfig,
  RelayClientEvents,
  WebSocketLike,
} from './types.js';

type EventName = keyof RelayClientEvents;
type EventHandler = (...args: never[]) => void;

const WS_OPEN = 1;

export class RelayClient {
  readonly channel: string;
  readonly id: string;
  readonly address: string;

  private url: string;
  private shouldReconnect: boolean;
  private maxReconnectDelay: number;
  private WsCtor: { new(url: string): WebSocketLike };
  private ws: WebSocketLike | null = null;
  private listeners = new Map<EventName, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;

  constructor(config: RelayClientConfig) {
    this.url = config.url;
    this.channel = config.channel;
    this.id = config.id;
    this.address = `${config.channel}:${config.id}`;
    this.shouldReconnect = config.reconnect ?? true;
    this.maxReconnectDelay = config.maxReconnectDelay ?? 30000;
    // The cast is needed because browser WebSocket has stricter event handler
    // types than our minimal WebSocketLike interface, but they're compatible at runtime
    this.WsCtor = (config.WebSocket ?? globalThis.WebSocket) as unknown as { new(url: string): WebSocketLike };

    if (!this.WsCtor) {
      throw new Error(
        'WebSocket not available. Pass a WebSocket constructor in config (e.g., from the "ws" package).'
      );
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  connect(): void {
    this.closed = false;
    this.doConnect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect
      this.ws.close(1000, 'Client closed');
      this.ws = null;
    }
  }

  /** Send a routed message to a peer address */
  send(to: string, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ from: this.address, to, payload }));
  }

  /** Watch a peer's online/offline status */
  watch(address: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.ws.send(JSON.stringify({ type: 'watch', address }));
  }

  /** Stop watching a peer's status */
  unwatch(address: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.ws.send(JSON.stringify({ type: 'unwatch', address }));
  }

  // ── Typed Event Emitter ─────────────────────────────────────────────

  on<E extends EventName>(event: E, handler: RelayClientEvents[E]): void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler as EventHandler);
  }

  off<E extends EventName>(event: E, handler: RelayClientEvents[E]): void {
    this.listeners.get(event)?.delete(handler as EventHandler);
  }

  private emit<E extends EventName>(event: E, ...args: Parameters<RelayClientEvents[E]>): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }

  // ── Connection Logic ────────────────────────────────────────────────

  private doConnect(): void {
    // Build URL: wss://host/{channel}/{id}
    const base = this.url.replace(/\/$/, '');
    const encodedId = encodeURIComponent(this.id);
    const wsUrl = `${base}/${this.channel}/${encodedId}`;

    const ws = new this.WsCtor(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1000; // reset backoff
      this.emit('open');
    };

    ws.onclose = () => {
      this.ws = null;
      this.emit('close');
      if (this.shouldReconnect && !this.closed) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror, so reconnect is handled there
    };

    ws.onmessage = (ev: { data: unknown }) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // non-JSON, ignore
      }

      // Server error
      if (msg.type === 'error' && msg.payload && typeof msg.payload === 'object') {
        const p = msg.payload as Record<string, unknown>;
        this.emit('error', String(p.code ?? ''), String(p.message ?? ''));
        return;
      }

      // Peer status
      if (msg.type === 'peer-status' && msg.payload && typeof msg.payload === 'object') {
        const p = msg.payload as Record<string, unknown>;
        this.emit('peer-status', String(p.address ?? ''), Boolean(p.online));
        return;
      }

      // Routed message from another peer
      if (typeof msg.from === 'string') {
        this.emit('message', msg.from, msg.payload);
        return;
      }
    };
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}

export type { RelayClientConfig, RelayClientEvents, WebSocketLike, WebSocketConstructor } from './types.js';
