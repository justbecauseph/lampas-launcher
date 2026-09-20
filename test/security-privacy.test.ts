import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  shell: {},
}));
const { LauncherLoggerService, safeBoundedClone } =
  await import("../src/logger");
const { ProcessLogFramer } = await import("../src/game-log-stream");

describe("Phase 6 privacy boundaries", () => {
  test("redacts credential aliases, signed URL queries, headers and CLI arguments", () => {
    const secret = "synthetic-secret-value";
    for (const input of [
      JSON.stringify({
        access_token: secret,
        refresh_token: secret,
        codeVerifier: secret,
      }),
      `https://example.test/blob?X-Amz-Signature=${secret}&code=${secret}`,
      `Authorization: Bearer ${secret}`,
      `Cookie: session=${secret}`,
      `X-Api-Key: ${secret}`,
      `Authorization=${secret}`,
      `java --accessToken ${secret} --token=${secret} --username Example`,
      `{"access_token":"${secret}`,
    ])
      expect(LauncherLoggerService.sanitize(input)).not.toContain(secret);
    expect(
      JSON.stringify(
        safeBoundedClone({
          access_token: secret,
          minecraft_access_token: secret,
        }),
      ),
    ).not.toContain(secret);
  });

  test("every chunk split redacts a complete line and drops an oversized raw line", () => {
    const raw = Buffer.from(
      'UTF8 你好 {"access_token":"synthetic-secret-value"}\n',
    );
    for (let split = 0; split <= raw.length; split++) {
      const entries: string[] = [];
      const framer = new ProcessLogFramer("INFO", (entry) =>
        entries.push(entry.message),
      );
      framer.pushChunk(raw.subarray(0, split));
      framer.pushChunk(raw.subarray(split));
      framer.finishOnce();
      expect(entries.join(" ")).not.toContain("synthetic-secret-value");
      expect(entries.join(" ")).toContain("你好");
    }
    const entries: string[] = [];
    const framer = new ProcessLogFramer(
      "INFO",
      (entry) => entries.push(entry.message),
      { maxLineLength: 32 },
    );
    framer.pushChunk('{"access_token":"' + "s".repeat(80));
    framer.pushChunk('tail-secret"}\nnormal line\n');
    framer.finishOnce();
    expect(entries).toEqual([
      "[Oversized log record discarded]",
      "normal line",
    ]);
  });

  test("API logs exclude response bodies and rotate only launcher-owned files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-private-logs-"));
    const logger = new LauncherLoggerService();
    (logger as any).MAX_FILE_BYTES = 2048;
    fs.writeFileSync(path.join(root, "minecraft.log"), "player-owned");
    try {
      logger.init(root);
      logger.logApiResponse(
        "POST",
        "https://example.test/auth?code=synthetic-secret",
        200,
        5,
        { name: "PRIVATE_PLAYER", token: "synthetic-secret" },
      );
      await logger.flush();
      expect(fs.readFileSync(logger.getLogPath(), "utf8")).not.toContain(
        "PRIVATE_PLAYER",
      );
      for (let i = 0; i < 100; i++)
        logger.info(`entry ${i} ${"x".repeat(100)}`);
      await logger.close();
      const files = fs
        .readdirSync(root)
        .filter((name) =>
          /^launcher(?:\.(?:previous|older))?\.log$/.test(name),
        );
      expect(files.length).toBeLessThanOrEqual(3);
      for (const name of files)
        expect(fs.statSync(path.join(root, name)).size).toBeLessThanOrEqual(
          2048,
        );
      expect(fs.readFileSync(path.join(root, "minecraft.log"), "utf8")).toBe(
        "player-owned",
      );
    } finally {
      await logger.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("retention expiry removes stale launcher generations before opening a new log", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "lampas-private-retention-"),
    );
    const staleAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const name of [
      "launcher.log",
      "launcher.previous.log",
      "launcher.older.log",
    ]) {
      const file = path.join(root, name);
      fs.writeFileSync(file, "stale launcher record");
      fs.utimesSync(file, staleAt, staleAt);
    }
    const logger = new LauncherLoggerService();
    try {
      logger.init(root);
      await logger.flush();
      expect(fs.existsSync(path.join(root, "launcher.previous.log"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(root, "launcher.older.log"))).toBe(false);
      expect(fs.readFileSync(logger.getLogPath(), "utf8")).not.toContain(
        "stale launcher record",
      );
    } finally {
      await logger.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses private log permissions on POSIX hosts", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-private-mode-"));
    const logger = new LauncherLoggerService();
    try {
      logger.init(root);
      await logger.flush();
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(logger.getLogPath()).mode & 0o777).toBe(0o600);
    } finally {
      await logger.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
