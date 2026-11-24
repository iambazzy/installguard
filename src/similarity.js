import { POPULAR_NPM, POPULAR_PYPI } from './data/popular.js';
import { EXTRA_NPM, EXTRA_PYPI } from './data/popular-extra.js';
import { normalizePypiName } from './registries/pypi.js';

const NPM_NAMES = [...new Set([...POPULAR_NPM, ...EXTRA_NPM].map((s) => s.toLowerCase()))];
const PYPI_NAMES = [...new Set([...POPULAR_PYPI, ...EXTRA_PYPI].map(normalizePypiName))];

const LISTS = {
  npm: { names: NPM_NAMES, set: new Set(NPM_NAMES), norm: (s) => s.toLowerCase() },
  pypi: { names: PYPI_NAMES, set: new Set(PYPI_NAMES), norm: normalizePypiName },
};

/** Optimal string alignment distance (Levenshtein plus adjacent swaps). */
export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

const strip = (s) => s.replace(/[-_.]/g, '');

function sameFamily(a, b) {
  const i = Math.max(a.lastIndexOf('-'), a.lastIndexOf('/'));
  const j = Math.max(b.lastIndexOf('-'), b.lastIndexOf('/'));
  return i > 0 && i === j && a.slice(0, i) === b.slice(0, j);
}

const AFFIXES = [
  (p) => `${p}-js`, (p) => `${p}js`, (p) => `${p}-node`, (p) => `node-${p}`,
  (p) => `${p}-dev`, (p) => `${p}2`, (p) => `${p}-official`, (p) => `${p}-lib`,
  (p) => `python-${p}`, (p) => `py${p}`, (p) => `${p}-python`, (p) => `${p}-py`,
];

/**
 * Is `name` suspiciously close to a well-known package?
 * Returns { target, kind } or null. kind is "typo", "separator" or "affix".
 */
export function findLookalike(ecosystem, name) {
  const list = LISTS[ecosystem];
  if (!list) return null;
  const n = list.norm(name);
  if (list.set.has(n)) return null;

  let best = null;
  for (const raw of list.names) {
    const p = list.norm(raw);
    if (strip(p) === strip(n)) return { target: raw, kind: 'separator' };
    if (p.length < 4 || Math.abs(p.length - n.length) > 2) continue;
    const dist = editDistance(n, p);
    const allowed = p.length >= 10 ? 2 : 1;
    // "tree-sitter-hcl" vs "tree-sitter-c": members of a naming family that
    // differ only in their last segment are not typos of each other.
    if (dist === 2 && sameFamily(n, p)) continue;
    if (dist <= allowed && (!best || dist < best.distance)) {
      best = { target: raw, kind: 'typo', distance: dist };
    }
  }
  if (best) return best;

  for (const raw of list.names) {
    const p = list.norm(raw);
    if (p.length < 4 || p.startsWith('@')) continue;
    if (AFFIXES.some((f) => list.norm(f(p)) === n)) return { target: raw, kind: 'affix' };
  }
  return null;
}

export function isPopular(ecosystem, name) {
  const list = LISTS[ecosystem];
  return Boolean(list && list.set.has(list.norm(name)));
}
