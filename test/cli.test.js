import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/installguard.js', import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('--version and --help', () => {
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /installguard check/);
});

test('non-install commands pass straight through', () => {
  const r = run(['node', '-e', 'process.exit(7)']);
  assert.equal(r.status, 7);
});

test('hook ignores commands with no installs', () => {
  const r = run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la && git status' } }));
  assert.equal(r.status, 0);
});

test('hook ignores non-Bash payloads', () => {
  const r = run(['hook'], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } }));
  assert.equal(r.status, 0);
});
