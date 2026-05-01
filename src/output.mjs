/**
 * Output renderers — pretty (human terminal) and json (script-friendly).
 *
 * The pretty renderer uses a small ANSI palette and Unicode glyphs. The
 * json renderer emits a single object identical in shape to what the CLI
 * collects internally — stable for downstream parsing.
 */

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const STATUS_GLYPHS = {
  healthy: '✅',
  degraded: '⚠️',
  unreachable: '❌',
  error: '❌',
  pass: '✓',
  fail: '✗',
  warn: '⚠',
};

const STATUS_COLORS = {
  healthy: ANSI.green,
  degraded: ANSI.yellow,
  unreachable: ANSI.red,
  error: ANSI.red,
  pass: ANSI.green,
  fail: ANSI.red,
  warn: ANSI.yellow,
};

function paint(text, color, useColor) {
  if (!useColor) return text;
  return `${color}${text}${ANSI.reset}`;
}

function alignLeft(s, width) {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Render the full probe report as machine-readable JSON. Output is a
 * single line by default (pipeable). Pass `pretty: true` for indented.
 */
export function renderJson(report, { pretty = false } = {}) {
  return JSON.stringify(report, null, pretty ? 2 : 0);
}

/**
 * Render the full probe report as a colored, human-readable summary.
 *
 * @param {object} report     — full report object (see index.mjs)
 * @param {object} options
 * @param {boolean} options.color   — emit ANSI escapes (default true)
 * @param {boolean} options.quiet   — only the final summary line
 */
export function renderPretty(report, { color = true, quiet = false } = {}) {
  const out = [];
  const c = (text, col) => paint(text, col, color);

  if (!quiet) {
    const header = `Unicity ${report.network} — infrastructure probe`;
    const ts = report.timestamp;
    out.push('');
    out.push(c('═'.repeat(64), ANSI.gray));
    out.push(`  ${c(header, ANSI.bold)}`);
    out.push(`  ${c(ts, ANSI.dim)}`);
    out.push(c('═'.repeat(64), ANSI.gray));
    out.push('');

    for (const svc of report.services) {
      const glyph = STATUS_GLYPHS[svc.status] ?? '?';
      const col = STATUS_COLORS[svc.status] ?? ANSI.gray;
      const head = `${glyph} ${c(alignLeft(svc.service, 11), ANSI.bold)} ${c(svc.endpoint, ANSI.dim)}`;
      out.push(head);
      for (const ck of svc.checks ?? []) {
        const ckGlyph = STATUS_GLYPHS[ck.status] ?? '·';
        const ckCol = STATUS_COLORS[ck.status] ?? ANSI.gray;
        const lat = typeof ck.latencyMs === 'number' ? c(`${ck.latencyMs}ms`, ANSI.dim) : '';
        const msg = ck.message ?? '';
        out.push(`   ${c(ckGlyph, ckCol)} ${alignLeft(ck.name, 22)} ${lat}  ${msg}`);
      }
      const summary = `Status: ${c(svc.status.toUpperCase(), col)}`;
      const passing = (svc.checks ?? []).filter((x) => x.status === 'pass').length;
      const total = (svc.checks ?? []).length;
      out.push(`   ${summary} (${passing}/${total} checks passed)`);
      if (svc.error) {
        out.push(`   ${c('error:', ANSI.red)} ${svc.error}`);
      }
      // Service-specific extras.
      if (svc.blockHeight) out.push(`   ${c('block height:', ANSI.dim)} ${svc.blockHeight}`);
      if (svc.chainTip) out.push(`   ${c('chain tip:', ANSI.dim)} ${svc.chainTip}`);
      out.push('');
    }
  }

  const tally = report.summary;
  const tallyLine = [
    `${tally.healthy} ${c('HEALTHY', ANSI.green)}`,
    `${tally.degraded} ${c('DEGRADED', ANSI.yellow)}`,
    `${tally.unreachable} ${c('UNREACHABLE', ANSI.red)}`,
  ].join(', ');
  out.push(c('═'.repeat(64), ANSI.gray));
  out.push(`  Summary: ${tallyLine}  ${c(`(of ${tally.total})`, ANSI.dim)}`);
  out.push(c('═'.repeat(64), ANSI.gray));
  out.push('');

  return out.join('\n');
}
