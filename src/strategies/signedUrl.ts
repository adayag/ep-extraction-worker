import consola from 'consola';
import type { ExtractedStream } from '../extractor.js';
import { safeFetch } from './safeFetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The embed page ships an XOR-obfuscated JS blob AND the decode keys inline.
// Recover the JS: for each byte b, char = ((b ^ k1) - k2 + 256) % 256, where
// k1/k2 and the byte array are resolved from their variable declarations.
export function decodeObfuscatedBlob(html: string): string | null {
  const formula = html.match(/(\w+)\s*\[\s*\w+\s*\]\s*\^\s*(\w+)\s*\)\s*-\s*(\w+)\s*\+\s*256/);
  if (!formula) return null;
  const [, arrName, k1Name, k2Name] = formula;
  const arrM = html.match(new RegExp(arrName + '\\s*=\\s*\\[([0-9,\\s]+)\\]'));
  const k1M = html.match(new RegExp(k1Name + '\\s*=\\s*(\\d+)'));
  const k2M = html.match(new RegExp(k2Name + '\\s*=\\s*(\\d+)'));
  if (!arrM || !k1M || !k2M) return null;
  const arr = arrM[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
  const k1 = parseInt(k1M[1], 10);
  const k2 = parseInt(k2M[1], 10);
  let out = '';
  for (const b of arr) out += String.fromCharCode(((b ^ k1) - k2 + 256) % 256);
  return out;
}

export async function extractSignedUrl(embedUrl: string, timeout: number): Promise<ExtractedStream | null> {
  const res = await safeFetch(embedUrl, { timeout, headers: { 'User-Agent': UA } });
  if (!res || res.status !== 200) return null;
  const html = await res.text();
  const decoded = decodeObfuscatedBlob(html) ?? html; // some pages may be plain
  const m = decoded.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
  if (!m) { consola.debug('[signed-url] no m3u8 in decoded blob'); return null; }
  const origin = new URL(embedUrl).origin;
  return { url: m[0], headers: { Referer: `${origin}/`, Origin: origin, 'User-Agent': UA } };
}
