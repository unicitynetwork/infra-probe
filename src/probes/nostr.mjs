/**
 * Nostr relay probe.
 *
 * Liveness checks (cheap):
 *   1. Connect (WebSocket TLS handshake).
 *   2. Subscribe `kind:1, limit:5` — REQ → EOSE roundtrip; distinguishes
 *      "relay returns events but never EOSEs" from "wholly silent".
 *
 * Functional checks (write+read across every kind Unicity uses):
 *   3. publish-and-confirm-kind:N for every entry of UNICITY_NOSTR_KINDS,
 *      each with a freshly-generated ephemeral keypair (so per-kind acks
 *      are isolated). For each:
 *        a) sign + send `["EVENT", e]`;
 *        b) wait for `["OK", id, true, ...]` (write path);
 *        c) re-query `{kinds:[N], authors:[ourPubkey]}` to confirm
 *           storage (read path through the indexed lookup).
 *
 * Each ephemeral keypair is single-use — the probe leaves only short-
 * lived events signed by random pubkeys. NIP-04 + NIP-17 envelopes
 * carry placeholder ciphertext; we don't encrypt anything because the
 * relay's job is store-and-forward, not validation of payloads.
 */

import WebSocket from 'ws';
import { randomBytes, createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

/**
 * Every Nostr event kind Unicity actually uses. Mirrors
 * `@unicitylabs/sphere-sdk` constants.ts NOSTR_EVENT_KINDS + NIP29_KINDS.
 * The relay must accept and store every one of these for production
 * wallet flows to work end-to-end.
 */
const UNICITY_NOSTR_KINDS = [
  { kind: 1,     label: 'broadcast / text-note (NIP-01)' },
  { kind: 4,     label: 'legacy DM (NIP-04)' },
  { kind: 9,     label: 'group chat message (NIP-29)' },
  { kind: 1059,  label: 'gift wrap (NIP-17)' },
  { kind: 25050, label: 'composing indicator (NIP-39?)' },
  { kind: 30000, label: 'follow list (NIP-51)' },
  { kind: 30078, label: 'app-data / nametag binding (NIP-78)' },
  { kind: 31113, label: 'token transfer (Unicity custom)' },
  { kind: 31115, label: 'payment request (Unicity custom)' },
  { kind: 31116, label: 'payment request response (Unicity custom)' },
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

export async function probeNostrRelay(url, { timeoutMs = 30_000 } = {}) {
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

    // ---- 2. Subscribe (read-path liveness) ----
    const subResult = await runSubProbe(ws, { kinds: [1], limit: 5 }, 'subscribe-kind:1', timeoutMs);
    checks.push(subResult);
    if (subResult.status === 'fail') {
      // Read path is wholly silent — no point exercising publishes.
      return finalize('unreachable', 'subscribe path silent; relay read endpoint is degraded');
    }

    // ---- 3. Publish-and-confirm for every Unicity kind (functional) ----
    // Each kind gets its own ephemeral keypair so acks are independently
    // attributable. We run them in series rather than parallel so the
    // relay's per-event ack ordering is observable.
    const publishWindowMs = Math.max(2_500, Math.floor((timeoutMs - (Date.now() - overallStart)) / UNICITY_NOSTR_KINDS.length));
    for (const { kind, label } of UNICITY_NOSTR_KINDS) {
      const result = await publishAndConfirm(ws, kind, publishWindowMs);
      checks.push({
        name: `publish-kind:${kind}`,
        status: result.status,
        latencyMs: result.latencyMs,
        message: result.message ?? label,
      });
    }

    const failed = checks.filter((c) => c.status === 'fail').length;
    const slow = checks.filter((c) => c.status === 'warn').length;
    const status = failed > 0
      ? failed > 2 ? 'unreachable' : 'degraded'
      : slow > 0 ? 'degraded' : 'healthy';
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
 * re-query authors:[ourPubkey] kinds:[N] and confirm the event is stored.
 *
 * Returns a check-shaped result; latencyMs is end-to-end (publish + read-back).
 */
async function publishAndConfirm(ws, kind, perStepBudgetMs) {
  const start = Date.now();
  const privKey = bytesToHex(randomBytes(32));
  const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privKey)));
  const event = signEvent(privKey, {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind,
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

  // ---- Read-back ----
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
