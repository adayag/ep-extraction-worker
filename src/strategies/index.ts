import { extractM3u8, type ExtractedStream } from '../extractor.js';
import { extractSignedUrl } from './signedUrl.js';
import { extractHttpToken } from './httpToken.js';
import { lightQueue } from './lightQueue.js';

export type Strategy = 'browser' | 'signed-url' | 'http-token';

export interface DispatchOpts {
  timeout: number;
  priority: number;
  strategy: Strategy;
  pattern?: string;
  queueEnqueueTime?: number;
}

export async function dispatchExtraction(embedUrl: string, opts: DispatchOpts): Promise<ExtractedStream | null> {
  if (opts.strategy === 'browser') {
    return extractM3u8(embedUrl, opts.timeout, opts.priority, opts.queueEnqueueTime);
  }
  const run = opts.strategy === 'signed-url'
    ? () => extractSignedUrl(embedUrl, opts.timeout)
    : () => extractHttpToken(embedUrl, opts.timeout, opts.pattern);
  return (await lightQueue.add(run)) ?? null;
}
