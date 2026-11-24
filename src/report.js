const useColor = (stream) =>
  !process.env.NO_COLOR && (process.env.FORCE_COLOR || stream.isTTY) && process.env.TERM !== 'dumb';

export function palette(stream = process.stderr) {
  const on = useColor(stream);
  const wrap = (open, close) => (s) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

const ICON = { critical: '✖', high: '▲', medium: '●', low: '·', info: '?' };

export function renderReport(results, { stream = process.stderr, verbose = false, compact, title } = {}) {
  const c = palette(stream);
  const color = { critical: c.red, high: c.red, medium: c.yellow, low: c.dim, info: c.cyan };
  const verdictLabel = {
    block: c.red(c.bold('do not install')),
    danger: c.red('risky'),
    caution: c.yellow('check this'),
    unknown: c.cyan('not checked'),
    ok: c.green('looks fine'),
  };
  const verdictIcon = { block: c.red('✖'), danger: c.red('▲'), caution: c.yellow('●'), unknown: c.cyan('?'), ok: c.green('✔') };

  // Long lists (dependency trees, lockfiles) only show what needs attention.
  const compactList = compact ?? results.length > 12;
  const shownResults = compactList && !verbose ? results.filter((r) => r.verdict !== 'ok' || r.allowed) : results;
  const hidden = results.length - shownResults.length;
  const width = Math.min(40, Math.max(...shownResults.map((r) => r.pkg.name.length), 8));
  const lines = [];
  if (title) lines.push(c.dim(title));
  for (const r of shownResults) {
    const version = c.dim(String(r.meta?.version || '').padEnd(10));
    const eco = c.dim(r.pkg.ecosystem === 'npm' ? 'npm ' : 'pypi');
    const label = r.allowed ? c.dim('allowed by config') : verdictLabel[r.verdict];
    const via = r.pkg.transitive && !compactList ? c.dim(' (dependency)') : '';
    lines.push(`  ${verdictIcon[r.verdict]} ${eco} ${c.bold(r.pkg.name.padEnd(width))} ${version} ${label}${via}`);
    const shown = verbose ? r.findings : r.findings.filter((f) => f.severity !== 'low' || r.verdict !== 'ok');
    for (const f of shown) {
      lines.push(`      ${color[f.severity](ICON[f.severity] + ' ' + f.severity.toUpperCase().padEnd(8))} ${f.message}`);
    }
  }
  if (hidden > 0) lines.push(`  ${c.green('✔')} ${hidden} ${shownResults.length ? 'other ' : ''}package${hidden === 1 ? '' : 's'} look${hidden === 1 ? 's' : ''} fine`);
  if (lines.length) stream.write(lines.join('\n') + '\n');
}

export function toJson(results) {
  return results.map((r) => ({
    ecosystem: r.pkg.ecosystem,
    name: r.pkg.name,
    requested: r.pkg.version,
    version: r.meta?.version ?? null,
    verdict: r.verdict,
    allowed: Boolean(r.allowed),
    weeklyDownloads: r.meta?.weeklyDownloads ?? null,
    dependency: Boolean(r.pkg.transitive),
    findings: r.findings,
  }));
}
