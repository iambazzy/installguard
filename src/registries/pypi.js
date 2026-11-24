const PYPI = 'https://pypi.org/pypi';
const STATS = 'https://pypistats.org/api/packages';

/** PEP 503 name normalisation: "Foo_Bar.baz" -> "foo-bar-baz". */
export function normalizePypiName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

const REPO_HOSTS = /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht/i;

export async function lookupPypi(name, { version, http }) {
  const norm = normalizePypiName(name);
  const res = await http(`${PYPI}/${norm}/json`);
  if (res.status === 404) return { exists: false };

  const doc = res.data || {};
  const info = doc.info || {};
  const releases = doc.releases || {};
  const released = Object.keys(releases).filter((v) => releases[v]?.length);

  let target = info.version;
  let requestedVersionMissing = false;
  if (version) {
    if (releases[version]?.length) target = version;
    else requestedVersionMissing = true;
  }

  const files = releases[target] || doc.urls || [];
  const uploadTimes = released
    .flatMap((v) => releases[v].map((f) => f.upload_time_iso_8601 || f.upload_time))
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
  const targetTimes = files
    .map((f) => Date.parse(f.upload_time_iso_8601 || f.upload_time))
    .filter((t) => !Number.isNaN(t));

  const urls = [info.home_page, ...Object.values(info.project_urls || {})].filter(Boolean);

  let weeklyDownloads = null;
  try {
    const st = await http(`${STATS}/${norm}/recent`);
    if (typeof st.data?.data?.last_week === 'number') weeklyDownloads = st.data.data.last_week;
  } catch {
    // Optional signal.
  }

  return {
    exists: true,
    version: target,
    requestedVersionMissing,
    versionCount: released.length,
    created: uploadTimes.length ? new Date(Math.min(...uploadTimes)).toISOString() : null,
    versionPublished: targetTimes.length ? new Date(Math.min(...targetTimes)).toISOString() : null,
    hasRepository: urls.some((u) => REPO_HOSTS.test(u)),
    yanked: files.length > 0 && files.every((f) => f.yanked),
    sdistOnly: files.length > 0 && !files.some((f) => f.packagetype === 'bdist_wheel'),
    weeklyDownloads,
  };
}
