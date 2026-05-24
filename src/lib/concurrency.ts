/**
 * Bounded-parallelism helpers.
 *
 * mapWithConcurrency(items, n, worker): runs `worker` over `items` with at most
 * `n` in flight. Output is in input order, even if completion is out-of-order.
 * Per-item failures don't kill the whole batch — each item resolves individually
 * (Promise.allSettled style), and the caller decides how to handle errors.
 *
 * onBatchSettled is invoked AFTER each batch of up to `n` consecutive items
 * has fully resolved (in input order), useful for incrementally updating shared
 * state (e.g. a glossary built from already-translated pages) before launching
 * the next batch.
 */

export interface BatchOptions {
  signal?: AbortSignal;
  onBatchSettled?: (batchStartIndex: number, batchEndIndex: number) => void | Promise<void>;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  n: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: BatchOptions = {},
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
  const out: Array<{ ok: true; value: R } | { ok: false; error: Error }> = new Array(items.length);
  const concurrency = Math.max(1, Math.min(n, items.length));

  // Process in batches so we can synchronously update state between batches.
  // (True streaming concurrency would defeat the glossary-warm-up between batches.)
  for (let start = 0; start < items.length; start += concurrency) {
    if (opts.signal?.aborted) {
      for (let i = start; i < items.length; i++) {
        out[i] = { ok: false, error: new Error("aborted") };
      }
      break;
    }
    const end = Math.min(start + concurrency, items.length);
    const promises: Promise<void>[] = [];
    for (let i = start; i < end; i++) {
      const idx = i;
      promises.push(
        worker(items[idx], idx).then(
          v => { out[idx] = { ok: true, value: v }; },
          e => { out[idx] = { ok: false, error: e instanceof Error ? e : new Error(String(e)) }; },
        ),
      );
    }
    await Promise.all(promises);
    if (opts.onBatchSettled) await opts.onBatchSettled(start, end - 1);
  }
  return out;
}
