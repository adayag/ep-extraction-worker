import { describe, it, expect } from 'vitest';
import { validateEmbedUrl } from './ssrf.js';

describe('validateEmbedUrl', () => {
  it.each([
    ['https://embed.example.com/x', null],
    ['ftp://x', 'scheme'],
    ['http://localhost/x', 'localhost'],
    ['http://127.0.0.1/x', 'internal'],
    ['http://10.1.2.3/x', 'internal'],
    ['http://169.254.1.1/x', 'internal'],
    ['not a url', 'Invalid'],
  ])('validates %s', (url, expectContains) => {
    const r = validateEmbedUrl(url);
    if (expectContains === null) expect(r).toBeNull();
    else expect(r).toContain(expectContains);
  });
});
