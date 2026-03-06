export { createRelay } from './relay.js';
export { PeerRegistry } from './registry.js';
export { BlobStore } from './blobStore.js';
export { RateLimiter } from './rateLimiter.js';
export { sendMessage, parsePeerUrl, isValidKeyFormat } from './utils.js';
export { KEY_FORMAT } from './types.js';
export { EnvKeyStore } from './envKeyStore.js';
export { FileKeyStore } from './fileKeyStore.js';
export { TrafficMeter } from './trafficMeter.js';
export type { FileKeyStoreOptions } from './fileKeyStore.js';

export type {
  RelayConfig,
  RelayInstance,
  RelayHooks,
  ChannelConfig,
  Peer,
  PeerAddress,
  ExtendedWebSocket,
  BlobStoreConfig,
  BlobStoreInterface,
  KeyStoreInterface,
  KeyWindowStats,
  PeerRegistryInterface,
  RegistryStats,
} from './types.js';
