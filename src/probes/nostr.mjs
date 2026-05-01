/**
 * Nostr relay probe.
 *
 * Verifies the relay can:
 *   1. accept a WebSocket connection (handshake);
 *   2. respond to a generic `kind:1` REQ with EOSE (read path);
 *   3. accept a freshly-signed `kind:1` event (write path) — uses an
 *      ephemeral, single-shot keypair so the probe never persists state;
 *   4. return that event when queried by author (read-back).
 *
 * Each step is timed independently so a partial outage (read OK / write
 * silent, or the inverse) is visible in the report.
 */

import WebSocket from 'ws';
import { randomBytes, createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

const SUB_PREFIX = 'probe-';

function bytesToHex(b) { return Buffer.from(b).toString('hex'); }
function hexToBytes(h) { return Uint8Array.from(Buffer.from(h, 'hex')); }
function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }

function signEvent(privKeyHex, event) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const id = sha256Hex(serialized);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(privKeyHex)));
  return { ...event, id, sig };
}

/**
 * Run all checks against a single relay URL and return a structured probe result.
 *
 * @param {string} url - the wss:// URL of the relay
 * @param {object} options
 * @param {number} options.timeoutMs - hard ceiling for the entire probe (default 20_000)
 * @returns {Promise<RelayProbeResult>}
 */
export async function probeNostrRelay(url, { timeoutMs = 20_000 } = {}) {
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
    checks.push({
      name: 'connect',
      status: 'pass',
      latencyMs: Date.now() - connectStart,
      message: 'WebSocket handshake OK',
    });

    // ---- 2. Subscribe (read path, REQ → EOSE) ----
    // Two-shot probe: kind:1 (text-note, broad-author indexed query) is the
    // canonical "is the read path healthy" check. We measure REQ → first
    // message AND REQ → EOSE separately so a relay that returns events but
    // never EOSEs is distinguishable from one that's wholly silent.
    const subResult = await runSubProbe(ws, { kinds: [1], limit: 5 }, 'subscribe-kind:1', timeoutMs);
    checks.push(subResult);

    // ---- 3. Publish (write path) ----
    const privKey = bytesToHex(randomBytes(32));
    const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privKey)));
    const event = signEvent(privKey, {
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [['t', 'unicity-infra-probe']],
      content: 'unicity-infra-probe — ephemeral health-check event',
    });
    const pubStart = Date.now();
    const pubOutcome = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, reason: `no OK in ${Math.min(8_000, timeoutMs)}ms` }), Math.min(8_000, timeoutMs));
      const onMsg = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'OK' && msg[1] === event.id) {
            clearTimeout(t);
            ws.off('message', onMsg);
            resolve({ ok: msg[2] === true, reason: msg[3] });
          } else if (msg[0] === 'NOTICE') {
            // accumulate but don't resolve — the NOTICE may follow with an OK
          }
        } catch { /* malformed frames; ignore */ }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify(['EVENT', event]));
    });
    checks.push({
      name: 'publish-kind:1',
      status: pubOutcome.ok ? 'pass' : 'fail',
      latencyMs: Date.now() - pubStart,
      message: pubOutcome.ok
        ? `OK accepted=true${pubOutcome.reason ? ` (${pubOutcome.reason})` : ''}`
        : `publish failed: ${pubOutcome.reason || 'unknown'}`,
    });

    // ---- 4. Read-back (own pubkey) ----
    if (pubOutcome.ok) {
      const readBack = await runSubProbe(
        ws,
        { kinds: [1], authors: [pubkey], limit: 5 },
        'read-back',
        timeoutMs,
      );
      // A successful read-back must include the event we just published.
      const readBackPass = readBack.status === 'pass' && readBack.eventCount >= 1;
      checks.push({
        name: 'read-back',
        status: readBackPass ? 'pass' : 'fail',
        latencyMs: readBack.latencyMs,
        message: readBackPass
          ? `${readBack.eventCount} event(s) returned`
          : `expected ≥1 event for own pubkey, got ${readBack.eventCount ?? 0}`,
      });
    }

    // ---- Verdict ----
    const failed = checks.filter((c) => c.status === 'fail').length;
    const slow = checks.filter((c) => c.status === 'warn').length;
    const status = failed > 0 ? (failed >= 2 ? 'unreachable' : 'degraded') : (slow > 0 ? 'degraded' : 'healthy');
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
 * Time a REQ → EOSE roundtrip on an already-open WebSocket. Returns a
 * check-shaped result (name + status + latencyMs + message + eventCount).
 */
async function runSubProbe(ws, filter, label, timeoutMs) {
  const subId = SUB_PREFIX + Math.random().toString(36).slice(2, 10);
  const start = Date.now();
  let firstMsgAt = 0;
  let eoseAt = 0;
  let eventCount = 0;

  await new Promise((resolve) => {
    const t = setTimeout(() => resolve(), Math.min(timeoutMs, 15_000));
    const onMsg = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[1] !== subId) return;
        if (!firstMsgAt) firstMsgAt = Date.now();
        if (msg[0] === 'EVENT') eventCount++;
        else if (msg[0] === 'EOSE') {
          eoseAt = Date.now();
          clearTimeout(t);
          ws.off('message', onMsg);
          resolve();
        }
      } catch { /* malformed frames; ignore */ }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify(['REQ', subId, filter]));
  });

  // Always close the sub so we don't leak server-side state on a slow relay.
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
    return {
      name: label,
      status: 'warn',
      latencyMs,
      message: `EOSE in ${latencyMs}ms (slow — healthy <500ms)`,
      eventCount,
    };
  }
  return {
    name: label,
    status: 'pass',
    latencyMs,
    message: `EOSE in ${latencyMs}ms (${eventCount} event(s))`,
    eventCount,
  };
}
