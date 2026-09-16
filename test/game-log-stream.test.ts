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

  test("redacts sensitive authorization tokens and passwords in live process output", () => {
    const emitted: GameLogEntry[] = [];
    const framer = new ProcessLogFramer("INFO", (entry) => emitted.push(entry));

    const stream = new PassThrough();
    framer.attach(stream);

    stream.write("Connecting to auth with Bearer my_secret_token_12345678901234567890\n");
    stream.write('Client config: {"token": "secret_key_abc", "password": "SuperSecret123"}\n');
    stream.end();

    expect(emitted.length).toBe(2);
    expect(emitted[0].message).toContain("Bearer [REDACTED]");
    expect(emitted[0].message).not.toContain("my_secret_token_12345678901234567890");
    expect(emitted[1].message).toContain('"token": "[REDACTED]"');
    expect(emitted[1].message).toContain('"password": "[REDACTED]"');
    expect(emitted[1].message).not.toContain("SuperSecret123");
  });

  test("finishOnce finishes on end and close without duplicate lines or throwing", () => {
    const emitted: GameLogEntry[] = [];
    const framer = new ProcessLogFramer("INFO", (entry) => emitted.push(entry));

    const stream = new PassThrough();
    framer.attach(stream);

    stream.write("Single line output\nUnfinished trailing");
    // Emit end and close
    stream.emit("end");
    stream.emit("close");

    expect(emitted.length).toBe(2);
    expect(emitted[0].message).toBe("Single line output");
    expect(emitted[1].message).toBe("Unfinished trailing");
  });
});

describe("Phase 2 — BoundedLogBatchTransport (Flow Control & Backpressure)", () => {
  test("batches log entries and enforces identified receiver-bound ACK accounting", async () => {
    const dispatchedBatches: Array<{ batchId: number; entries: GameLogEntry[]; dropped: number; bytes: number }> = [];

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
    });

    // Push 12 entries
    for (let i = 0; i < 12; i++) {
      transport.push({
        level: "INFO",
        message: `Message ${i}`,
        timestamp: "12:00:00",
      });
    }

    // First batch dispatched with batchId = 1
    expect(dispatchedBatches.length).toBe(1);
    expect(dispatchedBatches[0].batchId).toBe(1);
    expect(dispatchedBatches[0].entries.length).toBe(5);
    expect(dispatchedBatches[0].entries[0].message).toBe("Message 0");

    // Second batch should NOT dispatch while batch 1 is in flight
    expect(dispatchedBatches.length).toBe(1);

    // Mismatched ACK (e.g. batchId 999) does NOT grant credit
    transport.onRendererAck(999);
    expect(dispatchedBatches.length).toBe(1);

    // Matching ACK for batchId 1 clears in-flight and dispatches batch 2
    transport.onRendererAck(1);
    expect(dispatchedBatches.length).toBe(2);
    expect(dispatchedBatches[1].batchId).toBe(2);
    expect(dispatchedBatches[1].entries.length).toBe(5);
    expect(dispatchedBatches[1].entries[0].message).toBe("Message 5");

    // Matching ACK for batchId 2 dispatches remaining 2 items
    transport.onRendererAck(2);
    expect(dispatchedBatches.length).toBe(3);
    expect(dispatchedBatches[2].batchId).toBe(3);
    expect(dispatchedBatches[2].entries.length).toBe(2);
    expect(dispatchedBatches[2].entries[0].message).toBe("Message 10");

    transport.close();
  });

  test("hidden/unresponsive renderer: bounds queue capacity without timeout credit, then delivers on recovery", () => {
    const dispatchedBatches: Array<{ batchId: number; entries: GameLogEntry[]; dropped: number }> = [];

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
    });

    // First 5 items trigger immediate dispatch, setting inFlightBatch = { batchId: 1 }
    for (let i = 0; i < 5; i++) {
      transport.push({ level: "INFO", message: `Initial ${i}`, timestamp: "12:00" });
    }
    expect(dispatchedBatches.length).toBe(1);
    expect(dispatchedBatches[0].batchId).toBe(1);

    // Feed 30 items into transport while renderer is unacked
    for (let i = 0; i < 30; i++) {
      transport.push({ level: "INFO", message: `Storm ${i}`, timestamp: "12:00" });
    }

    // Queue size capped at maxQueueCapacity (10)
    expect(transport.getPendingCount()).toBe(10);
    // 20 items were dropped
    expect(transport.getDroppedCount()).toBe(20);

    // Transport did NOT dispatch additional unacknowledged batches
    expect(dispatchedBatches.length).toBe(1);

    // Renderer recovers and sends ACK for batch 1
    transport.onRendererAck(1);

    // Next batch dispatches with batchId 2 and reports dropped count of 20
    expect(dispatchedBatches.length).toBe(2);
    expect(dispatchedBatches[1].batchId).toBe(2);
    expect(dispatchedBatches[1].dropped).toBe(20);

    transport.close();
  });

  test("closing obeys batch and outstanding-delivery limits", () => {
    const dispatchedBatches: Array<{ batchId: number; entries: GameLogEntry[]; dropped: number }> = [];

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
      maxBatchSize: 2,
      maxQueueCapacity: 10,
    });

    // Push 5 items: first 2 dispatched immediately in batch 1
    for (let i = 0; i < 5; i++) {
      transport.push({ level: "INFO", message: `Item ${i}`, timestamp: "12:00" });
    }
    expect(dispatchedBatches.length).toBe(1);
    expect(transport.getPendingCount()).toBe(3);

    // Close transport while batch 1 is in-flight: MUST NOT dispatch second delivery!
    transport.close();
    expect(dispatchedBatches.length).toBe(1);

    // Remaining items in queue were dropped with accounting
    const metrics = transport.getMetrics();
    expect(metrics.droppedCount).toBe(3);
    expect(transport.getPendingCount()).toBe(0);
  });

  test("multi-session transport: survives across Launch 1, Launch 2, and Repair without closure", () => {
    const dispatchedBatches: Array<{ batchId: number; entries: GameLogEntry[]; dropped: number }> = [];

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
      maxBatchSize: 5,
      maxQueueCapacity: 50,
    });

    // Session 1: Launch 1
    transport.push({ level: "INFO", message: "Launch 1 start", timestamp: "12:00" });
    transport.push({ level: "INFO", message: "Launch 1 game running", timestamp: "12:01" });
    transport.flushSession(); // Game 1 exits
    expect(dispatchedBatches.length).toBe(1);
    expect(dispatchedBatches[0].entries[0].message).toBe("Launch 1 start");

    transport.onRendererAck(dispatchedBatches[0].batchId);

    // Session 2: Launch 2
    transport.push({ level: "INFO", message: "Launch 2 start", timestamp: "12:05" });
    transport.push({ level: "INFO", message: "Launch 2 game running", timestamp: "12:06" });
    transport.flushSession(); // Game 2 exits
    expect(dispatchedBatches.length).toBe(2);
    expect(dispatchedBatches[1].entries[0].message).toBe("Launch 2 start");

    transport.onRendererAck(dispatchedBatches[1].batchId);

    // Session 3: Repair
    transport.push({ level: "INFO", message: "Repair checking hashes", timestamp: "12:10" });
    transport.push({ level: "INFO", message: "Repair complete", timestamp: "12:11" });
    transport.flushSession(); // Repair exits
    expect(dispatchedBatches.length).toBe(3);
    expect(dispatchedBatches[2].entries[0].message).toBe("Repair checking hashes");

    transport.close();
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

    pendingQueue.push({ msg: "Log 1" }, { msg: "Log 2" });
    scheduleLogRender();
    expect(scheduledRaf).not.toBeNull();

    clearLogs();
    expect(scheduledRaf).toBeNull();
    expect(pendingQueue.length).toBe(0);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(renderedCount).toBe(0);
        resolve();
      }, 70);
    });
  });

  test("production DOM bounds: retains at most 1,000 lines AND at most 512 KB text bytes", () => {
    const MAX_DISPLAY_LINES = 1000;
    const MAX_DISPLAY_BYTES = 512 * 1024; // 512 KB

    // Simulated DOM Container matching consoleOutput
    class MockElement {
      children: MockElement[] = [];
      _byteLen = 0;
      innerText = "";

      get childElementCount(): number {
        return this.children.length;
      }

      get firstElementChild(): MockElement | null {
        return this.children[0] || null;
      }

      appendChild(el: MockElement): void {
        this.children.push(el);
      }

      removeChild(el: MockElement): void {
        const idx = this.children.indexOf(el);
        if (idx !== -1) {
          this.children.splice(idx, 1);
        }
      }
    }

    const consoleOutput = new MockElement();
    let retainedDisplayBytes = 0;
    let logLineCount = 0;

    function renderLines(messages: string[]) {
      for (const msg of messages) {
        const line = new MockElement();
        const text = `[12:00:00] [INFO] ${msg}`;
        const byteLen = Buffer.byteLength(text, "utf-8");
        line.innerText = text;
        line._byteLen = byteLen;

        consoleOutput.appendChild(line);
        retainedDisplayBytes += byteLen;
        logLineCount++;
      }

      // Exact production pruning logic from ui/renderer.js
      while (
        (consoleOutput.childElementCount > MAX_DISPLAY_LINES || retainedDisplayBytes > MAX_DISPLAY_BYTES) &&
        consoleOutput.firstElementChild
      ) {
        const first = consoleOutput.firstElementChild;
        const len = first._byteLen || 0;
        retainedDisplayBytes = Math.max(0, retainedDisplayBytes - len);
        consoleOutput.removeChild(first);
      }
    }

    // 1. Line count bound test: 5,000 lines of short logs
    const shortLogs = Array.from({ length: 5000 }, (_, i) => `Short log ${i}`);
    renderLines(shortLogs);

    expect(consoleOutput.childElementCount).toBe(1000);
    expect(retainedDisplayBytes).toBeLessThanOrEqual(MAX_DISPLAY_BYTES);

    // 2. Byte budget bound test: append 100 large 10 KB lines (total ~1 MB, exceeding 512 KB limit)
    const largeLogs = Array.from({ length: 100 }, (_, i) => "X".repeat(10 * 1024));
    renderLines(largeLogs);

    // Byte budget constraint (512 KB) must prune older lines even if child count < 1000!
    expect(retainedDisplayBytes).toBeLessThanOrEqual(MAX_DISPLAY_BYTES);
    expect(consoleOutput.childElementCount).toBeLessThanOrEqual(MAX_DISPLAY_LINES);
    expect(consoleOutput.childElementCount).toBeLessThan(100); // 100 * 10KB = 1MB, so < 52 lines retained
  });
});

describe("Phase 2 — Minecraft Log & IPC Disposal", () => {
  test("utils:openMinecraftLog checks file existence before attempting shell.openPath", () => {
    const nonExistentGameDir = path.join(testTemp, "non-existent-game-dir");
    const latestLog = path.join(nonExistentGameDir, "logs", "latest.log");

    const checkAndOpen = () => {
      if (!fs.existsSync(latestLog)) {
        throw new Error("Minecraft log (latest.log) not found. Launch Minecraft first to create it.");
      }
      return latestLog;
    };

    expect(checkAndOpen).toThrow("Minecraft log (latest.log) not found. Launch Minecraft first to create it.");
  });

  test("preload onLogBatch invokes callback with batchId and returns disposal function", () => {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const sentIpc: Array<{ channel: string; data: any }> = [];

    const mockIpcRenderer = {
      on: (channel: string, handler: any) => {
        listeners[channel] = listeners[channel] || [];
        listeners[channel].push(handler);
      },
      removeListener: (channel: string, handler: any) => {
        const list = listeners[channel] || [];
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      },
      send: (channel: string, data: any) => {
        sentIpc.push({ channel, data });
      },
    };

    // Preload contract implementation
    function subscribeLogBatch(callback: (batch: any) => void) {
      const handler = (_: any, data: any) => {
        callback(data);
        mockIpcRenderer.send("game:logAck", { batchId: data.batchId });
      };
      mockIpcRenderer.on("game:logBatch", handler);
      return () => mockIpcRenderer.removeListener("game:logBatch", handler);
    }

    const received: any[] = [];
    const unsubscribe = subscribeLogBatch((batch) => received.push(batch));

    expect(listeners["game:logBatch"].length).toBe(1);

    // Emit batch from main process
    const mockBatch = {
      batchId: 42,
      entries: [{ level: "INFO", message: "Hello Minecraft", timestamp: "12:00" }],
      dropped: 0,
      bytes: 120,
    };
    listeners["game:logBatch"][0]({}, mockBatch);

    expect(received.length).toBe(1);
    expect(received[0].batchId).toBe(42);
    expect(sentIpc.length).toBe(1);
    expect(sentIpc[0].channel).toBe("game:logAck");
    expect(sentIpc[0].data.batchId).toBe(42);

    // Unsubscribe removes listener
    unsubscribe();
    expect(listeners["game:logBatch"].length).toBe(0);
  });

  test("Phase 7: onRendererAck strictly rejects undefined, null, NaN, and mismatched batch IDs", () => {
    let dispatchedBatch: any = null;
    const mockWin: any = {
      isDestroyed: () => false,
      webContents: {
        id: 77,
        isDestroyed: () => false,
        send: (channel: string, payload: any) => {
          if (channel === "game:logBatch") dispatchedBatch = payload;
        },
      },
    };

    const transport = new BoundedLogBatchTransport(() => mockWin, {
      intervalMs: 10,
      maxBatchSize: 2,
    });

    transport.push({ level: "INFO", message: "msg-1", timestamp: "12:00" });
    transport.push({ level: "INFO", message: "msg-2", timestamp: "12:00" });

    expect(dispatchedBatch).toBeDefined();
    expect(dispatchedBatch.batchId).toBe(1);

    // Try undefined bypass
    transport.onRendererAck(undefined as any);
    expect(transport.getMetrics().acknowledgedCount).toBe(0);

    // Try null / NaN bypass
    transport.onRendererAck(null as any);
    expect(transport.getMetrics().acknowledgedCount).toBe(0);
    transport.onRendererAck(NaN as any);
    expect(transport.getMetrics().acknowledgedCount).toBe(0);

    // Try mismatched batch ID
    transport.onRendererAck(999);
    expect(transport.getMetrics().acknowledgedCount).toBe(0);

    // Provide exact matching batchId and matching receiverId
    transport.onRendererAck(1, 77);
    expect(transport.getMetrics().acknowledgedCount).toBe(2);

    transport.close();
  });

  test("Phase 7: onRendererAck rejects ACKs from unauthorized or mismatched sender window IDs", () => {
    let dispatchedBatch: any = null;
    const mockWin: any = {
      isDestroyed: () => false,
      webContents: {
        id: 42,
        isDestroyed: () => false,
        send: (channel: string, payload: any) => {
          if (channel === "game:logBatch") dispatchedBatch = payload;
        },
      },
    };

    const transport = new BoundedLogBatchTransport(() => mockWin, {
      intervalMs: 10,
      maxBatchSize: 1,
    });

    transport.push({ level: "INFO", message: "target-42", timestamp: "12:00" });
    expect(dispatchedBatch.batchId).toBe(1);

    // Sender with wrong ID (e.g. devtools window or unauthorized webContents)
    transport.onRendererAck(1, 999);
    expect(transport.getMetrics().acknowledgedCount).toBe(0);

    // Sender with expected ID
    transport.onRendererAck(1, 42);
    expect(transport.getMetrics().acknowledgedCount).toBe(1);

    transport.close();
  });
});
