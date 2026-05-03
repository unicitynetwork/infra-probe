/**
 * Nostr relay probe.
 *
 * Liveness checks (cheap):
 *   1. Connect (WebSocket TLS handshake) on a dedicated diagnostic
 *      socket.
 *   2. Subscribe `kind:1, limit:5` on the SAME diagnostic socket —
 *      REQ → EOSE roundtrip. **Diagnostic only**, never aborts the
 *      rest of the probe; a `fail` here is downgraded to `warn`.
 *
 * Functional checks (write+read across every kind Unicity uses):
 *   3. publish-and-confirm-kind:N for every entry of UNICITY_NOSTR_KINDS.
 *      Each kind runs on its OWN FRESH WebSocket — opened, used,
 *      closed. This is deliberate defense:
 *
 *        a) If the relay has a per-connection state bug (e.g. a hung
 *           REQ on a connection blocks subsequent EVENTs on the same
 *           connection — a behaviour we observed in production), the
 *           shared-socket design cascades the failure across every
 *           publish. Fresh-per-publish isolates each kind from every
 *           other and from the diagnostic subscribe.
 *
 *        b) If a previous publish leaked a hung subscribe (the read-
 *           back step), that hang doesn't carry over.
 *
 *        c) Connection drops mid-publish are caught explicitly via
 *           `ws.on('close')` rather than producing a silent 5 s wait.
 *
 *      Each kind is classified as regular/replaceable/ephemeral and
 *      verified accordingly:
 *
 *        regular     — sign + send EVENT, wait for OK true, then re-query
 *                      authors:[ourPubkey] kinds:[N] and confirm storage.
 *        replaceable — same as regular (parameterized replaceable
 *                      kinds 30000+ are stored with a d-tag; we always
 *                      attach one, so read-back finds it).
 *        ephemeral   — sign + send EVENT, wait for OK true. Skip read-back
 *                      because per NIP-01 §16 the relay MUST NOT store
 *                      kinds in 20000-29999.
 *
 *      NOTICE / CLOSED frames the relay sends back are surfaced in the
 *      failure message so a rate-limit / spam filter / auth challenge
 *      isn't mistaken for "no reply".
 *
 * Each ephemeral keypair is single-use. NIP-04 + NIP-17 envelopes carry
 * placeholder ciphertext; the relay's job is store-and-forward, not
 * payload validation.
 *
 * Excluded kinds (intentional):
 *   - kind 9 (NIP-29 group chat): lives on a separate group-chat relay
 *     (`DEFAULT_GROUP_RELAYS` in the SDK), not the wallet relay.
 */

import WebSocket from 'ws';
import { randomBytes, createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

/**
 * Every Nostr event kind the Unicity wallet (sphere-sdk + nostr-js-sdk)
 * actually emits against the wallet relay. Mirrors NOSTR_EVENT_KINDS +
 * COMPOSING_INDICATOR_KIND in the SDK. NIP-01 classification controls
 * the read-back strategy:
 *
 *   regular     — relays MUST store; we read back to confirm storage.
 *   replaceable — kinds 30000-39999, stored per (pubkey, kind, d-tag);
 *                 we attach a d-tag and read back.
 *   ephemeral   — kinds 20000-29999, dispatched live but NOT stored;
 *                 we only verify the OK ack.
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

  const finalize = (status, error) => ({
    service: 'nostr',
    endpoint: url,
    status,
    latencyMs: Date.now() - overallStart,
    checks,
    error,
    timestamp: new Date().toISOString(),
  });

  // ---- 1+2. Diagnostic socket: connect + subscribe-kind:1 ----
  // This socket is used ONLY for the advisory broad-author indexed
  // query check. It is explicitly NOT shared with the publish phase,
  // so a hung subscribe (the unicity testnet relay's most common
  // degraded state) cannot poison subsequent publishes via per-
  // connection state. The two checks are entirely independent
  // signals against entirely independent connections.
  let diagSocket;
  try {
    const connectStart = Date.now();
    diagSocket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timed out')), Math.min(10_000, timeoutMs));
      diagSocket.once('open', () => { clearTimeout(t); resolve(); });
      diagSocket.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    checks.push({ name: 'connect', status: 'pass', latencyMs: Date.now() - connectStart, message: 'WebSocket handshake OK' });

    const subResult = await runSubProbe(diagSocket, { kinds: [1], limit: 5 }, 'subscribe-kind:1', 15_000);
    if (subResult.status === 'fail') {
      // Demote to warn — diagnostic only. Real outages still surface
      // via publish-and-confirm. The unicity testnet relay's broad-
      // author indexed query has been observed to degrade
      // independently from the publish + author-indexed read paths
      // wallets actually use.
      subResult.status = 'warn';
      subResult.message = `(advisory only — broad-author indexed query path) ${subResult.message}`;
    }
    checks.push(subResult);
  } catch (err) {
    checks.push({ name: 'connect', status: 'fail', latencyMs: Date.now() - overallStart, message: err instanceof Error ? err.message : String(err) });
    return finalize('unreachable', err instanceof Error ? err.message : String(err));
  } finally {
    if (diagSocket) {
      try { diagSocket.close(); } catch { /* ignore */ }
    }
  }

  // ---- 3. Publish-and-confirm for every Unicity kind, EACH ON A FRESH SOCKET ----
  // Per-publish socket isolation defeats per-connection state issues
  // (relay-side queue corruption, prior-sub leftovers, etc.). Each
  // publish-and-confirm thus reflects ONLY whether the relay can
  // accept that one event on a clean connection — the cleanest
  // possible signal.
  const remainingMs = Math.max(2_500, timeoutMs - (Date.now() - overallStart));
  const perKindBudgetMs = Math.max(2_500, Math.floor(remainingMs / UNICITY_NOSTR_KINDS.length));
  for (const { kind, classification, label } of UNICITY_NOSTR_KINDS) {
    const result = await publishAndConfirm(url, kind, classification, perKindBudgetMs);
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
}

/**
 * Open a fresh WebSocket, sign + publish an ephemeral event of the
 * given kind, wait for OK, then (for non-ephemeral kinds) re-query
 * authors:[ourPubkey] kinds:[N] and confirm the event is stored.
 * Closes the WebSocket before returning.
 *
 * Captures NOTICE / CLOSED frames from the relay so a rate-limit or
 * spam filter shows up as the actual cause rather than being silently
 * mistaken for "no reply". Detects mid-flight connection drops via
 * `ws.on('close')` so we fail fast instead of waiting for the timer.
 */
async function publishAndConfirm(url, kind, classification, perStepBudgetMs) {
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

  let ws;
  try {
    // ---- Open a dedicated socket for this single publish-and-confirm ----
    const connectBudget = Math.min(5_000, perStepBudgetMs);
    ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`connect timed out after ${connectBudget}ms`)), connectBudget);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });

    // ---- Publish + wait for OK ----
    const okBudget = Math.min(5_000, perStepBudgetMs);
    const okOutcome = await new Promise((resolve) => {
      const notices = [];
      const t = setTimeout(() => {
        ws.off('message', onMsg);
        ws.off('close', onClose);
        const tail = notices.length ? ` (relay sent NOTICE: ${notices.join(' | ').slice(0, 120)})` : '';
        resolve({ ok: false, reason: `no OK in ${okBudget}ms${tail}` });
      }, okBudget);
      const onMsg = (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m[0] === 'OK' && m[1] === event.id) {
            clearTimeout(t);
            ws.off('message', onMsg);
            ws.off('close', onClose);
            resolve({ ok: m[2] === true, reason: m[3] });
          } else if (m[0] === 'NOTICE') {
            notices.push(String(m[1] ?? '').slice(0, 80));
          } else if (m[0] === 'CLOSED' && m[1] === event.id) {
            clearTimeout(t);
            ws.off('message', onMsg);
            ws.off('close', onClose);
            resolve({ ok: false, reason: `relay sent CLOSED for our EVENT: ${m[2] ?? 'no reason'}` });
          }
        } catch { /* malformed; ignore */ }
      };
      const onClose = (code, reason) => {
        clearTimeout(t);
        ws.off('message', onMsg);
        ws.off('close', onClose);
        resolve({ ok: false, reason: `connection closed mid-publish (code ${code}${reason ? `, ${reason}` : ''})` });
      };
      ws.on('message', onMsg);
      ws.on('close', onClose);
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
    // Per NIP-01 §16: relays MUST NOT store kinds 20000-29999.
    // Reading them back returns 0 events on every healthy relay. The
    // OK ack is the entire signal we get.
    if (classification === 'ephemeral') {
      const totalMs = Date.now() - start;
      return {
        status: totalMs > 3_000 ? 'warn' : 'pass',
        latencyMs: totalMs,
        message: `published+ack'd (ephemeral; not stored per NIP-01; ${totalMs}ms)`,
      };
    }

    // ---- Read-back ----
    const readBudget = Math.min(5_000, perStepBudgetMs);
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
  } catch (err) {
    return {
      status: 'fail',
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }
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
  let onMsg;

  await new Promise((resolve) => {
    const t = setTimeout(() => {
      // Important: detach the handler on timeout too. v0.2.0 leaked it
      // on the timer path, leaving a zombie listener attached for the
      // rest of the probe lifetime.
      if (onMsg) ws.off('message', onMsg);
      resolve();
    }, Math.min(timeoutMs, 15_000));
    onMsg = (data) => {
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
