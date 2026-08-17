import PQueue from 'p-queue';

// Cheap HTTP strategies run here, NOT on the 2-slot browser queue, so a slow
// Chrome extraction can never starve a fast signed-url/http-token fetch.
// A non-numeric env value would make p-queue throw at import and stop the
// worker from booting, so fall back to the default instead.
const parsedMax = parseInt(process.env.LIGHT_MAX_CONCURRENT || '8', 10);
const LIGHT_MAX = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 8;
export const lightQueue: PQueue = new PQueue({ concurrency: LIGHT_MAX });
