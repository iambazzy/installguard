import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { checkPackages } from './analyze.js';
import { cacheClear, cacheDir } from './cache.js';
import { loadConfig } from './config.js';
import { auditTargets, evaluateInstall } from './guard.js';
import { getJson } from './http.js';
import { findInstallsInCommand, parseInstallArgv, parseNpmSpec, parsePackageJson, parsePipSpec, parseRequirementsFile } from './parse.js';
import { palette, renderReport, toJson } from './report.js';
import { winQuote } from './resolve.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `installguard ${VERSION}
Check packages, and everything they pull in, before you install them.

Usage
  installguard <install command>     check, then run it
  installguard check <pkg...>        check packages (npm by default)
  installguard audit [dir]           check a project's lockfiles (or manifests)
  installguard scan "<command>"      check a shell command without running it
  installguard hook                  AI agent hook: reads a tool call on stdin
  installguard cache clear           forget cached registry lookups

Examples
  installguard npm install express
  installguard pip install requests==2.32.3
  installguard npm ci
  installguard check pypi:requests npm:left-pad
  installguard audit .

Options
  -y, --yes       continue without asking, even if something looks risky
  --strict        also stop on "check this" (medium) findings
  --direct        only check the packages you name, not their dependencies
  --dry-run       check only, never run the install
  --json          print results as JSON on stdout
  -v, --verbose   show every finding and every package checked
  -h, --help      show this help
  --version       show the version

Config: .installguardrc.json
  {"allow": ["internal-pkg"], "strict": false, "minReleaseAgeDays": 0}
Exit codes: 0 ok, 1 stopped because of a risky package, 2 error.
`;

const FLAG_NAMES = {
  '-y': 'yes', '--yes': 'yes', '--strict': 'strict', '--json': 'json', '-v': 'verbose', '--verbose': 'verbose',
  '--dry-run': 'dryRun', '--pypi': 'pypi', '--direct': 'direct', '-h': 'help', '--help': 'help', '--version': 'version',
};

function parseFlags(args) {
  const flags = {};
  let i = 0;
  for (; i < args.length && FLAG_NAMES[args[i]]; i++) flags[FLAG_NAMES[args[i]]] = true;
  return { flags, rest: args.slice(i) };
}

const isStopping = (r, strict) =>
  !r.allowed && (r.verdict === 'block' || r.verdict === 'danger' || (strict && r.verdict === 'caution'));

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function run(argv) {
  return new Promise((res) => {
    const win = process.platform === 'win32';
    const child = win
      ? spawn(argv.map(winQuote).join(' '), { stdio: 'inherit', shell: true })
      : spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
    // Ctrl+C goes to the installer; we wait for it and pass its exit code on.
    const ignore = () => {};
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
    child.on('error', (err) => {
      process.stderr.write(`installguard: could not run ${argv[0]}: ${err.message}\n`);
      res(127);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', ignore);
      res(signal ? 130 : (code ?? 0));
    });
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pluralDeps = (n) => `${n} ${n === 1 ? 'dependency' : 'dependencies'}`;

function stageReporter(flags) {
  if (flags.json) return () => {};
  const c = palette();
  return (stage, count) => {
    const what =
      stage === 'named'
        ? `checking ${plural(count, 'package')}`
        : stage === 'dependencies'
          ? `checking ${pluralDeps(count)} they would bring in`
          : `checking ${plural(count, 'package')} ${stage}`;
    process.stderr.write(c.dim(`installguard: ${what}\n`));
  };
}

function printNotes(notes, flags) {
  if (flags.json || !notes.length) return;
  const c = palette();
  for (const n of notes) process.stderr.write(c.yellow(`  ! ${n}\n`));
}

async function decide(stopping, flags) {
  const c = palette();
  if (!stopping.length) return true;
  if (flags.yes) {
    process.stderr.write(c.yellow('\n--yes given: continuing anyway.\n'));
    return true;
  }
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const ok = await ask(c.bold(`\n${stopping.length === 1 ? 'A package looks' : `${stopping.length} packages look`} risky. Install anyway? [y/N] `));
    if (!ok) process.stderr.write('Cancelled. Nothing was installed.\n');
    return ok;
  }
  process.stderr.write(c.red('\nStopped: risky package and no terminal to confirm. Nothing was installed. Use --yes to override.\n'));
  return false;
}

async function cmdCheck(names, flags, config) {
  const packages = [];
  for (const n of names) {
    let eco = flags.pypi ? 'pypi' : 'npm';
    let spec = n;
    const m = n.match(/^(npm|pypi|pip):(.+)$/);
    if (m) {
      eco = m[1] === 'npm' ? 'npm' : 'pypi';
      spec = m[2];
    }
    const p = eco === 'npm' ? parseNpmSpec(spec) : parsePipSpec(spec.replace(/@(?=[\w.]+$)/, '=='));
    if (!p) throw new Error(`not a registry package name: ${n}`);
    packages.push(p);
  }
  if (!packages.length) throw new Error('give at least one package name, e.g. installguard check express');
  const results = await checkPackages(packages, { http: getJson, allow: config.allow, minReleaseAgeDays: config.minReleaseAgeDays });
  if (flags.json) process.stdout.write(JSON.stringify(toJson(results), null, 2) + '\n');
  else renderReport(results, { verbose: flags.verbose, compact: false });
  return results.some((r) => isStopping(r, flags.strict || config.strict)) ? 1 : 0;
}

function parseManifests(dir) {
  const packages = [];
  const sources = [];
  if (existsSync(join(dir, 'package.json'))) {
    packages.push(...parsePackageJson(join(dir, 'package.json')));
    sources.push('package.json');
  }
  for (const f of readdirSync(dir)) {
    if (/^requirements.*\.txt$/i.test(f)) {
      packages.push(...parseRequirementsFile(join(dir, f)));
      sources.push(f);
    }
  }
  const seen = new Set();
  return {
    packages: packages.filter((p) => {
      const k = `${p.ecosystem}:${p.name}`;
      return seen.has(k) ? false : (seen.add(k), true);
    }),
    sources,
  };
}

async function cmdAudit(dirArg, flags, config) {
  const dir = resolve(dirArg || '.');
  if (!existsSync(dir)) throw new Error(`no such folder: ${dir}`);
  const c = palette();
  const target = flags.direct ? { ...parseManifests(dir), fromLockfile: false } : auditTargets(dir, { parseManifests });
  if (!target.packages.length) {
    if (flags.json) process.stdout.write('[]\n');
    else process.stderr.write(`installguard: no dependencies found in ${dir} (looked for lockfiles, package.json, requirements*.txt)\n`);
    return 0;
  }
  if (!flags.json) {
    process.stderr.write(c.dim(`installguard: checking ${plural(target.packages.length, 'package')} from ${target.sources.join(', ')}\n`));
  }
  const results = await checkPackages(
    target.packages.map((p) => ({ ...p, transitive: target.fromLockfile })),
    { http: getJson, allow: config.allow, minReleaseAgeDays: config.minReleaseAgeDays },
  );
  const strict = flags.strict || config.strict;
  const stopping = results.filter((r) => isStopping(r, strict));
  if (flags.json) {
    process.stdout.write(JSON.stringify(toJson(results), null, 2) + '\n');
  } else {
    renderReport(results, { verbose: flags.verbose });
    process.stderr.write(
      stopping.length ? c.red(`\n${plural(stopping.length, 'risky package')} found.\n`) : c.green('\nNo risky packages found.\n'),
    );
  }
  return stopping.length ? 1 : 0;
}

async function evaluateLine(line, flags, config) {
  const installs = findInstallsInCommand(line);
  const all = { direct: [], deps: [], notes: [] };
  for (const parsed of installs) {
    const r = await evaluateInstall(parsed, { http: getJson, config, deps: !flags.direct, onStage: stageReporter(flags) });
    all.direct.push(...r.direct);
    all.deps.push(...r.deps);
    all.notes.push(...r.notes);
  }
  return { installs, ...all };
}

async function cmdScan(line, flags, config) {
  const { installs, direct, deps, notes } = await evaluateLine(line, flags, config);
  const results = [...direct, ...deps];
  if (flags.json) {
    process.stdout.write(JSON.stringify(toJson(results), null, 2) + '\n');
  } else {
    if (!installs.length) process.stderr.write('installguard: no package installs found in that command\n');
    if (direct.length) renderReport(direct, { verbose: flags.verbose, compact: false });
    if (deps.length) renderReport(deps, { verbose: flags.verbose, title: '  dependencies:' });
    printNotes(notes, flags);
  }
  return results.some((r) => isStopping(r, flags.strict || config.strict)) ? 1 : 0;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Agent hook. Accepts JSON with tool_input.command (the common
 * pre-command hook format), {"command": ...}, or a raw command line.
 * Exit 2 = block, with the reason on stderr so the agent reads it and can
 * correct itself.
 */
async function cmdHook(flags, config) {
  const input = await readStdin();
  let command = input;
  try {
    const j = JSON.parse(input);
    command = j?.tool_input?.command ?? j?.command ?? '';
  } catch {
    // Not JSON: treat stdin as the command itself.
  }
  if (!command || typeof command !== 'string') return 0;

  const { direct, deps } = await evaluateLine(command, { ...flags, json: true }, config);
  const stopping = [...direct, ...deps].filter((r) => isStopping(r, flags.strict || config.strict));
  if (!stopping.length) return 0;

  const lines = ['installguard blocked this install because a package looks unsafe:'];
  for (const r of stopping) {
    lines.push(`- ${r.pkg.ecosystem}:${r.pkg.name}${r.meta?.version ? '@' + r.meta.version : ''}${r.pkg.transitive ? ' (pulled in as a dependency)' : ''}`);
    for (const f of r.findings.filter((f) => f.severity !== 'low' && f.severity !== 'info')) {
      lines.push(`  ${f.severity.toUpperCase()}: ${f.message}`);
    }
  }
  lines.push('Double-check the package name. If it is correct and trusted, ask the user to approve it or add it to "allow" in .installguardrc.json.');
  process.stderr.write(lines.join('\n') + '\n');
  return 2;
}

async function cmdWrap(argv, flags, config) {
  const c = palette();
  const parsed = parseInstallArgv(argv);
  if (!parsed) return flags.dryRun ? 0 : run(argv); // not an install: pass straight through

  const strict = flags.strict || config.strict;
  const { direct, deps, notes, treeUnchecked } = await evaluateInstall(parsed, {
    http: getJson,
    config,
    deps: !flags.direct,
    onStage: stageReporter(flags),
  });

  if (flags.json) {
    process.stdout.write(JSON.stringify(toJson([...direct, ...deps]), null, 2) + '\n');
  } else {
    if (direct.length) renderReport(direct, { verbose: flags.verbose, compact: false });
    if (deps.length) renderReport(deps, { verbose: flags.verbose, title: parsed.mode === 'add' ? '  dependencies:' : undefined });
    if (parsed.skipped.length) process.stderr.write(c.dim(`  (not checked, not from the registry: ${parsed.skipped.join(', ')})\n`));
    printNotes(notes, flags);
  }

  const stopping = [...direct, ...deps].filter((r) => isStopping(r, strict));
  if (strict && treeUnchecked && !flags.yes) {
    process.stderr.write(c.red('\nStopped (--strict): the dependency tree could not be checked.\n'));
    return 1;
  }
  if (!(await decide(stopping, flags))) return 1;
  if (flags.dryRun) return stopping.length ? 1 : 0;
  if (!flags.json) process.stderr.write('\n');
  return run(argv);
}

export async function main(args) {
  const { flags, rest } = parseFlags(args);
  if (flags.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (flags.help || rest.length === 0) {
    process.stdout.write(HELP);
    return rest.length === 0 && !flags.help ? 2 : 0;
  }

  const config = loadConfig();
  const [cmd, ...more] = rest;
  const { flags: moreFlags, rest: tail } = parseFlags(more);
  const all = { ...flags, ...moreFlags };

  switch (cmd) {
    case 'check':
      return cmdCheck(tail, all, config);
    case 'audit':
      return cmdAudit(tail[0], all, config);
    case 'scan':
      return cmdScan(tail.join(' '), all, config);
    case 'hook':
      return cmdHook(all, config);
    case 'cache':
      if (tail[0] === 'clear') {
        cacheClear();
        process.stdout.write(`Cleared ${cacheDir()}\n`);
        return 0;
      }
      process.stdout.write(`${cacheDir()}\n`);
      return 0;
    case 'help':
      process.stdout.write(HELP);
      return 0;
    default:
      return cmdWrap(rest, flags, config);
  }
}
