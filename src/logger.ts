import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

export interface LoggerMetrics {
  producedCount: number;
  producedBytes: number;
  writtenCount: number;
  writtenBytes: number;
  droppedCount: number;
  droppedBytes: number;
  errorCount: number;
}

export const MAX_LOG_RECORD_BYTES = 16_384; // 16 KB record budget

export function safeBoundedClone(
  data: any,
  depth = 0,
  seen = new WeakSet(),
  maxDepth = 3,
  maxKeys = 15,
  maxArrayItems = 15
): any {
  if (data === null || data === undefined) return data;
  if (typeof data === "string") {
    return LauncherLoggerService.sanitize(data);
  }
  if (typeof data === "number" || typeof data === "boolean") {
    return data;
  }
  if (typeof data === "bigint" || typeof data === "symbol") {
    return data.toString();
  }
  if (typeof data === "function") {
    return "[Function]";
  }
  if (Buffer.isBuffer(data)) {
    const preview = data.toString("utf-8", 0, Math.min(data.length, 1024));
    return LauncherLoggerService.sanitize(preview);
  }
  if (data instanceof Error) {
    return {
      name: data.name,
      message: LauncherLoggerService.sanitize(data.message),
      stack: LauncherLoggerService.sanitize(data.stack || ""),
    };
  }

  if (typeof data === "object") {
    if (seen.has(data)) {
      return "[Circular]";
    }
    seen.add(data);

    if (depth >= maxDepth) {
      return "[Object (max depth)]";
    }

    if (Array.isArray(data)) {
      const arr = [];
      const len = Math.min(data.length, maxArrayItems);
      for (let i = 0; i < len; i++) {
        arr.push(safeBoundedClone(data[i], depth + 1, seen, maxDepth, maxKeys, maxArrayItems));
      }
      if (data.length > maxArrayItems) {
        arr.push(`[... ${data.length - maxArrayItems} more items]`);
      }
      return arr;
    }

    const obj: Record<string, any> = {};
    const keys = Object.keys(data);
    const keyCount = Math.min(keys.length, maxKeys);

    for (let i = 0; i < keyCount; i++) {
      const key = keys[i];
      if (/^(token|refreshtoken|minecraftaccesstoken|publishsecret|secret|password|code_verifier|code|authorization|auth|cookie|key)$/i.test(key)) {
        obj[key] = "[REDACTED]";
      } else {
        obj[key] = safeBoundedClone(data[key], depth + 1, seen, maxDepth, maxKeys, maxArrayItems);
      }
    }
    if (keys.length > maxKeys) {
      obj["..."] = `[${keys.length - maxKeys} more keys]`;
    }
    return obj;
  }

  return String(data);
}

export class LauncherLoggerService {
  private logsDir = "";
  private logFilePath = "";
  private previousLogFilePath = "";
  private initialized = false;

  // Stream & backpressure state
  private writeStream: fs.WriteStream | null = null;
  private pendingQueue: string[] = [];
  private pendingBytes = 0;
  private inFlightWrites = 0;
  private waitingForDrain = false;
  private flushResolvers: Array<() => void> = [];

  // Lifecycle state
  private isClosing = false;
  private isClosed = false;
  private closePromise: Promise<void> | null = null;

  // Overload limits & accounting
  public MAX_PENDING_BYTES = 5 * 1024 * 1024; // 5 MB
  public MAX_PENDING_RECORDS = 10_000;
  private droppedRecords = 0;
  private overflowNotified = false;

  // Cumulative metrics
  private metrics: LoggerMetrics = {
    producedCount: 0,
    producedBytes: 0,
    writtenCount: 0,
    writtenBytes: 0,
    droppedCount: 0,
    droppedBytes: 0,
    errorCount: 0,
  };

  init(customLogsDir?: string): void {
    if (this.initialized) return;

    try {
      if (customLogsDir) {
        this.logsDir = customLogsDir;
      } else {
        const userDataDir = app
          ? app.getPath("userData")
          : path.join(process.env.APPDATA || process.env.HOME || process.cwd(), ".lampas-launcher");
        this.logsDir = path.join(userDataDir, "logs");
      }

      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }

      this.logFilePath = path.join(this.logsDir, "launcher.log");
      this.previousLogFilePath = path.join(this.logsDir, "launcher.previous.log");

      // Close any previously opened stream
      if (this.writeStream) {
        const stream = this.writeStream;
        this.writeStream = null;
        try {
          stream.removeAllListeners();
          if (!stream.destroyed && !stream.closed) {
            stream.end();
          }
        } catch {}
      }

      // Rotate previous session log
      if (fs.existsSync(this.logFilePath)) {
        try {
          if (fs.existsSync(this.previousLogFilePath)) {
            fs.unlinkSync(this.previousLogFilePath);
          }
          fs.renameSync(this.logFilePath, this.previousLogFilePath);
        } catch {
          // If locked, append mode remains viable
        }
      }

      // Open new write stream
      this.writeStream = fs.createWriteStream(this.logFilePath, {
        flags: "a",
        encoding: "utf-8",
      });

      this.writeStream.on("error", (err) => {
        this.metrics.errorCount++;
        // Defensive: do not recursively log through LauncherLogger
        process.stderr.write(`[LauncherLogger Stream Error] ${err?.message || err}\n`);
        this.settleFlushResolvers();
      });

      // Write session start header
      const header =
        `=== Lampas Launcher Session Started: ${new Date().toISOString()} ===\n` +
        `Platform: ${process.platform} (${process.arch}) | Node: ${process.version} | Electron: ${
          process.versions.electron || "N/A"
        }\n\n`;

      this.enqueueLine(header);
      this.initialized = true;
    } catch (err) {
      this.metrics.errorCount++;
      console.error("[Logger Init Error]", err);
    }
  }

  getLogPath(): string {
    if (!this.initialized) this.init();
    return this.logFilePath;
  }

  getLogsDir(): string {
    if (!this.initialized) this.init();
    return this.logsDir;
  }

  getDroppedRecordsCount(): number {
    return this.metrics.droppedCount;
  }

  getMetrics(): LoggerMetrics {
    return { ...this.metrics };
  }

  log(level: "INFO" | "WARN" | "ERROR" | "CHAT" | string, message: string): void {
    const sanitizedMessage = LauncherLoggerService.sanitize(message);
    const timestamp = new Date().toISOString();

    // Bound single record size to prevent unbounded memory allocation
    let processedMessage = sanitizedMessage;
    if (Buffer.byteLength(processedMessage, "utf-8") > MAX_LOG_RECORD_BYTES) {
      processedMessage = processedMessage.slice(0, MAX_LOG_RECORD_BYTES) + " ...[TRUNCATED]";
    }

    const line = `[${timestamp}] [${level}] ${processedMessage}\n`;
    const lineBytes = Buffer.byteLength(line, "utf-8");

    // Check if shutdown is in progress or completed
    if (this.isClosing || this.isClosed) {
      this.metrics.producedCount++;
      this.metrics.producedBytes += lineBytes;
      this.metrics.droppedCount++;
      this.metrics.droppedBytes += lineBytes;
      if (level === "ERROR") {
        process.stderr.write(`[POST-CLOSE ERROR] ${processedMessage}\n`);
      } else {
        process.stdout.write(`[POST-CLOSE LOG] ${processedMessage}\n`);
      }
      return;
    }

    if (!this.initialized) this.init();

    this.enqueueLine(line);

    if (level === "ERROR") {
      console.error(`[${level}]`, processedMessage);
    } else if (level === "WARN") {
      console.warn(`[${level}]`, processedMessage);
    } else {
      console.log(`[${level}]`, processedMessage);
    }
  }

  info(message: string): void {
    this.log("INFO", message);
  }

  warn(message: string): void {
    this.log("WARN", message);
  }

  error(message: string): void {
    this.log("ERROR", message);
  }

  private enqueueLine(line: string): void {
    const lineBytes = Buffer.byteLength(line, "utf-8");
    this.metrics.producedCount++;
    this.metrics.producedBytes += lineBytes;

    // Enforce memory and record bounds under disk backpressure / saturation
    while (
      (this.pendingBytes + lineBytes > this.MAX_PENDING_BYTES ||
        this.pendingQueue.length >= this.MAX_PENDING_RECORDS) &&
      this.pendingQueue.length > 0
    ) {
      this.droppedRecords++;
      const dropped = this.pendingQueue.shift()!;
      const droppedBytes = Buffer.byteLength(dropped, "utf-8");
      this.pendingBytes -= droppedBytes;
      this.metrics.droppedCount++;
      this.metrics.droppedBytes += droppedBytes;
    }

    this.pendingQueue.push(line);
    this.pendingBytes += lineBytes;

    this.pumpQueue();
  }

  private pumpQueue(): void {
    if (!this.writeStream || this.writeStream.destroyed || this.waitingForDrain) {
      return;
    }

    if (this.droppedRecords > 0) {
      const count = this.droppedRecords;
      this.droppedRecords = 0;
      const notice = `[${new Date().toISOString()}] [WARN] [Logger] Logging overload: dropped ${count} records due to write saturation\n`;
      const noticeBytes = Buffer.byteLength(notice, "utf-8");
      this.inFlightWrites++;
      this.writeStream.write(notice, () => {
        this.inFlightWrites--;
        this.metrics.writtenCount++;
        this.metrics.writtenBytes += noticeBytes;
        this.checkFlush();
      });
    }

    while (this.pendingQueue.length > 0) {
      const chunk = this.pendingQueue.shift()!;
      const chunkBytes = Buffer.byteLength(chunk, "utf-8");
      this.pendingBytes -= chunkBytes;
      this.inFlightWrites++;

      const ok = this.writeStream.write(chunk, () => {
        this.inFlightWrites--;
        this.metrics.writtenCount++;
        this.metrics.writtenBytes += chunkBytes;
        this.checkFlush();
      });

      if (!ok) {
        this.waitingForDrain = true;
        this.writeStream.once("drain", () => {
          this.waitingForDrain = false;
          this.pumpQueue();
        });
        break;
      }
    }

    this.checkFlush();
  }

  private checkFlush(): void {
    if (
      this.pendingQueue.length === 0 &&
      this.inFlightWrites === 0 &&
      !this.waitingForDrain &&
      this.flushResolvers.length > 0
    ) {
      this.settleFlushResolvers();
    }
  }

  private settleFlushResolvers(): void {
    const resolvers = this.flushResolvers;
    this.flushResolvers = [];
    for (const resolve of resolvers) {
      try {
        resolve();
      } catch {}
    }
  }

  async flush(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    if (
      !this.initialized ||
      (this.pendingQueue.length === 0 && this.inFlightWrites === 0 && !this.waitingForDrain)
    ) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.flushResolvers.push(resolve);
      this.pumpQueue();
    });
  }

  close(): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;

    this.isClosing = true;
    this.closePromise = (async () => {
      try {
        await Promise.race([
          this.flush(),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch {
        // Proceed on flush error
      } finally {
        this.settleFlushResolvers();
      }

      if (this.writeStream) {
        const stream = this.writeStream;
        this.writeStream = null;
        await new Promise<void>((resolve) => {
          try {
            stream.removeAllListeners();
            if (!stream.destroyed && !stream.closed) {
              stream.end(() => resolve());
            } else {
              resolve();
            }
          } catch {
            resolve();
          }
        });
      }

      this.isClosing = false;
      this.isClosed = true;
    })();

    return this.closePromise;
  }

  logApiRequest(method: string, url: string, payload?: any): void {
    let details = "";
    if (payload !== undefined) {
      const preview = this.formatPayloadPreview(payload);
      details = preview ? ` | Body: ${preview}` : "";
    }
    this.log("INFO", `[HTTP Request] ${method.toUpperCase()} ${url}${details}`);
  }

  logApiResponse(
    method: string,
    url: string,
    status: number,
    durationMs: number,
    responseData?: any
  ): void {
    let preview = "";
    if (responseData !== undefined) {
      const formatted = this.formatPayloadPreview(responseData);
      preview = formatted ? ` | Response: ${formatted}` : "";
    }
    const level = status >= 400 ? "ERROR" : "INFO";
    this.log(level, `[HTTP Response] ${method.toUpperCase()} ${url} -> ${status} (${durationMs}ms)${preview}`);
  }

  logApiError(method: string, url: string, error: any, durationMs?: number): void {
    const dur = durationMs !== undefined ? ` (${durationMs}ms)` : "";
    const msg = error?.message || String(error);
    this.log("ERROR", `[HTTP Error] ${method.toUpperCase()} ${url}${dur} -> ${LauncherLoggerService.sanitize(msg)}`);
  }

  private formatPayloadPreview(data: any, maxLen = 500): string {
    if (data === undefined || data === null) return "";

    try {
      let text: string;
      if (typeof data === "string") {
        // Redaction is ALWAYS performed BEFORE truncation!
        const sanitized = LauncherLoggerService.sanitize(data);
        return sanitized.length > maxLen ? `${sanitized.slice(0, maxLen)}...` : sanitized;
      } else if (Buffer.isBuffer(data)) {
        const sanitized = LauncherLoggerService.sanitize(data.toString("utf-8"));
        return sanitized.length > maxLen ? `${sanitized.slice(0, maxLen)}...` : sanitized;
      } else if (typeof data === "object") {
        const bounded = safeBoundedClone(data);
        const json = JSON.stringify(bounded);
        const sanitized = LauncherLoggerService.sanitize(json);
        return sanitized.length > maxLen ? `${sanitized.slice(0, maxLen)}...` : sanitized;
      } else {
        const sanitized = LauncherLoggerService.sanitize(String(data));
        return sanitized.length > maxLen ? `${sanitized.slice(0, maxLen)}...` : sanitized;
      }
    } catch {
      return "[Unserializable]";
    }
  }

  public static sanitize(text: string): string {
    if (!text) return "";
    // Mask potential bearer tokens, JWTs, and sensitive credential JSON fields
    return text
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi, "Bearer [REDACTED]")
      .replace(/(eyJ[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]+)/g, "[JWT_REDACTED]")
      .replace(
        /"(token|refreshToken|minecraftAccessToken|publishSecret|secret|password|code_verifier|code)"\s*:\s*"[^"]+"/gi,
        '"$1": "[REDACTED]"'
      );
  }

  resetForTesting(): void {
    if (this.writeStream) {
      const stream = this.writeStream;
      this.writeStream = null;
      try {
        stream.removeAllListeners();
        if (!stream.destroyed && !stream.closed) {
          stream.end();
        }
      } catch {}
    }
    this.pendingQueue = [];
    this.pendingBytes = 0;
    this.inFlightWrites = 0;
    this.waitingForDrain = false;
    this.flushResolvers = [];
    this.initialized = false;
    this.isClosing = false;
    this.isClosed = false;
    this.closePromise = null;
    this.logsDir = "";
    this.logFilePath = "";
    this.previousLogFilePath = "";
    this.droppedRecords = 0;
    this.overflowNotified = false;
    this.metrics = {
      producedCount: 0,
      producedBytes: 0,
      writtenCount: 0,
      writtenBytes: 0,
      droppedCount: 0,
      droppedBytes: 0,
      errorCount: 0,
    };
  }
}

const defaultInstance = new LauncherLoggerService();

export class LauncherLogger {
  public static get MAX_PENDING_BYTES(): number {
    return defaultInstance.MAX_PENDING_BYTES;
  }
  public static set MAX_PENDING_BYTES(val: number) {
    defaultInstance.MAX_PENDING_BYTES = val;
  }

  public static get MAX_PENDING_RECORDS(): number {
    return defaultInstance.MAX_PENDING_RECORDS;
  }
  public static set MAX_PENDING_RECORDS(val: number) {
    defaultInstance.MAX_PENDING_RECORDS = val;
  }

  static init(customLogsDir?: string): void {
    defaultInstance.init(customLogsDir);
  }

  static getLogPath(): string {
    return defaultInstance.getLogPath();
  }

  static getLogsDir(): string {
    return defaultInstance.getLogsDir();
  }

  static getDroppedRecordsCount(): number {
    return defaultInstance.getDroppedRecordsCount();
  }

  static getMetrics(): LoggerMetrics {
    return defaultInstance.getMetrics();
  }

  static log(level: "INFO" | "WARN" | "ERROR" | "CHAT" | string, message: string): void {
    defaultInstance.log(level, message);
  }

  static info(message: string): void {
    defaultInstance.info(message);
  }

  static warn(message: string): void {
    defaultInstance.warn(message);
  }

  static error(message: string): void {
    defaultInstance.error(message);
  }

  static async flush(): Promise<void> {
    return defaultInstance.flush();
  }

  static async close(): Promise<void> {
    return defaultInstance.close();
  }

  static logApiRequest(method: string, url: string, payload?: any): void {
    defaultInstance.logApiRequest(method, url, payload);
  }

  static logApiResponse(
    method: string,
    url: string,
    status: number,
    durationMs: number,
    responseData?: any
  ): void {
    defaultInstance.logApiResponse(method, url, status, durationMs, responseData);
  }

  static logApiError(method: string, url: string, error: any, durationMs?: number): void {
    defaultInstance.logApiError(method, url, error, durationMs);
  }

  public static sanitize(text: string): string {
    return LauncherLoggerService.sanitize(text);
  }

  static resetForTesting(): void {
    defaultInstance.resetForTesting();
  }
}
