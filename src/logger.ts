import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

export class LauncherLogger {
  private static logsDir: string;
  private static logFilePath: string;
  private static previousLogFilePath: string;
  private static initialized = false;

  static init(): void {
    if (this.initialized) return;

    try {
      const userDataDir = app
        ? app.getPath("userData")
        : path.join(process.env.APPDATA || process.env.HOME || process.cwd(), ".lampas-launcher");

      this.logsDir = path.join(userDataDir, "logs");
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }

      this.logFilePath = path.join(this.logsDir, "launcher.log");
      this.previousLogFilePath = path.join(this.logsDir, "launcher.previous.log");

      // Rotate previous session log
      if (fs.existsSync(this.logFilePath)) {
        try {
          if (fs.existsSync(this.previousLogFilePath)) {
            fs.unlinkSync(this.previousLogFilePath);
          }
          fs.renameSync(this.logFilePath, this.previousLogFilePath);
        } catch {
          // If locked, fallback to append mode
        }
      }

      // Write session start header
      const header = `=== Lampas Launcher Session Started: ${new Date().toISOString()} ===\n` +
        `Platform: ${process.platform} (${process.arch}) | Node: ${process.version} | Electron: ${process.versions.electron || "N/A"}\n\n`;
      fs.writeFileSync(this.logFilePath, header, "utf-8");

      this.initialized = true;
    } catch (err) {
      console.error("[Logger Init Error]", err);
    }
  }

  static getLogPath(): string {
    if (!this.initialized) this.init();
    return this.logFilePath;
  }

  static getLogsDir(): string {
    if (!this.initialized) this.init();
    return this.logsDir;
  }

  static log(level: "INFO" | "WARN" | "ERROR" | "CHAT" | string, message: string): void {
    if (!this.initialized) this.init();

    const timestamp = new Date().toISOString();
    const sanitizedMessage = this.sanitize(message);
    const line = `[${timestamp}] [${level}] ${sanitizedMessage}\n`;

    try {
      if (this.logFilePath) {
        fs.appendFileSync(this.logFilePath, line, "utf-8");
      }
    } catch {
      // Fallback
    }

    if (level === "ERROR") {
      console.error(`[${level}]`, sanitizedMessage);
    } else if (level === "WARN") {
      console.warn(`[${level}]`, sanitizedMessage);
    } else {
      console.log(`[${level}]`, sanitizedMessage);
    }
  }

  static info(message: string): void {
    this.log("INFO", message);
  }

  static warn(message: string): void {
    this.log("WARN", message);
  }

  static error(message: string): void {
    this.log("ERROR", message);
  }

  static logApiRequest(method: string, url: string, payload?: any): void {
    let details = "";
    if (payload !== undefined) {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      const masked = this.sanitize(raw);
      details = masked.length > 500 ? ` | Body: ${masked.slice(0, 500)}...` : ` | Body: ${masked}`;
    }
    this.log("INFO", `[HTTP Request] ${method.toUpperCase()} ${url}${details}`);
  }

  static logApiResponse(method: string, url: string, status: number, durationMs: number, responseData?: any): void {
    let preview = "";
    if (responseData !== undefined) {
      const raw = typeof responseData === "string" ? responseData : JSON.stringify(responseData);
      const masked = this.sanitize(raw);
      preview = masked.length > 500 ? ` | Response: ${masked.slice(0, 500)}... (${masked.length} bytes)` : ` | Response: ${masked}`;
    }
    const level = status >= 400 ? "ERROR" : "INFO";
    this.log(level, `[HTTP Response] ${method.toUpperCase()} ${url} -> ${status} (${durationMs}ms)${preview}`);
  }

  static logApiError(method: string, url: string, error: any, durationMs?: number): void {
    const dur = durationMs !== undefined ? ` (${durationMs}ms)` : "";
    const msg = error?.message || String(error);
    this.log("ERROR", `[HTTP Error] ${method.toUpperCase()} ${url}${dur} -> ${this.sanitize(msg)}`);
  }

  private static sanitize(text: string): string {
    if (!text) return "";
    // Mask potential bearer tokens, JWTs, and sensitive credential JSON fields
    return text
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi, "Bearer [REDACTED]")
      .replace(/(eyJ[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]+)/g, "[JWT_REDACTED]")
      .replace(/"(token|refreshToken|minecraftAccessToken|publishSecret|secret|password|code_verifier|code)"\s*:\s*"[^"]+"/gi, '"$1": "[REDACTED]"');
  }

  static resetForTesting(): void {
    this.initialized = false;
    this.logsDir = "";
    this.logFilePath = "";
    this.previousLogFilePath = "";
  }
}
