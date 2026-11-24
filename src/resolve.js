import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePackageLock } from './lockfiles.js';

/**
 * Work out every package an install would add, without installing anything
 * and without running any package code:
 *   npm: `npm install --package-lock-only --ignore-scripts` in a temp copy
 *   pip: `pip install --dry-run --report` restricted to pre-built wheels
 * Returns { ok: true, packages } or { ok: false, reason }.
 */

const WIN = process.platform === 'win32';

/** Quote an argument for cmd.exe when we have to go through a shell on Windows. */
export function winQuote(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '"^%"') + '"';
}

export function runQuiet(cmd, args, { cwd, timeout = 180000, env } = {}) {
  return new Promise((resolve) => {
    const child = WIN
      ? spawn([cmd, ...args].map(winQuote).join(' '), { cwd, shell: true, env: env || process.env, windowsHide: true })
      : spawn(cmd, args, { cwd, env: env || process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const firstLine = (s) =>
  String(s)
    .split('\n')
    .map((l) => l.replace(/^(npm (error|ERR!)|ERROR:|error:)\s*/i, '').trim())
    .find((l) => l && !/^(code|errno|A complete log|warning|WARNING|hint)/i.test(l)) || 'unknown error';

export async function resolveNpmTree(specs, { cwd = process.cwd(), flags = [] } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'installguard-'));
  try {
    const pj = join(cwd, 'package.json');
    if (existsSync(pj)) {
      const pkg = JSON.parse(readFileSync(pj, 'utf8').replace(/^\uFEFF/, ''));
      // Workspaces and local file: deps can't be resolved outside the repo.
      delete pkg.workspaces;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [n, r] of Object.entries(pkg[field] || {})) {
          if (typeof r === 'string' && /^(file:|link:|workspace:|portal:|\.|\/)/.test(r)) delete pkg[field][n];
        }
      }
      delete pkg.scripts;
      writeFileSync(join(tmp, 'package.json'), JSON.stringify(pkg));
    } else {
      writeFileSync(join(tmp, 'package.json'), '{"name":"installguard-resolve","version":"0.0.0","private":true}');
    }
    for (const f of ['package-lock.json', 'npm-shrinkwrap.json', '.npmrc']) {
      if (existsSync(join(cwd, f))) copyFileSync(join(cwd, f), join(tmp, f));
    }
    const before = existsSync(join(tmp, 'package-lock.json'))
      ? new Set(parsePackageLock(readFileSync(join(tmp, 'package-lock.json'), 'utf8')).map((p) => `${p.name}@${p.version}`))
      : new Set();

    const res = await runQuiet(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...flags, ...specs],
      { cwd: tmp, env: { ...process.env, npm_config_yes: 'true' } },
    );
    if (res.code !== 0 || !existsSync(join(tmp, 'package-lock.json'))) {
      return { ok: false, reason: firstLine(res.stderr || res.stdout) };
    }
    const after = parsePackageLock(readFileSync(join(tmp, 'package-lock.json'), 'utf8'));
    return { ok: true, packages: after.filter((p) => !before.has(`${p.name}@${p.version}`)) };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `pipCmd` is how to run pip, e.g. ['pip'] or ['python3', '-m', 'pip'].
 * Only wheels are considered, because resolving a source package would
 * run its setup code, which is exactly what we are trying to avoid.
 */
export async function resolvePipTree(pipCmd, installArgs, { cwd = process.cwd() } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'installguard-'));
  const report = join(tmp, 'report.json');
  try {
    const args = [...pipCmd.slice(1), 'install', '--dry-run', '--quiet', '--disable-pip-version-check', '--only-binary=:all:', '--report', report, ...installArgs];
    const res = await runQuiet(pipCmd[0], args, { cwd });
    if (res.code !== 0 || !existsSync(report)) {
      const err = res.stderr || res.stdout;
      const reason = /no such option: --report|no such option: --dry-run/.test(err)
        ? 'pip is too old to preview installs (needs pip 22.2+)'
        : /No matching distribution|from versions: none/i.test(err)
          ? 'pip could not resolve it from pre-built packages (a package may be missing, or only ship as source code that would have to run to be inspected)'
          : firstLine(err);
      return { ok: false, reason };
    }
    const data = JSON.parse(readFileSync(report, 'utf8'));
    const packages = (data.install || [])
      .map((i) => ({ ecosystem: 'pypi', name: i.metadata?.name, version: i.metadata?.version, raw: i.metadata?.name, requested: Boolean(i.requested) }))
      .filter((p) => p.name && p.version);
    return { ok: true, packages };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** uv has its own resolver: `uv pip install --dry-run` lists "+ name==version". */
export async function resolveUvTree(installArgs, { cwd = process.cwd() } = {}) {
  const res = await runQuiet('uv', ['pip', 'install', '--dry-run', '--no-build', ...installArgs], { cwd });
  if (res.code !== 0) return { ok: false, reason: firstLine(res.stderr) };
  const packages = [...(res.stderr + res.stdout).matchAll(/^\s*\+\s+([A-Za-z0-9._-]+)==([^\s]+)/gm)].map((m) => ({
    ecosystem: 'pypi',
    name: m[1],
    version: m[2],
    raw: m[1],
  }));
  return { ok: true, packages };
}
