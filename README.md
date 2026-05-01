# unicity-infra-probe

Tiny availability + performance probe for [Unicity Network](https://unicity.network) infrastructure.

Designed as a **pre-flight gate** for end-to-end test suites and a **5-second smoke test** when something feels off. Runs five parallel probes — Nostr relay, L3 Aggregator, IPFS gateway, L1 Fulcrum, and the Market intent database — exercises both the **liveness** of each endpoint and the **functional write+read+verify path** real wallet flows depend on, then reports per-check latency in either a colored human-readable format or single-line JSON.

```
✅ aggregator   https://goggregator-test.unicity.network
   ✓ health                  60ms   healthy (db ok, 2 shards ok, 60ms)
   ✓ json-rpc                 7ms   OK — structured error: Shard ID not found: 0
   ✓ submit_commitment       39ms   accepted (status=SUCCESS, 39ms)
   ✓ get_inclusion_proof      7ms   proof returned in 7ms
   Status: HEALTHY (4/4 checks passed)

✅ nostr        wss://nostr-relay.testnet.unicity.network
   ✓ connect                 87ms   WebSocket handshake OK
   ✓ subscribe-kind:1        71ms   EOSE in 71ms (5 event(s))
   ✓ publish-kind:1         190ms   published+stored (190ms; read-back 1 event)
   ✓ publish-kind:4         182ms   published+stored (182ms; read-back 1 event)
   ✓ publish-kind:1059      187ms   published+stored (187ms; read-back 1 event)
   ✓ publish-kind:30078     201ms   published+stored (201ms; read-back 1 event)
   ✓ publish-kind:31113     179ms   published+stored (179ms; read-back 1 event)
   ✓ publish-kind:31115     183ms   published+stored (183ms; read-back 1 event)
   ✓ publish-kind:31116     176ms   published+stored (176ms; read-back 1 event)
   ✓ publish-kind:9         185ms   published+stored (185ms; read-back 1 event)
   ✓ publish-kind:25050     181ms   published+stored (181ms; read-back 1 event)
   ✓ publish-kind:30000     188ms   published+stored (188ms; read-back 1 event)
   Status: HEALTHY

✅ ipfs         https://unicity-ipfs1.dyndns.org
   ✓ kubo-api               230ms   Kubo 0.39.0
   ✓ gateway-route            3ms   HTTP 200 (image/jpeg, 3ms)
   ✓ ipfs-add                 6ms   cid=bafkreieu5rue4yh55meuurfzeedvxmpn6riogv4goo6nxg6gn6kxnovv3m
   ✓ ipfs-fetch              17ms   byte-identical roundtrip (256 bytes, 17ms)
   Status: HEALTHY (4/4 checks passed)

✅ fulcrum      wss://fulcrum.unicity.network:50004
   ✓ connect                 35ms   WebSocket handshake OK
   ✓ server.version           3ms   Fulcrum 1.12.0
   ✓ chain-tip               24ms   block 501098
   ✓ chain-tip-fresh          0ms   tip is 0.8min old (target 2min)
   ✓ tx-index                 2ms   tx@501097:0 = df056744adac3761…
   Status: HEALTHY (5/5 checks passed)

✅ market       https://market-api.unicity.network
   ✓ search                3708ms   20 intent(s) returned (3708ms)
   ✓ feed-recent           1016ms   10 listing(s) returned (1016ms)
   Status: HEALTHY (2/2 checks passed)

  Summary: 5 HEALTHY, 0 DEGRADED, 0 UNREACHABLE  (of 5)
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

**Liveness:**
1. **connect** — WebSocket TLS + handshake.
2. **subscribe-kind:1** — sends `["REQ", id, {kinds:[1], limit:5}]`; times REQ → first message AND REQ → EOSE. A relay that returns events but never EOSEs is distinguished from one that's wholly silent.

**Functional (write+confirm across every Unicity-used kind):**
3. **publish-kind:N** for each of `1, 4, 9, 1059, 25050, 30000, 30078, 31113, 31115, 31116`. Each kind:
   - signs an ephemeral event with a fresh single-shot keypair;
   - sends `["EVENT", e]` and waits for `["OK", id, true, ...]` (write path);
   - re-queries `{kinds:[N], authors:[ourPubkey]}` and confirms the event is stored (indexed read path).

The relay must accept and store each kind for production wallet flows to work end-to-end. Each ephemeral keypair is generated per-publish and never persisted — the probe leaves only short-lived events signed by random pubkeys.

### Aggregator (L3)

**Liveness:**
1. **health** — `GET /health`. Operator-facing endpoint; returns `{ status, database, aggregators: {...} }`.
2. **json-rpc** — `POST` with a deliberately-invalid `shardId`. A structured `Shard ID not found` reply is healthy (proves the JSON-RPC handler is alive); a non-JSON reply is failure.

**Functional (full submit + retrieve roundtrip):**
3. **submit_commitment** — generates an ephemeral secp256k1 keypair, builds a fully-signed `SubmitCommitmentRequest` (canonical wire format mirrored from `@unicitylabs/state-transition-sdk`: DataHash imprints, RequestId = SHA-256(pubkey ‖ stateImprint), 65-byte recoverable signature), and submits.
4. **get_inclusion_proof** — polls for the inclusion proof of the just-submitted commitment for up to 5 s. A returned proof confirms the WRITE was actually persisted into the SMT and is retrievable through the read API.

### IPFS gateway

**Liveness:**
1. **kubo-api** — `POST /api/v0/version`; returns Kubo version info.
2. **gateway-route** — `HEAD /ipfs/<canonical-cid>`; verifies path routing.

**Functional (write+read+verify roundtrip):**
3. **ipfs-add** — uploads ~256 bytes of random content via `POST /api/v0/add?pin=false&cid-version=1`. `pin=false` keeps the probe stateless: the node will GC the bytes on its next sweep, so we don't need to call `pin/rm` (which the unicity gateway has locked down anyway).
4. **ipfs-fetch** — `GET /ipfs/<just-added-cid>` and asserts byte-identical content match. The byte-comparison is critical because the unicity gateway has been observed to return a placeholder JPEG (HTTP 200 + `image/jpeg`) for unpinned/missing CIDs — a "HTTP 200 = OK" check would false-pass.

### L1 Fulcrum (ALPHA blockchain Electrum server)

**Liveness:**
1. **connect** — WSS handshake.
2. **server.version** — Electrum-protocol handshake.
3. **chain-tip** — `blockchain.headers.subscribe`; current block height + header.

**Functional:**
4. **chain-tip-fresh** — decodes the block-header timestamp (offset 68, LE uint32) and asserts it's recent. Healthy: <30 min old. Warn: <2 h. Fail: ≥2 h. ALPHA target block time is 2 min so the typical age is sub-minute.
5. **tx-index** — `blockchain.transaction.id_from_pos [tipHeight − 1, 0]`; verifies the node serves indexed historical data, not just the live tip. This is the path wallet history rebuilds and address subscriptions depend on.

### Market / Intent database

**Liveness:**
1. **search** — `POST /api/search` with `{query: "test"}`. Healthy: HTTP 200 + JSON body whose `intents` field is an array (possibly empty). This one call exercises the embedding pipeline (semantic search) end-to-end.

**Functional:**
2. **feed-recent** — `GET /api/feed/recent`. Cross-checks the search engine against the raw feed. If search works but feed/recent doesn't, the embedding pipeline is sick; if both work, the database is fully online.

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
      "service": "aggregator",
      "endpoint": "https://goggregator-test.unicity.network",
      "status": "healthy",
      "latencyMs": 92,
      "checks": [
        { "name": "health",              "status": "pass", "latencyMs":  43, "message": "healthy (db ok, 2 shards ok, 43ms)" },
        { "name": "json-rpc",            "status": "pass", "latencyMs":   9, "message": "OK — structured error: Shard ID not found: 0" },
        { "name": "submit_commitment",   "status": "pass", "latencyMs":  34, "message": "accepted (status=SUCCESS, 34ms)" },
        { "name": "get_inclusion_proof", "status": "pass", "latencyMs":   5, "message": "proof returned in 5ms" }
      ],
      "timestamp": "2026-05-01T16:23:45.832Z"
    }
    // ...
  ],
  "summary": { "total": 5, "healthy": 5, "degraded": 0, "unreachable": 0 }
}
```

## License

MIT — see [LICENSE](./LICENSE).
