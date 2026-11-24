import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { checkPackages } from './analyze.js';
import { findLockfiles, installedNpm } from './lockfiles.js';
import { resolveNpmTree, resolvePipTree, resolveUvTree } from './resolve.js';

const key = (p) => `${p.ecosystem}:${p.name.toLowerCase()}`;

/**
 * Evaluate one parsed install command.
 * Returns { direct: results[], deps: results[], notes: string[] }.
 *  - direct: the packages named on the command line
 *  - deps:   everything else the install would bring in (dependency tree,
 *            or the lockfile for "npm ci"-style installs)
 * `onStage(name, count)` is called before each slow step (for progress output).
 */
export async function evaluateInstall(parsed, opts) {
  const { http, config, cwd = process.cwd(), deps: checkDeps = true, onStage = () => {} } = opts;
  const checkOpts = { http, allow: config.allow, minReleaseAgeDays: config.minReleaseAgeDays };
  const notes = [];

  if (parsed.mode === 'lockfile') {
    const locks = findLockfiles(cwd, { ecosystem: parsed.family });
    if (!locks.length) {
      notes.push(`No lockfile found, so installguard can't see which packages ${parsed.manager} will install. Run "installguard audit" after installing.`);
      return { direct: [], deps: [], notes };
    }
    let packages = locks[0].packages;
    if (parsed.family === 'npm' && !parsed.clean && locks[0].file === 'package-lock.json') {
      // Plain "npm install": only what isn't installed yet is new.
      const have = installedNpm(cwd);
      packages = packages.filter((p) => !have.has(`${p.name}@${p.version}`));
    }
    if (!packages.length) return { direct: [], deps: [], notes };
    onStage(`locked in ${locks[0].file}`, packages.length);
    const deps = await checkPackages(
      packages.map((p) => ({ ...p, transitive: true })),
      checkOpts,
    );
    return { direct: [], deps, notes };
  }

  onStage('named', parsed.packages.length);
  const direct = await checkPackages(parsed.packages, checkOpts);
  if (!checkDeps || !parsed.packages.length) return { direct, deps: [], notes };
  // No point resolving a tree for a package that doesn't exist.
  if (direct.some((r) => r.meta && r.meta.exists === false)) return { direct, deps: [], notes };

  let tree;
  if (parsed.family === 'npm') {
    tree = await resolveNpmTree(parsed.specs, { cwd, flags: parsed.flags });
  } else if (parsed.manager === 'uv' && parsed.installArgs) {
    tree = await resolveUvTree(parsed.installArgs, { cwd });
  } else if (parsed.pipCmd) {
    tree = await resolvePipTree(parsed.pipCmd, parsed.installArgs, { cwd });
  } else {
    // uv add / poetry add / pipx / pipenv: preview with the local pip
    const py = process.platform === 'win32' ? 'python' : 'python3';
    tree = await resolvePipTree([py, '-m', 'pip'], parsed.specs, { cwd });
  }

  if (!tree.ok) {
    notes.push(`Couldn't preview the full dependency tree (${tree.reason}). Only the packages you named were checked.`);
    return { direct, deps: [], notes, treeUnchecked: true };
  }
  const named = new Set(parsed.packages.map(key));
  // Anything already locked in the project (yarn.lock, pnpm-lock.yaml, ...) isn't new.
  const locked = new Set(
    findLockfiles(cwd, { ecosystem: parsed.family }).flatMap((l) => l.packages.map((p) => `${key(p)}@${p.version}`)),
  );
  const extra = tree.packages.filter((p) => !named.has(key(p)) && !locked.has(`${key(p)}@${p.version}`));
  if (!extra.length) return { direct, deps: [], notes };
  onStage('dependencies', extra.length);
  const deps = await checkPackages(
    extra.map((p) => ({ ...p, transitive: true })),
    checkOpts,
  );
  return { direct, deps, notes };
}

/** Packages to check for `installguard audit`: lockfiles if any, else manifests. */
export function auditTargets(dir, { parseManifests }) {
  const locks = findLockfiles(dir);
  if (locks.length) {
    const seen = new Set();
    const packages = [];
    for (const l of locks) {
      for (const p of l.packages) {
        const k = `${p.ecosystem}:${p.name}@${p.version}`;
        if (!seen.has(k)) {
          seen.add(k);
          packages.push(p);
        }
      }
    }
    return { packages, sources: locks.map((l) => l.file), fromLockfile: true };
  }
  const { packages, sources } = parseManifests(dir);
  return { packages, sources, fromLockfile: false };
}

export const hasFile = (dir, f) => existsSync(join(dir, f));
