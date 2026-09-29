// Holding a fake's answers back, for tests of a sync that keeps running (the lock, the queue, sources that don't wait).

/** A gate on a fetch: while held, every request waits; release lets them all through. */
export function gate() {
  let held: Promise<void> | null = null;
  let open = () => {};
  return {
    hold(): void {
      held = new Promise((resolve) => {
        open = () => {
          held = null;
          resolve();
        };
      });
    },
    release(): void {
      open();
    },
    wrap(f: typeof fetch): typeof fetch {
      return async (input, init) => {
        if (held) await held;
        return f(input, init);
      };
    },
  };
}
