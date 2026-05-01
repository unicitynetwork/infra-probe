/**
 * Nostr relay probe.
 *
 * Liveness checks (cheap):
 *   1. Connect (WebSocket TLS handshake).
 *   2. Subscribe `kind:1, limit:5` — REQ → EOSE roundtrip; **diagnostic
 *      only**, never aborts the rest of the probe. The unicity testnet
 *      relay's broad-author indexed query path has been observed to
 *      degrade independently from the publish + author-indexed read-back
 *      paths that wallets actually use, so this single check is NOT a
 *      reliable signal of overall relay health. We capture its latency
 *      so operators can correlate with relay-side observability, but
 *      we don't gate publish-and-confirm on it.
 *
 * Functional checks (write+read across every kind Unicity uses):
 *   3. publish-and-confirm-kind:N for every entry of UNICITY_NOSTR_KINDS,
 *      each with a freshly-generated ephemeral keypair (so per-kind acks
 *      are isolated). Each kind is classified as regular/replaceable/
 *      ephemeral, and the verification adapts:
 *        regular     — sign + send EVENT, wait for OK true, then re-query
 *                      authors:[ourPubkey] kinds:[N] and confirm storage.
 *        replaceable — same as regular (parameterized replaceable
 *                      kinds 30000+ are stored with a d-tag; we always
 *                      attach one, so read-back finds it).
 *        ephemeral   — sign + send EVENT, wait for OK true. Skip read-back
 *                      because per NIP-01 the relay MUST NOT store kinds
 *                      in 20000-29999. A read-back-required check would
 *                      false-fail every healthy relay for kind 25050.
 *
 * Each ephemeral keypair is single-use — the probe leaves only short-
 * lived events signed by random pubkeys. NIP-04 + NIP-17 envelopes
 * carry placeholder ciphertext; we don't encrypt anything because the
 * relay's job is store-and-forward, not validation of payloads.
 *
 * Excluded kinds (intentional):
 *   - kind 9 (NIP-29 group chat): lives on a separate group-chat relay
 *     (`DEFAULT_GROUP_RELAYS` in the SDK), not the wallet relay. Probing
 *     it here would either succeed by accident (relay treats as regular)
 *     or fail meaninglessly (relay rejects without group-h-tag), neither
 *     of which is useful info about the wallet relay.
 */

import WebSocket from 'ws';
import { randomBytes, createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

/**
 * Every Nostr event kind the Unicity wallet (sphere-sdk + nostr-js-sdk)
 * actually emits against the wallet relay. Mirrors NOSTR_EVENT_KINDS +
 * COMPOSING_INDICATOR_KIND in the SDK. Each entry is annotated with its
 * NIP-01 classification so we can pick the right verification strategy:
 *
 *   regular     — relays MUST store; we read back to confirm storage.
 *   replaceable — kinds 30000-39999, stored per (pubkey, kind, d-tag);
 *                 we attach a d-tag and read back.
 *   ephemeral   — kinds 20000-29999, dispatched live but NOT stored;
 *                 read-back returns 0 events even on a healthy relay,
 *                 so we only verify the OK ack.
 */
const UNICITY_NOSTR_KINDS = [
  { kind: 1,     classification: 'regular',     label: 'broadcast / text-note (NIP-01)' },
  { kind: 4,     classification: 'regular',     label: 'legacy DM (NIP-04)' },
  { kind: 1059,  classification: 'regular',     label: 'gift wrap (NIP-17)' },
  { kind: 25050, classification: 'ephemeral',   label: 'composing indicator (NIP-59)' },
  { kind: 30078, classification: 'replaceable', label: 'app-data / nametag binding (NIP-78)' },
  { kind: 31113, classification: 'replaceable', label: 'token transfer (Unicity custom)' },
  { kind: 31115, classification: 'replaceable', label: 'payment request (Unicity custom)' },
  { kind: 31116, classification: 'replaceable', label: 'payment request response (Unicity custom)' },
];

function bytesToHex(b) { return Buffer.from(b).toString('hex'); }
function hexToBytes(h) { return Uint8Array.from(Buffer.from(h, 'hex')); }
function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }

function signEvent(privKeyHex, e) {
  const serialized = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  const id = sha256Hex(serialized);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(privKeyHex)));
  return { ...e, id, sig };
}

export async function probeNostrRelay(url, { timeoutMs = 60_000 } = {}) {
  const checks = [];
  const overallStart = Date.now();
  let ws;
  let opened = false;

  const finalize = (status, error) => ({
    service: 'nostr',
    endpoint: url,
    status,
    latencyMs: Date.now() - overallStart,
    checks,
    error,
    timestamp: new Date().toISOString(),
  });

  try {
    // ---- 1. Connect ----
    const connectStart = Date.now();
    ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timed out')), Math.min(10_000, timeoutMs));
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    opened = true;
    checks.push({ name: 'connect', status: 'pass', latencyMs: Date.now() - connectStart, message: 'WebSocket handshake OK' });

    // ---- 2. Broad-author subscribe (DIAGNOSTIC ONLY — never aborts) ----
    // The unicity testnet relay's broad-author indexed query has been
    // observed to fluctuate between healthy (<200ms EOSE) and degraded
    // (>15s, sometimes silent) independently from the publish + author-
    // indexed read paths that wallets actually use. We capture this
    // metric for diagnostics, but degraded-here does NOT mean the relay
    // is unusable — only the write-and-author-read functional checks
    // below are authoritative.
    const subResult = await runSubProbe(ws, { kinds: [1], limit: 5 }, 'subscribe-kind:1', 15_000);
    // Demote a `fail` here to `warn` to reflect "diagnostic only, not
    // authoritative for verdict". Real outages still surface via the
    // publish-and-confirm checks.
    if (subResult.status === 'fail') {
      subResult.status = 'warn';
      subResult.message = `(advisory only — broad-author indexed query path) ${subResult.message}`;
    }
    checks.push(subResult);

    // ---- 3. Publish-and-confirm for every Unicity kind (functional) ----
    // Each kind gets its own ephemeral keypair so acks are independently
    // attributable. We run them in series so the relay's per-event ack
    // ordering is observable.
    const remainingMs = Math.max(2_500, timeoutMs - (Date.now() - overallStart));
    const perKindBudgetMs = Math.max(2_500, Math.floor(remainingMs / UNICITY_NOSTR_KINDS.length));
    for (const { kind, classification, label } of UNICITY_NOSTR_KINDS) {
      const result = await publishAndConfirm(ws, kind, classification, perKindBudgetMs);
      checks.push({
        name: `publish-kind:${kind}`,
        status: result.status,
        latencyMs: result.latencyMs,
        message: result.message ?? label,
      });
    }

    // ---- Verdict ----
    // Only the publish-and-confirm outcomes are authoritative. The
    // connect + advisory subscribe-kind:1 are diagnostics whose
    // status doesn't determine reachability.
    const publishChecks = checks.filter((c) => c.name.startsWith('publish-kind:'));
    const failed = publishChecks.filter((c) => c.status === 'fail').length;
    const slow = publishChecks.filter((c) => c.status === 'warn').length;
    const status =
      failed === publishChecks.length ? 'unreachable' :
      failed > 0                       ? 'degraded' :
      slow > 0                         ? 'degraded' :
      'healthy';
    return finalize(status);
  } catch (err) {
    return finalize('unreachable', err instanceof Error ? err.message : String(err));
  } finally {
    if (ws && opened) {
      try { ws.close(); } catch { /* ignore close errors */ }
    }
  }
}

/**
 * Sign + publish an ephemeral event of the given kind, wait for OK, then
 * (for non-ephemeral kinds) re-query authors:[ourPubkey] kinds:[N] and
 * confirm the event is stored. Ephemeral kinds (20000-29999) skip the
 * read-back per NIP-01 — relays MUST NOT store them, so a read-back
 * would always return 0 events even on a perfectly healthy relay.
 *
 * Returns a check-shaped result; latencyMs is end-to-end.
 */
async function publishAndConfirm(ws, kind, classification, perStepBudgetMs) {
  const start = Date.now();
  const privKey = bytesToHex(randomBytes(32));
  const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privKey)));
  const event = signEvent(privKey, {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind,
    // Parameterized replaceable kinds (30000-39999) require a d-tag
    // for storage uniqueness. We always include one for safety; relays
    // ignore it for non-replaceable kinds.
    tags: kind >= 30000 ? [['d', 'probe-' + Date.now()]] : [],
    content: `unicity-infra-probe kind:${kind}`,
  });

  const okBudget = Math.min(5_000, perStepBudgetMs);
  const readBudget = Math.min(5_000, perStepBudgetMs);

  // ---- Publish + wait for OK ----
  const okOutcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, reason: `no OK in ${okBudget}ms` }), okBudget);
    const onMsg = (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m[0] === 'OK' && m[1] === event.id) {
          clearTimeout(t);
          ws.off('message', onMsg);
          resolve({ ok: m[2] === true, reason: m[3] });
        }
      } catch { /* malformed; ignore */ }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify(['EVENT', event]));
  });

  if (!okOutcome.ok) {
    return {
      status: 'fail',
      latencyMs: Date.now() - start,
      message: `publish: ${okOutcome.reason || 'rejected'}`,
    };
  }

  // ---- Ephemeral kinds: stop here. ----
  // Per NIP-01 §16: "Events with kind 20000 to 29999 are ephemeral;
  // relays MUST NOT store them." Reading them back returns 0 events
  // on every healthy relay. The OK ack is the entire signal we get.
  if (classification === 'ephemeral') {
    const totalMs = Date.now() - start;
    return {
      status: totalMs > 3_000 ? 'warn' : 'pass',
      latencyMs: totalMs,
      message: `published+ack'd (ephemeral; not stored per NIP-01; ${totalMs}ms)`,
    };
  }

  // ---- Read-back (non-ephemeral kinds only) ----
  const readResult = await runSubProbe(ws, { kinds: [kind], authors: [pubkey], limit: 5 }, 'read-back', readBudget);
  const totalMs = Date.now() - start;
  if (readResult.status !== 'pass') {
    return {
      status: 'fail',
      latencyMs: totalMs,
      message: `OK in ${okOutcome.reason ?? 'ack'}; read-back failed: ${readResult.message}`,
    };
  }
  if (readResult.eventCount < 1) {
    return {
      status: 'fail',
      latencyMs: totalMs,
      message: `published OK but read-back returned 0 events (relay accepted but didn't store)`,
    };
  }
  return {
    status: totalMs > 3_000 ? 'warn' : 'pass',
    latencyMs: totalMs,
    message: `published+stored (${totalMs}ms; read-back ${readResult.eventCount} event(s))`,
  };
}

/**
 * Time a REQ → EOSE roundtrip on an already-open WebSocket.
 */
async function runSubProbe(ws, filter, label, timeoutMs) {
  const subId = 'probe-' + Math.random().toString(36).slice(2, 10);
  const start = Date.now();
  let firstMsgAt = 0;
  let eoseAt = 0;
  let eventCount = 0;

  await new Promise((resolve) => {
    const t = setTimeout(() => resolve(), Math.min(timeoutMs, 15_000));
    const onMsg = (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m[1] !== subId) return;
        if (!firstMsgAt) firstMsgAt = Date.now();
        if (m[0] === 'EVENT') eventCount++;
        else if (m[0] === 'EOSE') {
          eoseAt = Date.now();
          clearTimeout(t);
          ws.off('message', onMsg);
          resolve();
        }
      } catch { /* malformed; ignore */ }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify(['REQ', subId, filter]));
  });
  try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* socket may be closed already */ }

  const latencyMs = (eoseAt || Date.now()) - start;
  if (!eoseAt) {
    return {
      name: label,
      status: 'fail',
      latencyMs,
      message: firstMsgAt
        ? `received ${eventCount} event(s) but no EOSE within ${latencyMs}ms`
        : `no EOSE and no events within ${latencyMs}ms`,
      eventCount,
    };
  }
  if (latencyMs > 5_000) {
    return { name: label, status: 'warn', latencyMs, message: `EOSE in ${latencyMs}ms (slow — healthy <500ms)`, eventCount };
  }
  return { name: label, status: 'pass', latencyMs, message: `EOSE in ${latencyMs}ms (${eventCount} event(s))`, eventCount };
}
