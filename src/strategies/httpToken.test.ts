import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractHttpToken } from './httpToken.js';

describe('extractHttpToken', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  it('extracts a default .m3u8 from the page HTML', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      '<html><script>file:"https://cdn.free.top/hls/token123/stream.m3u8"</script></html>', { status: 200 }));
    const r = await extractHttpToken('https://embed.free.top/embed/x', 5000);
    expect(r?.url).toBe('https://cdn.free.top/hls/token123/stream.m3u8');
    expect(r?.headers?.Origin).toBe('https://embed.free.top');
  });
  it('honors a provided capture pattern', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('data-src="https://x.top/a/b.m3u8"', { status: 200 }));
    const r = await extractHttpToken('https://embed.free.top/e', 5000, 'data-src="([^"]+\\.m3u8[^"]*)"');
    expect(r?.url).toBe('https://x.top/a/b.m3u8');
  });
  it('returns null when nothing matches', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>no stream</html>', { status: 200 }));
    expect(await extractHttpToken('https://embed.free.top/e', 5000)).toBeNull();
  });
  it('cancels the body of a non-200 response it never reads', async () => {
    const res = new Response('error page', { status: 403 });
    const cancel = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(res, 'body', { get: () => ({ cancel }) });
    vi.mocked(fetch).mockResolvedValue(res);
    expect(await extractHttpToken('https://embed.free.top/e', 5000)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('returns null instead of throwing on an invalid operator pattern', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('https://x.top/a.m3u8', { status: 200 }));
    await expect(extractHttpToken('https://embed.free.top/e', 5000, '(')).resolves.toBeNull();
  });
});
