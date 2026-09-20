import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import {
  DISCARDED_LOG_RECORD,
  isSecretField,
  MAX_RAW_LOG_BYTES,
  sanitizeLogText,
} from "./privacy";

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
  maxArrayItems = 15,
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
    return data.length > MAX_RAW_LOG_BYTES
      ? DISCARDED_LOG_RECORD
      : LauncherLoggerService.sanitize(data.toString("utf-8"));
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
        arr.push(
          safeBoundedClone(
            data[i],
            depth + 1,
            seen,
            maxDepth,
            maxKeys,
            maxArrayItems,
          ),
        );
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
      if (isSecretField(key)) {
        obj[key] = "[REDACTED]";
      } else {
        obj[key] = safeBoundedClone(
          data[key],
          depth + 1,
          seen,
          maxDepth,
          maxKeys,
          maxArrayItems,
        );
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
  public MAX_FILE_BYTES = 5 * 1024 * 1024;
  private readonly maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  private currentFileBytes = 0;
  private rotating = false;

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
          : path.join(
              process.env.APPDATA || process.env.HOME || process.cwd(),
              ".lampas-launcher",
            );
        this.logsDir = path.join(userDataDir, "logs");
      }

      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true, mode: 0o700 });
      }
      if (fs.lstatSync(this.logsDir).isSymbolicLink())
        throw new Error("Launcher log directory cannot be a symbolic link.");
      if (process.platform !== "win32") fs.chmodSync(this.logsDir, 0o700);

      this.logFilePath = path.join(this.logsDir, "launcher.log");
      this.previousLogFilePath = path.join(
        this.logsDir,
        "launcher.previous.log",
      );

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

      this.rotateLogFiles();
      this.openLogStream();

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

  private rotateLogFiles(): void {
    const files = [
      this.logFilePath,
      this.previousLogFilePath,
      path.join(this.logsDir, "launcher.older.log"),
    ];
    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch (error: any) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Unsafe launcher log file type.");
      if (
        Date.now() - stat.mtimeMs > this.maxAgeMs ||
        stat.size > this.MAX_FILE_BYTES
      )
        fs.unlinkSync(file);
      else if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    }
    if (fs.existsSync(files[2])) fs.unlinkSync(files[2]);
    if (fs.existsSync(files[1])) fs.renameSync(files[1], files[2]);
    if (fs.existsSync(files[0])) fs.renameSync(files[0], files[1]);
  }

  private openLogStream(): void {
    this.currentFileBytes = 0;
    this.writeStream = fs.createWriteStream(this.logFilePath, {
      flags: "wx",
      mode: 0o600,
      encoding: "utf8",
    });
    this.writeStream.on("error", (err) => {
      this.metrics.errorCount++;
      process.stderr.write(
        `[LauncherLogger Stream Error] ${sanitizeLogText(err?.message || String(err))}\n`,
      );
      this.settleFlushResolvers();
    });
  }

  private rotateStream(): void {
    if (!this.writeStream || this.rotating) return;
    this.rotating = true;
    const oldStream = this.writeStream;
    oldStream.once("close", () => {
      try {
        this.rotateLogFiles();
        this.openLogStream();
      } catch (error: any) {
        this.metrics.errorCount++;
        this.writeStream = null;
        process.stderr.write(
          `[LauncherLogger Rotation Error] ${sanitizeLogText(error.message)}\n`,
        );
        this.settleFlushResolvers();
      } finally {
        this.rotating = false;
        this.pumpQueue();
      }
    });
    oldStream.end();
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

  log(
    level: "INFO" | "WARN" | "ERROR" | "CHAT" | string,
    message: string,
  ): void {
    const sanitizedMessage = LauncherLoggerService.sanitize(message);
    const timestamp = new Date().toISOString();

    // Bound single record size to prevent unbounded memory allocation
    let processedMessage = sanitizedMessage;
    if (Buffer.byteLength(processedMessage, "utf-8") > MAX_LOG_RECORD_BYTES) {
      processedMessage = DISCARDED_LOG_RECORD;
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
    if (
      !this.writeStream ||
      this.writeStream.destroyed ||
      this.waitingForDrain ||
      this.rotating
    ) {
      return;
    }

    if (this.droppedRecords > 0) {
      const count = this.droppedRecords;
      this.droppedRecords = 0;
      const notice = `[${new Date().toISOString()}] [WARN] [Logger] Logging overload: dropped ${count} records due to write saturation\n`;
      this.pendingQueue.unshift(notice);
      this.pendingBytes += Buffer.byteLength(notice, "utf8");
    }

    while (this.pendingQueue.length > 0) {
      const chunk = this.pendingQueue[0]!;
      const chunkBytes = Buffer.byteLength(chunk, "utf-8");
      if (chunkBytes > this.MAX_FILE_BYTES) {
        this.pendingQueue.shift();
        this.pendingBytes -= chunkBytes;
        this.metrics.droppedCount++;
        this.metrics.droppedBytes += chunkBytes;
        continue;
      }
      if (this.currentFileBytes + chunkBytes > this.MAX_FILE_BYTES) {
        this.rotateStream();
        return;
      }
      this.pendingQueue.shift();
      this.pendingBytes -= chunkBytes;
      this.inFlightWrites++;
      this.currentFileBytes += chunkBytes;

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
      (this.pendingQueue.length === 0 &&
        this.inFlightWrites === 0 &&
        !this.waitingForDrain)
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
      let flushTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const flushDeadline = new Promise<void>((resolve) => {
          flushTimeout = setTimeout(resolve, 3000);
        });
        await Promise.race([this.flush(), flushDeadline]);
      } catch {
        // Proceed on flush error
      } finally {
        if (flushTimeout) clearTimeout(flushTimeout);
        this.settleFlushResolvers();
      }

      if (this.writeStream) {
        const stream = this.writeStream;
        this.writeStream = null;
        await new Promise<void>((resolve) => {
          let settled = false;
          let closeTimer: ReturnType<typeof setTimeout> | null = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (closeTimer) clearTimeout(closeTimer);
            stream.removeListener("close", finish);
            resolve();
          };
          closeTimer = setTimeout(finish, 3000);
          stream.once("close", finish);
          try {
            if (!stream.destroyed && !stream.closed) stream.end();
            else finish();
          } catch {
            finish();
          }
        });
      }

      this.isClosing = false;
      this.isClosed = true;
    })();

    return this.closePromise;
  }

  logApiRequest(method: string, url: string, payload?: any): void {
    this.log("INFO", `[HTTP Request] ${method.toUpperCase()} ${url}`);
  }

  logApiResponse(
    method: string,
    url: string,
    status: number,
    durationMs: number,
    responseData?: any,
  ): void {
    const level = status >= 400 ? "ERROR" : "INFO";
    this.log(
      level,
      `[HTTP Response] ${method.toUpperCase()} ${url} -> ${status} (${durationMs}ms)`,
    );
  }

  logApiError(
    method: string,
    url: string,
    error: any,
    durationMs?: number,
  ): void {
    const dur = durationMs !== undefined ? ` (${durationMs}ms)` : "";
    const msg = error?.message || String(error);
    this.log(
      "ERROR",
      `[HTTP Error] ${method.toUpperCase()} ${url}${dur} -> ${LauncherLoggerService.sanitize(msg)}`,
    );
  }

  private formatPayloadPreview(data: any, maxLen = 500): string {
    if (data === undefined || data === null) return "";

    try {
      let text: string;
      if (typeof data === "string") {
        // Redaction is ALWAYS performed BEFORE truncation!
        const sanitized = LauncherLoggerService.sanitize(data);
        return sanitized.length > maxLen
          ? `${sanitized.slice(0, maxLen)}...`
          : sanitized;
      } else if (Buffer.isBuffer(data)) {
        const sanitized = LauncherLoggerService.sanitize(
          data.toString("utf-8"),
        );
        return sanitized.length > maxLen
          ? `${sanitized.slice(0, maxLen)}...`
          : sanitized;
      } else if (typeof data === "object") {
        const bounded = safeBoundedClone(data);
        const json = JSON.stringify(bounded);
        const sanitized = LauncherLoggerService.sanitize(json);
        return sanitized.length > maxLen
          ? `${sanitized.slice(0, maxLen)}...`
          : sanitized;
      } else {
        const sanitized = LauncherLoggerService.sanitize(String(data));
        return sanitized.length > maxLen
          ? `${sanitized.slice(0, maxLen)}...`
          : sanitized;
      }
    } catch {
      return "[Unserializable]";
    }
  }

  public static sanitize(text: string): string {
    return sanitizeLogText(text);
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
    this.currentFileBytes = 0;
    this.rotating = false;
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

  static log(
    level: "INFO" | "WARN" | "ERROR" | "CHAT" | string,
    message: string,
  ): void {
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
    responseData?: any,
  ): void {
    defaultInstance.logApiResponse(
      method,
      url,
      status,
      durationMs,
      responseData,
    );
  }

  static logApiError(
    method: string,
    url: string,
    error: any,
    durationMs?: number,
  ): void {
    defaultInstance.logApiError(method, url, error, durationMs);
  }

  public static sanitize(text: string): string {
    return LauncherLoggerService.sanitize(text);
  }

  static resetForTesting(): void {
    defaultInstance.resetForTesting();
  }
}
