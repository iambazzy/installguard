import { cached } from '../cache.js';

const PYPI = 'https://pypi.org/pypi';
const STATS = 'https://pypistats.org/api/packages';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const REPO_HOSTS = /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht/i;

/** PEP 503 name normalisation: "Foo_Bar.baz" -> "foo-bar-baz". */
export function normalizePypiName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

const isFinal = (v) => /^\d+(\.\d+)*$/.test(v);
const fileTimes = (files) =>
  (files || []).map((f) => Date.parse(f.upload_time_iso_8601 || f.upload_time)).filter((t) => !Number.isNaN(t));

/** Weekly downloads from pypistats. Best-effort: it sometimes blocks bots. */
const stats = { down: false };
async function pypiWeekly(norm, http) {
  return cached(`pypi:pop:${norm}`, (v) => (v !== null ? 12 * HOUR : HOUR), async () => {
    if (stats.down) return null;
    try {
      const st = await http(`${STATS}/${norm}/recent`, { retries: 0 });
      return typeof st.data?.data?.last_week === 'number' ? st.data.data.last_week : null;
    } catch (err) {
      // Blocked or unreachable: don't keep trying during this run.
      if (!/HTTP 404/.test(err?.message)) stats.down = true;
      return null;
    }
  });
}

/** Latest final release from the small RSS feed (avoids multi-MB JSON). */
async function latestRelease(norm, http) {
  return cached(`pypi:latest:${norm}`, (v) => (v ? 6 * HOUR : 0), async () => {
    const res = await http(`https://pypi.org/rss/project/${norm}/releases.xml`, { text: true });
    if (res.status === 404) return { missing: true };
    const titles = [...String(res.data).matchAll(/<item>\s*<title>([^<]+)<\/title>/g)].map((m) => m[1].trim());
    const version = titles.find(isFinal) || titles[0];
    return version ? { version } : null;
  });
}

async function versionDoc(norm, version, http) {
  return cached(`pypi:ver:${norm}@${version}`, (v) => (v ? 30 * DAY : 0), async () => {
    const res = await http(`${PYPI}/${norm}/${encodeURIComponent(version)}/json`);
    if (res.status === 404) return { missing: true };
    const d = res.data || {};
    const info = d.info || {};
    const urls = [info.home_page, ...Object.values(info.project_urls || {})].filter(Boolean);
    const times = fileTimes(d.urls);
    return {
      version: info.version,
      published: times.length ? new Date(Math.min(...times)).toISOString() : null,
      hasRepository: urls.some((u) => REPO_HOSTS.test(u)),
      yanked: Boolean(info.yanked) || ((d.urls || []).length > 0 && d.urls.every((f) => f.yanked)),
      sdistOnly: (d.urls || []).length > 0 && !d.urls.some((f) => f.packagetype === 'bdist_wheel'),
    };
  });
}

async function fullDoc(norm, http) {
  return cached(`pypi:doc:${norm}`, (v) => (v ? 6 * HOUR : 0), async () => {
    const res = await http(`${PYPI}/${norm}/json`);
    if (res.status === 404) return { missing: true };
    const d = res.data || {};
    const info = d.info || {};
    const releases = {};
    for (const [v, files] of Object.entries(d.releases || {})) {
      if (!files?.length) continue;
      const t = fileTimes(files);
      releases[v] = {
        published: t.length ? new Date(Math.min(...t)).toISOString() : null,
        yanked: files.every((f) => f.yanked),
        sdistOnly: !files.some((f) => f.packagetype === 'bdist_wheel'),
      };
    }
    const urls = [info.home_page, ...Object.values(info.project_urls || {})].filter(Boolean);
    return { latest: info.version, releases, hasRepository: urls.some((u) => REPO_HOSTS.test(u)) };
  });
}

/**
 * Look up a package on PyPI. Well-known packages (passed in as
 * `established`) use small per-version endpoints; others get full history.
 */
export async function lookupPypi(name, { version, http, established = false }) {
  const norm = normalizePypiName(name);
  const weekly = await pypiWeekly(norm, http);

  if (established || (weekly ?? 0) >= 50_000) {
    let target = version;
    if (!target) {
      const latest = await latestRelease(norm, http);
      if (latest?.missing) return { exists: false };
      target = latest?.version;
    }
    if (target) {
      const v = await versionDoc(norm, target, http);
      if (!v.missing) {
        return {
          exists: true,
          established: true,
          version: v.version,
          requestedVersionMissing: false,
          versionCount: null,
          created: null,
          versionPublished: v.published,
          hasRepository: v.hasRepository,
          yanked: v.yanked,
          sdistOnly: v.sdistOnly,
          weeklyDownloads: weekly,
        };
      }
      if (version) return { exists: true, established: true, version: null, requestedVersionMissing: true, weeklyDownloads: weekly };
    }
  }

  const doc = await fullDoc(norm, http);
  if (doc.missing) return { exists: false };
  const released = Object.keys(doc.releases);
  if (!released.length) return { exists: false };

  let target = doc.latest;
  let requestedVersionMissing = false;
  if (version) {
    if (doc.releases[version]) target = version;
    else requestedVersionMissing = true;
  }
  const rel = doc.releases[target] || {};
  const firsts = released.map((v) => Date.parse(doc.releases[v].published)).filter((t) => !Number.isNaN(t));

  return {
    exists: true,
    established: false,
    version: requestedVersionMissing ? null : target,
    requestedVersionMissing,
    versionCount: released.length,
    created: firsts.length ? new Date(Math.min(...firsts)).toISOString() : null,
    versionPublished: rel.published || null,
    hasRepository: doc.hasRepository,
    yanked: Boolean(rel.yanked),
    sdistOnly: Boolean(rel.sdistOnly),
    weeklyDownloads: weekly,
  };
}
