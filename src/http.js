const UA = 'installguard (+https://github.com/iambazzy/installguard)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON. Returns { status, data }. A 404 is returned (not thrown),
 * because "this package does not exist" is a normal, important answer.
 * Network errors, timeouts, 429s and 5xx responses are retried twice.
 */
export async function getJson(url, { timeout = 15000, retries = 2, text: wantText = false } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(400 * attempt);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: wantText ? '*/*' : 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 404) return { status: 404, data: null };
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`), { final: true });
      const text = await res.text();
      if (wantText) return { status: res.status, data: text };
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        // Bot walls and captive portals return HTML with a 200.
        throw Object.assign(new Error(`unexpected response from ${new URL(url).host}`), { final: true });
      }
    } catch (err) {
      if (err.final) throw err;
      lastError = err?.name === 'TimeoutError' ? new Error(`timed out reaching ${new URL(url).host}`) : err;
    }
  }
  throw lastError;
}
