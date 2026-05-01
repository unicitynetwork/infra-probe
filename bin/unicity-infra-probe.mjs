#!/usr/bin/env node
/**
 * unicity-infra-probe — CLI entry.
 *
 * Tiny argv parser intentionally — keeps the shipped surface zero-dep
 * beyond `ws` + `@noble/curves`. Any feature creep belongs in src/.
 */

import { runProbes, exitCodeForReport, SERVICES } from '../src/index.mjs';
import { renderPretty, renderJson } from '../src/output.mjs';
import { NETWORKS } from '../src/networks.mjs';

const HELP = `\
unicity-infra-probe — availability + performance probe for Unicity Network

Usage:
  unicity-infra-probe [options]

Options:
  --network <name>     Network to probe: ${Object.keys(NETWORKS).join(', ')} (default: testnet)
  --format <name>      Output format: pretty, json (default: pretty)
  --only <list>        Comma-separated services to probe: ${SERVICES.join(', ')}
                       (default: all)
  --timeout <ms>       Per-probe ceiling in ms (default: 20000)
  --api-key <key>      Aggregator X-API-Key (default: SDK public key)
  --pretty-json        With --format=json, indent the output (2 spaces)
  --quiet              Pretty mode: only emit the final summary line
  --no-color           Pretty mode: disable ANSI colors
  -h, --help           Print this help and exit 0
  -v, --version        Print version and exit 0

Exit codes:
  0   all probed services healthy
  1   at least one service degraded
  2   at least one service unreachable
  3   internal CLI error (bad args, etc.)

Examples:
  unicity-infra-probe
  unicity-infra-probe --network mainnet --format json
  unicity-infra-probe --only nostr,aggregator --timeout 5000
  # Pre-flight gate for an e2e suite:
  unicity-infra-probe --network testnet --quiet || { echo "infra unhealthy"; exit 1; }
`;

function parseArgs(argv) {
  const args = {
    network: 'testnet',
    format: 'pretty',
    only: undefined,
    timeoutMs: 20_000,
    apiKey: undefined,
    color: process.stdout.isTTY,
    quiet: false,
    prettyJson: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '-h': case '--help': args.help = true; break;
      case '-v': case '--version': args.version = true; break;
      case '--network': args.network = next(); break;
      case '--format': args.format = next(); break;
      case '--only': args.only = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--timeout': args.timeoutMs = Number(next()); break;
      case '--api-key': args.apiKey = next(); break;
      case '--pretty-json': args.prettyJson = true; break;
      case '--quiet': args.quiet = true; break;
      case '--no-color': args.color = false; break;
      default:
        throw new Error(`Unknown argument: ${a}. Run with --help.`);
    }
  }
  if (Number.isNaN(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive number of ms');
  }
  if (!['pretty', 'json'].includes(args.format)) {
    throw new Error(`--format must be 'pretty' or 'json' (got ${JSON.stringify(args.format)})`);
  }
  if (!Object.keys(NETWORKS).includes(args.network)) {
    throw new Error(`--network must be one of ${Object.keys(NETWORKS).join(', ')} (got ${JSON.stringify(args.network)})`);
  }
  if (args.only) {
    const bad = args.only.filter((s) => !SERVICES.includes(s));
    if (bad.length > 0) throw new Error(`--only: unknown service(s): ${bad.join(', ')}. Valid: ${SERVICES.join(', ')}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${HELP}`);
    process.exit(3);
  }

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.version) {
    // Read version lazily; keeps this file zero-cost on --help.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
    process.exit(0);
  }

  let report;
  try {
    report = await runProbes({
      network: args.network,
      only: args.only,
      timeoutMs: args.timeoutMs,
      aggregatorApiKey: args.apiKey,
    });
  } catch (err) {
    process.stderr.write(`probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  }

  const out = args.format === 'json'
    ? renderJson(report, { pretty: args.prettyJson })
    : renderPretty(report, { color: args.color, quiet: args.quiet });
  process.stdout.write(out + (args.format === 'json' ? '\n' : ''));

  process.exit(exitCodeForReport(report));
}

main().catch((err) => {
  process.stderr.write(`internal error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(3);
});
