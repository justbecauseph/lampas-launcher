import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-logger-test-"));
const userDataDir = path.join(testRoot, "user-data");
const logsDir = path.join(userDataDir, "logs");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const { LauncherLogger, LauncherLoggerService } = await import("../src/logger");

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterAll(async () => {
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("LauncherLogger persistent disk logging", () => {
  test("initializes log directory and creates launcher.log with session header", async () => {
    const logger = new LauncherLoggerService();
    logger.init(logsDir);
    await logger.flush();

    const logPath = logger.getLogPath();
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("=== Lampas Launcher Session Started:");
    expect(content).toContain("Platform:");
    await logger.close();
  });

  test("appends formatted INFO, WARN, and ERROR messages to launcher.log in exact order", async () => {
    const logger = new LauncherLoggerService();
    logger.init(logsDir);
    logger.info("Starting synchronization test");
    logger.warn("Channel warning alert");
    logger.error("Failed connection attempt");
    await logger.flush();

    const content = fs.readFileSync(logger.getLogPath(), "utf-8");
    expect(content).toContain("[INFO] Starting synchronization test");
    expect(content).toContain("[WARN] Channel warning alert");
    expect(content).toContain("[ERROR] Failed connection attempt");

    const infoIndex = content.indexOf("[INFO] Starting synchronization test");
    const warnIndex = content.indexOf("[WARN] Channel warning alert");
    const errorIndex = content.indexOf("[ERROR] Failed connection attempt");

    expect(infoIndex).toBeLessThan(warnIndex);
    expect(warnIndex).toBeLessThan(errorIndex);
    await logger.close();
  });

  test("sanitizes authorization tokens in log output", async () => {
    const logger = new LauncherLoggerService();
    logger.init(logsDir);
    logger.info("Sending request with Bearer secret_token_12345678901234567890");
    logger.info(
      "User JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    );
    await logger.flush();

    const content = fs.readFileSync(logger.getLogPath(), "utf-8");
    expect(content).toContain("Bearer [REDACTED]");
    expect(content).not.toContain("secret_token_12345678901234567890");
    expect(content).toContain("[JWT_REDACTED]");
    await logger.close();
  });

  test("rotates previous session log to launcher.previous.log on next initialization", async () => {
    const logger1 = new LauncherLoggerService();
    logger1.init(logsDir);
    logger1.info("Session 1 Message");
    await logger1.close();

    const logger2 = new LauncherLoggerService();
    logger2.init(logsDir);
    logger2.info("Session 2 Message");
    await logger2.flush();

    const activeLogsDir = logger2.getLogsDir();
    const prevLogPath = path.join(activeLogsDir, "launcher.previous.log");
    const currentLogPath = path.join(activeLogsDir, "launcher.log");

    expect(fs.existsSync(prevLogPath)).toBe(true);
    expect(fs.existsSync(currentLogPath)).toBe(true);

    const prevContent = fs.readFileSync(prevLogPath, "utf-8");
    expect(prevContent).toContain("Session 1 Message");

    const currentContent = fs.readFileSync(currentLogPath, "utf-8");
    expect(currentContent).toContain("Session 2 Message");
    expect(currentContent).not.toContain("Session 1 Message");
    await logger2.close();
  });

  test("logs API requests, responses, and errors with payload sanitization", async () => {
    const logger = new LauncherLoggerService();
    logger.init(logsDir);

    logger.logApiRequest("POST", "https://dev.lampas.town/api/v1/auth/exchange", {
      code: "secret_auth_code_123",
      code_verifier: "my_secret_verifier",
    });

    logger.logApiResponse("GET", "https://dev.lampas.town/api/v1/channels/stable", 200, 142, {
      version: "2.0.0",
      pack: "Lampas 2",
    });

    logger.logApiError(
      "GET",
      "https://dev.lampas.town/api/v1/releases/9.9.9",
      new Error("HTTP 404 Not Found"),
      55
    );
    await logger.flush();

    const content = fs.readFileSync(logger.getLogPath(), "utf-8");
    expect(content).toContain("[HTTP Request] POST https://dev.lampas.town/api/v1/auth/exchange");
    expect(content).toContain('"code": "[REDACTED]"');
    expect(content).toContain('"code_verifier": "[REDACTED]"');
    expect(content).not.toContain("secret_auth_code_123");

    expect(content).toContain("[HTTP Response] GET https://dev.lampas.town/api/v1/channels/stable -> 200 (142ms)");
    expect(content).toContain('"version":"2.0.0"');

    expect(content).toContain("[HTTP Error] GET https://dev.lampas.town/api/v1/releases/9.9.9 (55ms) -> HTTP 404 Not Found");
    await logger.close();
  });

  test("bounded memory: drops oldest records and inserts warning when queue saturated", async () => {
    const logger = new LauncherLoggerService();
    logger.init(logsDir);

    logger.MAX_PENDING_BYTES = 500; // 500 byte limit for test
    logger.MAX_PENDING_RECORDS = 5;

    // Pause draining to build up backlog
    (logger as any).waitingForDrain = true;

    for (let i = 0; i < 20; i++) {
      logger.info(`Saturation test line ${i}`);
    }

    expect(logger.getDroppedRecordsCount()).toBeGreaterThan(0);

    // Resume draining and flush
    (logger as any).waitingForDrain = false;
    await logger.flush();

    const content = fs.readFileSync(logger.getLogPath(), "utf-8");
    expect(content).toContain("Logging overload: dropped");
    await logger.close();
  });

  test("close flushes pending writes and cleans up stream descriptor", async () => {
    const logger = new LauncherLoggerService();
    logger.init(logsDir);
    logger.info("Line before close");
    await logger.close();

    const content = fs.readFileSync(logger.getLogPath(), "utf-8");
    expect(content).toContain("Line before close");
    expect((logger as any).writeStream).toBeNull();
  });

  test("blocked drain pauses pumpQueue until drain event is emitted", async () => {
    const logger = new LauncherLoggerService();
    logger.init(logsDir);
    const ws = (logger as any).writeStream;
    let originalWrite = ws.write;

    let writeBlocked = true;
    ws.write = function (chunk: any, cb?: any) {
      const res = originalWrite.call(ws, chunk, cb);
      if (writeBlocked) {
        return false; // Signal backpressure
      }
      return res;
    };

    logger.info("Line during backpressure 1");
    logger.info("Line during backpressure 2");

    // Because write returned false, logger is waiting for drain
    expect((logger as any).waitingForDrain).toBe(true);

    // Unblock and emit drain
    writeBlocked = false;
    ws.emit("drain");

    expect((logger as any).waitingForDrain).toBe(false);
    await logger.flush();

    const content = fs.readFileSync(logger.getLogPath(), "utf-8");
    expect(content).toContain("Line during backpressure 1");
    expect(content).toContain("Line during backpressure 2");
    await logger.close();
  });

  test("write stream error does not trigger recursive logging or crash flush", async () => {
    const logger = new LauncherLoggerService();
    logger.init(logsDir);
    const ws = (logger as any).writeStream;

    let stderrOutput = "";
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => {
      stderrOutput += String(chunk);
      return true;
    }) as any;

    try {
      ws.emit("error", new Error("Disk hardware failure"));
      expect(stderrOutput).toContain("[LauncherLogger Stream Error] Disk hardware failure");
      // Flush does not hang
      await logger.flush();
      await logger.close();
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  test("LauncherLogger static facade delegates to defaultInstance", () => {
    expect(typeof LauncherLogger.info).toBe("function");
    expect(typeof LauncherLogger.getLogPath).toBe("function");
    expect(LauncherLogger.sanitize("Bearer secret12345678901234567890")).toBe("Bearer [REDACTED]");
  });
});
