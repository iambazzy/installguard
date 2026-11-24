import { lookupNpm } from './registries/npm.js';
import { lookupPypi } from './registries/pypi.js';
import { findLookalike, isPopular } from './similarity.js';

export const SEVERITY = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

const DAY = 24 * 60 * 60 * 1000;
const POPULAR_DOWNLOADS = 100_000;
const SUSPICIOUS_SCRIPT =
  /curl|wget|https?:\/\/|base64|\beval\b|node\s+-e|python\s+-c|powershell|\|\s*(ba)?sh\b|chmod|\/dev\/tcp|nc\s+-|child_process|Buffer\.from/i;

const REGISTRY_NAME = { npm: 'npm', pypi: 'PyPI' };

function ageDays(iso, now) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (now - t) / DAY;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatAge(days) {
  if (days < 1) return 'less than a day ago';
  if (days < 2) return '1 day ago';
  return `${Math.floor(days)} days ago`;
}

/**
 * Turn registry facts into human-readable findings.
 * Pure function: easy to test, no network.
 */
export function assess(pkg, meta, { now = Date.now() } = {}) {
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message });
  const reg = REGISTRY_NAME[pkg.ecosystem];
  const look = findLookalike(pkg.ecosystem, pkg.name);

  if (meta.error) {
    add('info', 'LOOKUP_FAILED', `Could not reach ${reg} (${meta.error}). Not checked.`);
    return findings;
  }

  if (!meta.exists) {
    const hint = look ? ` Did you mean "${look.target}"?` : '';
    add(
      'critical',
      'NOT_FOUND',
      meta.unpublished
        ? `This package was removed from ${reg}.${hint}`
        : `This package does not exist on ${reg}. It may be a name an AI made up, and anyone could register it with malware.${hint}`,
    );
    return findings;
  }

  const popular = (meta.weeklyDownloads ?? 0) >= POPULAR_DOWNLOADS || isPopular(pkg.ecosystem, pkg.name);

  if (pkg.ecosystem === 'npm' && /-security$/.test(meta.version || '')) {
    add('critical', 'SECURITY_HOLD', 'npm removed this package for security reasons (usually malware). Only a placeholder is left.');
    return findings;
  }

  if (look) {
    const how = {
      separator: `is the same as "${look.target}" with different punctuation`,
      typo: `is ${plural(look.distance, 'letter')} away from the popular package "${look.target}"`,
      affix: `looks like a knock-off name for "${look.target}"`,
    }[look.kind];
    if (popular) add('low', 'LOOKALIKE', `Name ${how}, but it is widely used itself.`);
    else add(look.kind === 'affix' ? 'medium' : 'high', 'LOOKALIKE', `Name ${how}. Check you typed it right.`);
  }

  if (meta.requestedVersionMissing) {
    add('high', 'VERSION_NOT_FOUND', `Version ${pkg.version} does not exist.`);
  }

  const created = meta.created ? ageDays(meta.created, now) : null;
  if (created !== null && created < 7) {
    add('high', 'NEW_PACKAGE', `First published ${formatAge(created)}. Brand-new packages are the most common carrier of malware.`);
  } else if (created !== null && created < 30) {
    add('medium', 'NEW_PACKAGE', `First published ${formatAge(created)}.`);
  }

  const versionAge = meta.versionPublished ? ageDays(meta.versionPublished, now) : null;
  if (versionAge !== null && versionAge < 2 && created !== null && created > 90) {
    add('low', 'FRESH_RELEASE', `Version ${meta.version} came out ${formatAge(versionAge)}. Hijacked releases are usually caught within days.`);
  }

  if (meta.weeklyDownloads !== null && meta.weeklyDownloads !== undefined && meta.weeklyDownloads < 100) {
    add('medium', 'LOW_DOWNLOADS', `Only ${plural(meta.weeklyDownloads, 'download')} last week.`);
  }

  const hooks = Object.entries(meta.installScripts || {});
  if (hooks.length) {
    const shown = hooks.map(([k, v]) => `${k}: ${v.length > 80 ? v.slice(0, 77) + '...' : v}`).join('; ');
    if (hooks.some(([, v]) => SUSPICIOUS_SCRIPT.test(v))) {
      add('high', 'INSTALL_SCRIPT', `Runs a script on install that downloads or executes code (${shown}).`);
    } else {
      add(popular ? 'low' : 'medium', 'INSTALL_SCRIPT', `Runs a script on install (${shown}).`);
    }
  }

  if (meta.newPublisher) {
    add('medium', 'NEW_PUBLISHER', `Version ${meta.version} was published by "${meta.publisher}", who never published this package before.`);
  }
  if (meta.deprecated) add('medium', 'DEPRECATED', `Deprecated: ${String(meta.deprecated).slice(0, 120)}`);
  if (meta.yanked) add('high', 'YANKED', `Version ${meta.version} was yanked (pulled) by its authors.`);
  if (meta.sdistOnly && !popular) add('low', 'RUNS_SETUP', 'No pre-built wheel, so its setup code runs on your machine during install.');
  if (!meta.hasRepository && !popular) add('low', 'NO_REPOSITORY', 'No link to its source code.');
  if (meta.versionCount === 1 && !popular) add('low', 'SINGLE_VERSION', 'Only one version has ever been published.');

  return findings;
}

export function verdictOf(findings) {
  const top = Math.max(-1, ...findings.map((f) => SEVERITY[f.severity]));
  if (top >= SEVERITY.critical) return 'block';
  if (top >= SEVERITY.high) return 'danger';
  if (top >= SEVERITY.medium) return 'caution';
  if (findings.some((f) => f.code === 'LOOKUP_FAILED')) return 'unknown';
  return 'ok';
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function checkPackages(packages, { http, allow = [], now } = {}) {
  const allowSet = new Set(allow.map((a) => a.toLowerCase()));
  return pool(packages, 6, async (pkg) => {
    if (allowSet.has(pkg.name.toLowerCase())) {
      return { pkg, meta: null, findings: [], verdict: 'ok', allowed: true };
    }
    let meta;
    try {
      const lookup = pkg.ecosystem === 'npm' ? lookupNpm : lookupPypi;
      meta = await lookup(pkg.name, { version: pkg.version, http });
    } catch (err) {
      meta = { error: err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error' };
    }
    const findings = assess(pkg, meta, { now });
    return { pkg, meta, findings, verdict: verdictOf(findings) };
  });
}
