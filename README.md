# unicity-infra-probe

Tiny availability + performance probe for [Unicity Network](https://unicity.network) infrastructure.

Designed as a **pre-flight gate** for end-to-end test suites and a **5-second smoke test** when something feels off. Runs four parallel probes — Nostr relay, L3 Aggregator, IPFS gateway, L1 Fulcrum — and reports per-check latency in either a colored human-readable format or single-line JSON for downstream parsing.

```
✅ nostr        wss://nostr-relay.testnet.unicity.network
   ✓ connect                   87ms   WebSocket handshake OK
   ✓ subscribe-kind:1          71ms   EOSE in 71ms (5 event(s))
   ✓ publish-kind:1           158ms   OK accepted=true
   ✓ read-back                 70ms   1 event(s) returned
   Status: HEALTHY (4/4 checks passed)

✅ aggregator   https://goggregator-test.unicity.network
   ✓ get_block_height         240ms   block 1234567
   Status: HEALTHY (1/1 checks passed)
   block height: 1234567

⚠️  ipfs         https://unicity-ipfs1.dyndns.org
   ✓ liveness                  41ms   HTTP 200 OK
   ✓ kubo-api                  93ms   Kubo 0.18.1
   ⚠ fetch-known-cid         5734ms   OK (5734ms — slow, cold cache?)
   Status: DEGRADED (2/3 checks passed)

✅ fulcrum      wss://fulcrum.unicity.network:50004
   ✓ connect                  142ms   WebSocket handshake OK
   ✓ server.version            34ms   Fulcrum 1.10.0
   ✓ chain-tip                 42ms   block 250123
   Status: HEALTHY (3/3 checks passed)
   chain tip: 250123

  Summary: 3 HEALTHY, 1 DEGRADED, 0 UNREACHABLE  (of 4)
```

## Install

```sh
# From npm (once published)
npm install -g @unicitylabs/infra-probe

# From source
git clone https://github.com/unicitynetwork/infra-probe
cd infra-probe
npm install
npm start
```

Requires Node.js ≥ 20.

## Usage

```sh
unicity-infra-probe                                       # testnet, pretty
unicity-infra-probe --network mainnet                     # mainnet
unicity-infra-probe --format json                         # one-line JSON
unicity-infra-probe --format json --pretty-json           # indented JSON
unicity-infra-probe --only nostr,aggregator               # subset
unicity-infra-probe --timeout 5000                        # tighter ceiling
unicity-infra-probe --quiet                               # only summary line
unicity-infra-probe --no-color                            # piped-output friendly
```

### Pre-flight gate for an e2e suite

```sh
# Bash
unicity-infra-probe --quiet || { echo "infra unhealthy — skipping e2e"; exit 1; }
npm run test:e2e

# JSON-aware (parse exit code AND service detail)
report=$(unicity-infra-probe --format json)
nostr_status=$(echo "$report" | jq -r '.services[] | select(.service=="nostr") | .status')
[ "$nostr_status" = "healthy" ] || exit 1
```

### CI / scripted use

The CLI exits with a status code derived from the probe outcome:

| Exit | Meaning |
|--:|---|
| `0` | every probed service is healthy |
| `1` | at least one service degraded (slow, partial) |
| `2` | at least one service unreachable (down) |
| `3` | internal CLI error (bad args, etc.) |

The JSON output is **shape-stable** — service names, check names, status enums (`healthy`/`degraded`/`unreachable`/`error` for services; `pass`/`fail`/`warn` for checks), and key field names are part of the public API. New optional fields may be added; existing fields will not be renamed without a major version bump.

## What each probe checks

### Nostr relay

1. **connect** — WebSocket TLS + handshake.
2. **subscribe-kind:1** — sends `["REQ", id, {kinds:[1], limit:5}]`; times REQ → first message AND REQ → EOSE. A relay that returns events but never EOSEs is distinguished from one that's wholly silent.
3. **publish-kind:1** — signs an ephemeral kind:1 with a single-shot keypair, sends `["EVENT", e]`; waits for `["OK", id, true, ...]`.
4. **read-back** — subscribes to `{kinds:[1], authors:[ourPubkey]}` and confirms the event we just published is returned.

The ephemeral keypair is generated per-run and never persisted — the probe leaves only an ephemeral text-note signed by an unrecognised pubkey.

### Aggregator (L3)

1. **get_block_height** — JSON-RPC `get_block_height` over HTTPS. Healthy aggregators return `{ blockNumber: N }` within a few hundred milliseconds.

The probe sends the SDK's public API key (`X-API-Key` header) by default; override via `--api-key` for higher-rate-limit lanes.

### IPFS gateway

1. **liveness** — `HEAD /` to the gateway origin.
2. **kubo-api** — `POST /api/v0/version` (Kubo HTTP API). `warn` if the API is not exposed on the gateway (`HTTP 404`); `pass` if it returns the Kubo version JSON.
3. **fetch-known-cid** — `GET /ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy`, the canonical "hello world\n" file used by Kubo's smoke tests. `pass` on byte-identical content within 5 s; `warn` on byte-identical but slow (cold cache); `fail` on mismatch or HTTP error.

### L1 Fulcrum (ALPHA blockchain Electrum server)

1. **connect** — WSS handshake.
2. **server.version** — Electrum-protocol handshake; returns server software string + protocol version.
3. **chain-tip** — `blockchain.headers.subscribe`; returns current block height + 80-byte header hex. Rising height across runs = "L1 is making blocks".

## Embedding

```js
import { runProbes, exitCodeForReport } from '@unicitylabs/infra-probe';

const report = await runProbes({ network: 'testnet', only: ['nostr', 'aggregator'] });
console.log(JSON.stringify(report.summary)); // { total: 2, healthy: 2, degraded: 0, unreachable: 0 }
process.exit(exitCodeForReport(report));
```

## Adding a new probe

1. Add an `mjs` file under `src/probes/` exporting a `probeXxx(endpoint, opts)` function. Return a service-shaped object: `{ service, endpoint, status, latencyMs, checks, error?, timestamp }`. The `status` enum is `'healthy' | 'degraded' | 'unreachable' | 'error'`. Each entry of `checks` follows `{ name, status: 'pass'|'fail'|'warn', latencyMs?, message? }`.
2. Wire the probe into `src/index.mjs` (`SERVICES` array + `thunks` map) and add the endpoint to `src/networks.mjs`.
3. The pretty + JSON renderers pick up the new service automatically.

## Output shape

```jsonc
{
  "network": "testnet",
  "networkLabel": "Testnet",
  "startedAt": "2026-05-01T16:23:45.000Z",
  "completedAt": "2026-05-01T16:23:51.000Z",
  "services": [
    {
      "service": "nostr",
      "endpoint": "wss://nostr-relay.testnet.unicity.network",
      "status": "healthy",
      "latencyMs": 446,
      "checks": [
        { "name": "connect",            "status": "pass", "latencyMs":  87, "message": "WebSocket handshake OK" },
        { "name": "subscribe-kind:1",   "status": "pass", "latencyMs":  71, "message": "EOSE in 71ms (5 event(s))", "eventCount": 5 },
        { "name": "publish-kind:1",     "status": "pass", "latencyMs": 158, "message": "OK accepted=true" },
        { "name": "read-back",          "status": "pass", "latencyMs":  70, "message": "1 event(s) returned" }
      ],
      "timestamp": "2026-05-01T16:23:45.000Z"
    }
    // ...
  ],
  "summary": { "total": 4, "healthy": 4, "degraded": 0, "unreachable": 0 }
}
```

## License

MIT — see [LICENSE](./LICENSE).
