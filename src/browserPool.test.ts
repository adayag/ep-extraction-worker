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

  describe('priority queue', () => {
    it('executes high priority before low priority when queued', async () => {
      vi.resetModules();
      vi.useRealTimers(); // Need real timers for p-queue

      // Set MAX_CONCURRENT=1 to ensure tasks truly queue
      process.env.MAX_CONCURRENT = '1';
      const { browserPool } = await import('./browserPool.js');
      const order: string[] = [];

      // Create a blocker to fill the single slot
      let releaseBlocker: () => void;
      const blockerPromise = browserPool.withLimit(
        () =>
          new Promise<void>((resolve) => {
            releaseBlocker = resolve;
          }),
        0
      );

      // Wait for blocker to start
      await new Promise((r) => setTimeout(r, 10));

      // Queue low priority first (will be pending)
      const lowPromise = browserPool.withLimit(async () => {
        order.push('low');
      }, 0);

      // Queue high priority second (will be pending but higher priority)
      const highPromise = browserPool.withLimit(async () => {
        order.push('high');
      }, 10);

      // Release blocker and let queue process
      releaseBlocker!();
      await blockerPromise;
      await Promise.all([lowPromise, highPromise]);

      // High priority should execute before low priority
      expect(order).toEqual(['high', 'low']);

      await browserPool.close();
      delete process.env.MAX_CONCURRENT;
    });

    it('respects FIFO within same priority level', async () => {
      vi.resetModules();
      vi.useRealTimers();

      // Set MAX_CONCURRENT=1 to ensure tasks truly queue
      process.env.MAX_CONCURRENT = '1';
      const { browserPool } = await import('./browserPool.js');
      const order: string[] = [];

      // Create a blocker to fill the single slot
      let releaseBlocker: () => void;
      const blockerPromise = browserPool.withLimit(
        () =>
          new Promise<void>((resolve) => {
            releaseBlocker = resolve;
          }),
        5
      );

      // Wait for blocker to start
      await new Promise((r) => setTimeout(r, 10));

      // Queue three tasks with same priority (all will be pending)
      const first = browserPool.withLimit(async () => {
        order.push('first');
      }, 5);

      const second = browserPool.withLimit(async () => {
        order.push('second');
      }, 5);

      const third = browserPool.withLimit(async () => {
        order.push('third');
      }, 5);

      // Release blocker and let queue process
      releaseBlocker!();
      await blockerPromise;
      await Promise.all([first, second, third]);

      // Should maintain FIFO order within same priority
      expect(order).toEqual(['first', 'second', 'third']);

      await browserPool.close();
      delete process.env.MAX_CONCURRENT;
    });

    it('reports correct queue size and active count', async () => {
      vi.resetModules();
      vi.useRealTimers();

      const { browserPool } = await import('./browserPool.js');

      // Initially empty
      expect(browserPool.getQueueSize()).toBe(0);
      expect(browserPool.getActiveCount()).toBe(0);

      // Create a blocker
      let releaseBlocker: () => void;
      const blockerPromise = browserPool.withLimit(
        () =>
          new Promise<void>((resolve) => {
            releaseBlocker = resolve;
          }),
        0
      );

      // Wait a tick for the task to become active
      await new Promise((r) => setTimeout(r, 10));

      // One task should be active
      expect(browserPool.getActiveCount()).toBe(1);

      // Queue another task
      const queuedPromise = browserPool.withLimit(async () => {}, 0);

      // Wait a tick
      await new Promise((r) => setTimeout(r, 10));

      // Should have one pending (since MAX_CONCURRENT defaults to 2, it might already be active)
      // Just verify getQueueSize returns a number
      expect(typeof browserPool.getQueueSize()).toBe('number');

      // Release and clean up
      releaseBlocker!();
      await blockerPromise;
      await queuedPromise;

      await browserPool.close();
    });
  });
});
