import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findInstallsInCommand,
  parseInstallArgv,
  parseNpmSpec,
  parsePackageJson,
  parsePipSpec,
  parseRequirementsFile,
  tokenize,
} from '../src/parse.js';

const names = (r) => r.packages.map((p) => `${p.name}${p.version ? '@' + p.version : ''}`);

test('npm specs', () => {
  assert.deepEqual(parseNpmSpec('express'), { ecosystem: 'npm', name: 'express', version: null, raw: 'express' });
  assert.equal(parseNpmSpec('@types/node@20.1.0').name, '@types/node');
  assert.equal(parseNpmSpec('@types/node@20.1.0').version, '20.1.0');
  assert.equal(parseNpmSpec('lodash@^4').version, '^4');
  assert.equal(parseNpmSpec('my-alias@npm:real-pkg@1.0.0').name, 'real-pkg');
  for (const s of ['./local', 'file:../x', 'git+https://x/y.git', 'user/repo', 'https://x.com/a.tgz', 'pkg.tgz']) {
    assert.equal(parseNpmSpec(s), null, s);
  }
});

test('pip specs', () => {
  assert.equal(parsePipSpec('requests==2.31.0').version, '2.31.0');
  assert.equal(parsePipSpec('requests>=2').version, null);
  assert.equal(parsePipSpec('uvicorn[standard]').name, 'uvicorn');
  assert.equal(parsePipSpec('numpy; python_version > "3.8"').name, 'numpy');
  assert.equal(parsePipSpec('pkg @ https://example.com/pkg.whl'), null);
  assert.equal(parsePipSpec('./dist/thing.whl'), null);
});

test('install commands across package managers', () => {
  assert.deepEqual(names(parseInstallArgv(['npm', 'install', '-D', 'vitest', 'zod@3.22.0'])), ['vitest', 'zod@3.22.0']);
  assert.deepEqual(names(parseInstallArgv(['npm', 'i', '--registry', 'https://r.example', 'left-pad'])), ['left-pad']);
  assert.deepEqual(names(parseInstallArgv(['pnpm', 'add', 'react'])), ['react']);
  assert.deepEqual(names(parseInstallArgv(['yarn', 'add', '@scope/pkg'])), ['@scope/pkg']);
  assert.deepEqual(names(parseInstallArgv(['bun', 'add', 'hono'])), ['hono']);
  assert.deepEqual(names(parseInstallArgv(['pip', 'install', '-U', 'requests', 'flask==3.0.0'])), ['requests', 'flask@3.0.0']);
  assert.deepEqual(names(parseInstallArgv(['python3', '-m', 'pip', 'install', 'rich'])), ['rich']);
  assert.deepEqual(names(parseInstallArgv(['uv', 'pip', 'install', 'httpx'])), ['httpx']);
  assert.deepEqual(names(parseInstallArgv(['uv', 'add', 'pydantic'])), ['pydantic']);
  assert.deepEqual(names(parseInstallArgv(['poetry', 'add', 'typer'])), ['typer']);
  assert.deepEqual(names(parseInstallArgv(['sudo', 'pip3', 'install', 'awscli'])), ['awscli']);
  assert.deepEqual(names(parseInstallArgv(['FOO=1', 'npm', 'install', 'ms'])), ['ms']);
});

test('non-install commands are ignored', () => {
  assert.equal(parseInstallArgv(['npm', 'run', 'build']), null);
  assert.equal(parseInstallArgv(['pip', 'list']), null);
  assert.equal(parseInstallArgv(['yarn', 'install']), null);
  assert.deepEqual(parseInstallArgv(['npm', 'install']).packages, []);
});

test('finds installs inside a full shell line', () => {
  const found = findInstallsInCommand('cd app && npm i axios; pip install "requests==2.32.3" | tee log && echo done');
  assert.deepEqual(found.flatMap((f) => f.packages.map((p) => p.name)), ['axios', 'requests']);
});

test('tokenizer handles quotes', () => {
  assert.deepEqual(tokenize(`pip install "a b" 'c' d\\ e`), ['pip', 'install', 'a b', 'c', 'd e']);
});

test('requirements files and package.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'));
  writeFileSync(join(dir, 'base.txt'), 'six==1.16.0\n');
  writeFileSync(join(dir, 'requirements.txt'), '# deps\nrequests>=2  # http\n-r base.txt\n-e ./local\n\nflask==3.0.0\n');
  assert.deepEqual(parseRequirementsFile(join(dir, 'requirements.txt')).map((p) => p.name), ['requests', 'six', 'flask']);

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      dependencies: { express: '^4.18.0', exact: '1.2.3', local: 'file:../x', gh: 'user/repo' },
      devDependencies: { vitest: '*', alias: 'npm:real@1.0.0' },
    }),
  );
  const pkgs = parsePackageJson(join(dir, 'package.json'));
  assert.deepEqual(pkgs.map((p) => p.name), ['express', 'exact', 'vitest', 'real']);
  assert.equal(pkgs[1].version, '1.2.3');
  assert.equal(pkgs[0].version, '^4.18.0');
  assert.equal(pkgs[2].version, null); // "*"

  const viaFlag = parseInstallArgv(['pip', 'install', '-r', 'requirements.txt'], { cwd: dir });
  assert.deepEqual(viaFlag.packages.map((p) => p.name), ['requests', 'six', 'flask']);
});
