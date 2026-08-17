import consola from 'consola';
import type { ExtractedStream } from '../extractor.js';
import { safeFetch } from './safeFetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_PATTERN = /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/;

export async function extractHttpToken(embedUrl: string, timeout: number, pattern?: string): Promise<ExtractedStream | null> {
  const res = await safeFetch(embedUrl, { timeout, headers: { 'User-Agent': UA } });
  if (!res) return null;
  if (res.status !== 200) { res.body?.cancel().catch(() => {}); return null; }
  const html = await res.text();
  // Operators tune this pattern live, so a malformed one must degrade to a
  // pattern_miss rather than crash the request. ReDoS on a hand-tuned pattern
  // is an accepted operator-controlled risk.
  let re = DEFAULT_PATTERN;
  if (pattern) {
    try {
      re = new RegExp(pattern);
    } catch (err) {
      consola.warn(`[http-token] invalid pattern ${JSON.stringify(pattern)}: ${err}`);
      return null;
    }
  }
  const m = html.match(re);
  if (!m) { consola.debug('[http-token] no token match'); return null; }
  const url = m[1] ?? m[0]; // capture group 1 if the pattern has one
  const origin = new URL(embedUrl).origin;
  return { url, headers: { Referer: `${origin}/`, Origin: origin, 'User-Agent': UA } };
}
