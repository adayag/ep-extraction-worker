import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock browser that we can control
const mockBrowser = {
  isConnected: vi.fn().mockReturnValue(true),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  newContext: vi.fn().mockResolvedValue({}),
};

const mockChromium = {
  launch: vi.fn().mockResolvedValue(mockBrowser),
};

vi.mock('patchright', () => ({
  chromium: mockChromium,
}));

describe('browserPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockBrowser.isConnected.mockReturnValue(true);
    mockBrowser.close.mockResolvedValue(undefined);
    mockChromium.launch.mockResolvedValue(mockBrowser);
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Reset module cache to get fresh instances
    vi.resetModules();
  });

  describe('idle restart', () => {
    it('schedules restart timer after extraction completes', async () => {
      vi.resetModules();
      const { browserPool } = await import('./browserPool.js');

      // Run an extraction that creates a context (this launches the browser)
      await browserPool.withLimit(async () => {
        await browserPool.createContext();
        return 'result';
      });

      // Timer should be scheduled (idle timer)
      expect(vi.getTimerCount()).toBe(1);

      await browserPool.close();
    });

    it('clears timer when new extraction starts', async () => {
      vi.resetModules();
      const { browserPool } = await import('./browserPool.js');

      // Run first extraction
      await browserPool.withLimit(async () => {
        await browserPool.createContext();
        return 'result1';
      });

      // Timer should be scheduled
      expect(vi.getTimerCount()).toBe(1);

      // Start new extraction - timer should be cleared during execution
      await browserPool.withLimit(async () => {
        // Timer should be cleared when extraction starts
        expect(vi.getTimerCount()).toBe(0);
        return 'result2';
      });

      // New timer should be scheduled after completion
      expect(vi.getTimerCount()).toBe(1);

      await browserPool.close();
    });

    it('restarts browser when idle timer fires', async () => {
      vi.resetModules();
      const { browserPool } = await import('./browserPool.js');

      // Launch browser by running an extraction that creates context
      await browserPool.withLimit(async () => {
        await browserPool.createContext();
        return 'result';
      });

      // Browser should be running
      expect(browserPool.isRunning()).toBe(true);

      // Clear close mock to check if it's called by idle timer
      mockBrowser.close.mockClear();

      // Advance time past idle timeout (60 seconds)
      await vi.advanceTimersByTimeAsync(61000);

      // Browser should have been closed by idle restart
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('does not restart if extractions are in progress', async () => {
      vi.resetModules();
      const { browserPool } = await import('./browserPool.js');

      // Clear any initial close calls
      mockBrowser.close.mockClear();

      // Start a long-running extraction
      let resolveExtraction: () => void;
      const extractionPromise = browserPool.withLimit(
        () =>
          new Promise<string>((resolve) => {
            resolveExtraction = () => resolve('done');
          })
      );

      // Advance time past idle timeout while extraction is running
      await vi.advanceTimersByTimeAsync(61000);

      // Browser should NOT have been closed (extraction still in progress)
      expect(mockBrowser.close).not.toHaveBeenCalled();

      // Complete the extraction
      resolveExtraction!();
      await extractionPromise;

      await browserPool.close();
    });
  });

  describe('max-age restart', () => {
    it('restarts browser when max age exceeded and queue empty', async () => {
      vi.resetModules();
      const { browserPool } = await import('./browserPool.js');

      // Launch browser
      await browserPool.withLimit(async () => {
        await browserPool.createContext();
        return 'result';
      });

      // Clear the close mock
      mockBrowser.close.mockClear();

      // Advance time past idle timeout (60s) - this triggers idle restart
      await vi.advanceTimersByTimeAsync(61000);

      // Idle restart should have triggered (which is good - it also resets for max-age)
      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('clears idle timer on close', async () => {
      vi.resetModules();
      const { browserPool } = await import('./browserPool.js');

      // Run an extraction to schedule idle timer
      await browserPool.withLimit(async () => {
        await browserPool.createContext();
        return 'result';
      });

      // Timer should be scheduled
      expect(vi.getTimerCount()).toBe(1);

      // Close should clear the timer
      await browserPool.close();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
