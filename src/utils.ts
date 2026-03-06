import { WebSocket } from 'ws';
import { KEY_FORMAT } from './types.js';
import type { ChannelConfig } from './types.js';

interface SignalingMessage {
  type: string;
  payload?: unknown;
}

export interface ParsedPeerUrl {
  channel: string;
  id: string;
}

/**
 * Default ID validator: 8-64 alphanumeric chars plus - and _
 */
function defaultParseId(raw: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) return null;
  if (raw.length < 8 || raw.length > 64) return null;
  return raw;
}

/**
 * Parse a WebSocket connection URL against configured channels.
 *
 * For a channel named "foo", matches URL /foo/{id}
 * For a channel named "foo/bar", matches URL /foo/bar/{id}
 *
 * The {id} segment is validated by the channel's parseId function
 * (or the default validator if not provided).
 */
export function parsePeerUrl(channels: ChannelConfig[], url: string): ParsedPeerUrl | null {
  // Strip query string and fragment
  const cleanUrl = url.split('?')[0].split('#')[0];

  for (const channel of channels) {
    const prefix = `/${channel.name}/`;
    if (!cleanUrl.startsWith(prefix)) continue;

    const rawId = cleanUrl.slice(prefix.length);
    // Reject if rawId contains additional path segments
    if (rawId.includes('/')) continue;
    // Reject empty
    if (!rawId) continue;

    const parseId = channel.parseId ?? defaultParseId;
    const id = parseId(rawId);
    if (id === null) continue;

    return { channel: channel.name, id };
  }

  return null;
}

/**
 * Send a JSON message to a WebSocket if it's open.
 */
export function sendMessage(ws: WebSocket, message: SignalingMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Validate that a string matches the access key format (KEY_FORMAT regex).
 */
export function isValidKeyFormat(key: string): boolean {
  return KEY_FORMAT.test(key);
}

/** Extract the 'key' query parameter from a URL string */
export function parseQueryKey(url: string): string | null {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return null;
  const params = new URLSearchParams(url.slice(qIdx));
  return params.get('key');
}
