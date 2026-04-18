# Changelog

All notable changes to this project will be documented in this file.

## [0.1.2]

### Added

- `RelayHooks.verifyPeer` — async pre-registration hook for cryptographically verifying connecting peers. Runs after URL parsing and key validation, **before** duplicate resolution and registry insertion. Receives `{ parsed, req, ip, key, registry }` and returns `{ ok: true }` or `{ ok: false, reason?, closeCode?, errorCode? }`. When verification fails the peer is never added to the registry, watchers are not notified, and `onDuplicate` is not evaluated — a failed verify cannot evict a legitimate peer.
- `VerifyPeerContext` and `VerifyPeerResult` types exported from the package root.

Existing consumers that do not supply `verifyPeer` see identical behavior to 0.1.1.

## [0.1.1]

- Changed rate limiter from window-based to concurrent connection counter.

## [0.1.0]

- Initial public release.
