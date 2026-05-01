/**
 * Aggregator (L3) probe.
 *
 * Two endpoints exercised, in this order:
 *
 *   1. `GET /health` — the operator-facing liveness endpoint. Returns
 *      `{ status: "healthy", database: "ok", aggregators: {...} }`. No
 *      API key required. Cheapest possible signal that the service is
 *      up + its database + its shard backends are reachable.
 *
 *   2. `POST /` JSON-RPC `get_block_height` with a synthetic shardId —
 *      verifies the JSON-RPC plane is wired and answers (even if the
 *      sample shard ID is rejected, a structured "Shard ID not found"
 *      reply proves the protocol is responsive). The probe accepts EITHER
 *      a successful block-height result OR a "Shard ID not found" error
 *      as a healthy signal — the cheap fact we want to prove is "the
 *      JSON-RPC handler is alive", not "this specific shard exists".
 *
 * The two-step shape gives us the operator-style /health signal AND a
 * sanity check on the JSON-RPC plane in one probe — which is what
 * production-style monitoring wants.
 */

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
  let healthBody;
  try {
    const response = await fetchWithTimeout(`${base}/health`, { method: 'GET' }, timeoutMs);
    const latencyMs = Date.now() - healthStart;
    if (!response.ok) {
      checks.push({
        name: 'health',
        status: 'fail',
        latencyMs,
        message: `HTTP ${response.status} ${response.statusText}`,
      });
      return finalize('unreachable', `health endpoint returned HTTP ${response.status}`);
    }
    healthBody = await response.json().catch(() => null);
    const databaseOk = healthBody?.database === 'ok';
    const allShardsOk = healthBody?.aggregators
      ? Object.values(healthBody.aggregators).every((v) => v === 'ok')
      : true;
    const happy = healthBody?.status === 'healthy' && databaseOk && allShardsOk;
    checks.push({
      name: 'health',
      status: happy ? (latencyMs > 2_000 ? 'warn' : 'pass') : 'fail',
      latencyMs,
      message: happy
        ? formatHealthBody(healthBody, latencyMs)
        : `unhealthy: ${JSON.stringify(healthBody).slice(0, 160)}`,
    });
    if (!happy) {
      return finalize('degraded', 'health endpoint reports degraded state');
    }
  } catch (err) {
    checks.push({
      name: 'health',
      status: 'fail',
      latencyMs: Date.now() - healthStart,
      message: err instanceof Error ? err.message : String(err),
    });
    return finalize('unreachable', err instanceof Error ? err.message : String(err));
  }

  // ---- 2. JSON-RPC plane sanity ----
  // The aggregator returns HTTP 4xx alongside a structured JSON error body
  // for client-side issues (e.g. our deliberately invalid `shardId: '0'`).
  // That's still proof-of-life for the JSON-RPC handler — a structured
  // reply at all is better than no reply, and is what we want to detect.
  // We only mark this check `fail` if the body isn't parseable JSON
  // (network error, HTML 502 from a fronting proxy, etc.).
  const rpcStart = Date.now();
  try {
    const response = await fetchWithTimeout(
      base,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'get_block_height', params: { shardId: '0' } }),
      },
      timeoutMs,
    );
    const latencyMs = Date.now() - rpcStart;
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
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
    checks.push({
      name: 'json-rpc',
      status: 'fail',
      latencyMs: Date.now() - rpcStart,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const slow = checks.filter((c) => c.status === 'warn').length;
  const status = failed > 0 ? 'degraded' : slow > 0 ? 'degraded' : 'healthy';
  const blockHeight = healthBody?.aggregators ? undefined : healthBody?.blockHeight;
  return finalize(status, undefined, blockHeight ? { blockHeight } : {});
}

function formatHealthBody(body, latencyMs) {
  const shardCount = body?.aggregators ? Object.keys(body.aggregators).length : 0;
  return `${body.status} (db ${body.database}, ${shardCount} shard${shardCount === 1 ? '' : 's'} ok, ${latencyMs}ms)`;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
