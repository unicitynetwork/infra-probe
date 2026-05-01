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
    try {
      const tip = await rpc(ws, pending, 'blockchain.headers.subscribe', [], Math.min(5_000, timeoutMs));
      // Result format: { height: <int>, hex: <80-byte hex header> }
      tipHeight = tip?.height;
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
