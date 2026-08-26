import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-logger-test-"));
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const { LauncherLogger } = await import("../src/logger");

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
});

beforeEach(() => {
  LauncherLogger.resetForTesting();
});

afterAll(() => {
  LauncherLogger.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("LauncherLogger persistent disk logging", () => {
  test("initializes log directory and creates launcher.log with session header", () => {
    LauncherLogger.init();

    const logPath = LauncherLogger.getLogPath();
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("=== Lampas Launcher Session Started:");
    expect(content).toContain("Platform:");
  });

  test("appends formatted INFO, WARN, and ERROR messages to launcher.log", () => {
    LauncherLogger.init();
    LauncherLogger.info("Starting synchronization test");
    LauncherLogger.warn("Channel warning alert");
    LauncherLogger.error("Failed connection attempt");

    const content = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(content).toContain("[INFO] Starting synchronization test");
    expect(content).toContain("[WARN] Channel warning alert");
    expect(content).toContain("[ERROR] Failed connection attempt");
  });

  test("sanitizes authorization tokens in log output", () => {
    LauncherLogger.init();
    LauncherLogger.info("Sending request with Bearer secret_token_12345678901234567890");
    LauncherLogger.info("User JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");

    const content = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(content).toContain("Bearer [REDACTED]");
    expect(content).not.toContain("secret_token_12345678901234567890");
    expect(content).toContain("[JWT_REDACTED]");
  });

  test("rotates previous session log to launcher.previous.log on next initialization", () => {
    LauncherLogger.init();
    LauncherLogger.info("Session 1 Message");

    LauncherLogger.resetForTesting();
    LauncherLogger.init();
    LauncherLogger.info("Session 2 Message");

    const logsDir = LauncherLogger.getLogsDir();
    const prevLogPath = path.join(logsDir, "launcher.previous.log");
    const currentLogPath = path.join(logsDir, "launcher.log");

    expect(fs.existsSync(prevLogPath)).toBe(true);
    expect(fs.existsSync(currentLogPath)).toBe(true);

    const prevContent = fs.readFileSync(prevLogPath, "utf-8");
    expect(prevContent).toContain("Session 1 Message");

    const currentContent = fs.readFileSync(currentLogPath, "utf-8");
    expect(currentContent).toContain("Session 2 Message");
    expect(currentContent).not.toContain("Session 1 Message");
  });

  test("logs API requests, responses, and errors with payload sanitization", () => {
    LauncherLogger.init();

    LauncherLogger.logApiRequest("POST", "https://dev.lampas.town/api/v1/auth/exchange", {
      code: "secret_auth_code_123",
      code_verifier: "my_secret_verifier",
    });

    LauncherLogger.logApiResponse("GET", "https://dev.lampas.town/api/v1/channels/stable", 200, 142, {
      version: "2.0.0",
      pack: "Lampas 2",
    });

    LauncherLogger.logApiError("GET", "https://dev.lampas.town/api/v1/releases/9.9.9", new Error("HTTP 404 Not Found"), 55);

    const content = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(content).toContain("[HTTP Request] POST https://dev.lampas.town/api/v1/auth/exchange");
    expect(content).toContain('"code": "[REDACTED]"');
    expect(content).toContain('"code_verifier": "[REDACTED]"');
    expect(content).not.toContain("secret_auth_code_123");

    expect(content).toContain("[HTTP Response] GET https://dev.lampas.town/api/v1/channels/stable -> 200 (142ms)");
    expect(content).toContain('"version":"2.0.0"');

    expect(content).toContain("[HTTP Error] GET https://dev.lampas.town/api/v1/releases/9.9.9 (55ms) -> HTTP 404 Not Found");
  });
});
