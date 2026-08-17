import { validateEmbedUrl } from '../ssrf.js';

const MAX_REDIRECTS = 5;

// SSRF-safe fetch: re-validates every hop (embed pages can redirect), manual
// redirect handling, hard timeout. Returns null if blocked or too many hops.
export async function safeFetch(
  url: string,
  opts: { timeout: number; headers?: Record<string, string> }
): Promise<Response | null> {
  // One deadline for the whole chain: a per-hop timeout would let N redirects
  // multiply the wall-clock budget.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  try {
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (validateEmbedUrl(current)) return null; // blocked host/hop
      const res = await fetch(current, {
        method: 'GET',
        headers: opts.headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        // Redirect bodies are never read — release the socket instead of
        // leaking it until GC.
        res.body?.cancel().catch(() => {});
        const loc = res.headers.get('location');
        if (!loc) return res;
        current = new URL(loc, current).toString();
        continue;
      }
      return res;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
