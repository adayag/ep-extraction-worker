import { validateEmbedUrl } from '../ssrf.js';

const MAX_REDIRECTS = 5;

// SSRF-safe fetch: re-validates every hop (embed pages can redirect), manual
// redirect handling, hard timeout. Returns null if blocked or too many hops.
export async function safeFetch(
  url: string,
  opts: { timeout: number; headers?: Record<string, string> }
): Promise<Response | null> {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (validateEmbedUrl(current)) return null; // blocked host/hop
    const res = await fetch(current, {
      method: 'GET',
      headers: opts.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeout),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  return null;
}
