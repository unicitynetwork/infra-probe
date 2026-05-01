/**
 * IPFS gateway probe.
 *
 * Liveness checks (cheap):
 *   1. `POST /api/v0/version` — Kubo HTTP API liveness.
 *   2. `HEAD /ipfs/<canonical-cid>` — gateway path routing.
 *
 * Functional checks (write+read+verify):
 *   3. add+fetch+verify — uploads ~256 random bytes via
 *      `POST /api/v0/add?pin=false&cid-version=1`, then fetches them
 *      back via `GET /ipfs/<cid>` and asserts byte-identical roundtrip.
 *      `pin=false` keeps the probe stateless: the node will garbage-
 *      collect the random bytes on its next sweep, so the probe doesn't
 *      need to call `/api/v0/pin/rm` (which the unicity gateway has
 *      locked down anyway). The CID we just added IS retrievable
 *      because Kubo serves unpinned content from the local block
 *      store until GC runs.
 *
 * The byte-identical assertion is critical: the unicity gateway has
 * been observed to serve a placeholder JPEG (HTTP 200 + image/jpeg)
 * for unpinned/missing CIDs, so a "HTTP 200 = OK" check would
 * false-pass. We verify the actual content matches what we uploaded.
 */

import { randomBytes } from 'node:crypto';

export async function probeIpfsGateway(baseUrl, { timeoutMs = 15_000 } = {}) {
  const checks = [];
  const overallStart = Date.now();
  const url = baseUrl.replace(/\/+$/, '');

  const finalize = (status, error, extras = {}) => ({
    service: 'ipfs',
    endpoint: baseUrl,
    status,
    latencyMs: Date.now() - overallStart,
    checks,
    error,
    timestamp: new Date().toISOString(),
    ...extras,
  });

  // ---- 1. Kubo HTTP API ----
  const versionStart = Date.now();
  let kuboVersion;
  try {
    const response = await fetchWithTimeout(`${url}/api/v0/version`, { method: 'POST' }, timeoutMs);
    const latencyMs = Date.now() - versionStart;
    if (!response.ok) {
      checks.push({ name: 'kubo-api', status: 'fail', latencyMs, message: `HTTP ${response.status} ${response.statusText}` });
      return finalize('unreachable', `Kubo API returned HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => ({}));
    kuboVersion = body.Version;
    checks.push({
      name: 'kubo-api',
      status: latencyMs > 2_000 ? 'warn' : 'pass',
      latencyMs,
      message: kuboVersion ? `Kubo ${kuboVersion}` : 'API responded',
    });
  } catch (err) {
    checks.push({ name: 'kubo-api', status: 'fail', latencyMs: Date.now() - versionStart, message: errMsg(err) });
    return finalize('unreachable', errMsg(err));
  }

  // ---- 2. Gateway path routing ----
  const gwStart = Date.now();
  try {
    const response = await fetchWithTimeout(
      `${url}/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy`,
      { method: 'HEAD' },
      timeoutMs,
    );
    const latencyMs = Date.now() - gwStart;
    if (response.ok) {
      checks.push({
        name: 'gateway-route',
        status: latencyMs > 5_000 ? 'warn' : 'pass',
        latencyMs,
        message: `HTTP 200 (${response.headers.get('content-type') ?? 'unknown'}, ${latencyMs}ms)`,
      });
    } else {
      checks.push({ name: 'gateway-route', status: 'fail', latencyMs, message: `HTTP ${response.status} ${response.statusText}` });
    }
  } catch (err) {
    checks.push({ name: 'gateway-route', status: 'fail', latencyMs: Date.now() - gwStart, message: errMsg(err) });
  }

  // ---- 3. add+fetch+verify (functional) ----
  // Upload random bytes, then GET them back through the public gateway,
  // and assert byte-identical content. `pin=false` keeps the node
  // stateless — the bytes are GC'd on next sweep.
  let uploadedCid;
  const addStart = Date.now();
  try {
    // Generate exactly 256 bytes of identifiable random content.
    const payload = randomBytes(256);
    const form = new FormData();
    form.append(
      'file',
      new Blob([payload], { type: 'application/octet-stream' }),
      'unicity-infra-probe.bin',
    );

    const addResponse = await fetchWithTimeout(
      `${url}/api/v0/add?pin=false&cid-version=1&hash=sha2-256`,
      { method: 'POST', body: form },
      timeoutMs,
    );
    if (!addResponse.ok) {
      const text = await addResponse.text().catch(() => '');
      checks.push({
        name: 'ipfs-add',
        status: 'fail',
        latencyMs: Date.now() - addStart,
        message: `HTTP ${addResponse.status}: ${text.slice(0, 120)}`,
      });
    } else {
      const body = await addResponse.json().catch(() => ({}));
      uploadedCid = body.Hash;
      const addLatencyMs = Date.now() - addStart;
      if (!uploadedCid) {
        checks.push({
          name: 'ipfs-add',
          status: 'fail',
          latencyMs: addLatencyMs,
          message: `unexpected /add response shape: ${JSON.stringify(body).slice(0, 120)}`,
        });
      } else {
        checks.push({
          name: 'ipfs-add',
          status: addLatencyMs > 3_000 ? 'warn' : 'pass',
          latencyMs: addLatencyMs,
          message: `cid=${uploadedCid} (${addLatencyMs}ms)`,
        });

        // Fetch back through the public gateway and assert byte-identical.
        const fetchStart = Date.now();
        const fetchResponse = await fetchWithTimeout(`${url}/ipfs/${uploadedCid}`, { method: 'GET' }, timeoutMs);
        const fetchLatencyMs = Date.now() - fetchStart;
        if (!fetchResponse.ok) {
          checks.push({
            name: 'ipfs-fetch',
            status: 'fail',
            latencyMs: fetchLatencyMs,
            message: `HTTP ${fetchResponse.status} ${fetchResponse.statusText}`,
          });
        } else {
          const buf = new Uint8Array(await fetchResponse.arrayBuffer());
          const matches = buf.length === payload.length && Buffer.compare(buf, payload) === 0;
          checks.push({
            name: 'ipfs-fetch',
            status: matches ? (fetchLatencyMs > 5_000 ? 'warn' : 'pass') : 'fail',
            latencyMs: fetchLatencyMs,
            message: matches
              ? `byte-identical roundtrip (${buf.length} bytes, ${fetchLatencyMs}ms)`
              : `content mismatch — uploaded ${payload.length}B, got ${buf.length}B (gateway may be returning placeholder)`,
          });
        }
      }
    }
  } catch (err) {
    checks.push({ name: 'ipfs-add', status: 'fail', latencyMs: Date.now() - addStart, message: errMsg(err) });
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const slow = checks.filter((c) => c.status === 'warn').length;
  const status =
    failed > 0 ? (failed >= 2 ? 'unreachable' : 'degraded') : slow > 0 ? 'degraded' : 'healthy';
  return finalize(status, undefined, kuboVersion ? { kuboVersion } : {});
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
