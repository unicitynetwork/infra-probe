# CLAUDE.md — Project context for AI coding agents

This file gives an AI agent everything it needs to work on `@unicitylabs/infra-probe` without re-deriving the design from scratch. Read this before making any non-trivial changes.

## What this project is

`unicity-infra-probe` is a **single-purpose CLI tool** that probes the availability and functional health of the live Unicity Network infrastructure:

- **Nostr relay** (`wss://nostr-relay.testnet.unicity.network` / `wss://relay.unicity.network`)
- **L3 Aggregator** (JSON-RPC over HTTPS)
- **IPFS gateway** (Kubo HTTP API + `/ipfs/*` path)
- **L1 Fulcrum** (Electrum-protocol over WSS, the Unicity ALPHA blockchain front)
- **Market / Intent database** (semantic-search REST API)

It is the canonical pre-flight gate for any e2e test suite that hits the live testnet/mainnet, and a hand-tool smoke test when something feels off.

## What it explicitly is *not*

- Not a continuous-monitoring system (use Grafana/Prometheus for that).
- Not a load tester.
- Not a wallet — it has no concept of identity persistence; every probe-generated keypair is single-shot and discarded.
- Not a dependency of `sphere-sdk` or any production code path. It is a standalone diagnostic.

## Hard rules

- **No build step.** Source files are runnable Node.js ESM. No TypeScript, no transpiler, no bundler. If you find yourself wanting one, stop and reconsider — it'd compromise the "clone-and-run-anywhere" property.
- **Minimal dependencies.** Only `ws` and `@noble/curves` are allowed. Adding a third dependency requires a strong justification in the commit message.
- **No SDK coupling.** The probe must NOT import from `@unicitylabs/sphere-sdk` or `@unicitylabs/state-transition-sdk`. The wire formats those SDKs use are reverse-engineered into this repo's source so the probe stays independent of SDK release cycles. If a wire format changes upstream, mirror it here in plain code with a comment pointing back to the SDK source.
- **Network-only — no local state.** The probe never writes to disk, never reads config files. Every input is CLI args + env vars. Every output is stdout/stderr.
- **Stateless on the relay/gateway side too.** Probes use ephemeral keypairs, `?pin=false` for IPFS adds, etc., so a successful probe leaves no persisted artifact on the upstream service.

## Folder layout (canonical — don't reorganise without strong reason)

```
unicity-infra-probe/
├── README.md                          # human-facing docs (usage, output shape, contributing)
├── CLAUDE.md                          # this file
├── CHANGELOG.md                       # versioned changelog (Keep-A-Changelog style)
├── LICENSE                            # MIT
├── package.json                       # npm metadata, ESM ("type": "module"), Node ≥ 20
├── package-lock.json                  # committed for reproducibility
├── .gitignore
├── .github/workflows/ci.yml           # lint+help job + live testnet probe job
├── bin/
│   └── unicity-infra-probe.mjs        # CLI entry — shebang #!/usr/bin/env node, executable
├── src/
│   ├── index.mjs                      # orchestration + runProbes() + exitCodeForReport()
│   ├── networks.mjs                   # endpoint config (mainnet/testnet/dev) + thresholds
│   ├── output.mjs                     # pretty + JSON renderers
│   └── probes/
│       ├── nostr.mjs                  # one file per service
│       ├── aggregator.mjs
│       ├── ipfs.mjs
│       ├── fulcrum.mjs
│       └── market.mjs
└── tests/
    └── smoke.test.mjs                 # Node --test runner; CI-friendly, no network
```

Add a new service: drop `src/probes/<name>.mjs` exporting `probeXxx(endpoint, opts)`, wire it into `src/index.mjs` (`SERVICES` array + `thunks` map) and `src/networks.mjs`. The renderers pick it up automatically.

## Probe contract (the API you must follow)

Every probe function returns this shape (extra service-specific fields are allowed — the renderers and tests don't enforce a closed schema):

```js
{
  service: string,        // 'nostr' | 'aggregator' | 'ipfs' | 'fulcrum' | 'market' | ...
  endpoint: string,       // human-readable URL
  status: 'healthy' | 'degraded' | 'unreachable' | 'error',
  latencyMs: number,      // overall probe wall-clock
  checks: [
    {
      name: string,       // e.g. 'connect', 'submit_commitment'
      status: 'pass' | 'fail' | 'warn',
      latencyMs?: number,
      message?: string,
      ...                 // service-specific fields fine (e.g. eventCount)
    }
  ],
  error?: string,         // top-level failure reason if status is unreachable/error
  timestamp: string,      // ISO-8601 UTC
  ...                     // service-specific (e.g. blockHeight, kuboVersion, chainTip)
}
```

The status enum and check fields are **shape-stable public API**. Don't rename or repurpose them without bumping the major version.

## Verdict logic

Per service:
- `unreachable` — the service is unusable for its intended purpose.
- `degraded` — works but slow, or some checks fail while others pass.
- `healthy` — all checks pass.

Aggregate across services → CLI exit code:
- `0` everything healthy
- `1` at least one degraded
- `2` at least one unreachable
- `3` internal CLI / arg error

These codes are **public contract** for downstream gate scripts. Don't change them.

## Liveness vs functional checks

Each probe runs **two layers**:

1. **Liveness** — cheap. "Is this endpoint reachable and minimally responsive?"
2. **Functional** — write+read+verify roundtrip. "Can a real wallet actually transact through this?"

The functional layer is what catches real outages that liveness misses. When adding a new probe, both layers should be there. See `src/probes/aggregator.mjs` `submit_commitment` + `get_inclusion_proof` for the canonical pattern.

## False-negative discipline

The probe is run by humans and CI. A false-negative — reporting a healthy service as broken — is the most expensive kind of error: it breaks trust, makes operators ignore real signals, and gates legitimate work behind phantom outages. Three principles:

1. **Functional checks are authoritative for the verdict; advisory checks are not.** A diagnostic broad-author indexed query is useful info, but a wallet doesn't depend on it. Demote it to `warn` and let the publish-and-confirm checks be the verdict driver. See `src/probes/nostr.mjs`'s `subscribe-kind:1` design.
2. **Adapt the verification to the protocol.** Per NIP-01, ephemeral Nostr kinds (20000-29999) are NOT stored — read-back returns 0 events on every healthy relay. A check that requires read-back for kind 25050 is a guaranteed false-negative. Classify each kind and pick the right verification.
3. **Isolate per-operation state.** Don't share a WebSocket across operations if the protocol allows per-connection misbehaviour. The Nostr probe opens a fresh socket per publish for exactly this reason — a hung REQ on one connection won't poison subsequent EVENTs.

When in doubt, **probe with raw cURL or a minimal raw-WebSocket script first** to confirm what the service actually does, then design the probe around that ground truth — not around what the SDK abstraction implies.

## Threshold calibration

Latency thresholds are inherently per-service. A 3 s GET is degraded; a 3 s semantic-search call is healthy. Don't apply uniform thresholds across services. Each probe owns its own threshold logic; document the reasoning inline (see `src/probes/market.mjs` 10 s threshold for `search`).

## Commit messages

Conventional Commits, scope = service or area:

```
feat(market): add semantic-search probe
fix(nostr): isolate each publish on a fresh WebSocket
docs: add CLAUDE.md for AI agent contributors
```

Body: explain *why*, not *what*. The diff shows what. The body should answer "what would I need to know to evaluate this six months from now?" — typically: the symptom that motivated the change, the root cause, the alternatives considered, and any non-obvious tradeoffs.

## Testing & CI

- `npm test` runs `node --test tests/`. Tests are fast and network-free; they validate argv parsing, contract shapes, and orchestration sanity.
- The CI job `lint-and-help` exercises `--help`, `--version`, and the bad-arg → exit-3 path. Deterministic.
- The CI job `live-probe-testnet` runs `--network testnet --format json` against the live testnet. **Informational** (`continue-on-error: true`) — the whole point of the tool is to detect testnet outages, so a degraded testnet should NOT fail this repo's CI.

## Releasing

1. Bump `version` in `package.json`.
2. Add a section to `CHANGELOG.md` (Keep-A-Changelog format).
3. Commit (`chore(release): vX.Y.Z`), tag (`vX.Y.Z`), push tag.
4. `npm publish --access public` (the `@unicitylabs` scope is public).

Pre-release sanity: `npm pack && tar -tf @unicitylabs-infra-probe-*.tgz` — confirm the tarball includes `bin/`, `src/`, `README.md`, `LICENSE`, and excludes `tests/`, `.github/`, and dotfiles.

## Pointers to upstream

- Endpoint authority: `@unicitylabs/sphere-sdk` `constants.ts` (`NETWORKS`, `DEFAULT_AGGREGATOR_URL`, `DEFAULT_NOSTR_RELAYS`, `DEFAULT_IPFS_GATEWAYS`, `DEFAULT_ELECTRUM_URL`, `DEFAULT_MARKET_API_URL`).
- Aggregator wire format: `@unicitylabs/state-transition-sdk` `lib/api/{SubmitCommitmentRequest,RequestId,Authenticator}.js` + `lib/hash/{DataHash,HashAlgorithm}.js`.
- Fulcrum protocol: any Electrum client; the unicity webwallet `index.html` `electrumRequest` helper is a good reference.
- Nostr protocol: NIPs at https://github.com/nostr-protocol/nips — especially NIP-01 §16 (event-kind classification: regular / replaceable / ephemeral / parameterized replaceable).

If you change endpoints, mirror the SDK's `constants.ts` exactly; if the SDK introduces a new endpoint type, add a probe.
