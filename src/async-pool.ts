/**
 * Bounded work primitive and operation-local single-flight.
 *
 * Invariants:
 * 1. Strictly bounded concurrency.
 * 2. Deterministic, input-ordered results (critical for classpath ordering).
 * 3. On first fatal error: stops scheduling new work, triggers internal abort signal,
 *    awaits all active in-flight worker promises and cleanup, then rejects with the original error.
 * 4. Operation-local single-flight keyed by normalized destination and artifact identity.
 */

import * as path from "node:path";

export interface PoolOptions {
  concurrency: number;
  signal?: AbortSignal;
}

export class TaskConflictError extends Error {
  constructor(
    destination: string,
    existingIdentity: string,
    newIdentity: string,
  ) {
    super(
      `Conflicting task identity for destination '${destination}': existing '${existingIdentity}' vs new '${newIdentity}'`,
    );
    this.name = "TaskConflictError";
  }
}

export class OperationAbortedError extends Error {
  constructor(message = "The operation was cancelled.") {
    super(message);
    this.name = "OperationAbortedError";
  }
}

/**
 * Executes a list of tasks using a bounded pool, returning results in exact input order.
 * If any task fails or the signal is aborted:
 * - Stops scheduling subsequent tasks immediately.
 * - Aborts sibling workers via an internal AbortController.
 * - Awaits settlement of all currently active workers before rejecting.
 */
export async function runBoundedPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  options: PoolOptions,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const concurrency = Math.max(1, Math.min(options.concurrency, items.length));
  const abortController = new AbortController();

  // Forward external abort signal if supplied
  if (options.signal) {
    if (options.signal.aborted) {
      throw new OperationAbortedError();
    }
    const onParentAbort = () => {
      abortController.abort(
        options.signal?.reason || new OperationAbortedError(),
      );
    };
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  let activeCount = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      if (firstError || abortController.signal.aborted) {
        break;
      }

      const currentIndex = nextIndex++;
      const item = items[currentIndex];
      activeCount++;

      try {
        const result = await worker(item, currentIndex, abortController.signal);
        results[currentIndex] = result;
      } catch (err) {
        if (!firstError) {
          firstError = err;
          abortController.abort(err);
        }
        break;
      } finally {
        activeCount--;
      }
    }
  };

  const workerPromises = Array.from({ length: concurrency }, () => runWorker());
  await Promise.allSettled(workerPromises);

  if (firstError) {
    throw firstError;
  }

  if (abortController.signal.aborted) {
    throw abortController.signal.reason || new OperationAbortedError();
  }

  return results;
}

/**
 * Operation-local single-flight coordinator.
 * Allows duplicate tasks (same destination + same identity) to share an active Promise,
 * but immediately rejects conflicting identities for the same destination.
 */
export class OperationSingleFlight {
  private inFlight = new Map<
    string,
    { identity: string; promise: Promise<any> }
  >();

  async do<R>(
    destination: string,
    identity: string,
    factory: () => Promise<R>,
  ): Promise<R> {
    const normKey = path.resolve(destination).toLowerCase();
    const existing = this.inFlight.get(normKey);

    if (existing) {
      if (existing.identity !== identity) {
        throw new TaskConflictError(destination, existing.identity, identity);
      }
      return existing.promise as Promise<R>;
    }

    const promise = factory().finally(() => {
      if (this.inFlight.get(normKey)?.promise === promise) {
        this.inFlight.delete(normKey);
      }
    });

    this.inFlight.set(normKey, { identity, promise });
    return promise;
  }

  clear(): void {
    this.inFlight.clear();
  }

  get size(): number {
    return this.inFlight.size;
  }
}
