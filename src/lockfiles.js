import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read locked packages from lockfiles. Every parser returns
 * [{ ecosystem, name, version }] for packages that come from the public
 * registry; local, git and workspace packages are left out.
 */

const NPM_LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock'];
const PY_LOCKS = ['poetry.lock', 'uv.lock', 'Pipfile.lock'];

const isRegistryUrl = (u) => !u || /^https?:\/\/[^/]*(registry|npmjs|yarnpkg|npmmirror)/.test(u);
const npmPkg = (name, version) => ({ ecosystem: 'npm', name: name.toLowerCase(), version, raw: name });
const pyPkg = (name, version) => ({ ecosystem: 'pypi', name, version, raw: name });

export function parsePackageLock(text) {
  const lock = JSON.parse(text);
  const out = [];
  if (lock.packages) {
    for (const [path, e] of Object.entries(lock.packages)) {
      if (!path || e.link || !e.version) continue;
      if (e.resolved && !isRegistryUrl(e.resolved)) continue;
      const i = path.lastIndexOf('node_modules/');
      if (i < 0) continue;
      out.push(npmPkg(e.name || path.slice(i + 'node_modules/'.length), e.version));
    }
  } else if (lock.dependencies) {
    // lockfile v1: nested tree
    const walk = (deps) => {
      for (const [name, e] of Object.entries(deps || {})) {
        if (e.version && /^\d/.test(e.version) && isRegistryUrl(e.resolved)) out.push(npmPkg(name, e.version));
        walk(e.dependencies);
      }
    };
    walk(lock.dependencies);
  }
  return dedupe(out);
}

export function parseYarnLock(text) {
  const out = [];
  // Yarn 2+ ("berry"): resolution: "name@npm:1.2.3"
  for (const m of text.matchAll(/^\s+resolution:\s+"?(@?[^@"\s]+)@npm:([^"\s]+)"?\s*$/gm)) out.push(npmPkg(m[1], m[2]));
  if (out.length) return dedupe(out);
  // Yarn 1: block header lines followed by an indented `version "x"`
  const blocks = text.split(/\n(?=\S)/);
  for (const block of blocks) {
    const header = block.split('\n')[0];
    if (!header.endsWith(':') || header.startsWith('#')) continue;
    const first = header.slice(0, -1).split(',')[0].trim().replace(/^"|"$/g, '');
    const at = first.lastIndexOf('@');
    if (at <= 0) continue;
    const name = first.slice(0, at);
    const range = first.slice(at + 1);
    if (/^(file|link|git|github|workspace|portal|patch):|:\/\//.test(range)) continue;
    const v = block.match(/^\s+version\s+"?([^"\s]+)"?/m);
    const resolved = block.match(/^\s+resolved\s+"?([^"\s]+)"?/m)?.[1];
    if (v && isRegistryUrl(resolved)) out.push(npmPkg(name.replace(/@npm$/, ''), v[1]));
  }
  return dedupe(out);
}

export function parsePnpmLock(text) {
  const out = [];
  const section = text.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] || '';
  for (const m of section.matchAll(/^ {2}['"]?\/?((?:@[^@/\s'"]+\/)?[^@/\s'"(]+)@(\d[^(:'"\s]*)/gm)) {
    out.push(npmPkg(m[1], m[2]));
  }
  // lockfile v5 style: "/name/1.2.3:"
  for (const m of section.matchAll(/^ {2}['"]?\/((?:@[^/\s'"]+\/)?[^/\s'"]+)\/(\d[^:_'"\s]*)/gm)) out.push(npmPkg(m[1], m[2]));
  return dedupe(out);
}

export function parseBunLock(text) {
  // bun.lock is JSON with trailing commas
  const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  const out = [];
  for (const entry of Object.values(lock.packages || {})) {
    const id = Array.isArray(entry) ? entry[0] : null;
    if (typeof id !== 'string') continue;
    const at = id.lastIndexOf('@');
    if (at <= 0) continue;
    const version = id.slice(at + 1);
    if (/^\d/.test(version)) out.push(npmPkg(id.slice(0, at), version));
  }
  return dedupe(out);
}

export function parseTomlPackages(text) {
  // poetry.lock and uv.lock: [[package]] tables with name/version lines
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^source\s*=\s*(.+)$/m)?.[1] || '';
    if (!name || !version) continue;
    if (/editable|virtual|directory|path|git\s*=/.test(source)) continue;
    if (/^\[package\.source\][\s\S]*?type\s*=\s*"(directory|file|git|url)"/m.test(block)) continue;
    out.push(pyPkg(name, version));
  }
  return dedupe(out);
}

export function parsePipfileLock(text) {
  const lock = JSON.parse(text);
  const out = [];
  for (const group of ['default', 'develop']) {
    for (const [name, e] of Object.entries(lock[group] || {})) {
      const v = typeof e.version === 'string' ? e.version.replace(/^==/, '') : null;
      if (v && !e.git && !e.path && !e.file) out.push(pyPkg(name, v));
    }
  }
  return dedupe(out);
}

function dedupe(pkgs) {
  const seen = new Set();
  return pkgs.filter((p) => {
    const k = `${p.ecosystem}:${p.name}@${p.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const PARSERS = {
  'package-lock.json': parsePackageLock,
  'npm-shrinkwrap.json': parsePackageLock,
  'yarn.lock': parseYarnLock,
  'pnpm-lock.yaml': parsePnpmLock,
  'bun.lock': parseBunLock,
  'poetry.lock': parseTomlPackages,
  'uv.lock': parseTomlPackages,
  'Pipfile.lock': parsePipfileLock,
};

export function readLockfile(file) {
  const base = file.split(/[\\/]/).pop();
  return PARSERS[base](readFileSync(file, 'utf8'));
}

/** All lockfiles in a folder, as { file, packages } (npm-family first). */
export function findLockfiles(dir, { ecosystem } = {}) {
  const names = ecosystem === 'npm' ? NPM_LOCKS : ecosystem === 'pypi' ? PY_LOCKS : [...NPM_LOCKS, ...PY_LOCKS];
  return names.filter((n) => existsSync(join(dir, n))).map((n) => ({ file: n, packages: readLockfile(join(dir, n)) }));
}

/** Packages npm already installed, from node_modules/.package-lock.json. */
export function installedNpm(dir) {
  try {
    return new Set(parsePackageLock(readFileSync(join(dir, 'node_modules', '.package-lock.json'), 'utf8')).map((p) => `${p.name}@${p.version}`));
  } catch {
    return new Set();
  }
}
