/**
 * Aggregator (L3) probe.
 *
 * Liveness checks:
 *   1. `GET /health` — operator-facing liveness endpoint.
 *   2. `POST /` JSON-RPC plane sanity (any structured reply counts as alive).
 *
 * Functional check:
 *   3. `submit_commitment` — generates an ephemeral secp256k1 keypair,
 *      signs a random transaction hash with a canonical authenticator,
 *      submits the commitment, then verifies the resulting inclusion
 *      proof exists via `get_inclusion_proof`. This exercises the same
 *      code path real wallets use to write state transitions.
 *
 * The wire format is reverse-engineered from
 * `@unicitylabs/state-transition-sdk` so the probe stays SDK-version-
 * independent. See `signCommitment` for the canonical rules:
 *   - DataHash imprint = [algorithm-uint16-BE, hash-bytes]; SHA256 = 0x0000.
 *   - RequestId = SHA256(publicKey || stateHash.imprint), wrapped in DataHash.
 *   - Signature wire = r || s || recovery (65 bytes; recovery is 0 or 1).
 *   - Authenticator JSON = { algorithm: "secp256k1", publicKey, signature, stateHash }.
 */

import { randomBytes, createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { DEFAULT_AGGREGATOR_API_KEY } from '../networks.mjs';

export async function probeAggregator(url, { timeoutMs = 10_000, apiKey = DEFAULT_AGGREGATOR_API_KEY } = {}) {
  const checks = [];
  const overallStart = Date.now();
  const base = url.replace(/\/+$/, '');

  const finalize = (status, error, extras = {}) => ({
    service: 'aggregator',
    endpoint: url,
    status,
    latencyMs: Date.now() - overallStart,
    checks,
    error,
    timestamp: new Date().toISOString(),
    ...extras,
  });

  // ---- 1. /health ----
  const healthStart = Date.now();
  try {
    const response = await fetchWithTimeout(`${base}/health`, { method: 'GET' }, timeoutMs);
    const latencyMs = Date.now() - healthStart;
    if (!response.ok) {
      checks.push({ name: 'health', status: 'fail', latencyMs, message: `HTTP ${response.status} ${response.statusText}` });
      return finalize('unreachable', `health endpoint returned HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => null);
    const databaseOk = body?.database === 'ok';
    const allShardsOk = body?.aggregators ? Object.values(body.aggregators).every((v) => v === 'ok') : true;
    const happy = body?.status === 'healthy' && databaseOk && allShardsOk;
    checks.push({
      name: 'health',
      status: happy ? (latencyMs > 2_000 ? 'warn' : 'pass') : 'fail',
      latencyMs,
      message: happy ? formatHealthBody(body, latencyMs) : `unhealthy: ${JSON.stringify(body).slice(0, 160)}`,
    });
    if (!happy) return finalize('degraded', 'health endpoint reports degraded state');
  } catch (err) {
    checks.push({ name: 'health', status: 'fail', latencyMs: Date.now() - healthStart, message: errMsg(err) });
    return finalize('unreachable', errMsg(err));
  }

  // ---- 2. JSON-RPC plane sanity ----
  // The aggregator returns HTTP 4xx alongside a structured JSON error body
  // for client-side issues (e.g. our deliberately invalid `shardId: '0'`).
  // That's still proof-of-life for the JSON-RPC handler.
  const rpcStart = Date.now();
  try {
    const response = await postJson(base, { jsonrpc: '2.0', id: Date.now(), method: 'get_block_height', params: { shardId: '0' } }, { timeoutMs, apiKey });
    const latencyMs = Date.now() - rpcStart;
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    const ok = json !== null && (json.result !== undefined || json.error !== undefined);
    checks.push({
      name: 'json-rpc',
      status: ok ? (latencyMs > 2_000 ? 'warn' : 'pass') : 'fail',
      latencyMs,
      message: ok
        ? json.result !== undefined
          ? `OK — result=${JSON.stringify(json.result).slice(0, 80)}`
          : `OK — structured error: ${typeof json.error === 'string' ? json.error : json.error?.message ?? JSON.stringify(json.error).slice(0, 80)}`
        : `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 120)}`,
    });
  } catch (err) {
    checks.push({ name: 'json-rpc', status: 'fail', latencyMs: Date.now() - rpcStart, message: errMsg(err) });
  }

  // ---- 3. submit_commitment (functional) ----
  // Build a complete, valid commitment with an ephemeral keypair and submit
  // it. A successful submission proves the entire write path: signing,
  // serialization, JSON-RPC, validation, and aggregator persistence.
  const submitStart = Date.now();
  let submitted; // { requestId, transactionHash, ... }
  try {
    submitted = await signCommitment();
    const response = await postJson(base, {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'submit_commitment',
      params: {
        requestId: submitted.requestIdHex,
        transactionHash: submitted.transactionHashHex,
        authenticator: submitted.authenticator,
        receipt: false,
      },
    }, { timeoutMs, apiKey });
    const latencyMs = Date.now() - submitStart;
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!json || (json.error !== undefined && json.result === undefined)) {
      checks.push({
        name: 'submit_commitment',
        status: 'fail',
        latencyMs,
        message: json?.error
          ? `aggregator rejected: ${typeof json.error === 'string' ? json.error : json.error?.message ?? JSON.stringify(json.error)}`
          : `unexpected response: HTTP ${response.status} ${text.slice(0, 120)}`,
      });
    } else {
      // The aggregator response shape varies by version. SUCCESS is the
      // canonical positive ack; we accept any 200 with a `result` field.
      const status = json.result?.status ?? 'OK';
      checks.push({
        name: 'submit_commitment',
        status: latencyMs > 3_000 ? 'warn' : 'pass',
        latencyMs,
        message: `accepted (status=${status}, ${latencyMs}ms)`,
      });
    }
  } catch (err) {
    checks.push({ name: 'submit_commitment', status: 'fail', latencyMs: Date.now() - submitStart, message: errMsg(err) });
  }

  // ---- 4. get_inclusion_proof for the just-submitted commitment ----
  // Verifies the WRITE was actually persisted and the read path matches.
  // Inclusion proofs are only available a moment after the commit lands
  // (the aggregator batches into the SMT) — we poll for up to 5 s.
  if (submitted) {
    const proofStart = Date.now();
    const proofDeadline = proofStart + Math.min(5_000, timeoutMs);
    let lastErr;
    let proofResult;
    while (Date.now() < proofDeadline) {
      try {
        const response = await postJson(base, {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'get_inclusion_proof',
          params: { requestId: submitted.requestIdHex },
        }, { timeoutMs: Math.max(1_000, proofDeadline - Date.now()), apiKey });
        const json = await response.json().catch(() => null);
        if (json?.result) { proofResult = json.result; break; }
        lastErr = json?.error
          ? typeof json.error === 'string' ? json.error : json.error.message ?? JSON.stringify(json.error)
          : `HTTP ${response.status}`;
      } catch (err) {
        lastErr = errMsg(err);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const latencyMs = Date.now() - proofStart;
    if (proofResult) {
      checks.push({
        name: 'get_inclusion_proof',
        status: latencyMs > 3_000 ? 'warn' : 'pass',
        latencyMs,
        message: `proof returned in ${latencyMs}ms`,
      });
    } else {
      checks.push({
        name: 'get_inclusion_proof',
        status: 'fail',
        latencyMs,
        message: `no proof within ${latencyMs}ms (last: ${lastErr ?? 'unknown'})`,
      });
    }
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const slow = checks.filter((c) => c.status === 'warn').length;
  const status = failed > 0 ? (failed >= 2 ? 'unreachable' : 'degraded') : slow > 0 ? 'degraded' : 'healthy';
  return finalize(status);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatHealthBody(body, latencyMs) {
  const shardCount = body?.aggregators ? Object.keys(body.aggregators).length : 0;
  return `${body.status} (db ${body.database}, ${shardCount} shard${shardCount === 1 ? '' : 's'} ok, ${latencyMs}ms)`;
}

const SHA256_ALG_BYTES = new Uint8Array([0x00, 0x00]); // DataHash imprint algorithm prefix for SHA256

function sha256Bytes(input) {
  return Uint8Array.from(createHash('sha256').update(input).digest());
}

function imprintForSha256(hashBytes) {
  const out = new Uint8Array(2 + hashBytes.length);
  out.set(SHA256_ALG_BYTES, 0);
  out.set(hashBytes, 2);
  return out;
}

function bytesToHex(b) { return Buffer.from(b).toString('hex'); }

/**
 * Build a fresh, fully-signed commitment with an ephemeral keypair.
 *
 * Mirrors `@unicitylabs/state-transition-sdk` Authenticator + RequestId
 * canonical encoding without depending on the SDK package itself. See
 * the file-level docstring for the wire-format rules.
 */
async function signCommitment() {
  const privateKey = randomBytes(32);
  const publicKey = secp256k1.getPublicKey(privateKey, true); // 33 bytes compressed

  // State hash = SHA256(random 32 bytes), wrapped as a DataHash imprint.
  const stateData = sha256Bytes(randomBytes(32));
  const stateImprint = imprintForSha256(stateData);

  // RequestId = SHA256(publicKey || stateImprint), wrapped as a DataHash imprint.
  const reqIdInner = sha256Bytes(Buffer.concat([publicKey, stateImprint]));
  const requestIdImprint = imprintForSha256(reqIdInner);

  // Transaction hash = SHA256(random 32 bytes), wrapped as a DataHash imprint.
  const transactionData = sha256Bytes(randomBytes(32));
  const transactionImprint = imprintForSha256(transactionData);

  // The signing input is the inner hash (`hash.data` per the SDK), NOT
  // the full imprint — the algorithm-prefix bytes are excluded.
  const signature = secp256k1.sign(transactionData, privateKey, { format: 'recovered', prehash: false });
  const sigBytes = signature.toCompactRawBytes(); // 64 bytes (r || s)
  const sigWire = new Uint8Array(65);
  sigWire.set(sigBytes, 0);
  sigWire[64] = signature.recovery;             // 1 byte recovery (0 or 1)

  return {
    privateKey,
    publicKey,
    stateImprint,
    requestIdImprint,
    transactionImprint,
    requestIdHex: bytesToHex(requestIdImprint),
    transactionHashHex: bytesToHex(transactionImprint),
    authenticator: {
      algorithm: 'secp256k1',
      publicKey: bytesToHex(publicKey),
      signature: bytesToHex(sigWire),
      stateHash: bytesToHex(stateImprint),
    },
  };
}

async function postJson(url, payload, { timeoutMs, apiKey } = {}) {
  return fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    body: JSON.stringify(payload),
  }, timeoutMs);
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
