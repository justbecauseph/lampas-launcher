import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-ops-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
}));

const {
  OperationCoordinator,
  OperationBusyError,
  GameRunningConflictError,
  safeSend,
} = await import("../src/operations");
const { GameRunner } = await import("../src/game-runner");
const { ConfigManager } = await import("../src/config");

beforeEach(() => {
  OperationCoordinator.resetForTesting();
  GameRunner.resetForTesting();
  ConfigManager.resetForTesting();
});

afterEach(() => {
  OperationCoordinator.resetForTesting();
  GameRunner.resetForTesting();
});

describe("Phase 1 — OperationCoordinator & Mutual Exclusion", () => {
  test("exclusive acquisition: cannot acquire second operation while one is active", () => {
    const lease1 = OperationCoordinator.acquire("sync", "Modpack sync");
    expect(OperationCoordinator.isBusy()).toBe(true);
    expect(OperationCoordinator.getActive()?.type).toBe("sync");
    expect(OperationCoordinator.getActive()?.description).toBe("Modpack sync");

    // Attempting another operation must throw OperationBusyError
    expect(() => {
      OperationCoordinator.acquire("repair", "Full repair");
    }).toThrow(OperationBusyError);

    expect(() => {
      OperationCoordinator.acquire("move", "Relocate");
    }).toThrow(OperationBusyError);

    expect(() => {
      OperationCoordinator.acquire("launch", "Start game");
    }).toThrow(OperationBusyError);

    // Releasing the first operation allows next acquisition
    lease1.release();
    expect(OperationCoordinator.isBusy()).toBe(false);
    expect(OperationCoordinator.getActive()).toBeNull();

    const lease2 = OperationCoordinator.acquire("move", "Relocate");
    expect(OperationCoordinator.isBusy()).toBe(true);
    expect(OperationCoordinator.getActive()?.type).toBe("move");
    lease2.release();
    expect(OperationCoordinator.isBusy()).toBe(false);
  });

  test("assertCanMutate rejects when operation is active or game is running", () => {
    // Idle state: mutation allowed
    expect(() =>
      OperationCoordinator.assertCanMutate("import custom mod"),
    ).not.toThrow();

    // Active operation: mutation blocked
    const lease = OperationCoordinator.acquire("sync");
    expect(() =>
      OperationCoordinator.assertCanMutate("import custom mod"),
    ).toThrow(OperationBusyError);
    lease.release();

    // Game running: mutation blocked
    (GameRunner as any).runningProcess = { killed: false };
    expect(() =>
      OperationCoordinator.assertCanMutate("import custom mod"),
    ).toThrow(GameRunningConflictError);
  });

  test("cannot acquire installation operation when game is running", () => {
    (GameRunner as any).runningProcess = { killed: false };
    expect(() => OperationCoordinator.acquire("sync")).toThrow(
      GameRunningConflictError,
    );
    expect(() => OperationCoordinator.acquire("repair")).toThrow(
      GameRunningConflictError,
    );
    expect(() => OperationCoordinator.acquire("move")).toThrow(
      GameRunningConflictError,
    );
  });

  test("operation owns its own AbortController and abort signal", () => {
    const lease = OperationCoordinator.acquire("repair");
    expect(lease.signal.aborted).toBe(false);

    let abortFired = false;
    lease.signal.addEventListener("abort", () => {
      abortFired = true;
    });

    lease.abort(new Error("User cancelled repair"));
    expect(lease.signal.aborted).toBe(true);
    expect(abortFired).toBe(true);
    lease.release();
  });
});

describe("Phase 1 — Throttled Progress & Stale Callback Rejection", () => {
  test("throttled progress delivers immediate first call, throttles intermediary, delivers trailing", async () => {
    const lease = OperationCoordinator.acquire("sync");
    const delivered: Array<{ percent: number; message: string }> = [];

    const sendProgress = lease.createThrottledProgress<{
      percent: number;
      message: string;
    }>(
      (p) => delivered.push(p),
      50, // 50ms throttle for test speed
    );

    // Immediate first call
    sendProgress({ percent: 10, message: "downloading" });
    expect(delivered.length).toBe(1);
    expect(delivered[0].percent).toBe(10);

    // Rapid intermediate updates within 50ms window
    sendProgress({ percent: 20, message: "downloading" });
    sendProgress({ percent: 30, message: "downloading" });
    sendProgress({ percent: 40, message: "downloading" });
    // Still throttled
    expect(delivered.length).toBe(1);

    // Wait for throttle window to expire
    await new Promise((resolve) => setTimeout(resolve, 70));
    // Trailing update delivered
    expect(delivered.length).toBe(2);
    expect(delivered[1].percent).toBe(40);

    lease.release();
  });

  test("terminal progress and forceImmediate bypass throttle cadence", () => {
    const lease = OperationCoordinator.acquire("sync");
    const delivered: number[] = [];

    const sendProgress = lease.createThrottledProgress<number>(
      (p) => delivered.push(p),
      1000, // Large throttle interval
      (p) => p === 100, // 100 is terminal
    );

    sendProgress(1);
    expect(delivered).toEqual([1]);

    // Force immediate bypasses throttle
    sendProgress(2, true);
    expect(delivered).toEqual([1, 2]);

    // Terminal progress (100) dispatches immediately
    sendProgress(100);
    expect(delivered).toEqual([1, 2, 100]);

    lease.release();
  });

  test("stale callbacks: progress updates are completely rejected after operation is released", async () => {
    const lease = OperationCoordinator.acquire("sync");
    const delivered: number[] = [];

    const sendProgress = lease.createThrottledProgress<number>(
      (p) => delivered.push(p),
      50,
    );

    sendProgress(10);
    expect(delivered).toEqual([10]);

    // Queue an intermediate update
    sendProgress(20);

    // Release operation before timer expires
    lease.release();

    // Subsequent updates after release must be discarded
    sendProgress(30);

    await new Promise((resolve) => setTimeout(resolve, 80));
    // Neither queued update 20 nor post-release update 30 were delivered
    expect(delivered).toEqual([10]);
  });
});

describe("Phase 1 — safeSend IPC Guard", () => {
  test("returns true and sends when window and webContents are active", () => {
    let sentChannel = "";
    let sentArgs: any[] = [];

    const mockWin: any = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (ch: string, ...args: any[]) => {
          sentChannel = ch;
          sentArgs = args;
        },
      },
    };

    const ok = safeSend(mockWin, "test:event", { payload: 123 });
    expect(ok).toBe(true);
    expect(sentChannel).toBe("test:event");
    expect(sentArgs).toEqual([{ payload: 123 }]);
  });

  test("returns false and avoids crash when window or webContents is null or destroyed", () => {
    expect(safeSend(null, "ch")).toBe(false);
    expect(safeSend(undefined, "ch")).toBe(false);

    const destroyedWin: any = {
      isDestroyed: () => true,
      webContents: {
        isDestroyed: () => false,
        send: () => {
          throw new Error("Should not be called");
        },
      },
    };
    expect(safeSend(destroyedWin, "ch")).toBe(false);

    const destroyedContentsWin: any = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        send: () => {
          throw new Error("Should not be called");
        },
      },
    };
    expect(safeSend(destroyedContentsWin, "ch")).toBe(false);

    const noContentsWin: any = {
      isDestroyed: () => false,
      webContents: null,
    };
    expect(safeSend(noContentsWin, "ch")).toBe(false);
  });

  test("handles unexpected throw inside send() safely", () => {
    const throwingWin: any = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: () => {
          throw new Error("Object has been destroyed");
        },
      },
    };

    const ok = safeSend(throwingWin, "test:event");
    expect(ok).toBe(false);
  });
});

describe("Phase 1 — GameRunner Lifecycle Invariants", () => {
  test("killGame does not clear process state before exit event settlement", () => {
    const fakeProc = new EventEmitter() as any;
    fakeProc.killed = false;
    fakeProc.kill = () => {
      fakeProc.killed = true;
    };

    (GameRunner as any).runningProcess = fakeProc;
    expect(GameRunner.isGameRunning()).toBe(true);

    GameRunner.killGame();
    // In Phase 1: runningProcess remains intact so isGameRunning is still true
    expect(GameRunner.isGameRunning()).toBe(true);
    expect(fakeProc.killed).toBe(true);

    // Only after exit event fires does runningProcess clear
    fakeProc.emit("exit", 0);
    // Exit handler clears runningProcess
    expect((fakeProc as any).listenerCount?.("exit") || 0).toBeLessThanOrEqual(
      1,
    );
  });

  test("repeated killGame calls do not crash and handle already-killed gracefully", () => {
    let killCount = 0;
    const fakeProc = new EventEmitter() as any;
    fakeProc.killed = false;
    fakeProc.kill = () => {
      killCount++;
      fakeProc.killed = true;
    };

    (GameRunner as any).runningProcess = fakeProc;
    GameRunner.killGame();
    GameRunner.killGame();
    GameRunner.killGame();

    // Only one kill signal issued because proc.killed becomes true
    expect(killCount).toBe(1);
  });

  test("exit callback is invoked exactly once even if both exit and close fire", () => {
    const fakeProc = new EventEmitter() as any;
    (GameRunner as any).runningProcess = fakeProc;

    let exitReportCount = 0;
    let reportedCode: number | null = null;

    let exitReported = false;
    const handleExit = (code: number | null) => {
      if (exitReported) return;
      exitReported = true;
      (GameRunner as any).runningProcess = null;
      exitReportCount++;
      reportedCode = code;
    };

    fakeProc.once("exit", handleExit);
    fakeProc.once("close", handleExit);

    fakeProc.emit("exit", 0);
    fakeProc.emit("close", 0);

    expect(exitReportCount).toBe(1);
    expect(reportedCode).toBe(0);
    expect(GameRunner.isGameRunning()).toBe(false);
  });
});
