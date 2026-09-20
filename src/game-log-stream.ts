import { StringDecoder } from "node:string_decoder";
import { type Readable } from "node:stream";
import type { GameLogEntry } from "./types";
import { safeSend } from "./operations";
import { LauncherLogger } from "./logger";
import { DISCARDED_LOG_RECORD } from "./privacy";

export interface ProcessLogFramerOptions {
  maxLineLength?: number;
}

/**
 * Handles streaming UTF-8 decoding and line framing for child process stdout/stderr streams.
 * Prevents memory exhaustion from unbounded lines, redacts sensitive tokens, and correctly
 * stitches split UTF-8 sequences across chunk boundaries.
 */
export class ProcessLogFramer {
  private decoder: StringDecoder;
  private buffer = "";
  private readonly maxLineLength: number;
  private finished = false;
  private discarding = false;

  constructor(
    private readonly defaultLevel: "INFO" | "WARN" | "ERROR",
    private readonly onEntry: (entry: GameLogEntry) => void,
    options?: ProcessLogFramerOptions,
  ) {
    this.decoder = new StringDecoder("utf-8");
    this.maxLineLength = options?.maxLineLength ?? 16_384;
  }

  attach(stream: Readable | null | undefined): void {
    if (!stream) return;

    stream.on("data", (chunk: Buffer | string) => {
      this.pushChunk(chunk);
    });

    const onFinish = () => this.finishOnce();
    stream.once("end", onFinish);
    stream.once("close", onFinish);
  }

  finishOnce(): void {
    if (this.finished) return;
    this.finished = true;
    this.flush();
  }

  pushChunk(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.processText(text);
  }

  flush(): void {
    const remaining = this.decoder.end();
    if (remaining) {
      this.processText(remaining);
    }

    if (this.discarding) {
      this.discarding = false;
      this.buffer = "";
      this.emitLine(DISCARDED_LOG_RECORD);
    } else if (this.buffer.length > 0) {
      let line = this.buffer;
      this.buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        this.emitLine(trimmed);
      }
    }
  }

  private processText(text: string): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      if (!this.discarding) {
        const segment = text.slice(start, end);
        if (
          Buffer.byteLength(this.buffer, "utf8") +
            Buffer.byteLength(segment, "utf8") >
          this.maxLineLength
        ) {
          this.buffer = "";
          this.discarding = true;
        } else this.buffer += segment;
      }
      if (newline < 0) break;
      if (this.discarding) this.emitLine(DISCARDED_LOG_RECORD);
      else if (this.buffer.trim()) this.emitLine(this.buffer.trim());
      this.buffer = "";
      this.discarding = false;
      start = newline + 1;
    }
  }

  private emitLine(message: string): void {
    let level = this.defaultLevel;
    if (this.defaultLevel !== "INFO") {
      const isError = /ERROR|Exception|FATAL|CRITICAL/i.test(message);
      level = isError ? "ERROR" : "WARN";
    }

    // Apply tested redaction to live-output delivery
    const sanitizedMessage = LauncherLogger.sanitize(message);

    this.onEntry({
      level,
      message: sanitizedMessage,
      timestamp: new Date().toLocaleTimeString(),
    });
  }
}

export interface LogBatchTransportOptions {
  intervalMs?: number;
  maxBatchSize?: number;
  maxBatchBytes?: number;
  maxQueueCapacity?: number;
  maxQueueBytes?: number;
}

export interface TransportMetrics {
  producedCount: number;
  producedBytes: number;
  dispatchedCount: number;
  dispatchedBytes: number;
  acknowledgedCount: number;
  acknowledgedBytes: number;
  droppedCount: number;
  droppedBytes: number;
}

interface QueuedItem {
  entry: GameLogEntry;
  bytes: number;
}

/**
 * Bounded, flow-controlled IPC batch transport with identified, receiver-bound ACK accounting.
 * Enforces per-record, queue, and batch byte budgets. Separates application transport lifetime
 * from individual game sessions.
 */
export class BoundedLogBatchTransport {
  private queue: QueuedItem[] = [];
  private queueBytes = 0;
  private droppedCount = 0;
  private droppedBytes = 0;
  private nextBatchId = 1;
  private inFlightBatch: {
    batchId: number;
    receiverId?: number;
    entries: GameLogEntry[];
    bytes: number;
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxBatchBytes: number;
  private readonly maxQueueCapacity: number;
  private readonly maxQueueBytes: number;

  private metrics: TransportMetrics = {
    producedCount: 0,
    producedBytes: 0,
    dispatchedCount: 0,
    dispatchedBytes: 0,
    acknowledgedCount: 0,
    acknowledgedBytes: 0,
    droppedCount: 0,
    droppedBytes: 0,
  };

  constructor(
    private readonly targetWindowProvider: () => any,
    options?: LogBatchTransportOptions,
  ) {
    this.intervalMs = options?.intervalMs ?? 50;
    this.maxBatchSize = options?.maxBatchSize ?? 100;
    this.maxBatchBytes = options?.maxBatchBytes ?? 64 * 1024; // 64 KB
    this.maxQueueCapacity = options?.maxQueueCapacity ?? 2_000;
    this.maxQueueBytes = options?.maxQueueBytes ?? 2 * 1024 * 1024; // 2 MB
  }

  push(entry: GameLogEntry): void {
    if (this.closed) return;

    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf-8");
    this.metrics.producedCount++;
    this.metrics.producedBytes += entryBytes;

    // Enforce queue capacity and byte budget
    while (
      (this.queue.length >= this.maxQueueCapacity ||
        this.queueBytes + entryBytes > this.maxQueueBytes) &&
      this.queue.length > 0
    ) {
      const dropped = this.queue.shift()!;
      this.queueBytes -= dropped.bytes;
      this.droppedCount++;
      this.droppedBytes += dropped.bytes;
      this.metrics.droppedCount++;
      this.metrics.droppedBytes += dropped.bytes;
    }

    this.queue.push({ entry, bytes: entryBytes });
    this.queueBytes += entryBytes;

    if (this.queue.length >= this.maxBatchSize && !this.inFlightBatch) {
      this.dispatchBatch();
    } else if (!this.timer && !this.inFlightBatch) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.dispatchBatch();
      }, this.intervalMs);
    }
  }

  onRendererAck(batchId?: number, receiverId?: number): void {
    if (!this.inFlightBatch) return;

    // Exact numeric batchId check: reject undefined, null, NaN, or mismatch
    if (
      typeof batchId !== "number" ||
      isNaN(batchId) ||
      batchId !== this.inFlightBatch.batchId
    ) {
      // Reject unauthorized, undefined, or mismatched batch IDs
      return;
    }

    // Identified, receiver-bound check: if receiverId is provided/bound, ensure exact match
    if (
      this.inFlightBatch.receiverId !== undefined &&
      receiverId !== undefined &&
      receiverId !== this.inFlightBatch.receiverId
    ) {
      // Reject ACKs sent from a window different than the dispatched receiver
      return;
    }

    this.metrics.acknowledgedCount += this.inFlightBatch.entries.length;
    this.metrics.acknowledgedBytes += this.inFlightBatch.bytes;
    this.inFlightBatch = null;

    if (this.queue.length > 0 && !this.closed) {
      this.dispatchBatch();
    }
  }

  private dispatchBatch(): void {
    if (this.inFlightBatch || this.queue.length === 0 || this.closed) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batchEntries: GameLogEntry[] = [];
    let batchBytes = 0;

    while (
      this.queue.length > 0 &&
      batchEntries.length < this.maxBatchSize &&
      batchBytes + this.queue[0].bytes <= this.maxBatchBytes
    ) {
      const item = this.queue.shift()!;
      this.queueBytes -= item.bytes;
      batchEntries.push(item.entry);
      batchBytes += item.bytes;
    }

    // If a single record exceeds maxBatchBytes, allow it as a 1-entry batch
    if (batchEntries.length === 0 && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.queueBytes -= item.bytes;
      batchEntries.push(item.entry);
      batchBytes += item.bytes;
    }

    const batchId = this.nextBatchId++;
    const dropped = this.droppedCount;
    this.droppedCount = 0;
    this.droppedBytes = 0;

    this.metrics.dispatchedCount += batchEntries.length;
    this.metrics.dispatchedBytes += batchBytes;

    const win = this.targetWindowProvider();
    const receiverId = win?.webContents?.id;
    const sent = safeSend(win, "game:logBatch", {
      batchId,
      entries: batchEntries,
      dropped,
      bytes: batchBytes,
    });

    if (sent) {
      this.inFlightBatch = {
        batchId,
        receiverId,
        entries: batchEntries,
        bytes: batchBytes,
      };
    } else {
      // Window unavailable or destroyed: cannot deliver, reset inFlight and restore dropped count
      this.inFlightBatch = null;
      this.droppedCount += dropped;
    }
  }

  /**
   * Flush pending logs at the conclusion of an individual game session or repair.
   * Keeps the application transport alive for subsequent sessions.
   */
  flushSession(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.inFlightBatch && this.queue.length > 0 && !this.closed) {
      this.dispatchBatch();
    }
  }

  /**
   * Permanently closes the transport upon application shutdown.
   * Obeys batch and outstanding-delivery limits: does not dispatch if a delivery is in-flight,
   * and dispatches at most one final batch obeying limits.
   */
  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.inFlightBatch && this.queue.length > 0) {
      this.dispatchBatch();
    }

    // Drop remaining queued entries with accounting
    if (this.queue.length > 0) {
      for (const item of this.queue) {
        this.droppedCount++;
        this.droppedBytes += item.bytes;
        this.metrics.droppedCount++;
        this.metrics.droppedBytes += item.bytes;
      }
      this.queue = [];
      this.queueBytes = 0;
    }
  }

  flushAndClose(): void {
    this.close();
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getPendingBytes(): number {
    return this.queueBytes;
  }

  getDroppedCount(): number {
    return this.metrics.droppedCount;
  }

  getMetrics(): TransportMetrics {
    return { ...this.metrics };
  }

  resetForTesting(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.queueBytes = 0;
    this.droppedCount = 0;
    this.droppedBytes = 0;
    this.inFlightBatch = null;
    this.closed = false;
    this.nextBatchId = 1;
    this.metrics = {
      producedCount: 0,
      producedBytes: 0,
      dispatchedCount: 0,
      dispatchedBytes: 0,
      acknowledgedCount: 0,
      acknowledgedBytes: 0,
      droppedCount: 0,
      droppedBytes: 0,
    };
  }
}
