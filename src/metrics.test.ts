import { describe, it, expect } from 'vitest';
import { ERROR_TYPES, extractionsTotal, register } from './metrics.js';

describe('metrics for strategies', () => {
  it('has pattern_miss and http_error error types', () => {
    expect(ERROR_TYPES.pattern_miss).toBe('pattern_miss');
    expect(ERROR_TYPES.http_error).toBe('http_error');
  });

  it('extractionsTotal accepts a strategy label', async () => {
    extractionsTotal.inc({ status: 'success', error_type: 'none', strategy: 'signed-url' });
    const txt = await register.metrics();
    expect(txt).toContain('strategy="signed-url"');
  });
});
