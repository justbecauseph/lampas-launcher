import { StringDecoder } from "node:string_decoder";
import { type Readable } from "node:stream";
import type { GameLogEntry } from "./types";
import { safeSend } from "./operations";

export interface ProcessLogFramerOptions {
  maxLineLength?: number;
}

/**
 * Handles streaming UTF-8 decoding and line framing for child process stdout/stderr streams.
 * Prevents memory exhaustion from unbounded lines and correctly stitches split UTF-8 sequences.
 */
export class ProcessLogFramer {
  private decoder: StringDecoder;
  private buffer = "";
  private readonly maxLineLength: number;

  constructor(
    private readonly defaultLevel: "INFO" | "WARN" | "ERROR",
    private readonly onEntry: (entry: GameLogEntry) => void,
    options?: ProcessLogFramerOptions
  ) {
    this.decoder = new StringDecoder("utf-8");
    this.maxLineLength = options?.maxLineLength ?? 16_384;
  }

  attach(stream: Readable | null | undefined): void {
    if (!stream) return;

    stream.on("data", (chunk: Buffer | string) => {
      this.pushChunk(chunk);
    });

    stream.on("end", () => {
      this.flush();
    });
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

    if (this.buffer.length > 0) {
      let line = this.buffer;
      this.buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > this.maxLineLength) {
        line = line.slice(0, this.maxLineLength) + " ...[TRUNCATED]";
      }
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        this.emitLine(trimmed);
      }
    }
  }

  private processText(text: string): void {
    let searchStart = 0;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        const segment = text.slice(searchStart, i);
        searchStart = i + 1;

        let fullLine = this.buffer + segment;
        this.buffer = "";

        if (fullLine.endsWith("\r")) {
          fullLine = fullLine.slice(0, -1);
        }

        if (fullLine.length > this.maxLineLength) {
          fullLine = fullLine.slice(0, this.maxLineLength) + " ...[TRUNCATED]";
        }

        const trimmed = fullLine.trim();
        if (trimmed.length > 0) {
          this.emitLine(trimmed);
        }
      }
    }

    if (searchStart < text.length) {
      this.buffer += text.slice(searchStart);

      // Unterminated line bound check
      if (this.buffer.length >= this.maxLineLength) {
        const truncatedLine = this.buffer.slice(0, this.maxLineLength) + " ...[TRUNCATED]";
        this.buffer = "";
        this.emitLine(truncatedLine);
      }
    }
  }

  private emitLine(message: string): void {
    let level = this.defaultLevel;
    if (this.defaultLevel !== "INFO") {
      const isError = /ERROR|Exception|FATAL|CRITICAL/i.test(message);
      level = isError ? "ERROR" : "WARN";
    }

    this.onEntry({
      level,
      message,
      timestamp: new Date().toLocaleTimeString(),
    });
  }
}

export interface LogBatchTransportOptions {
  intervalMs?: number;
  maxBatchSize?: number;
  maxQueueCapacity?: number;
  ackTimeoutMs?: number;
}

/**
 * Bounded, flow-controlled IPC batch transport for streaming game logs to Electron renderer.
 * Prevents event loop stalling, IPC pipe saturation, and unbounded DOM growth.
 */
export class BoundedLogBatchTransport {
  private queue: GameLogEntry[] = [];
  private droppedCount = 0;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ackFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueCapacity: number;
  private readonly ackTimeoutMs: number;

  constructor(
    private readonly targetWindowProvider: () => any,
    options?: LogBatchTransportOptions
  ) {
    this.intervalMs = options?.intervalMs ?? 50;
    this.maxBatchSize = options?.maxBatchSize ?? 100;
    this.maxQueueCapacity = options?.maxQueueCapacity ?? 2_000;
    this.ackTimeoutMs = options?.ackTimeoutMs ?? 500;
  }

  push(entry: GameLogEntry): void {
    if (this.closed) return;

    if (this.queue.length >= this.maxQueueCapacity) {
      // Bounded queue: drop oldest records, keep newest
      this.queue.shift();
      this.droppedCount++;
    }

    this.queue.push(entry);

    if (this.queue.length >= this.maxBatchSize && !this.inFlight) {
      this.dispatchBatch();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.dispatchBatch();
      }, this.intervalMs);
    }
  }

  onRendererAck(): void {
    if (this.ackFallbackTimer) {
      clearTimeout(this.ackFallbackTimer);
      this.ackFallbackTimer = null;
    }
    this.inFlight = false;
    if (this.queue.length > 0) {
      this.dispatchBatch();
    }
  }

  private dispatchBatch(): void {
    if (this.inFlight || this.queue.length === 0 || this.closed) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const countToSend = Math.min(this.queue.length, this.maxBatchSize);
    const entries = this.queue.splice(0, countToSend);
    const dropped = this.droppedCount;
    this.droppedCount = 0;

    const win = this.targetWindowProvider();
    const sent = safeSend(win, "game:logBatch", { entries, dropped });

    if (sent) {
      this.inFlight = true;
      // Fallback timer if renderer is hidden, minimized, or crashed
      this.ackFallbackTimer = setTimeout(() => {
        this.ackFallbackTimer = null;
        this.inFlight = false;
        if (this.queue.length > 0) {
          this.dispatchBatch();
        }
      }, this.ackTimeoutMs);
    } else {
      // Window unavailable or destroyed: discard dispatched batch and reset inFlight
      this.inFlight = false;
    }
  }

  flushAndClose(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ackFallbackTimer) {
      clearTimeout(this.ackFallbackTimer);
      this.ackFallbackTimer = null;
    }

    if (this.queue.length > 0) {
      const win = this.targetWindowProvider();
      safeSend(win, "game:logBatch", {
        entries: this.queue,
        dropped: this.droppedCount,
      });
      this.queue = [];
      this.droppedCount = 0;
    }
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }
}
