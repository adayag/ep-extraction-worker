import { describe, it, expect, vi, afterEach } from 'vitest';

// Concurrency is read at import time, so each case needs a fresh module graph.
async function loadConcurrency(env: string): Promise<number> {
  vi.resetModules();
  vi.stubEnv('LIGHT_MAX_CONCURRENT', env);
  const { lightQueue } = await import('./lightQueue.js');
  return lightQueue.concurrency;
}

describe('lightQueue concurrency', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses a valid numeric env value', async () => {
    expect(await loadConcurrency('4')).toBe(4);
  });
  it('defaults to 8 when unset', async () => {
    expect(await loadConcurrency('')).toBe(8);
  });
  it('defaults to 8 instead of throwing on a non-numeric value', async () => {
    await expect(loadConcurrency('eight')).resolves.toBe(8);
  });
  it('defaults to 8 on a non-positive value', async () => {
    expect(await loadConcurrency('0')).toBe(8);
  });
});
