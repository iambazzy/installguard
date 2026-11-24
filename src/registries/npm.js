const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];

function encodeName(name) {
  return name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
}

/**
 * Look up a package on npm and return a small summary of the facts
 * installguard needs. Never returns the full (often huge) packument.
 */
export async function lookupNpm(name, { version, http }) {
  const res = await http(`${REGISTRY}/${encodeName(name)}`);
  if (res.status === 404) return { exists: false };

  const doc = res.data || {};
  const versions = doc.versions || {};
  const versionNames = Object.keys(versions);
  if (versionNames.length === 0) {
    return { exists: false, unpublished: Boolean(doc.time?.unpublished) };
  }

  const tags = doc['dist-tags'] || {};
  const latest = tags.latest || versionNames[versionNames.length - 1];

  let target = latest;
  let requestedVersionMissing = false;
  if (version) {
    if (versions[version]) target = version;
    else if (tags[version]) target = tags[version];
    else if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) requestedVersionMissing = true;
  }

  const manifest = versions[target] || {};
  const time = doc.time || {};

  const scripts = {};
  for (const hook of INSTALL_HOOKS) {
    if (manifest.scripts?.[hook]) scripts[hook] = manifest.scripts[hook];
  }

  // Who published each version, oldest first. A first-time publisher on
  // an established package is how many account-takeover attacks look.
  const ordered = versionNames
    .filter((v) => time[v])
    .sort((a, b) => Date.parse(time[a]) - Date.parse(time[b]));
  const targetIndex = ordered.indexOf(target);
  const earlier = targetIndex > 0 ? ordered.slice(0, targetIndex) : [];
  const earlierPublishers = new Set(
    earlier.map((v) => versions[v]?._npmUser?.name).filter(Boolean),
  );
  const publisher = manifest._npmUser?.name || null;

  let weeklyDownloads = null;
  try {
    const dl = await http(`${DOWNLOADS}/${name}`);
    if (dl.status !== 404 && typeof dl.data?.downloads === 'number') {
      weeklyDownloads = dl.data.downloads;
    }
  } catch {
    // Download counts are a bonus signal. Carry on without them.
  }

  return {
    exists: true,
    version: target,
    requestedVersionMissing,
    versionCount: versionNames.length,
    created: time.created || time[ordered[0]] || null,
    versionPublished: time[target] || null,
    hasRepository: Boolean(doc.repository || manifest.repository),
    deprecated: manifest.deprecated || null,
    installScripts: scripts,
    publisher,
    newPublisher:
      Boolean(publisher) && earlier.length >= 3 && earlierPublishers.size > 0 && !earlierPublishers.has(publisher),
    weeklyDownloads,
  };
}
