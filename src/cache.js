import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Small on-disk cache for registry lookups, so repeat installs are instant.
 * Lives in the platform cache folder; set INSTALLGUARD_NO_CACHE=1 to skip it
 * or INSTALLGUARD_CACHE_DIR to move it. Any error just means "no cache".
 */
export function cacheDir() {
  if (process.env.INSTALLGUARD_CACHE_DIR) return process.env.INSTALLGUARD_CACHE_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'installguard', 'cache');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'installguard');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'installguard');
}

const enabled = () => !process.env.INSTALLGUARD_NO_CACHE;
const fileFor = (key) => join(cacheDir(), createHash('sha256').update(key).digest('hex').slice(0, 32) + '.json');

export function cacheGet(key) {
  if (!enabled()) return undefined;
  try {
    const entry = JSON.parse(readFileSync(fileFor(key), 'utf8'));
    if (entry.key !== key || Date.now() > entry.expires) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

export function cacheSet(key, value, ttlMs) {
  if (!enabled()) return;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(fileFor(key), JSON.stringify({ key, expires: Date.now() + ttlMs, value }));
  } catch {
    // A read-only home folder must never break an install.
  }
}

export function cacheClear() {
  rmSync(cacheDir(), { recursive: true, force: true });
}

/** Wrap an async lookup with the cache. */
export async function cached(key, ttlFor, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  const ttl = ttlFor(value);
  if (ttl > 0) cacheSet(key, value, ttl);
  return value;
}
