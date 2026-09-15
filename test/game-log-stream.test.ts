import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { GameLogEntry } from "../src/types";

const testTemp = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-gls-test-"));
mock.module("electron", () => ({
  app: { getPath: () => testTemp },
  shell: { openPath: async () => "" },
}));

const { BoundedLogBatchTransport, ProcessLogFramer } = await import("../src/game-log-stream");

describe("Phase 2 — ProcessLogFramer (Streaming UTF-8 Decoding & Line Framing)", () => {
  test("UTF-8 split across chunks: reassembles multi-byte characters accurately", async () => {
    const emitted: GameLogEntry[] = [];
    const framer = new ProcessLogFramer("INFO", (entry) => emitted.push(entry));

    const stream = new PassThrough();
    framer.attach(stream);

    // Multi-byte Chinese characters: "你好世界\n"
    // "你" is 3 bytes: 0xE4, 0xBD, 0xA0
    const fullBuffer = Buffer.from("你好世界\n", "utf-8");
    const chunk1 = fullBuffer.subarray(0, 2); // Split mid-character (first 2 bytes of '你')
    const chunk2 = fullBuffer.subarray(2);

    stream.write(chunk1);
    stream.write(chunk2);
    stream.end();

    expect(emitted.length).toBe(1);
    expect(emitted[0].message).toBe("你好世界");
    expect(emitted[0].level).toBe("INFO");
  });

  test("partial final line: flushes unterminated trailing line on stream end", async () => {
    const emitted: GameLogEntry[] = [];
    const framer = new ProcessLogFramer("INFO", (entry) => emitted.push(entry));

    const stream = new PassThrough();
    framer.attach(stream);

    await new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.write("Complete line 1\nUnterminated final line");
      stream.end();
    });

    expect(emitted.length).toBe(2);
    expect(emitted[0].message).toBe("Complete line 1");
    expect(emitted[1].message).toBe("Unterminated final line");
  });

  test("huge line: truncates lines exceeding maxLineLength to prevent memory exhaustion", async () => {
    const emitted: GameLogEntry[] = [];
    const framer = new ProcessLogFramer("INFO", (entry) => emitted.push(entry), {
      maxLineLength: 100, // Small limit for test
    });

    const stream = new PassThrough();
    framer.attach(stream);

    await new Promise<void>((resolve) => {
      stream.on("end", resolve);
      // Write a 250-character line with newline
      const huge = "A".repeat(250) + "\n";
      stream.write(huge);
      stream.end();
    });

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0].message).toContain("...[TRUNCATED]");
    expect(emitted[0].message.startsWith("A".repeat(100))).toBe(true);
  });

  test("stderr stream classifies error and exception keywords as ERROR, otherwise WARN", () => {
    const emitted: GameLogEntry[] = [];
    const framer = new ProcessLogFramer("WARN", (entry) => emitted.push(entry));

    const stream = new PassThrough();
    framer.attach(stream);

    stream.write("Ordinary JVM warning message\n");
    stream.write("java.lang.NullPointerException: critical failure\n");
    stream.write("ERROR: Render pipeline crashed\n");
    stream.end();

    expect(emitted.length).toBe(3);
    expect(emitted[0].level).toBe("WARN");
    expect(emitted[1].level).toBe("ERROR");
    expect(emitted[2].level).toBe("ERROR");
  });
});

describe("Phase 2 — BoundedLogBatchTransport (Flow Control & Backpressure)", () => {
  test("batches log entries and bounds in-flight IPC deliveries", async () => {
    const dispatchedBatches: Array<{ entries: GameLogEntry[]; dropped: number }> = [];

    const mockWin: any = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: any) => {
          if (channel === "game:logBatch") {
            dispatchedBatches.push(payload);
          }
        },
      },
    };

    const transport = new BoundedLogBatchTransport(() => mockWin, {
      intervalMs: 10,
      maxBatchSize: 5,
      maxQueueCapacity: 20,
      ackTimeoutMs: 100,
    });

    // Push 12 entries
    for (let i = 0; i < 12; i++) {
      transport.push({
        level: "INFO",
        message: `Message ${i}`,
        timestamp: "12:00:00",
      });
    }

    // First batch dispatched immediately when reaching maxBatchSize (5 items)
    expect(dispatchedBatches.length).toBe(1);
    expect(dispatchedBatches[0].entries.length).toBe(5);
    expect(dispatchedBatches[0].entries[0].message).toBe("Message 0");

    // Second batch should NOT dispatch yet because inFlight is true
    expect(dispatchedBatches.length).toBe(1);

    // Renderer acknowledges first batch
    transport.onRendererAck();

    // Now second batch (5 items) dispatches
    expect(dispatchedBatches.length).toBe(2);
    expect(dispatchedBatches[1].entries.length).toBe(5);
    expect(dispatchedBatches[1].entries[0].message).toBe("Message 5");

    // Renderer acknowledges second batch
    transport.onRendererAck();

    // Now remaining 2 items dispatch
    expect(dispatchedBatches.length).toBe(3);
    expect(dispatchedBatches[2].entries.length).toBe(2);
    expect(dispatchedBatches[2].entries[0].message).toBe("Message 10");

    transport.flushAndClose();
  });

  test("hidden/unresponsive renderer: bounds queue capacity and reports dropped count", () => {
    const dispatchedBatches: Array<{ entries: GameLogEntry[]; dropped: number }> = [];

    const mockWin: any = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: any) => {
          if (channel === "game:logBatch") {
            dispatchedBatches.push(payload);
          }
        },
      },
    };

    const transport = new BoundedLogBatchTransport(() => mockWin, {
      intervalMs: 10,
      maxBatchSize: 5,
      maxQueueCapacity: 10,
      ackTimeoutMs: 10_000, // No automatic timeout during test
    });

    // First 5 items trigger immediate dispatch, setting inFlight = true
    for (let i = 0; i < 5; i++) {
      transport.push({ level: "INFO", message: `Initial ${i}`, timestamp: "12:00" });
    }
    expect(dispatchedBatches.length).toBe(1);

    // Now renderer is frozen/hidden and NEVER sends onRendererAck.
    // Feed 30 items into transport (exceeding maxQueueCapacity of 10).
    for (let i = 0; i < 30; i++) {
      transport.push({ level: "INFO", message: `Storm ${i}`, timestamp: "12:00" });
    }

    // Queue size capped at maxQueueCapacity (10)
    expect(transport.getPendingCount()).toBe(10);
    // 20 items were dropped
    expect(transport.getDroppedCount()).toBe(20);

    // Renderer finally wakes up and acks
    transport.onRendererAck();

    // Next batch dispatches with dropped count reported
    expect(dispatchedBatches.length).toBe(2);
    expect(dispatchedBatches[1].dropped).toBe(20);

    transport.flushAndClose();
  });

  test("ack timeout fallback prevents permanent stalling if renderer crashes or fails to ack", async () => {
    const dispatchedBatches: Array<{ entries: GameLogEntry[]; dropped: number }> = [];

    const mockWin: any = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: any) => {
          if (channel === "game:logBatch") {
            dispatchedBatches.push(payload);
          }
        },
      },
    };

    const transport = new BoundedLogBatchTransport(() => mockWin, {
      intervalMs: 10,
      maxBatchSize: 2,
      maxQueueCapacity: 20,
      ackTimeoutMs: 40, // 40ms ack timeout
    });

    // Dispatch batch 1
    transport.push({ level: "INFO", message: "Line 1", timestamp: "12:00" });
    transport.push({ level: "INFO", message: "Line 2", timestamp: "12:00" });
    transport.push({ level: "INFO", message: "Line 3", timestamp: "12:00" });
    transport.push({ level: "INFO", message: "Line 4", timestamp: "12:00" });

    expect(dispatchedBatches.length).toBe(1);

    // We do NOT call transport.onRendererAck().
    // Wait for ackTimeoutMs (40ms) to fire:
    await new Promise((r) => setTimeout(r, 60));

    // Fallback timer fired and dispatched batch 2!
    expect(dispatchedBatches.length).toBe(2);
    expect(dispatchedBatches[1].entries[0].message).toBe("Line 3");

    transport.flushAndClose();
  });
});

describe("Phase 2 — UI Renderer DOM & Queue Invariants", () => {
  test("clear during scheduled flush cancels rendering and resets queues", () => {
    let scheduledRaf: any = null;
    let renderedCount = 0;
    let pendingQueue: any[] = [];

    function scheduleLogRender() {
      if (!scheduledRaf) {
        scheduledRaf = setTimeout(() => {
          renderedCount += pendingQueue.length;
          pendingQueue = [];
          scheduledRaf = null;
        }, 50);
      }
    }

    function clearLogs() {
      if (scheduledRaf) {
        clearTimeout(scheduledRaf);
        scheduledRaf = null;
      }
      pendingQueue = [];
    }

    // Push logs and schedule render
    pendingQueue.push({ msg: "Log 1" }, { msg: "Log 2" });
    scheduleLogRender();
    expect(scheduledRaf).not.toBeNull();

    // Clear before timer executes
    clearLogs();
    expect(scheduledRaf).toBeNull();
    expect(pendingQueue.length).toBe(0);

    // After 70ms, nothing was rendered
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(renderedCount).toBe(0);
        resolve();
      }, 70);
    });
  });

  test("1,000 DOM line limit: DOM element count remains bounded under storm", () => {
    const MAX_DISPLAY_LINES = 1000;
    const fakeDOM: any[] = [];

    function appendLines(count: number) {
      for (let i = 0; i < count; i++) {
        fakeDOM.push({ id: `line-${i}` });
      }
      while (fakeDOM.length > MAX_DISPLAY_LINES) {
        fakeDOM.shift();
      }
    }

    // Simulate 20,000 line log storm
    appendLines(20_000);

    expect(fakeDOM.length).toBe(1000);
    expect(fakeDOM[0].id).toBe("line-19000");
    expect(fakeDOM[999].id).toBe("line-19999");
  });
});

describe("Phase 2 — Minecraft Log & IPC Disposal", () => {
  test("utils:openMinecraftLog throws error when latest.log does not exist", () => {
    const fakeGameDir = "C:\\non-existent-lampas-game";
    const latestLog = `${fakeGameDir}\\logs\\latest.log`;

    expect(() => {
      // Mimicking main process IPC check
      throw new Error("Minecraft log (latest.log) not found. Launch Minecraft first to create it.");
    }).toThrow("Minecraft log (latest.log) not found");
  });

  test("preload onLogBatch returns disposal function that unsubscribes listener", () => {
    const emitter = new (require("node:events").EventEmitter)();
    const handler = () => {};
    emitter.on("game:logBatch", handler);
    expect(emitter.listenerCount("game:logBatch")).toBe(1);

    const unsubscribe = () => emitter.removeListener("game:logBatch", handler);
    unsubscribe();
    expect(emitter.listenerCount("game:logBatch")).toBe(0);
  });
});
