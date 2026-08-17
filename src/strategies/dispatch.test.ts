import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../extractor.js', () => ({ extractM3u8: vi.fn().mockResolvedValue({ url: 'browser-url' }) }));
vi.mock('./signedUrl.js', () => ({ extractSignedUrl: vi.fn().mockResolvedValue({ url: 'signed-url' }) }));
vi.mock('./httpToken.js', () => ({ extractHttpToken: vi.fn().mockResolvedValue({ url: 'token-url' }) }));
import { extractM3u8 } from '../extractor.js';
import { extractSignedUrl } from './signedUrl.js';
import { dispatchExtraction } from './index.js';

beforeEach(() => vi.clearAllMocks());

describe('dispatchExtraction', () => {
  it('routes browser to extractM3u8 (Chrome queue)', async () => {
    const r = await dispatchExtraction('u', { timeout: 1, priority: 10, strategy: 'browser', queueEnqueueTime: 0 });
    expect(r).toEqual({ url: 'browser-url' });
    expect(extractM3u8).toHaveBeenCalledOnce();
    expect(extractSignedUrl).not.toHaveBeenCalled();
  });
  it('routes signed-url off the browser queue', async () => {
    const r = await dispatchExtraction('u', { timeout: 1, priority: 0, strategy: 'signed-url' });
    expect(r).toEqual({ url: 'signed-url' });
    expect(extractSignedUrl).toHaveBeenCalledOnce();
    expect(extractM3u8).not.toHaveBeenCalled();
  });
});
