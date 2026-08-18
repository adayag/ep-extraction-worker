import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../extractor.js', () => ({ extractM3u8: vi.fn().mockResolvedValue({ url: 'browser-url' }) }));
vi.mock('./httpToken.js', () => ({ extractHttpToken: vi.fn().mockResolvedValue({ url: 'token-url' }) }));
import { extractM3u8 } from '../extractor.js';
import { extractHttpToken } from './httpToken.js';
import { dispatchExtraction } from './index.js';

beforeEach(() => vi.clearAllMocks());

describe('dispatchExtraction', () => {
  it('routes browser to extractM3u8 (Chrome queue)', async () => {
    const r = await dispatchExtraction('u', { timeout: 1, priority: 10, strategy: 'browser', queueEnqueueTime: 0 });
    expect(r).toEqual({ url: 'browser-url' });
    expect(extractM3u8).toHaveBeenCalledOnce();
    expect(extractHttpToken).not.toHaveBeenCalled();
  });
  it('forwards the navigation referer to the browser extractor', async () => {
    await dispatchExtraction('u', {
      timeout: 5,
      priority: 0,
      strategy: 'browser',
      queueEnqueueTime: 0,
      referer: 'https://dlstreams.example.st/',
    });
    expect(extractM3u8).toHaveBeenCalledWith('u', 5, 0, 0, 'https://dlstreams.example.st/');
  });
  it('leaves the browser referer undefined when not supplied', async () => {
    await dispatchExtraction('u', { timeout: 5, priority: 0, strategy: 'browser' });
    expect(extractM3u8).toHaveBeenCalledWith('u', 5, 0, undefined, undefined);
  });
  it('routes http-token off the browser queue', async () => {
    const r = await dispatchExtraction('u', { timeout: 1, priority: 0, strategy: 'http-token' });
    expect(r).toEqual({ url: 'token-url' });
    expect(extractHttpToken).toHaveBeenCalledOnce();
    expect(extractM3u8).not.toHaveBeenCalled();
  });
});
