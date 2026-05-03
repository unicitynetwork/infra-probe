# Changelog

All notable changes to `@unicitylabs/infra-probe` are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-05-03

First publishable release. Three rounds of probe-correctness work since the initial cut, plus documentation and packaging hardening.

### Added

- **`market` probe** for the Unicity intent-database semantic-search service (`https://market-api.unicity.network`). Two checks: `search` exercises the embedding pipeline end-to-end (`POST /api/search`); `feed-recent` cross-checks against the raw feed (`GET /api/feed/recent`).
- **Functional checks across every service** — write+read+verify roundtrips, not just liveness:
  - **aggregator**: `submit_commitment` (canonical secp256k1-signed commitment with a single-shot keypair) + `get_inclusion_proof` (polled). Wire format mirrored from `@unicitylabs/state-transition-sdk`.
  - **ipfs**: `ipfs-add` (256 random bytes, `?pin=false`) + `ipfs-fetch` (byte-identical roundtrip assertion — defeats the gateway's placeholder-JPEG behaviour for unpinned CIDs).
  - **fulcrum**: `chain-tip-fresh` (parses block-header timestamp at offset 68; ALPHA's 112-byte headers handled) + `tx-index` (`blockchain.transaction.id_from_pos`).
  - **nostr**: `publish-kind:N` for every Unicity-emitted kind (1, 4, 1059, 25050, 30078, 31113, 31115, 31116). Each kind classified per NIP-01 (regular / replaceable / ephemeral) with verification adapted accordingly; ephemeral kinds skip read-back.
- **`tests/`** directory with `node --test`-runnable smoke tests for argv, contracts, and renderer sanity. CI runs them in the `lint-and-help` job.
- **`CLAUDE.md`** — project context for AI coding agents.

### Changed

- **Nostr probe**: each publish now runs on a **fresh WebSocket** rather than a shared one, defeating per-connection state issues at the relay (a hung REQ no longer poisons subsequent EVENTs). The advisory `subscribe-kind:1` runs on a dedicated diagnostic socket, downgraded to `warn` on failure so it never gates the verdict.
- **Aggregator probe**: switched primary liveness from `get_block_height` (requires shard routing knowledge) to `GET /health` — operator-facing endpoint, no API-key dance, returns rich db+shard state. JSON-RPC plane sanity now correctly handles HTTP 4xx with a structured JSON error body as proof-of-life.
- **IPFS probe**: dropped the byte-content assertion for an external "hello world" CID (the unicity gateway returns a placeholder JPEG for unknown CIDs). Now uploads ephemeral random bytes via `?pin=false` and asserts byte-identical roundtrip.
- **Market probe**: search latency `warn` threshold raised from 3 s to 10 s — semantic search has a different latency profile from a flat REST GET, so 1-8 s is normal load, not degradation.
- **Pretty renderer**: per-service extras (`blockHeight`, `chainTip`, `kuboVersion`) surfaced under each service block.

### Fixed

- **Nostr false-negative #1 — early abort.** Previously, a single advisory `subscribe-kind:1` failure aborted the entire probe with `unreachable`. Now it's diagnostic-only; the publish-and-confirm phase always runs.
- **Nostr false-negative #2 — read-back for ephemeral kinds.** Per NIP-01 §16, kinds 20000-29999 (composing indicator, etc.) are NOT stored; the v0.1.0 probe expected read-back to find them and reported `fail` on every healthy relay. Now classified and skipped.
- **Nostr false-negative #3 — wrong-relay kind.** Kind 9 (NIP-29 group chat) was probed against the wallet relay; that's a different relay's responsibility. Removed from this probe; a future `groupchat` probe will cover NIP-29.
- **Nostr handler leak.** `runSubProbe`'s `onMsg` listener was leaked on the timer path (harmless but unhygienic). Now removed in both branches.
- **Aggregator HTTP 4xx false-negative.** A structured JSON-RPC error body returned with HTTP 4xx (e.g. "Shard ID not found: 0") is the JSON-RPC plane proving it's alive. Previously misreported as `fail`.
- **Fulcrum 112-byte header parsing.** ALPHA block headers are 112 bytes (vs Bitcoin's canonical 80). Header parsing now tolerates `>= 80 bytes` so the freshness check works.

## [0.2.0] — 2026-05-01 (internal)

Functional probes added (write+read+verify across all 5 services). Not published to npm; see 0.3.0 for the consolidated release notes.

## [0.1.0] — 2026-05-01 (internal)

Initial release. Liveness-only probes for nostr, aggregator, ipfs, fulcrum. Pretty + JSON output. Documented exit codes. Not published to npm.

[0.3.0]: https://github.com/unicitynetwork/infra-probe/releases/tag/v0.3.0
[0.2.0]: https://github.com/unicitynetwork/infra-probe/releases/tag/v0.2.0
[0.1.0]: https://github.com/unicitynetwork/infra-probe/releases/tag/v0.1.0
