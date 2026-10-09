/** Run a bounded set of read workers; drain admitted work before propagating failure.
 * @param {Array} items Read inputs.
 * @param {number} concurrency Maximum admitted workers.
 * @param {Function} worker Async operation.
 * @param {AbortSignal} [signal] Stop admission when cancelled.
 * @returns {Promise<Array>} Results in input order.
 */
export async function boundedWork(items, concurrency, worker, signal) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid read concurrency');
  const results = new Array(items.length);
  let next = 0, failure;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !failure && !signal?.aborted) {
      const index = next++;
      try { results[index] = await worker(items[index], index); }
      catch (error) { failure ??= error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  signal?.throwIfAborted();
  return results;
}
