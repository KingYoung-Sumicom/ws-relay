import { describe, it, expect, vi } from 'vitest';
import { parsePeerUrl, sendMessage } from './utils.js';
import { WebSocket } from 'ws';
import type { ChannelConfig } from './types.js';

const defaultChannels: ChannelConfig[] = [
  { name: 'server' },
  { name: 'client' },
];

describe('parsePeerUrl', () => {
  it('should parse a simple channel URL', () => {
    const result = parsePeerUrl(defaultChannels, '/server/abcd1234');
    expect(result).toEqual({ channel: 'server', id: 'abcd1234' });
  });

  it('should parse another channel', () => {
    const result = parsePeerUrl(defaultChannels, '/client/xyz12345');
    expect(result).toEqual({ channel: 'client', id: 'xyz12345' });
  });

  it('should reject unknown channel', () => {
    expect(parsePeerUrl(defaultChannels, '/unknown/abcd1234')).toBeNull();
  });

  it('should reject empty id', () => {
    expect(parsePeerUrl(defaultChannels, '/server/')).toBeNull();
  });

  it('should reject missing id', () => {
    expect(parsePeerUrl(defaultChannels, '/server')).toBeNull();
  });

  it('should reject ID shorter than 8 chars (default validator)', () => {
    expect(parsePeerUrl(defaultChannels, '/server/short')).toBeNull();
  });

  it('should reject ID longer than 64 chars (default validator)', () => {
    const longId = 'a'.repeat(65);
    expect(parsePeerUrl(defaultChannels, `/server/${longId}`)).toBeNull();
  });

  it('should accept ID at min length (8 chars)', () => {
    const result = parsePeerUrl(defaultChannels, '/server/abcdefgh');
    expect(result).toEqual({ channel: 'server', id: 'abcdefgh' });
  });

  it('should accept ID at max length (64 chars)', () => {
    const id = 'a'.repeat(64);
    const result = parsePeerUrl(defaultChannels, `/server/${id}`);
    expect(result).toEqual({ channel: 'server', id });
  });

  it('should accept alphanumeric plus - and _ in ID', () => {
    const result = parsePeerUrl(defaultChannels, '/server/my_id-12345');
    expect(result).toEqual({ channel: 'server', id: 'my_id-12345' });
  });

  it('should reject special characters in ID', () => {
    expect(parsePeerUrl(defaultChannels, '/server/my@id!12345')).toBeNull();
  });

  it('should reject extra path segments', () => {
    expect(parsePeerUrl(defaultChannels, '/server/abcd1234/extra')).toBeNull();
  });

  it('should strip query string', () => {
    const result = parsePeerUrl(defaultChannels, '/server/abcd1234?foo=bar');
    expect(result).toEqual({ channel: 'server', id: 'abcd1234' });
  });

  it('should strip fragment', () => {
    const result = parsePeerUrl(defaultChannels, '/server/abcd1234#section');
    expect(result).toEqual({ channel: 'server', id: 'abcd1234' });
  });

  describe('multi-segment channel names', () => {
    const channels: ChannelConfig[] = [
      { name: 'client/key', parseId: (raw) => {
        const decoded = decodeURIComponent(raw);
        return decoded.length >= 8 && decoded.length <= 512 ? decoded : null;
      }},
      { name: 'client' },
      { name: 'server' },
    ];

    it('should match longer channel name first', () => {
      const result = parsePeerUrl(channels, '/client/key/myPublicKey123');
      expect(result).toEqual({ channel: 'client/key', id: 'myPublicKey123' });
    });

    it('should match shorter channel when longer does not match', () => {
      const result = parsePeerUrl(channels, '/client/abcd1234');
      expect(result).toEqual({ channel: 'client', id: 'abcd1234' });
    });

    it('should handle URL-encoded characters in multi-segment channel', () => {
      const result = parsePeerUrl(channels, '/client/key/abc%2Bdef%3D12');
      expect(result).toEqual({ channel: 'client/key', id: 'abc+def=12' });
    });

    it('should use custom parseId for validation', () => {
      // Too short (< 8 chars)
      expect(parsePeerUrl(channels, '/client/key/short')).toBeNull();
    });
  });
});

describe('sendMessage', () => {
  it('should send JSON to open WebSocket', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    sendMessage(ws, { type: 'test', payload: { foo: 'bar' } });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'test', payload: { foo: 'bar' } }));
  });

  it('should not send to closed WebSocket', () => {
    const ws = {
      readyState: WebSocket.CLOSED,
      send: vi.fn(),
    } as unknown as WebSocket;

    sendMessage(ws, { type: 'test' });

    expect(ws.send).not.toHaveBeenCalled();
  });
});
