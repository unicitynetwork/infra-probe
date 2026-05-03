/**
 * Smoke tests — fast, network-free, deterministic.
 *
 * Run with `npm test` (uses Node's built-in `node --test` runner; no
 * external test framework required).
 *
 * Tests in this file MUST NOT touch the network. They exercise:
 *   - argv parsing (--help, --version, bad args, exit codes)
 *   - networks.mjs configuration completeness
 *   - output renderer doesn't throw on either empty or full reports
 *   - the SERVICES / NETWORKS contract surface is consistent
 *
 * Live-network behaviour is exercised by the `live-probe-testnet` job
 * in `.github/workflows/ci.yml`, kept separate so it can degrade
 * informationally without failing this test suite.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { NETWORKS, DEFAULT_AGGREGATOR_API_KEY, DEFAULT_LATENCY_THRESHOLDS } from '../src/networks.mjs';
import { SERVICES, exitCodeForReport } from '../src/index.mjs';
import { renderJson, renderPretty } from '../src/output.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'unicity-infra-probe.mjs');

// ---------------------------------------------------------------------------
// Helper: run the CLI binary and capture stdout/stderr/exit-code.
// ---------------------------------------------------------------------------

function runCli(args, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI test timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// argv / CLI surface
// ---------------------------------------------------------------------------

test('--help prints usage and exits 0', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /unicity-infra-probe/);
  assert.match(r.stdout, /--network/);
  assert.match(r.stdout, /Exit codes:/);
});

test('--version prints the package version and exits 0', async () => {
  const r = await runCli(['--version']);
  assert.equal(r.code, 0);
  // Match `@unicitylabs/infra-probe X.Y.Z` (any semver).
  assert.match(r.stdout, /@unicitylabs\/infra-probe \d+\.\d+\.\d+/);
});

test('unknown --network value exits 3 and prints help on stderr', async () => {
  const r = await runCli(['--network', 'no-such-network']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /--network must be one of/);
});

test('unknown --format value exits 3', async () => {
  const r = await runCli(['--format', 'gibberish']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /--format must be 'pretty' or 'json'/);
});

test('unknown flag exits 3 with helpful message', async () => {
  const r = await runCli(['--definitely-not-a-flag']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /Unknown argument/);
});

test('--only validates against known SERVICES', async () => {
  const r = await runCli(['--only', 'nostr,bogus,aggregator']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /unknown service/);
});

// ---------------------------------------------------------------------------
// networks.mjs — configuration completeness
// ---------------------------------------------------------------------------

test('NETWORKS exposes mainnet, testnet, dev', () => {
  assert.deepEqual(Object.keys(NETWORKS).sort(), ['dev', 'mainnet', 'testnet']);
});

test('every NETWORKS entry has the required endpoint set', () => {
  const REQUIRED = ['label', 'aggregator', 'nostrRelays', 'ipfsGateways', 'fulcrum', 'marketApi'];
  for (const [name, cfg] of Object.entries(NETWORKS)) {
    for (const key of REQUIRED) {
      assert.ok(cfg[key] !== undefined, `${name}.${key} missing`);
    }
    assert.ok(Array.isArray(cfg.nostrRelays) && cfg.nostrRelays.length > 0, `${name}.nostrRelays must be non-empty`);
    assert.ok(Array.isArray(cfg.ipfsGateways) && cfg.ipfsGateways.length > 0, `${name}.ipfsGateways must be non-empty`);
    assert.match(cfg.aggregator, /^https?:\/\//);
    assert.match(cfg.fulcrum, /^wss?:\/\//);
    assert.match(cfg.marketApi, /^https?:\/\//);
  }
});

test('DEFAULT_AGGREGATOR_API_KEY and DEFAULT_LATENCY_THRESHOLDS are exported', () => {
  assert.equal(typeof DEFAULT_AGGREGATOR_API_KEY, 'string');
  assert.ok(DEFAULT_AGGREGATOR_API_KEY.length > 0);
  assert.equal(typeof DEFAULT_LATENCY_THRESHOLDS.healthyMaxMs, 'number');
  assert.equal(typeof DEFAULT_LATENCY_THRESHOLDS.degradedMaxMs, 'number');
});

// ---------------------------------------------------------------------------
// SERVICES + verdict logic
// ---------------------------------------------------------------------------

test('SERVICES enumerates all five canonical services in stable order', () => {
  assert.deepEqual(SERVICES, ['nostr', 'aggregator', 'ipfs', 'fulcrum', 'market']);
});

test('exitCodeForReport: all healthy → 0', () => {
  const r = { summary: { total: 5, healthy: 5, degraded: 0, unreachable: 0 } };
  assert.equal(exitCodeForReport(r), 0);
});

test('exitCodeForReport: any degraded → 1', () => {
  const r = { summary: { total: 5, healthy: 4, degraded: 1, unreachable: 0 } };
  assert.equal(exitCodeForReport(r), 1);
});

test('exitCodeForReport: any unreachable → 2 (overrides degraded)', () => {
  const r = { summary: { total: 5, healthy: 3, degraded: 1, unreachable: 1 } };
  assert.equal(exitCodeForReport(r), 2);
});

// ---------------------------------------------------------------------------
// Output renderers — must not throw on either empty or full payloads
// ---------------------------------------------------------------------------

const emptyReport = {
  network: 'testnet',
  networkLabel: 'Testnet',
  startedAt: '2026-05-03T00:00:00.000Z',
  completedAt: '2026-05-03T00:00:01.000Z',
  timestamp: '2026-05-03T00:00:00.000Z',
  services: [],
  summary: { total: 0, healthy: 0, degraded: 0, unreachable: 0 },
};

const fullReport = {
  ...emptyReport,
  services: [
    {
      service: 'nostr',
      endpoint: 'wss://nostr-relay.testnet.unicity.network',
      status: 'healthy',
      latencyMs: 250,
      checks: [
        { name: 'connect', status: 'pass', latencyMs: 100, message: 'WebSocket handshake OK' },
        { name: 'publish-kind:1', status: 'pass', latencyMs: 150, message: 'published+stored' },
      ],
      timestamp: '2026-05-03T00:00:01.000Z',
    },
    {
      service: 'aggregator',
      endpoint: 'https://goggregator-test.unicity.network',
      status: 'unreachable',
      latencyMs: 10_000,
      checks: [{ name: 'health', status: 'fail', latencyMs: 10_000, message: 'timeout' }],
      error: 'health endpoint timed out',
      timestamp: '2026-05-03T00:00:01.000Z',
    },
  ],
  summary: { total: 2, healthy: 1, degraded: 0, unreachable: 1 },
};

test('renderJson: emits valid JSON for empty report', () => {
  const s = renderJson(emptyReport);
  const parsed = JSON.parse(s);
  assert.equal(parsed.network, 'testnet');
  assert.equal(parsed.summary.total, 0);
});

test('renderJson: round-trips a full report without losing fields', () => {
  const s = renderJson(fullReport);
  const parsed = JSON.parse(s);
  assert.equal(parsed.services.length, 2);
  assert.equal(parsed.services[1].error, 'health endpoint timed out');
});

test('renderJson with pretty:true emits indented output', () => {
  const s = renderJson(fullReport, { pretty: true });
  // Indented JSON has newlines; one-line does not.
  assert.ok(s.includes('\n'));
});

test('renderPretty: empty report renders the summary line', () => {
  const out = renderPretty(emptyReport, { color: false });
  assert.match(out, /Summary:/);
  assert.match(out, /0 HEALTHY/);
});

test('renderPretty: full report renders every service block', () => {
  const out = renderPretty(fullReport, { color: false });
  assert.match(out, /nostr/);
  assert.match(out, /aggregator/);
  assert.match(out, /HEALTHY/);
  assert.match(out, /UNREACHABLE/);
  assert.match(out, /publish-kind:1/);
  // Error message surfaces in the output.
  assert.match(out, /health endpoint timed out/);
});

test('renderPretty: --quiet emits only the summary line', () => {
  const out = renderPretty(fullReport, { color: false, quiet: true });
  // No per-service block headers expected with quiet.
  assert.ok(!out.includes('publish-kind:1'));
  assert.match(out, /Summary:/);
});

test('renderPretty: --no-color produces ANSI-free output', () => {
  const out = renderPretty(fullReport, { color: false });
  // ESC = 0x1b. If color is off, no ANSI escape sequences should appear.
  assert.ok(!out.includes('\x1b['));
});
