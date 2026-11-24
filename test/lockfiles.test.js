import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseBunLock, parsePackageLock, parsePipfileLock, parsePnpmLock, parseTomlPackages, parseYarnLock } from '../src/lockfiles.js';

const read = (f) => readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)), 'utf8');
const ids = (pkgs) => pkgs.map((p) => `${p.name}@${p.version}`).sort();

// The same project (chalk@^4.1.2 + @types/ms@0.7.34), locked by each tool for real.
const NODE_TREE = ['@types/ms@0.7.34', 'ansi-styles@4.3.0', 'chalk@4.1.2', 'color-convert@2.0.1', 'color-name@1.1.4', 'has-flag@4.0.0', 'supports-color@7.2.0'];

test('npm package-lock.json', () => assert.deepEqual(ids(parsePackageLock(read('package-lock.json'))), NODE_TREE));
test('yarn 1 yarn.lock', () => assert.deepEqual(ids(parseYarnLock(read('yarn.lock'))), NODE_TREE));
test('pnpm 9 pnpm-lock.yaml', () => assert.deepEqual(ids(parsePnpmLock(read('pnpm-lock.yaml'))), NODE_TREE));
test('bun.lock', () => assert.deepEqual(ids(parseBunLock(read('bun.lock'))), NODE_TREE));

test('yarn 2+ lockfile skips workspaces', () => {
  assert.deepEqual(ids(parseYarnLock(read('yarn-berry.lock'))), ['@types/ms@0.7.34', 'chalk@4.1.2']);
});

test('pnpm 6 lockfile with peer suffixes', () => {
  assert.deepEqual(ids(parsePnpmLock(read('pnpm-v6.yaml'))), ['@types/ms@0.7.34', 'chalk@4.1.2', 'react-dom@18.2.0']);
});

test('poetry.lock and uv.lock', () => {
  const py = ['certifi@2026.11.20', 'charset-normalizer@3.5.3', 'idna@3.20', 'requests@2.32.3', 'urllib3@2.8.0'];
  assert.deepEqual(ids(parseTomlPackages(read('poetry.lock'))), py);
  assert.deepEqual(ids(parseTomlPackages(read('uv.lock'))), py);
});

test('Pipfile.lock skips local paths', () => {
  assert.deepEqual(ids(parsePipfileLock(read('Pipfile.lock'))), ['pytest@8.3.4', 'requests@2.32.3']);
});

test('package-lock v1 (nested) and non-registry entries', () => {
  const v1 = JSON.stringify({
    lockfileVersion: 1,
    dependencies: {
      a: { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', dependencies: { b: { version: '2.0.0' } } },
      local: { version: 'file:../local' },
      gh: { version: 'github:user/repo#abc', resolved: 'git+ssh://git@github.com/user/repo.git#abc' },
    },
  });
  assert.deepEqual(ids(parsePackageLock(v1)), ['a@1.0.0', 'b@2.0.0']);
});
