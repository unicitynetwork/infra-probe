/**
 * L1 Fulcrum (Electrum-protocol) probe.
 *
 * Fulcrum is an ElectrumX-compatible server fronting the Unicity ALPHA
 * blockchain. It speaks JSON over a newline-delimited socket — over WSS
 * for our deployment (wss://fulcrum.unicity.network:50004).
 *
 * Each line is a JSON-RPC envelope: `{"id":N,"method":"...","params":[...]}`.
 *
 * Probes:
 *   1. `server.version` — handshake; returns server software + protocol.
 *   2. `blockchain.headers.subscribe` — current chain tip (height + header).
 *      A live, advancing height is the canonical "L1 is making blocks"
 *      signal. We don't subscribe long-term; the response is enough.
 */

import WebSocket from 'ws';

export async function probeFulcrum(url, { timeoutMs = 12_000 } = {}) {
  const checks = [];
  const overallStart = Date.now();
  let ws;
  let opened = false;
  const pending = new Map(); // id -> { resolve, reject, timer }

  const finalize = (status, error, extras = {}) => ({
    service: 'fulcrum',
    endpoint: url,
    status,
    latencyMs: Date.now() - overallStart,
    checks,
    error,
    timestamp: new Date().toISOString(),
    ...extras,
  });

  try {
    // ---- 1. Connect ----
    const connectStart = Date.now();
    ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timed out')), Math.min(8_000, timeoutMs));
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

    // Wire frame parser. Fulcrum sends one JSON envelope per WS message.
    ws.on('message', (data) => {
      try {
        const text = data.toString();
        for (const line of text.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line);
          const reg = pending.get(msg.id);
          if (!reg) continue;
          pending.delete(msg.id);
          clearTimeout(reg.timer);
          if (msg.error) reg.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else reg.resolve(msg.result);
        }
      } catch { /* ignore malformed frames */ }
    });

    // ---- 2. server.version ----
    const versionStart = Date.now();
    try {
      const v = await rpc(ws, pending, 'server.version', ['unicity-infra-probe', '1.4'], Math.min(5_000, timeoutMs));
      // Result format: ['Fulcrum 1.10.0', '1.4']  (server software, protocol version)
      const server = Array.isArray(v) ? v[0] : v;
      checks.push({
        name: 'server.version',
        status: 'pass',
        latencyMs: Date.now() - versionStart,
        message: typeof server === 'string' ? server : 'OK',
      });
    } catch (err) {
      checks.push({
        name: 'server.version',
        status: 'fail',
        latencyMs: Date.now() - versionStart,
        message: err instanceof Error ? err.message : String(err),
      });
      return finalize('unreachable', err instanceof Error ? err.message : String(err));
    }

    // ---- 3. blockchain.headers.subscribe (chain tip) ----
    const tipStart = Date.now();
    let tipHeight;
    let tipHeader;
    try {
      const tip = await rpc(ws, pending, 'blockchain.headers.subscribe', [], Math.min(5_000, timeoutMs));
      // Result format: { height: <int>, hex: <80-byte hex header> }
      tipHeight = tip?.height;
      tipHeader = tip?.hex;
      const latencyMs = Date.now() - tipStart;
      if (typeof tipHeight === 'number' && tipHeight > 0) {
        checks.push({
          name: 'chain-tip',
          status: latencyMs > 3_000 ? 'warn' : 'pass',
          latencyMs,
          message: `block ${tipHeight}` + (latencyMs > 3_000 ? ' (slow)' : ''),
        });
      } else {
        checks.push({
          name: 'chain-tip',
          status: 'fail',
          latencyMs,
          message: `unexpected response: ${JSON.stringify(tip).slice(0, 120)}`,
        });
      }
    } catch (err) {
      checks.push({
        name: 'chain-tip',
        status: 'fail',
        latencyMs: Date.now() - tipStart,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // ---- 4. chain-tip-freshness (functional) ----
    // Decode the block header timestamp (bytes 68-72, little-endian uint32
    // = unix seconds) and check it's recent. ALPHA's target block time is
    // 2 minutes; a healthy node's tip should be < 30 minutes old.
    //
    // ALPHA block headers are 112 bytes (32 bytes longer than Bitcoin's
    // canonical 80) — the timestamp is still at the standard offset 68.
    // We accept any header at least 80 bytes (160 hex) so the freshness
    // check works on both Bitcoin-derivative chains and Unicity ALPHA.
    if (tipHeader && typeof tipHeader === 'string' && tipHeader.length >= 160) {
      try {
        const headerBytes = Buffer.from(tipHeader, 'hex');
        // Bitcoin-style block header layout: version(4) prevHash(32) merkle(32) time(4) bits(4) nonce(4)
        // → time at offset 68, little-endian.
        const tipTimestampSec = headerBytes.readUInt32LE(68);
        const ageSeconds = Math.floor(Date.now() / 1000) - tipTimestampSec;
        const ageMin = (ageSeconds / 60).toFixed(1);
        const status = ageSeconds < 1_800 ? 'pass' : ageSeconds < 7_200 ? 'warn' : 'fail';
        checks.push({
          name: 'chain-tip-fresh',
          status,
          latencyMs: 0,
          message: status === 'fail'
            ? `tip is ${ageMin}min old — chain has not made a block in over 2h (target = 2min)`
            : status === 'warn'
              ? `tip is ${ageMin}min old (slow — target 2min)`
              : `tip is ${ageMin}min old (target 2min)`,
        });
      } catch (err) {
        checks.push({ name: 'chain-tip-fresh', status: 'warn', latencyMs: 0, message: `header parse failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // ---- 5. blockchain.transaction.id_from_pos at tip-1 (functional) ----
    // Verify the node can serve indexed historical data, not just the tip.
    // Picks a block height the chain definitely has (tipHeight - 1) and
    // asks for the first transaction's txid. This exercises Fulcrum's
    // block-tx index — a common operation for wallet history rebuilds.
    if (typeof tipHeight === 'number' && tipHeight > 1) {
      const idxStart = Date.now();
      try {
        const txid = await rpc(ws, pending, 'blockchain.transaction.id_from_pos', [tipHeight - 1, 0], Math.min(5_000, timeoutMs));
        const latencyMs = Date.now() - idxStart;
        const valid = typeof txid === 'string' && /^[0-9a-f]{64}$/i.test(txid);
        checks.push({
          name: 'tx-index',
          status: valid ? (latencyMs > 3_000 ? 'warn' : 'pass') : 'fail',
          latencyMs,
          message: valid
            ? `tx@${tipHeight - 1}:0 = ${txid.slice(0, 16)}…`
            : `unexpected response: ${JSON.stringify(txid).slice(0, 80)}`,
        });
      } catch (err) {
        checks.push({ name: 'tx-index', status: 'fail', latencyMs: Date.now() - idxStart, message: err instanceof Error ? err.message : String(err) });
      }
    }

    const failed = checks.filter((c) => c.status === 'fail').length;
    const slow = checks.filter((c) => c.status === 'warn').length;
    const status =
      failed > 0 ? (failed >= 2 ? 'unreachable' : 'degraded') : slow > 0 ? 'degraded' : 'healthy';
    return finalize(status, undefined, { chainTip: tipHeight });
  } catch (err) {
    return finalize('unreachable', err instanceof Error ? err.message : String(err));
  } finally {
    if (ws && opened) {
      try { ws.close(); } catch { /* ignore close errors */ }
    }
    for (const [, reg] of pending) {
      clearTimeout(reg.timer);
      reg.reject(new Error('connection closed before reply'));
    }
    pending.clear();
  }
}

let nextRpcId = 1;
function rpc(ws, pending, method, params, timeoutMs) {
  const id = nextRpcId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n');
  });
}
