/**
 * IPFS gateway probe.
 *
 * The Unicity IPFS gateway exposes a Kubo (go-ipfs) HTTP API at
 * `/api/v0/version` and serves content under `/ipfs/<cid>`. Most other
 * Kubo API endpoints (e.g. `/api/v0/id`, `/api/v0/swarm/peers`) are
 * locked down for safety. So our probe is intentionally narrow:
 *
 *   1. `POST /api/v0/version` — Kubo HTTP API liveness. Returns
 *      `{ Version, Commit, Repo, System, Golang }`. This is the canonical
 *      signal that the IPFS daemon is up and accepting RPC.
 *
 *   2. `HEAD /ipfs/<probe-cid>` — gateway path liveness. We use a known-
 *      stable IPFS CID (`bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy`,
 *      the canonical "hello world\n" file). The check passes if the
 *      gateway returns HTTP 200, irrespective of WHICH content it serves
 *      — some Unicity gateway deployments serve a placeholder image for
 *      unpinned CIDs (HTTP 200 + image/jpeg), so a body-byte check would
 *      false-fail. The signal we want here is "the gateway routes
 *      /ipfs/* and answers".
 *
 * Together these two checks tell us "Kubo daemon is alive" + "gateway
 * frontend routes /ipfs/* to it". Per-CID retrievability is out of
 * scope for a generic infra probe — that's a content-pinning question.
 */

const PROBE_CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

export async function probeIpfsGateway(baseUrl, { timeoutMs = 10_000 } = {}) {
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
    const response = await fetchWithTimeout(
      `${url}/api/v0/version`,
      { method: 'POST' },
      timeoutMs,
    );
    const latencyMs = Date.now() - versionStart;
    if (!response.ok) {
      checks.push({
        name: 'kubo-api',
        status: 'fail',
        latencyMs,
        message: `HTTP ${response.status} ${response.statusText}`,
      });
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
    checks.push({
      name: 'kubo-api',
      status: 'fail',
      latencyMs: Date.now() - versionStart,
      message: err instanceof Error ? err.message : String(err),
    });
    return finalize('unreachable', err instanceof Error ? err.message : String(err));
  }

  // ---- 2. Gateway path routing ----
  const gwStart = Date.now();
  try {
    const response = await fetchWithTimeout(
      `${url}/ipfs/${PROBE_CID}`,
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
      checks.push({
        name: 'gateway-route',
        status: 'fail',
        latencyMs,
        message: `HTTP ${response.status} ${response.statusText}`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'gateway-route',
      status: 'fail',
      latencyMs: Date.now() - gwStart,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const slow = checks.filter((c) => c.status === 'warn').length;
  const status = failed > 0 ? 'degraded' : slow > 0 ? 'degraded' : 'healthy';
  return finalize(status, undefined, kuboVersion ? { kuboVersion } : {});
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
