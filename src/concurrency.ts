/** Run a bounded number of tasks while preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= items.length) return;
        try {
          result[index] = await run(items[index]!, index);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
  return result;
}

/** Cancel one wait without cancelling the promise other callers may be using. */
export function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Share an in-flight request; abort its work only when every caller has left. */
export function createSingleFlight<K, V>() {
  const pending = new Map<K, { promise: Promise<V>; controller: AbortController; callers: number }>();
  return async (key: K, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<V>): Promise<V> => {
    signal?.throwIfAborted();
    let entry = pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, callers: 0, promise: Promise.resolve().then(() => work(controller.signal)) };
      pending.set(key, entry);
      const created = entry;
      const clear = () => {
        if (pending.get(key) === created) pending.delete(key);
      };
      entry.promise.then(clear, clear);
    }
    entry.callers++;
    try {
      return await waitFor(entry.promise, signal);
    } finally {
      if (--entry.callers === 0) {
        if (pending.get(key) === entry) pending.delete(key);
        entry.controller.abort();
      }
    }
  };
}

/** Serialize operations for one key, allowing queued callers to cancel their waits. */
export function createKeyedQueue<K>() {
  const tails = new Map<K, Promise<void>>();
  return async <T>(key: K, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => slot);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    try {
      await waitFor(previous, signal);
      signal?.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  };
}
