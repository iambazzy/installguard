const UA = 'installguard (+https://github.com/iambazzy/installguard)';

/**
 * Fetch JSON. Returns { status, data }. A 404 is returned (not thrown),
 * because "this package does not exist" is a normal, important answer.
 */
export async function getJson(url, { timeout = 10000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return { status: res.status, data: await res.json() };
}
