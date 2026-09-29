/**
 * Runs `fn` over `items`, `concurrency` at a time. After the first failure no further items start, but the ones in
 * flight are awaited before it is rethrown: once this settles, nothing it started can still write (the caller
 * releases the sync lock then).
 */
export async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { err: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      try {
        await fn(items[next++]!);
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure) throw (failure as { err: unknown }).err;
}

/** `items` in slices of `size`, the last one shorter. */
export const chunked = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
