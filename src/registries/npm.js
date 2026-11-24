import { cached, cacheGet, cacheSet } from '../cache.js';
import { maxSatisfying } from '../semver.js';

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];

/** Packages this popular are looked up through small endpoints only. */
export const ESTABLISHED_DOWNLOADS = 50_000;

function encodeName(name) {
  return name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
}
const pathName = (name) => (name.startsWith('@') ? name : encodeURIComponent(name));
const isExact = (v) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v || '');

function pickScripts(manifest) {
  const out = {};
  for (const hook of INSTALL_HOOKS) if (manifest?.scripts?.[hook]) out[hook] = manifest.scripts[hook];
  return out;
}

// npm's search API is rate-limited, so it is used sparingly: throttled,
// capped per run, and switched off for the rest of the run after a refusal.
const search = { active: 0, used: 0, max: 40, disabled: false, queue: [] };
async function searchOne(name, http) {
  if (search.disabled || search.used >= search.max) return null;
  while (search.active >= 2) await new Promise((r) => search.queue.push(r));
  search.active++;
  search.used++;
  try {
    const s = await http(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(name)}&size=20`, { retries: 0 });
    return s.data?.objects?.find((o) => o.package?.name === name) || null;
  } catch (err) {
    if (/429/.test(err?.message)) search.disabled = true;
    return null;
  } finally {
    search.active--;
    search.queue.shift()?.();
  }
}

/** Weekly downloads (cached). Use prefetchNpmDownloads to batch many names. */
// If the downloads API is unreachable (firewalls, proxies), stop asking for
// the rest of the run instead of paying a timeout per package.
const downloadsApi = { down: false };

export async function npmWeekly(name, http, { useSearch = true } = {}) {
  return cached(`npm:dl:${name}`, (v) => (v !== null ? 12 * HOUR : HOUR), async () => {
    if (!downloadsApi.down) {
      try {
        const dl = await http(`${DOWNLOADS}/${name}`, { retries: 1 });
        if (typeof dl.data?.downloads === 'number') return dl.data.downloads;
      } catch (err) {
        if (!/HTTP 4\d\d/.test(err?.message)) downloadsApi.down = true;
      }
    }
    // Search is rate-limited: only spend it on packages the user named.
    const hit = useSearch ? await searchOne(name, http) : null;
    return typeof hit?.downloads?.weekly === 'number' ? hit.downloads.weekly : null;
  });
}

/** Fill the cache for many packages with one request per 128 unscoped names. */
export async function prefetchNpmDownloads(names, http) {
  if (downloadsApi.down) return;
  const todo = [...new Set(names)].filter((n) => !n.startsWith('@') && cacheGet(`npm:dl:${n}`) === undefined);
  for (let i = 0; i < todo.length; i += 128) {
    const chunk = todo.slice(i, i + 128);
    try {
      const res = await http(`${DOWNLOADS}/${chunk.join(',')}`, { retries: 1 });
      const data = res.data || {};
      for (const n of chunk) {
        const d = chunk.length === 1 ? data : data[n];
        if (typeof d?.downloads === 'number') cacheSet(`npm:dl:${n}`, d.downloads, 12 * HOUR);
      }
    } catch (err) {
      if (!/HTTP 4\d\d/.test(err?.message)) downloadsApi.down = true;
      return; // individual lookups will fall back
    }
  }
}

/** Publish date of a package's latest version, via (rate-limited) search. */
async function latestDate(name, version, http) {
  // Cached as { date } so "unknown" is remembered too (for a shorter time).
  const r = await cached(`npm:date:${name}@${version}`, (v) => (v?.date ? 30 * DAY : v?.tried ? 6 * HOUR : 0), async () => {
    if (search.disabled || search.used >= search.max) return null;
    const hit = await searchOne(name, http);
    return { date: hit?.package?.version === version ? hit.package.date || null : null, tried: true };
  });
  return r?.date ?? null;
}

function manifest(name, spec, http) {
  // Exact versions never change, so they can be cached for a long time.
  const ttl = isExact(spec) ? 30 * DAY : 6 * HOUR;
  return cached(`npm:manifest:${name}@${spec}`, (v) => (v ? ttl : 0), async () => {
    const res = await http(`${REGISTRY}/${pathName(name)}/${encodeURIComponent(spec)}`);
    if (res.status === 404) return { missing: true };
    const m = res.data || {};
    return {
      version: m.version,
      scripts: pickScripts(m),
      deprecated: m.deprecated || null,
      repository: Boolean(m.repository),
      publisher: m._npmUser?.name || null,
      trusted: Boolean(m._npmUser?.trustedPublisher || m.dist?.attestations),
    };
  });
}

async function fullDoc(name, http) {
  return cached(`npm:doc:${name}`, (v) => (v ? 6 * HOUR : 0), async () => {
    const res = await http(`${REGISTRY}/${encodeName(name)}`);
    if (res.status === 404) return { missing: true };
    const doc = res.data || {};
    const versions = doc.versions || {};
    // Keep only what we need: full documents can be tens of megabytes.
    const slim = {};
    for (const [v, m] of Object.entries(versions)) {
      slim[v] = {
        scripts: pickScripts(m),
        deprecated: m.deprecated || null,
        repository: Boolean(m.repository),
        publisher: m._npmUser?.name || null,
        trusted: Boolean(m._npmUser?.trustedPublisher || m.dist?.attestations),
      };
    }
    return {
      tags: doc['dist-tags'] || {},
      time: doc.time || {},
      repository: Boolean(doc.repository),
      unpublished: Boolean(doc.time?.unpublished),
      versions: slim,
    };
  });
}

/**
 * Look up a package on npm and return the facts installguard needs.
 * Popular packages go through small endpoints (fast even for huge packages
 * like typescript); everything else gets the full history.
 */
export async function lookupNpm(name, { version, http, established = false, transitive = false, needDates = !transitive }) {
  const weekly = await npmWeekly(name, http, { useSearch: !transitive });

  if ((weekly ?? 0) >= ESTABLISHED_DOWNLOADS || (weekly === null && established)) {
    let spec = version || 'latest';
    if (version && !isExact(version) && !/^[a-z][\w.-]*$/i.test(version)) {
      // A semver range: resolve it against the version list.
      const doc = await fullDoc(name, http);
      if (doc.missing) return { exists: false };
      const match = maxSatisfying(Object.keys(doc.versions), version);
      if (!match) return { exists: true, established: true, version: null, requestedVersionMissing: true, weeklyDownloads: weekly };
      spec = match;
    }
    const m = await manifest(name, spec, http);
    if (m.missing) {
      if (!version) return { exists: false };
      return { exists: true, established: true, version: null, requestedVersionMissing: true, weeklyDownloads: weekly };
    }
    // Only the newest release can be "brand new"; date it if that is what we install.
    const latest = spec === 'latest' ? m : await manifest(name, 'latest', http);
    const published = needDates && !latest.missing && latest.version === m.version ? await latestDate(name, m.version, http) : null;
    return {
      exists: true,
      established: true,
      version: m.version,
      requestedVersionMissing: false,
      versionCount: null,
      created: null,
      versionPublished: published,
      hasRepository: m.repository,
      deprecated: m.deprecated,
      installScripts: m.scripts,
      publisher: m.publisher,
      newPublisher: false,
      weeklyDownloads: weekly,
    };
  }

  const doc = await fullDoc(name, http);
  if (doc.missing) return { exists: false };
  const versionNames = Object.keys(doc.versions);
  if (versionNames.length === 0) return { exists: false, unpublished: doc.unpublished };

  const latest = doc.tags.latest || versionNames[versionNames.length - 1];
  let target = latest;
  let requestedVersionMissing = false;
  if (version) {
    if (doc.versions[version]) target = version;
    else if (doc.tags[version]) target = doc.tags[version];
    else if (isExact(version)) requestedVersionMissing = true;
    else {
      // A range like ^4.19.0: check the version npm would actually install.
      const match = maxSatisfying(versionNames, version);
      if (match) target = match;
      else requestedVersionMissing = true;
    }
  }

  const m = doc.versions[target] || {};
  const time = doc.time;

  // Who published each version, oldest first. A first-time publisher on
  // an established package is how many account-takeover attacks look.
  const ordered = versionNames.filter((v) => time[v]).sort((a, b) => Date.parse(time[a]) - Date.parse(time[b]));
  const idx = ordered.indexOf(target);
  const earlier = idx > 0 ? ordered.slice(0, idx) : [];
  const earlierPublishers = new Set(earlier.map((v) => doc.versions[v]?.publisher).filter(Boolean));

  return {
    exists: true,
    established: false,
    version: requestedVersionMissing ? null : target,
    requestedVersionMissing,
    versionCount: versionNames.length,
    created: time.created || time[ordered[0]] || null,
    versionPublished: time[target] || null,
    hasRepository: doc.repository || m.repository,
    deprecated: m.deprecated || null,
    installScripts: m.scripts || {},
    publisher: m.publisher || null,
    // Trusted publishing (CI with verified provenance) is a good sign,
    // not an account takeover, so it never counts as a new publisher.
    newPublisher:
      !m.trusted && Boolean(m.publisher) && earlier.length >= 3 && earlierPublishers.size > 0 && !earlierPublishers.has(m.publisher),
    weeklyDownloads: weekly,
  };
}
