import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxSatisfying } from '../src/semver.js';

const V = ['1.0.0', '1.2.3', '1.9.0', '2.0.0-beta.1', '2.0.0', '2.3.1', '0.1.0', '0.1.5', '0.2.0', '0.0.3'];

test('picks the version npm would install', () => {
  assert.equal(maxSatisfying(V, '^1.2.0'), '1.9.0');
  assert.equal(maxSatisfying(V, '~1.2.0'), '1.2.3');
  assert.equal(maxSatisfying(V, '^0.1.0'), '0.1.5');
  assert.equal(maxSatisfying(V, '^0.0.3'), '0.0.3');
  assert.equal(maxSatisfying(V, '1.x'), '1.9.0');
  assert.equal(maxSatisfying(V, '1'), '1.9.0');
  assert.equal(maxSatisfying(V, '*'), '2.3.1');
  assert.equal(maxSatisfying(V, '>=1.2.0 <2.0.0'), '1.9.0');
  assert.equal(maxSatisfying(V, '^1.0.0 || ^2.0.0'), '2.3.1');
  assert.equal(maxSatisfying(V, '^2'), '2.3.1'); // prerelease skipped
  assert.equal(maxSatisfying(V, '^9.0.0'), null);
});
