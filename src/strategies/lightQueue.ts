import PQueue from 'p-queue';

// Cheap HTTP strategies run here, NOT on the 2-slot browser queue, so a slow
// Chrome extraction can never starve a fast signed-url/http-token fetch.
const LIGHT_MAX = parseInt(process.env.LIGHT_MAX_CONCURRENT || '8', 10);
export const lightQueue: PQueue = new PQueue({ concurrency: LIGHT_MAX });
