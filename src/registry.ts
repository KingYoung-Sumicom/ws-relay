import type { Peer, PeerAddress, PeerRegistryInterface, RegistryStats } from './types.js';

export class PeerRegistry implements PeerRegistryInterface {
  /** channel name → (id → Peer) */
  private channels: Map<string, Map<string, Peer>> = new Map();
  /** watched address → set of watcher addresses */
  private presenceWatchers: Map<PeerAddress, Set<PeerAddress>> = new Map();

  private _stats: RegistryStats = {
    totalConnections: 0,
    messagesRelayed: 0,
    startTime: Date.now(),
    channels: {},
  };

  private ensureChannel(channel: string): Map<string, Peer> {
    let map = this.channels.get(channel);
    if (!map) {
      map = new Map();
      this.channels.set(channel, map);
      this._stats.channels[channel] = { active: 0, peak: 0 };
    }
    return map;
  }

  add(peer: Peer): void {
    const map = this.ensureChannel(peer.channel);
    map.set(peer.id, peer);

    this._stats.totalConnections++;
    const channelStats = this._stats.channels[peer.channel];
    channelStats.active = map.size;
    if (channelStats.active > channelStats.peak) {
      channelStats.peak = channelStats.active;
    }
  }

  remove(peer: Peer): void {
    const map = this.channels.get(peer.channel);
    if (map) {
      map.delete(peer.id);
      const channelStats = this._stats.channels[peer.channel];
      if (channelStats) {
        channelStats.active = map.size;
      }
    }
  }

  get(channel: string, id: string): Peer | undefined {
    return this.channels.get(channel)?.get(id);
  }

  /**
   * Look up a peer by address string.
   * Address format: "channel:id" — splits on the first colon.
   */
  getByAddress(address: PeerAddress): Peer | undefined {
    const colonIdx = address.indexOf(':');
    if (colonIdx === -1) return undefined;
    const channel = address.slice(0, colonIdx);
    const id = address.slice(colonIdx + 1);
    return this.get(channel, id);
  }

  has(channel: string, id: string): boolean {
    return this.channels.get(channel)?.has(id) ?? false;
  }

  // ── Presence Watching ─────────────────────────────────────────────

  watch(watchedAddress: PeerAddress, watcherAddress: PeerAddress): void {
    let watchers = this.presenceWatchers.get(watchedAddress);
    if (!watchers) {
      watchers = new Set();
      this.presenceWatchers.set(watchedAddress, watchers);
    }
    watchers.add(watcherAddress);
  }

  unwatch(watchedAddress: PeerAddress, watcherAddress: PeerAddress): void {
    const watchers = this.presenceWatchers.get(watchedAddress);
    if (watchers) {
      watchers.delete(watcherAddress);
      if (watchers.size === 0) {
        this.presenceWatchers.delete(watchedAddress);
      }
    }
  }

  getWatchers(watchedAddress: PeerAddress): Set<PeerAddress> {
    return this.presenceWatchers.get(watchedAddress) ?? new Set();
  }

  /** Get all addresses that a given watcher is watching. */
  getWatched(watcherAddress: PeerAddress): PeerAddress[] {
    const result: PeerAddress[] = [];
    for (const [watched, watchers] of this.presenceWatchers) {
      if (watchers.has(watcherAddress)) {
        result.push(watched);
      }
    }
    return result;
  }

  removeAllWatchesFor(watcherAddress: PeerAddress): void {
    for (const [watched, watchers] of this.presenceWatchers) {
      watchers.delete(watcherAddress);
      if (watchers.size === 0) {
        this.presenceWatchers.delete(watched);
      }
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────

  incrementMessagesRelayed(): void {
    this._stats.messagesRelayed++;
  }

  getStats(): RegistryStats & { uptime: number } {
    return {
      ...this._stats,
      channels: { ...this._stats.channels },
      uptime: Date.now() - this._stats.startTime,
    };
  }
}
