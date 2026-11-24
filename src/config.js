import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FILE = '.installguardrc.json';

/**
 * Config is merged from ~/.installguardrc.json and the nearest
 * .installguardrc.json walking up from the current folder.
 *   { "allow": ["my-internal-pkg"], "strict": false, "minReleaseAgeDays": 0 }
 */
export function loadConfig(cwd = process.cwd()) {
  const files = [];
  const home = join(homedir(), FILE);
  if (existsSync(home)) files.push(home);
  let dir = cwd;
  while (true) {
    const f = join(dir, FILE);
    if (existsSync(f) && f !== home) {
      files.push(f);
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  const config = { allow: [], strict: false, minReleaseAgeDays: 0 };
  for (const f of files) {
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(c.allow)) config.allow.push(...c.allow);
      if (typeof c.strict === 'boolean') config.strict = c.strict;
      if (Number.isFinite(c.minReleaseAgeDays) && c.minReleaseAgeDays >= 0) config.minReleaseAgeDays = c.minReleaseAgeDays;
    } catch (err) {
      process.stderr.write(`installguard: ignoring ${f}: ${err.message}\n`);
    }
  }
  if (process.env.INSTALLGUARD_ALLOW) {
    config.allow.push(...process.env.INSTALLGUARD_ALLOW.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return config;
}
