import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  OperationAbortedError,
  OperationSingleFlight,
  runBoundedPool,
  TaskConflictError,
} from "../src/async-pool";

describe("Phase 1 — runBoundedPool", () => {
  test("empty pool returns empty array immediately", async () => {
    let workerCalled = false;
    const result = await runBoundedPool(
      [],
      async () => {
        workerCalled = true;
        return "never";
      },
      { concurrency: 4 },
    );

    expect(result).toEqual([]);
    expect(workerCalled).toBe(false);
  });

  test("bounded maximum: active concurrency never exceeds limit", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    let activeConcurrency = 0;
    let maxConcurrency = 0;

    const results = await runBoundedPool(
      items,
      async (item) => {
        activeConcurrency++;
        maxConcurrency = Math.max(maxConcurrency, activeConcurrency);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeConcurrency--;
        return item * 2;
      },
      { concurrency: 3 },
    );

    expect(maxConcurrency).toBeLessThanOrEqual(3);
    expect(results).toEqual(items.map((i) => i * 2));
  });

  test("ordered output under out-of-order worker completion", async () => {
    // Deliberately delay earlier items longer so items finish in reverse or mixed order
    const delays = [40, 10, 30, 5];
    const completionOrder: number[] = [];

    const results = await runBoundedPool(
      delays,
      async (delayMs, index) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        completionOrder.push(index);
        return `item-${index}`;
      },
      { concurrency: 4 },
    );

    // Completion order was out of order
    expect(completionOrder).not.toEqual([0, 1, 2, 3]);
    // But returned results array preserves exact input order
    expect(results).toEqual(["item-0", "item-1", "item-2", "item-3"]);
  });

  test("external abort signal pre-aborted rejects immediately without scheduling", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Pre-aborted test"));

    let invokedCount = 0;
    await expect(
      runBoundedPool(
        [1, 2, 3],
        async () => {
          invokedCount++;
          return true;
        },
        { concurrency: 2, signal: controller.signal },
      ),
    ).rejects.toThrow();

    expect(invokedCount).toBe(0);
  });

  test("external abort signal mid-flight stops scheduling new tasks and aborts active workers", async () => {
    const controller = new AbortController();
    const items = [1, 2, 3, 4, 5, 6];
    const started: number[] = [];
    const aborted: number[] = [];

    const poolPromise = runBoundedPool(
      items,
      async (item, _idx, signal) => {
        started.push(item);
        if (item === 2) {
          controller.abort(new Error("Mid-flight abort"));
        }

        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve(`done-${item}`), 50);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted.push(item);
            reject(signal.reason);
          });
        });
      },
      { concurrency: 2, signal: controller.signal },
    );

    await expect(poolPromise).rejects.toThrow("Mid-flight abort");
    // Items 1 and 2 started. Item 3..6 were never scheduled.
    expect(started).toEqual([1, 2]);
    expect(aborted.length).toBeGreaterThanOrEqual(1);
  });

  test("one worker failing while another writes: stops scheduling, aborts siblings, awaits settlement, rejects with first error", async () => {
    const items = [0, 1, 2, 3, 4];
    const scheduled: number[] = [];
    const workerSettled: number[] = [];
    let siblingReceivedAbort = false;

    const poolPromise = runBoundedPool(
      items,
      async (item, idx, signal) => {
        scheduled.push(idx);

        if (idx === 0) {
          // Fast failing worker
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("Worker 0 fatal disk error");
        }

        if (idx === 1) {
          // Sibling worker that should receive abort signal and finish cleanly
          return new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              workerSettled.push(idx);
              resolve("sibling-ok");
            }, 50);

            signal.addEventListener("abort", () => {
              siblingReceivedAbort = true;
              clearTimeout(timer);
              workerSettled.push(idx);
              resolve("sibling-aborted");
            });
          });
        }

        // Subsequent items should never be scheduled
        return "unreachable";
      },
      { concurrency: 2 },
    );

    await expect(poolPromise).rejects.toThrow("Worker 0 fatal disk error");
    // Pool waited for sibling worker to settle before rejecting
    expect(workerSettled).toContain(1);
    expect(siblingReceivedAbort).toBe(true);
    // Tasks 2, 3, 4 were never scheduled
    expect(scheduled).toEqual([0, 1]);
  });

  test("no writes after rejection: pending items are completely abandoned", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const writes: number[] = [];

    const promise = runBoundedPool(
      items,
      async (item, idx) => {
        if (idx === 0) {
          throw new Error("Immediate failure");
        }
        writes.push(item);
        return item;
      },
      { concurrency: 1 },
    );

    await expect(promise).rejects.toThrow("Immediate failure");
    expect(writes).toEqual([]);
  });
});

describe("Phase 1 — OperationSingleFlight", () => {
  test("duplicate task identity: concurrent calls share single execution promise", async () => {
    const singleFlight = new OperationSingleFlight();
    let executions = 0;

    const dest = path.join(process.cwd(), "temp-dest", "mod.jar");
    const identity = "sha256-abcdef1234567890";

    const [res1, res2, res3] = await Promise.all([
      singleFlight.do(dest, identity, async () => {
        executions++;
        await new Promise((r) => setTimeout(r, 20));
        return { path: dest, bytes: 1024 };
      }),
      singleFlight.do(dest, identity, async () => {
        executions++;
        return { path: dest, bytes: 1024 };
      }),
      singleFlight.do(dest, identity, async () => {
        executions++;
        return { path: dest, bytes: 1024 };
      }),
    ]);

    expect(executions).toBe(1);
    expect(res1).toEqual({ path: dest, bytes: 1024 });
    expect(res2).toBe(res1);
    expect(res3).toBe(res1);
    // After completion, flight map is cleared
    expect(singleFlight.size).toBe(0);
  });

  test("conflicting destinations: rejecting incompatible task identity for same destination", async () => {
    const singleFlight = new OperationSingleFlight();

    const dest = path.join(process.cwd(), "temp-dest", "target.jar");
    const identity1 = "sha256-111111111111";
    const identity2 = "sha256-222222222222";

    let task1Done = false;
    const task1Promise = singleFlight.do(dest, identity1, async () => {
      await new Promise((r) => setTimeout(r, 40));
      task1Done = true;
      return "task1-result";
    });

    // Incompatible identity for the same destination path while task 1 is in-flight
    await expect(
      singleFlight.do(dest, identity2, async () => "task2-result"),
    ).rejects.toThrow(TaskConflictError);

    // Ensure task 1 completes successfully
    const res1 = await task1Promise;
    expect(res1).toBe("task1-result");
    expect(task1Done).toBe(true);
  });

  test("distinct destinations execute independently", async () => {
    const singleFlight = new OperationSingleFlight();
    const dest1 = path.join(process.cwd(), "temp-dest", "mod1.jar");
    const dest2 = path.join(process.cwd(), "temp-dest", "mod2.jar");

    let runs = 0;
    const [res1, res2] = await Promise.all([
      singleFlight.do(dest1, "id-1", async () => {
        runs++;
        return "result-1";
      }),
      singleFlight.do(dest2, "id-2", async () => {
        runs++;
        return "result-2";
      }),
    ]);

    expect(runs).toBe(2);
    expect(res1).toBe("result-1");
    expect(res2).toBe("result-2");
  });

  test("normalizes destination paths to prevent casing and relative path bypasses", async () => {
    const singleFlight = new OperationSingleFlight();
    let runs = 0;

    const relativeDest = "./temp-dest/mod.jar";
    const absoluteDest = path.resolve(relativeDest);

    const [r1, r2] = await Promise.all([
      singleFlight.do(relativeDest, "id-same", async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        return "shared";
      }),
      singleFlight.do(absoluteDest, "id-same", async () => {
        runs++;
        return "shared";
      }),
    ]);

    expect(runs).toBe(1);
    expect(r1).toBe("shared");
    expect(r2).toBe("shared");
  });
});
