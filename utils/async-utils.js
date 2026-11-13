/**
 * Small async helpers used across VectHare.
 * Originally adapted from https://github.com/prolix-oc/ST-Helpers
 * @module asyncUtils
 */

const AsyncUtils = {
    /**
     * Resolves after `ms` milliseconds.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * Calls `fn` until it succeeds, with exponential backoff.
     * @param {() => Promise<*>} fn
     * @param {object} [options]
     * @param {number} [options.maxAttempts=3]
     * @param {number} [options.delay=1000] First retry delay in ms
     * @param {number} [options.maxDelay=30000]
     * @param {number} [options.backoffFactor=2]
     * @param {(attempt: number, error: Error) => void} [options.onRetry]
     * @param {(error: Error) => boolean} [options.shouldRetry] Return false to fail immediately
     * @returns {Promise<*>}
     */
    async retry(fn, options = {}) {
        const {
            maxAttempts = 3,
            delay = 1000,
            maxDelay = 30000,
            backoffFactor = 2,
            onRetry = null,
            shouldRetry = () => true,
        } = options;

        let currentDelay = delay;
        for (let attempt = 1; ; attempt++) {
            try {
                return await fn();
            } catch (error) {
                if (attempt >= maxAttempts || !shouldRetry(error)) throw error;
                onRetry?.(attempt, error);
                await this.sleep(currentDelay);
                currentDelay = Math.min(currentDelay * backoffFactor, maxDelay);
            }
        }
    },

    /**
     * Rejects with `message` if `promise` does not settle within `ms`.
     * @param {Promise<*>} promise
     * @param {number} ms
     * @param {string} [message]
     * @returns {Promise<*>}
     */
    timeout(promise, ms, message = 'Operation timed out') {
        let timeoutId;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]).finally(() => clearTimeout(timeoutId));
    },

    /**
     * Runs async task functions with at most `concurrency` in flight.
     * Results keep the input order; the first rejection rejects the whole call.
     * @param {Array<() => Promise<*>>} fns
     * @param {number} [concurrency=5]
     * @returns {Promise<Array<*>>}
     */
    async parallel(fns, concurrency = 5) {
        const results = new Array(fns.length);
        let next = 0;
        const worker = async () => {
            while (next < fns.length) {
                const index = next++;
                results[index] = await fns[index]();
            }
        };
        const workers = Array.from({ length: Math.max(1, Math.min(concurrency, fns.length)) }, worker);
        await Promise.all(workers);
        return results;
    },
};

export default AsyncUtils;
