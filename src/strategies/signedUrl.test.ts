import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeObfuscatedBlob, extractSignedUrl } from './signedUrl.js';

const K1 = 233, K2 = 18;
function encode(plaintext: string): number[] {
  // inverse of ((b ^ K1) - K2 + 256) % 256 === c  =>  b = ((c + K2) % 256) ^ K1
  return [...plaintext].map(ch => (((ch.charCodeAt(0) + K2) % 256) ^ K1));
}
function fakeEmbed(jsPayload: string): string {
  const arr = encode(jsPayload);
  return `<html><script>(function(){var _a=[${arr.join(',')}],_k1=${K1},_k2=${K2},s="",i;` +
    `for(i=0;i<_a.length;i++){s+=String.fromCharCode(((_a[i]^_k1)-_k2+256)%256);}window["ev"+"al"](s);})();</script></html>`;
}

describe('decodeObfuscatedBlob', () => {
  it('recovers the plaintext JS using in-page keys', () => {
    const js = 'var SIGNED_URL="https://cdn.example.com/secure/abc/123/x.m3u8";';
    expect(decodeObfuscatedBlob(fakeEmbed(js))).toContain('https://cdn.example.com/secure/abc/123/x.m3u8');
  });
  it('returns null when no blob is present', () => {
    expect(decodeObfuscatedBlob('<html>nothing</html>')).toBeNull();
  });
});

describe('extractSignedUrl', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  it('fetches the embed, decodes, and returns the m3u8 with headers', async () => {
    const js = 'var SIGNED_URL="https://volder.example.cfd/main/secure/sig/1786940364/id.m3u8";';
    vi.mocked(fetch).mockResolvedValue(new Response(fakeEmbed(js), { status: 200 }));
    const r = await extractSignedUrl('https://embed.example.top/embed/x', 5000);
    expect(r?.url).toBe('https://volder.example.cfd/main/secure/sig/1786940364/id.m3u8');
    expect(r?.headers?.Referer).toBe('https://embed.example.top/');
    expect(r?.headers?.Origin).toBe('https://embed.example.top');
  });
  it('returns null when the decoded blob has no m3u8', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(fakeEmbed('var x=1;'), { status: 200 }));
    expect(await extractSignedUrl('https://embed.example.top/embed/x', 5000)).toBeNull();
  });
});
