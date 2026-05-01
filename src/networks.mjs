/**
 * Endpoint configuration per network.
 *
 * Mirrors the canonical config in @unicitylabs/sphere-sdk constants.ts —
 * keep in sync when those endpoints change. Each entry lists the primary
 * endpoint per service; multi-relay arrays expose each entry separately so
 * the probe can attribute degradation to one specific endpoint.
 */
export const NETWORKS = {
  mainnet: {
    label: 'Mainnet',
    aggregator: 'https://aggregator.unicity.network/rpc',
    nostrRelays: [
      'wss://relay.unicity.network',
    ],
    ipfsGateways: [
      'https://unicity-ipfs1.dyndns.org',
    ],
    fulcrum: 'wss://fulcrum.unicity.network:50004',
    marketApi: 'https://market-api.unicity.network',
  },
  testnet: {
    label: 'Testnet',
    aggregator: 'https://goggregator-test.unicity.network',
    nostrRelays: [
      'wss://nostr-relay.testnet.unicity.network',
    ],
    ipfsGateways: [
      'https://unicity-ipfs1.dyndns.org',
    ],
    fulcrum: 'wss://fulcrum.unicity.network:50004',
    marketApi: 'https://market-api.unicity.network',
  },
  dev: {
    label: 'Development',
    aggregator: 'https://dev-aggregator.dyndns.org/rpc',
    nostrRelays: [
      'wss://nostr-relay.testnet.unicity.network',
    ],
    ipfsGateways: [
      'https://unicity-ipfs1.dyndns.org',
    ],
    fulcrum: 'wss://fulcrum.unicity.network:50004',
    marketApi: 'https://market-api.unicity.network',
  },
};

/**
 * Default API key shipped in the SDK for testnet / mainnet aggregators.
 * Public — meant for read-mostly probes. Override via `--api-key` if you
 * need a higher-rate-limit key. Source: sphere-sdk DEFAULT_AGGREGATOR_API_KEY.
 */
export const DEFAULT_AGGREGATOR_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

/**
 * Latency thresholds (ms) used to grade individual checks. Tunable via CLI.
 * `healthyMaxMs`     — probe is fast enough that no warning is emitted.
 * `degradedMaxMs`    — probe is slow but still returned a result.
 * (above degradedMaxMs the probe is reported as `degraded`.)
 * (timeout fires at the per-probe `timeoutMs` regardless.)
 */
export const DEFAULT_LATENCY_THRESHOLDS = {
  healthyMaxMs: 500,
  degradedMaxMs: 3000,
};
