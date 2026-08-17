import consola from 'consola';
import type { ExtractedStream } from '../extractor.js';
import { safeFetch } from './safeFetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_PATTERN = /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/;

export async function extractHttpToken(embedUrl: string, timeout: number, pattern?: string): Promise<ExtractedStream | null> {
  const res = await safeFetch(embedUrl, { timeout, headers: { 'User-Agent': UA } });
  if (!res || res.status !== 200) return null;
  const html = await res.text();
  const re = pattern ? new RegExp(pattern) : DEFAULT_PATTERN;
  const m = html.match(re);
  if (!m) { consola.debug('[http-token] no token match'); return null; }
  const url = m[1] ?? m[0]; // capture group 1 if the pattern has one
  const origin = new URL(embedUrl).origin;
  return { url, headers: { Referer: `${origin}/`, Origin: origin, 'User-Agent': UA } };
}
