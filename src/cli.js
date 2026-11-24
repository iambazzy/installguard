import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { checkPackages } from './analyze.js';
import { loadConfig } from './config.js';
import { getJson } from './http.js';
import {
  findInstallsInCommand,
  parseInstallArgv,
  parseNpmSpec,
  parsePackageJson,
  parsePipSpec,
  parseRequirementsFile,
} from './parse.js';
import { palette, renderReport, toJson } from './report.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `installguard ${VERSION}
Check packages before you install them.

Usage
  installguard <install command>     check, then run it
  installguard check <pkg...>        check packages (npm by default)
  installguard audit [dir]           check package.json and requirements*.txt
  installguard scan "<command>"      check a shell command without running it
  installguard hook                  agent hook: reads a tool call on stdin

Examples
  installguard npm install express lodash
  installguard pip install requests==2.32.3
  installguard check pypi:requests npm:left-pad
  installguard check --pypi numpy pandas
  installguard audit .

Options
  -y, --yes       continue without asking, even if something looks risky
  --strict        also stop on "check this" (medium) findings
  --dry-run       check only, never run the install
  --json          print results as JSON on stdout
  -v, --verbose   show every finding, including minor ones
  -h, --help      show this help
  --version       show the version

Config: .installguardrc.json  {"allow": ["internal-pkg"], "strict": false}
Exit codes: 0 ok, 1 stopped because of a risky package, 2 error.
`;

function parseFlags(args) {
  const flags = { yes: false, strict: false, json: false, verbose: false, dryRun: false, pypi: false };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-y' || a === '--yes') flags.yes = true;
    else if (a === '--strict') flags.strict = true;
    else if (a === '--json') flags.json = true;
    else if (a === '-v' || a === '--verbose') flags.verbose = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--pypi') flags.pypi = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--version') flags.version = true;
    else break;
  }
  return { flags, rest: args.slice(i) };
}

function isStopping(result, strict) {
  if (result.allowed) return false;
  return result.verdict === 'block' || result.verdict === 'danger' || (strict && result.verdict === 'caution');
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function run(argv) {
  return new Promise((res) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', (err) => {
      process.stderr.write(`installguard: could not run ${argv[0]}: ${err.message}\n`);
      res(127);
    });
    child.on('exit', (code, signal) => res(signal ? 1 : code ?? 0));
  });
}

async function report(results, flags) {
  const c = palette();
  if (flags.json) process.stdout.write(JSON.stringify(toJson(results), null, 2) + '\n');
  else if (results.length) renderReport(results, { verbose: flags.verbose });
  const stopping = results.filter((r) => isStopping(r, flags.strict));
  return { stopping, c };
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
  const results = await checkPackages(packages, { http: getJson, allow: config.allow });
  const { stopping } = await report(results, flags);
  return stopping.length ? 1 : 0;
}

function collectManifests(dir) {
  const packages = [];
  const sources = [];
  const pj = join(dir, 'package.json');
  if (existsSync(pj)) {
    packages.push(...parsePackageJson(pj));
    sources.push('package.json');
  }
  for (const f of readdirSync(dir)) {
    if (/^requirements.*\.txt$/i.test(f)) {
      packages.push(...parseRequirementsFile(join(dir, f)));
      sources.push(f);
    }
  }
  const seen = new Set();
  const unique = packages.filter((p) => {
    const key = `${p.ecosystem}:${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { packages: unique, sources };
}

async function cmdAudit(dirArg, flags, config) {
  const dir = resolve(dirArg || '.');
  const { packages, sources } = collectManifests(dir);
  const c = palette();
  if (!packages.length) {
    process.stderr.write(`installguard: no dependencies found in ${dir} (looked for package.json, requirements*.txt)\n`);
    return 0;
  }
  if (!flags.json) process.stderr.write(c.dim(`installguard: checking ${packages.length} dependencies from ${sources.join(', ')}\n`));
  const results = await checkPackages(packages, { http: getJson, allow: config.allow });
  const { stopping } = await report(results, flags);
  if (!flags.json) {
    process.stderr.write(
      stopping.length
        ? c.red(`\n${stopping.length} risky ${stopping.length === 1 ? 'dependency' : 'dependencies'} found.\n`)
        : c.green('\nNo risky dependencies found.\n'),
    );
  }
  return stopping.length ? 1 : 0;
}

async function checkCommandLine(line, config) {
  const installs = findInstallsInCommand(line);
  const packages = installs.flatMap((i) => i.packages);
  if (!packages.length) return { results: [], installs };
  const results = await checkPackages(packages, { http: getJson, allow: config.allow });
  return { results, installs };
}

async function cmdScan(line, flags, config) {
  const { results } = await checkCommandLine(line, config);
  if (!results.length) {
    if (!flags.json) process.stderr.write('installguard: no package installs found in that command\n');
    else process.stdout.write('[]\n');
    return 0;
  }
  const { stopping } = await report(results, flags);
  return stopping.length ? 1 : 0;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Agent hook. Works with pre-command agent hooks (JSON with
 * tool_input.command on stdin) and with anything that pipes a raw
 * command line. Exit 2 = block, with the reason on stderr so the agent
 * reads it and can correct itself.
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

  const { results } = await checkCommandLine(command, config);
  const stopping = results.filter((r) => isStopping(r, flags.strict || config.strict));
  if (!stopping.length) return 0;

  const lines = ['installguard blocked this install because a package looks unsafe:'];
  for (const r of stopping) {
    lines.push(`- ${r.pkg.ecosystem}:${r.pkg.name}`);
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
  if (!parsed || !parsed.packages.length) {
    // Not an install (or "npm install" with no names): nothing to check.
    if (parsed?.skipped.length && !flags.json) {
      process.stderr.write(c.dim(`installguard: not checking non-registry sources: ${parsed.skipped.join(', ')}\n`));
    }
    return flags.dryRun ? 0 : run(argv);
  }

  if (!flags.json) {
    const n = parsed.packages.length;
    process.stderr.write(c.dim(`installguard: checking ${n} ${n === 1 ? 'package' : 'packages'} before ${parsed.manager} installs\n`));
  }
  const results = await checkPackages(parsed.packages, { http: getJson, allow: config.allow });
  const strict = flags.strict || config.strict;
  const { stopping } = await report(results, { ...flags, strict });
  if (parsed.skipped.length && !flags.json) {
    process.stderr.write(c.dim(`  (not checked, not from the registry: ${parsed.skipped.join(', ')})\n`));
  }

  if (stopping.length) {
    if (flags.yes) {
      process.stderr.write(c.yellow('\n--yes given: installing anyway.\n'));
    } else if (process.stdin.isTTY && process.stderr.isTTY) {
      const ok = await ask(c.bold(`\n${stopping.length === 1 ? 'This package looks' : 'Some packages look'} risky. Install anyway? [y/N] `));
      if (!ok) {
        process.stderr.write('Cancelled. Nothing was installed.\n');
        return 1;
      }
    } else {
      process.stderr.write(c.red('\nStopped: risky package and no terminal to confirm. Use --yes to override.\n'));
      return 1;
    }
  }

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
  const all = { ...flags, ...Object.fromEntries(Object.entries(moreFlags).filter(([, v]) => v)) };

  switch (cmd) {
    case 'check':
      return cmdCheck(tail, all, config);
    case 'audit':
      return cmdAudit(tail[0], all, config);
    case 'scan':
      return cmdScan(tail.join(' '), all, config);
    case 'hook':
      return cmdHook(all, config);
    case 'help':
      process.stdout.write(HELP);
      return 0;
    default:
      return cmdWrap(rest, flags, config);
  }
}
