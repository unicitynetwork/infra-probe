/**
 * Market / Intent-database probe.
 *
 * The Market service hosts a public bulletin board of agent intents
 * (buy/sell/service/announcement) with a semantic-search API. The
 * `/api/search` endpoint is the canonical read entry point and the
 * cheapest sanity check that the intent database is up + the
 * embedding pipeline behind the semantic search is responsive.
 *
 * Liveness:
 *   1. `POST /api/search` with a generic query (`"test"`). Healthy:
 *      HTTP 200 + a JSON body whose `intents` field is an array
 *      (possibly empty — empty corpus is still a well-formed answer).
 *
 * Functional:
 *   2. `POST /api/feed/recent` (read the recent-public-intents feed).
 *      Cross-checks the search engine against the raw feed: if search
 *      works but feed/recent doesn't, the embedding pipeline is sick;
 *      if both work, the database is fully online.
 */

const DEFAULT_MARKET_API_URL = 'https://market-api.unicity.network';

export async function probeMarket(url = DEFAULT_MARKET_API_URL, { timeoutMs = 10_000 } = {}) {
  const checks = [];
  const overallStart = Date.now();
  const base = url.replace(/\/+$/, '');

  const finalize = (status, error) => ({
    service: 'market',
    endpoint: url,
    status,
    latencyMs: Date.now() - overallStart,
    checks,
    error,
    timestamp: new Date().toISOString(),
  });

  // ---- 1. Semantic search ----
  const searchStart = Date.now();
  try {
    const response = await postJson(`${base}/api/search`, { query: 'test' }, timeoutMs);
    const latencyMs = Date.now() - searchStart;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      checks.push({ name: 'search', status: 'fail', latencyMs, message: `HTTP ${response.status}: ${text.slice(0, 120)}` });
      return finalize('unreachable', `search returned HTTP ${response.status}`);
    }
    const json = await response.json().catch(() => null);
    const intents = json?.intents;
    if (!Array.isArray(intents)) {
      checks.push({
        name: 'search',
        status: 'fail',
        latencyMs,
        message: `unexpected shape: ${JSON.stringify(json).slice(0, 120)}`,
      });
      return finalize('degraded', 'search returned unexpected shape');
    }
    checks.push({
      name: 'search',
      status: latencyMs > 3_000 ? 'warn' : 'pass',
      latencyMs,
      message: `${intents.length} intent(s) returned (${latencyMs}ms)`,
    });
  } catch (err) {
    checks.push({ name: 'search', status: 'fail', latencyMs: Date.now() - searchStart, message: errMsg(err) });
    return finalize('unreachable', errMsg(err));
  }

  // ---- 2. Recent feed (functional cross-check) ----
  const feedStart = Date.now();
  try {
    const response = await fetchWithTimeout(`${base}/api/feed/recent`, { method: 'GET' }, timeoutMs);
    const latencyMs = Date.now() - feedStart;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      checks.push({ name: 'feed-recent', status: 'fail', latencyMs, message: `HTTP ${response.status}: ${text.slice(0, 120)}` });
    } else {
      const json = await response.json().catch(() => null);
      // Accept either { listings: [...] } or a bare array; just confirm
      // we got structured JSON back.
      const ok = Array.isArray(json) || (json && typeof json === 'object');
      const count = Array.isArray(json) ? json.length : Array.isArray(json?.listings) ? json.listings.length : null;
      checks.push({
        name: 'feed-recent',
        status: ok ? (latencyMs > 3_000 ? 'warn' : 'pass') : 'fail',
        latencyMs,
        message: ok
          ? count != null ? `${count} listing(s) returned (${latencyMs}ms)` : `JSON returned (${latencyMs}ms)`
          : `unexpected shape: ${JSON.stringify(json).slice(0, 120)}`,
      });
    }
  } catch (err) {
    checks.push({ name: 'feed-recent', status: 'fail', latencyMs: Date.now() - feedStart, message: errMsg(err) });
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const slow = checks.filter((c) => c.status === 'warn').length;
  const status = failed > 0 ? (failed >= 2 ? 'unreachable' : 'degraded') : slow > 0 ? 'degraded' : 'healthy';
  return finalize(status);
}

async function postJson(url, payload, timeoutMs) {
  return fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
