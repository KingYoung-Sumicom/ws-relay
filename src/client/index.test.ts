import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RelayClient } from './index.js';
import type { WebSocketLike } from './types.js';

// Mock WebSocket
function createMockWsCtor() {
  let instance: MockWs;

  class MockWs implements WebSocketLike {
    readyState = 0; // CONNECTING
    url: string;
    onopen: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    send = vi.fn();
    close = vi.fn();

    constructor(url: string) {
      this.url = url;
      instance = this;
    }

    // Test helpers
    simulateOpen() {
      this.readyState = 1; // OPEN
      this.onopen?.({});
    }
    simulateClose() {
      this.readyState = 3; // CLOSED
      this.onclose?.({});
    }
    simulateMessage(data: string) {
      this.onmessage?.({ data });
    }
  }

  return {
    Ctor: MockWs as unknown as { new(url: string): WebSocketLike },
    getInstance: () => instance,
  };
}

describe('RelayClient', () => {
  let mock: ReturnType<typeof createMockWsCtor>;

  beforeEach(() => {
    mock = createMockWsCtor();
    vi.useFakeTimers();
  });

  it('should construct with correct address', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      WebSocket: mock.Ctor,
    });
    expect(client.address).toBe('server:abc12345');
    expect(client.channel).toBe('server');
    expect(client.id).toBe('abc12345');
  });

  it('should connect to correct URL', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      WebSocket: mock.Ctor,
    });
    client.connect();
    const ws = mock.getInstance();
    expect((ws as unknown as { url: string }).url).toBe('ws://localhost:8080/server/abc12345');
  });

  it('should URL-encode the id', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'client',
      id: 'key+with/special=chars',
      WebSocket: mock.Ctor,
    });
    client.connect();
    const ws = mock.getInstance();
    expect((ws as unknown as { url: string }).url).toBe(
      'ws://localhost:8080/client/key%2Bwith%2Fspecial%3Dchars'
    );
  });

  it('should strip trailing slash from URL', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080/',
      channel: 'server',
      id: 'abc12345',
      WebSocket: mock.Ctor,
    });
    client.connect();
    const ws = mock.getInstance();
    expect((ws as unknown as { url: string }).url).toBe('ws://localhost:8080/server/abc12345');
  });

  it('should emit open event on connect', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      WebSocket: mock.Ctor,
    });
    const onOpen = vi.fn();
    client.on('open', onOpen);
    client.connect();
    mock.getInstance().simulateOpen();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('should report connected state', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      WebSocket: mock.Ctor,
    });
    expect(client.connected).toBe(false);
    client.connect();
    mock.getInstance().simulateOpen();
    expect(client.connected).toBe(true);
  });

  it('should emit close event on disconnect', () => {
    const client = new RelayClient({
      url: 'ws://localhost:8080',
      channel: 'server',
      id: 'abc12345',
      WebSocket: mock.Ctor,
      reconnect: false,
    });
    const onClose = vi.fn();
    client.on('close', onClose);
    client.connect();
    mock.getInstance().simulateOpen();
    mock.getInstance().simulateClose();
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe('sending messages', () => {
    it('should send routed message with correct format', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      client.connect();
      const ws = mock.getInstance();
      ws.simulateOpen();

      client.send('client:xyz789', { type: 'hello' });

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ from: 'server:abc12345', to: 'client:xyz789', payload: { type: 'hello' } })
      );
    });

    it('should not send when disconnected', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      client.send('client:xyz', { test: true });
      // No ws created yet, should not throw
    });

    it('should send watch message', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      client.connect();
      mock.getInstance().simulateOpen();
      client.watch('client:xyz');

      expect(mock.getInstance().send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'watch', address: 'client:xyz' })
      );
    });

    it('should send unwatch message', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      client.connect();
      mock.getInstance().simulateOpen();
      client.unwatch('client:xyz');

      expect(mock.getInstance().send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'unwatch', address: 'client:xyz' })
      );
    });
  });

  describe('receiving messages', () => {
    it('should emit message event for routed messages', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      const onMessage = vi.fn();
      client.on('message', onMessage);
      client.connect();
      mock.getInstance().simulateOpen();

      mock.getInstance().simulateMessage(
        JSON.stringify({ from: 'client:xyz', to: 'server:abc12345', payload: 'hello' })
      );

      expect(onMessage).toHaveBeenCalledWith('client:xyz', 'hello');
    });

    it('should emit peer-status event', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      const onStatus = vi.fn();
      client.on('peer-status', onStatus);
      client.connect();
      mock.getInstance().simulateOpen();

      mock.getInstance().simulateMessage(
        JSON.stringify({ type: 'peer-status', payload: { address: 'client:xyz', online: true } })
      );

      expect(onStatus).toHaveBeenCalledWith('client:xyz', true);
    });

    it('should emit error event', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      const onError = vi.fn();
      client.on('error', onError);
      client.connect();
      mock.getInstance().simulateOpen();

      mock.getInstance().simulateMessage(
        JSON.stringify({ type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many' } })
      );

      expect(onError).toHaveBeenCalledWith('RATE_LIMITED', 'Too many');
    });

    it('should ignore non-JSON messages', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      const onMessage = vi.fn();
      client.on('message', onMessage);
      client.connect();
      mock.getInstance().simulateOpen();

      mock.getInstance().simulateMessage('not json');
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe('reconnection', () => {
    it('should auto-reconnect after disconnect', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        reconnect: true,
        WebSocket: mock.Ctor,
      });
      client.connect();
      mock.getInstance().simulateOpen();
      mock.getInstance().simulateClose();

      // Should reconnect after 1s
      vi.advanceTimersByTime(1000);
      expect(mock.getInstance()).toBeDefined();
    });

    it('should use exponential backoff', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        reconnect: true,
        WebSocket: mock.Ctor,
      });
      client.connect();

      // First disconnect → 1s delay
      mock.getInstance().simulateClose();
      vi.advanceTimersByTime(999);
      const ws1 = mock.getInstance();
      vi.advanceTimersByTime(1);
      const ws2 = mock.getInstance();
      expect(ws2).not.toBe(ws1);

      // Second disconnect → 2s delay
      ws2.simulateClose();
      vi.advanceTimersByTime(1999);
      const ws3 = mock.getInstance();
      expect(ws3).toBe(ws2); // not yet reconnected
      vi.advanceTimersByTime(1);
      expect(mock.getInstance()).not.toBe(ws2); // now reconnected
    });

    it('should not reconnect when reconnect is false', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        reconnect: false,
        WebSocket: mock.Ctor,
      });
      client.connect();
      const ws = mock.getInstance();
      ws.simulateClose();

      vi.advanceTimersByTime(60000);
      // Still the same (closed) ws
      expect(mock.getInstance()).toBe(ws);
    });

    it('should not reconnect after close() is called', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        reconnect: true,
        WebSocket: mock.Ctor,
      });
      client.connect();
      mock.getInstance().simulateOpen();
      client.close();

      vi.advanceTimersByTime(60000);
      // ws was nulled by close()
      expect(client.connected).toBe(false);
    });

    it('should reset backoff after successful connection', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        reconnect: true,
        WebSocket: mock.Ctor,
      });
      client.connect();

      // Disconnect + reconnect at 1s
      mock.getInstance().simulateClose();
      vi.advanceTimersByTime(1000);

      // Disconnect + reconnect at 2s
      mock.getInstance().simulateClose();
      vi.advanceTimersByTime(2000);

      // Now connect successfully — should reset backoff
      mock.getInstance().simulateOpen();
      mock.getInstance().simulateClose();

      // Next reconnect should be at 1s again (reset)
      vi.advanceTimersByTime(1000);
      const ws = mock.getInstance();
      ws.simulateOpen();
      expect(ws.readyState).toBe(1);
    });
  });

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
      })).toThrow('invalid format');
    });
  });

  describe('event emitter', () => {
    it('should support off() to remove listeners', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      const handler = vi.fn();
      client.on('open', handler);
      client.off('open', handler);
      client.connect();
      mock.getInstance().simulateOpen();
      expect(handler).not.toHaveBeenCalled();
    });

    it('should support multiple listeners for same event', () => {
      const client = new RelayClient({
        url: 'ws://localhost:8080',
        channel: 'server',
        id: 'abc12345',
        WebSocket: mock.Ctor,
      });
      const h1 = vi.fn();
      const h2 = vi.fn();
      client.on('open', h1);
      client.on('open', h2);
      client.connect();
      mock.getInstance().simulateOpen();
      expect(h1).toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
    });
  });
});
