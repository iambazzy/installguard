import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * A package request: { ecosystem: 'npm' | 'pypi', name, version|null, raw }.
 * Anything that is not from the public registry (git URLs, local paths,
 * tarballs) is returned in `skipped` so we can say we did not check it.
 */

const NPM_TOOLS = {
  npm: new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall']),
  pnpm: new Set(['add', 'install', 'i']),
  yarn: new Set(['add']),
  bun: new Set(['add', 'install', 'i']),
};
const NPM_VALUE_FLAGS = new Set(['--registry', '--tag', '-w', '--workspace', '--prefix', '--filter', '--cwd', '-C']);

const PIP_VALUE_FLAGS = new Set([
  '-c', '--constraint', '-i', '--index-url', '--extra-index-url', '-t', '--target', '--prefix',
  '-f', '--find-links', '--python-version', '--platform', '--trusted-host', '--root',
  '--src', '--upgrade-strategy', '--python', '-p', '--group', '--extra', '-E',
]);

function isNonRegistryNpm(spec) {
  return (
    /^(\.|\/|~|file:|link:|workspace:|portal:|git\+|git:|github:|gitlab:|bitbucket:|https?:)/.test(spec) ||
    spec.includes('://') ||
    /\.t(ar\.)?gz$/.test(spec) ||
    (!spec.startsWith('@') && /^[\w.-]+\/[\w.-]+/.test(spec))
  );
}

export function parseNpmSpec(spec) {
  if (isNonRegistryNpm(spec)) return null;
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  let name = at === -1 ? spec : spec.slice(0, at);
  let version = at === -1 ? null : spec.slice(at + 1) || null;
  if (version?.startsWith('npm:')) return parseNpmSpec(version.slice(4)); // alias@npm:real@1
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) return null;
  return { ecosystem: 'npm', name: name.toLowerCase(), version, raw: spec };
}

export function parsePipSpec(spec) {
  const s = spec.trim().split(';')[0].trim(); // drop environment markers
  if (!s || /^(\.|\/|~|-)/.test(s) || s.includes('://') || /\.(whl|zip|tar\.gz)$/.test(s)) return null;
  if (/\s@\s/.test(s)) return null; // "name @ https://..."
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  const exact = m[3].match(/^===?\s*([\w.+!-]+)$/);
  return { ecosystem: 'pypi', name: m[1], version: exact ? exact[1] : null, raw: spec };
}

/** Very small shell tokenizer: handles quotes and backslashes. */
export function tokenize(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Split a shell line into simple commands on ; && || | and newlines. */
export function splitCommands(line) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function stripPrefixes(argv) {
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++;
    else if (['sudo', 'command', 'exec', 'time', 'nohup'].includes(t)) i++;
    else if (t === 'npx' && /^installguard(-cli)?$/.test(argv[i + 1] || '')) i += 2;
    else if (t === 'installguard' || t === 'ig') i++;
    else break;
  }
  return argv.slice(i);
}

/**
 * Work out what an install command would do.
 * Returns null if it is not an install, otherwise:
 *   { family: 'npm'|'pypi', manager, mode: 'add'|'lockfile', packages, skipped,
 *     specs (package arguments as typed), flags (registry/index flags to reuse),
 *     installArgs (pip: everything after "install"), pipCmd }
 * mode "lockfile" means "install what the lockfile says" (npm ci, yarn, ...).
 */
export function parseInstallArgv(argvIn, { cwd = process.cwd() } = {}) {
  const argv = stripPrefixes(argvIn);
  if (!argv.length) return null;
  const tool = argv[0].split(/[\\/]/).pop().replace(/\.(cmd|exe|ps1)$/i, '');

  // npm-family
  if (NPM_TOOLS[tool]) {
    let i = 1;
    while (i < argv.length && argv[i].startsWith('-')) i += NPM_VALUE_FLAGS.has(argv[i]) ? 2 : 1;
    const sub = argv[i];
    const lockfileOnly =
      (tool === 'npm' && (sub === 'ci' || sub === 'clean-install' || sub === 'install-clean' || sub === 'isntall-clean')) ||
      (tool === 'yarn' && (sub === undefined || sub === 'install')) ||
      (tool === 'pnpm' && sub === 'install-test');
    if (lockfileOnly) return { family: 'npm', manager: tool, mode: 'lockfile', clean: tool === 'npm', packages: [], skipped: [], specs: [], flags: [] };
    if (!sub || !NPM_TOOLS[tool].has(sub)) return null;
    const packages = [];
    const skipped = [];
    const specs = [];
    const flags = [];
    for (let j = i + 1; j < argv.length; j++) {
      const t = argv[j];
      if (t.startsWith('-')) {
        if (/^--registry(=|$)/.test(t)) flags.push(t.includes('=') ? t : `${t}=${argv[j + 1]}`);
        if (NPM_VALUE_FLAGS.has(t)) j++;
        continue;
      }
      const p = parseNpmSpec(t);
      if (p) {
        packages.push(p);
        specs.push(t);
      } else skipped.push(t);
    }
    if (!packages.length && !skipped.length) {
      // "npm install" / "pnpm i" / "bun install" with no names: install from the lockfile
      return { family: 'npm', manager: tool, mode: 'lockfile', clean: false, packages, skipped, specs, flags };
    }
    return { family: 'npm', manager: tool, mode: 'add', packages, skipped, specs, flags };
  }

  // Python lockfile installs
  if ((tool === 'poetry' && (argv[1] === 'install' || argv[1] === 'sync')) || (tool === 'uv' && argv[1] === 'sync') || (tool === 'pipenv' && (argv[1] === 'sync' || (argv[1] === 'install' && !argv.slice(2).some((a) => !a.startsWith('-')))))) {
    return { family: 'pypi', manager: tool, mode: 'lockfile', packages: [], skipped: [], specs: [], flags: [] };
  }

  // pip-family: pip / pip3 / python -m pip / uv pip / uv add / poetry add / pipx / pipenv install <pkg>
  let rest = null;
  let manager = tool;
  let pipCmd = null;
  if (/^pip(\d(\.\d+)?)?$/.test(tool) && argv[1] === 'install') {
    rest = argv.slice(2);
    pipCmd = [argv[0]];
  } else if (/^(python|py)(\d(\.\d+)?)?$/.test(tool) && argv[1] === '-m' && /^pip\d?$/.test(argv[2] || '') && argv[3] === 'install') {
    rest = argv.slice(4);
    manager = 'pip';
    pipCmd = [argv[0], '-m', 'pip'];
  } else if (tool === 'uv' && argv[1] === 'pip' && argv[2] === 'install') rest = argv.slice(3);
  else if ((tool === 'uv' || tool === 'poetry') && argv[1] === 'add') rest = argv.slice(2);
  else if ((tool === 'pipx' || tool === 'pipenv') && argv[1] === 'install') rest = argv.slice(2);
  if (!rest) return null;

  const packages = [];
  const skipped = [];
  const specs = [];
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (t === '-r' || t === '--requirement') {
      const file = rest[++j];
      if (file) {
        try {
          packages.push(...parseRequirementsFile(resolve(cwd, file)));
        } catch {
          skipped.push(`-r ${file}`);
        }
      }
      continue;
    }
    if (t.startsWith('--requirement=')) {
      try {
        packages.push(...parseRequirementsFile(resolve(cwd, t.split('=')[1])));
      } catch {
        skipped.push(t);
      }
      continue;
    }
    if (t === '-e' || t === '--editable') {
      skipped.push(rest[++j]);
      continue;
    }
    if (t.startsWith('-')) {
      if (PIP_VALUE_FLAGS.has(t)) j++;
      continue;
    }
    const p = parsePipSpec(t);
    if (p) {
      packages.push(p);
      specs.push(t);
    } else skipped.push(t);
  }
  return { family: 'pypi', manager, mode: 'add', packages, skipped, specs, flags: [], installArgs: rest, pipCmd };
}

/** Find every install inside a full shell command line (used by agent hooks). */
export function findInstallsInCommand(line, opts) {
  const found = [];
  for (const part of splitCommands(line)) {
    const r = parseInstallArgv(tokenize(part), opts);
    if (r && (r.packages.length || r.skipped.length)) found.push(r);
  }
  return found;
}

export function parseRequirementsFile(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const out = [];
  for (let line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const inc = line.match(/^(-r|--requirement)\s*=?\s*(.+)$/);
    if (inc) {
      out.push(...parseRequirementsFile(resolve(dirname(file), inc[2]), seen));
      continue;
    }
    if (line.startsWith('-')) continue;
    const p = parsePipSpec(line);
    if (p) out.push(p);
  }
  return out;
}

export function parsePackageJson(file) {
  const pkg = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] || {})) {
      if (typeof range !== 'string') continue;
      if (range.startsWith('npm:')) {
        const p = parseNpmSpec(range.slice(4));
        if (p) out.push(p);
        continue;
      }
      if (isNonRegistryNpm(range)) continue;
      const version = range.trim() && range !== '*' && range !== 'latest' ? range.trim() : null;
      out.push({ ecosystem: 'npm', name: name.toLowerCase(), version, raw: name });
    }
  }
  return out;
}
