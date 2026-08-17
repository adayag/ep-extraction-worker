import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeFetch } from './safeFetch.js';

// Real Response bodies can't be spied on directly, so swap the instance's
// `body` getter for a stub exposing cancel().
function withCancelSpy(res: Response) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(res, 'body', { get: () => ({ cancel }) });
  return { res, cancel };
}

describe('safeFetch', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('follows a redirect and returns the final response', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/final' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await safeFetch('https://embed.example.top/a', { timeout: 5000 });
    expect(res?.status).toBe(200);
  });

  it('returns null for a blocked host without fetching', async () => {
    expect(await safeFetch('http://127.0.0.1/x', { timeout: 5000 })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels the body of a redirect response it does not read', async () => {
    const { res, cancel } = withCancelSpy(
      new Response('redirect padding', { status: 302, headers: { location: '/final' } })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(res)
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await safeFetch('https://embed.example.top/a', { timeout: 5000 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels the body of a redirect that has no location header', async () => {
    const { res, cancel } = withCancelSpy(new Response('redirect padding', { status: 302 }));
    vi.mocked(fetch).mockResolvedValueOnce(res);
    const out = await safeFetch('https://embed.example.top/a', { timeout: 5000 });
    expect(out?.status).toBe(302);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('shares one deadline signal across every hop', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.mocked(fetch).mockImplementation(async (_url: any, init: any) => {
      signals.push(init?.signal);
      return signals.length === 1
        ? new Response(null, { status: 302, headers: { location: '/final' } })
        : new Response('ok', { status: 200 });
    });
    await safeFetch('https://embed.example.top/a', { timeout: 5000 });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).toBe(signals[1]); // one deadline, not one per hop
  });

  it('aborts exactly once when the shared deadline expires', async () => {
    vi.useFakeTimers();
    const aborts: string[] = [];
    vi.mocked(fetch).mockImplementation(
      (_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborts.push('abort');
            reject(new Error('aborted'));
          });
        })
    );
    const assertion = expect(safeFetch('https://embed.example.top/a', { timeout: 1000 })).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(aborts).toHaveLength(1);
  });

  it('clears the deadline timer once the fetch completes', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(new Response('ok', { status: 200 }));
    await safeFetch('https://embed.example.top/a', { timeout: 5000 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
