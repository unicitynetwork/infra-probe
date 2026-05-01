/**
 * Orchestration — runs every requested probe in parallel, assembles the
 * structured report, and dispatches to the requested renderer.
 *
 * Designed to be embeddable: `runProbes()` returns the report object
 * directly so callers can drive their own decision logic without parsing
 * pretty-printed text. The CLI in ../bin/unicity-infra-probe.mjs is a
 * thin shell around this.
 */

import { NETWORKS } from './networks.mjs';
import { probeNostrRelay } from './probes/nostr.mjs';
import { probeAggregator } from './probes/aggregator.mjs';
import { probeIpfsGateway } from './probes/ipfs.mjs';
import { probeFulcrum } from './probes/fulcrum.mjs';

export const SERVICES = ['nostr', 'aggregator', 'ipfs', 'fulcrum'];

/**
 * @param {object} options
 * @param {'mainnet'|'testnet'|'dev'} options.network    — default 'testnet'
 * @param {string[]} [options.only]                      — subset of SERVICES; default all
 * @param {number}   [options.timeoutMs]                 — per-probe ceiling; default 20_000
 * @param {string}   [options.aggregatorApiKey]          — override default API key
 * @returns {Promise<Report>}
 */
export async function runProbes({ network = 'testnet', only, timeoutMs = 20_000, aggregatorApiKey } = {}) {
  const cfg = NETWORKS[network];
  if (!cfg) {
    throw new Error(`Unknown network: ${network}. Valid: ${Object.keys(NETWORKS).join(', ')}`);
  }
  const requested = only && only.length > 0 ? only : SERVICES;
  const startedAt = new Date().toISOString();

  // Each probe runs independently — slow Fulcrum doesn't block fast IPFS.
  // Map service name to a thunk so we only fire the ones requested.
  const thunks = {
    nostr:      () => probeNostrRelay(cfg.nostrRelays[0],      { timeoutMs }),
    aggregator: () => probeAggregator(cfg.aggregator,           { timeoutMs, apiKey: aggregatorApiKey }),
    ipfs:       () => probeIpfsGateway(cfg.ipfsGateways[0],     { timeoutMs }),
    fulcrum:    () => probeFulcrum(cfg.fulcrum,                 { timeoutMs }),
  };

  const tasks = requested.map((name) => {
    const thunk = thunks[name];
    if (!thunk) {
      return Promise.resolve({
        service: name,
        endpoint: '(unknown)',
        status: 'error',
        latencyMs: 0,
        checks: [],
        error: `Unknown service: ${name}. Valid: ${SERVICES.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
    }
    return thunk().catch((err) => ({
      service: name,
      endpoint: '(probe-internal-error)',
      status: 'error',
      latencyMs: 0,
      checks: [],
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      timestamp: new Date().toISOString(),
    }));
  });

  const services = await Promise.all(tasks);

  const summary = services.reduce(
    (acc, s) => {
      acc.total += 1;
      if (s.status === 'healthy') acc.healthy += 1;
      else if (s.status === 'degraded') acc.degraded += 1;
      else acc.unreachable += 1;
      return acc;
    },
    { total: 0, healthy: 0, degraded: 0, unreachable: 0 },
  );

  return {
    network,
    networkLabel: cfg.label,
    startedAt,
    completedAt: new Date().toISOString(),
    timestamp: startedAt,        // alias kept for terse renderers
    services,
    summary,
  };
}

/**
 * Map a report to a CLI exit code.
 *
 *   0  — every probed service is healthy
 *   1  — at least one degraded but none unreachable
 *   2  — at least one unreachable
 *   3  — internal error during probing (kept for the CLI's catch arm)
 */
export function exitCodeForReport(report) {
  if (report.summary.unreachable > 0) return 2;
  if (report.summary.degraded > 0) return 1;
  return 0;
}
