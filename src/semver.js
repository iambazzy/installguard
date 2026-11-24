// Tiny semver helper: just enough to pick the version an npm range
// would install. Handles exact, ^, ~, x/* wildcards, >=, and "a || b".

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/;

export function parse(v) {
  const m = RE.exec(String(v).trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null } : null;
}

export function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.pre ? (b.pre ? (a.pre < b.pre ? -1 : 1) : -1) : b.pre ? 1 : 0);
}

function partial(s) {
  const parts = s.replace(/^v/, '').split('.');
  const nums = parts.map((p) => (p === 'x' || p === 'X' || p === '*' || p === '' ? null : Number(p)));
  if (nums.some((n) => n !== null && Number.isNaN(n))) return null;
  return nums;
}

function satisfiesOne(v, range) {
  range = range.trim();
  if (range === '' || range === '*' || range === 'latest') return true;
  const all = range.split(/\s+/);
  if (all.length > 1) return all.every((r) => satisfiesOne(v, r));

  let op = '';
  const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(range);
  op = m[1] || '';
  const p = partial(m[2].split('-')[0]);
  if (!p) return false;
  const [M = null, m2 = null, pt = null] = p;
  const base = { major: M ?? 0, minor: m2 ?? 0, patch: pt ?? 0, pre: null };
  const c = compare({ ...v, pre: null }, base);

  if (op === '>=') return c >= 0;
  if (op === '>') return c > 0;
  if (op === '<=') return c <= 0;
  if (op === '<') return c < 0;
  if (op === '^') {
    if (c < 0) return false;
    if (base.major > 0 || M === null) return v.major === base.major;
    if (base.minor > 0 || m2 === null) return v.major === 0 && v.minor === base.minor;
    return v.major === 0 && v.minor === 0 && v.patch === base.patch;
  }
  if (op === '~') {
    if (c < 0) return false;
    return m2 === null ? v.major === base.major : v.major === base.major && v.minor === base.minor;
  }
  // exact or wildcard ("1", "1.2", "1.x")
  if (M !== null && v.major !== M) return false;
  if (m2 !== null && v.minor !== m2) return false;
  if (pt !== null && v.patch !== pt) return false;
  return true;
}

/** Highest version in `versions` matching `range`, or null. Skips prereleases. */
export function maxSatisfying(versions, range) {
  let best = null;
  for (const raw of versions) {
    const v = parse(raw);
    if (!v || v.pre) continue;
    if (range.split('||').some((r) => satisfiesOne(v, r)) && (!best || compare(v, best.v) > 0)) {
      best = { raw, v };
    }
  }
  return best?.raw ?? null;
}
