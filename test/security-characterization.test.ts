import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Disposable test directories
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sec-char-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

// Minimal parent-process Electron mock for pure config path resolution
mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : testRoot),
    getName: () => "Lampas Launcher",
    getVersion: () => "1.3.0",
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
}));

// Load modules under test
const { LauncherLogger, LauncherLoggerService } = await import("../src/logger");
const { ConfigManager, normalizePortalUrl, PortalPolicy } = await import("../src/config");
const { isPathProtected, isSafeRelativePath } = await import("../src/sync");
const { GameDirectoryManager } = await import("../src/game-directory");
const { FabricMetaResolver } = await import("../src/fabric-meta");
const { downloadVerified } = await import("../src/file-transfer");
const { ProcessLogFramer } = await import("../src/game-log-stream");

let activeHttpServers: Array<{ stop: (closeActive?: boolean) => Promise<void> | void }> = [];

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
  PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
  ConfigManager.resetForTesting();
  GameDirectoryManager.resetForTesting();

  ConfigManager.set({
    token: "syn-test-bearer-token-12345",
    refreshToken: "syn-test-refresh-token-67890",
    minecraftAccessToken: "syn-test-mc-token-abcdef",
    portalUrl: "http://localhost:3000",
    selectedChannel: "stable",
    gameDir,
    customClientMods: [],
    disabledClientMods: [],
  });

  if (fs.existsSync(gameDir)) {
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.mkdirSync(gameDir, { recursive: true });
  }
});

afterEach(async () => {
  for (const s of activeHttpServers) {
    try {
      await s.stop(true);
    } catch {}
  }
  activeHttpServers = [];
});

afterAll(async () => {
  PortalPolicy.resetForTesting();
  try {
    await LauncherLogger.close();
  } catch {}
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Phase 1 Security Verification — SEC-01: Portal Destination & Credential Routing", () => {
  test("normalizePortalUrl rejects HTTP bypass when 'localhost' is part of domain name", () => {
    const bypassUrl = "http://localhost.attacker.invalid";
    expect(() => normalizePortalUrl(bypassUrl)).toThrow();
  });

  test("normalizePortalUrl rejects HTTP bypass when '127.0.0.1' is in query or path", () => {
    const queryBypass = "http://attacker.invalid/login?returnTo=127.0.0.1";
    const pathBypass = "http://attacker.invalid/api/127.0.0.1/auth";
    expect(() => normalizePortalUrl(queryBypass)).toThrow();
    expect(() => normalizePortalUrl(pathBypass)).toThrow();
  });

  test("normalizePortalUrl upgrades scheme when uppercase HTTP:// is supplied for approved host", () => {
    const upperHttp = "HTTP://dev.lampas.town";
    expect(normalizePortalUrl(upperHttp)).toBe("https://dev.lampas.town");
  });
});

describe("Phase 1 Security Verification — Isolated Boundary Harness (SEC-01, SEC-02)", () => {
  test("Executes boundary characterizations in isolated child process with complete Electron mock", async () => {
    const boundaryScript = path.resolve(__dirname, "security-boundary-characterization.ts");
    const proc = Bun.spawn([process.execPath, "run", boundaryScript], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
    }, 15000);

    const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.exited,
    ]);
    clearTimeout(timeoutHandle);

    const stdout = Buffer.from(stdoutBytes).toString("utf-8");
    const stderr = Buffer.from(stderrBytes).toString("utf-8");

    if (timedOut) {
      throw new Error(`Boundary test child process timed out after 15s. Stderr: ${stderr}\nStdout: ${stdout}`);
    }
    if (exitCode !== 0) {
      console.error("[Boundary Child Process Stderr]", stderr);
      console.error("[Boundary Child Process Stdout]", stdout);
    }
    expect(exitCode).toBe(0);

    const sentinel = "__BOUNDARY_RESULTS__:";
    const jsonStart = stdout.indexOf(sentinel);
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(stdout.slice(jsonStart + sentinel.length).trim().split("\n")[0]);

    expect(parsed.totalPassed).toBe(61);
    expect(parsed.totalSkipped).toBe(0);
    expect(parsed.tests.length).toBe(61);
    for (const t of parsed.tests) {
      expect(t.passed).toBe(true);
    }
  });
});

describe("Phase 3 Security Verification — SEC-03: Plaintext Credential Separation", () => {
  test("ConfigManager and SessionManager never persist authentication secrets in plaintext config.json", () => {
    const fakeToken = "sensitive_jwt_token_header.payload.signature";
    const fakeRefresh = "sensitive_refresh_token_string";
    const fakeMinecraft = "sensitive_mc_access_token";

    ConfigManager.establishSession("https://dev.lampas.town", {
      token: fakeToken,
      refreshToken: fakeRefresh,
      minecraftAccessToken: fakeMinecraft,
    });

    const configPath = path.join(userDataDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.token).toBeUndefined();
    expect(parsed.refreshToken).toBeUndefined();
    expect(parsed.minecraftAccessToken).toBeUndefined();

    expect(content).not.toContain(fakeToken);
    expect(content).not.toContain(fakeRefresh);
    expect(content).not.toContain(fakeMinecraft);

    const inMemory = ConfigManager.get();
    expect(inMemory.token).toBe(fakeToken);
    expect(inMemory.refreshToken).toBe(fakeRefresh);
    expect(inMemory.minecraftAccessToken).toBe(fakeMinecraft);
  });
});

describe("Phase 0 Security Characterization — SEC-04: Path Containment & Ownership Inconsistencies", () => {
  test("isSafeRelativePath and isPathProtected have inconsistent dot-alias handling", () => {
    const candidate = "mods/../saves/world-data.txt";
    expect(isSafeRelativePath(candidate)).toBe(true);
    expect(isPathProtected(candidate)).toBe(false);
  });

  test("isPathProtected fails on Windows uppercase path variants", () => {
    expect(isPathProtected("saves/level.dat")).toBe(true);
    expect(isPathProtected("Saves/level.dat")).toBe(false);
    expect(isPathProtected("SAVES/level.dat")).toBe(false);
    expect(isPathProtected("Screenshots/1.png")).toBe(false);
    expect(isPathProtected("Logs/latest.log")).toBe(false);
  });

  test("Internal launcher state directory (.lampas) is not protected from pack manifest paths", () => {
    const internalPath = ".lampas/installation.json";
    expect(isSafeRelativePath(internalPath)).toBe(true);
    expect(isPathProtected(internalPath)).toBe(false);
  });

  test("Previous state obsolete deletion resolves unvalidated traversal keys outside gameDir", () => {
    const outsideSentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-outside-sentinel-"));
    const outsideSentinelFile = path.join(outsideSentinelDir, "important-data.txt");
    fs.writeFileSync(outsideSentinelFile, "sentinel-payload");

    try {
      const relTraversal = path.relative(gameDir, outsideSentinelFile);
      expect(isPathProtected(relTraversal)).toBe(false);

      const resolved = path.join(gameDir, relTraversal);
      expect(path.resolve(resolved)).toBe(path.resolve(outsideSentinelFile));
    } finally {
      if (fs.existsSync(outsideSentinelDir)) {
        fs.rmSync(outsideSentinelDir, { recursive: true, force: true });
      }
    }
  });
});

describe("Phase 0 Security Characterization — SEC-05: Move Recovery Recursive Deletion of Staging", () => {
  test("recoverInterruptedMove recursively deletes arbitrary unvalidated staging path in 'preparing' phase", async () => {
    const outsideVictimDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-victim-dir-"));
    const victimFile = path.join(outsideVictimDir, "important-user-document.txt");
    fs.writeFileSync(victimFile, "do-not-delete-this-data", "utf-8");

    const journalPath = path.join(userDataDir, "directory-move.json");
    const maliciousJournal = {
      opId: "op-corrupt-staging",
      phase: "preparing",
      source: path.join(gameDir, "nonexistent-src"),
      target: path.join(gameDir, "nonexistent-dst"),
      staging: outsideVictimDir,
      startTime: new Date().toISOString(),
    };
    fs.writeFileSync(journalPath, JSON.stringify(maliciousJournal, null, 2), "utf-8");

    try {
      expect(fs.existsSync(victimFile)).toBe(true);
      await GameDirectoryManager.recoverInterruptedMove();
      expect(fs.existsSync(outsideVictimDir)).toBe(false);
    } finally {
      if (fs.existsSync(outsideVictimDir)) {
        fs.rmSync(outsideVictimDir, { recursive: true, force: true });
      }
    }
  });
});

describe("Phase 0 Security Characterization — SEC-06: Executable Verification Fails Open", () => {
  test("FabricMetaResolver returns metadata without checksums when sidecar 404s", async () => {
    const runtime = {
      minecraft: "26.2",
      loader: { type: "fabric" as const, version: "0.19.3" },
    };

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.endsWith(".sha256") || urlStr.endsWith(".sha1")) {
        return new Response("Not Found", { status: 404 });
      }
      if (urlStr.includes("meta.fabricmc.net")) {
        return Response.json({
          loader: { maven: "net.fabricmc:fabric-loader:0.19.3", version: "0.19.3", stable: true },
          intermediary: { maven: "net.fabricmc:intermediary:26.2", version: "26.2", stable: true },
          launcherMeta: {
            libraries: {
              client: [],
              common: [
                {
                  name: "net.fabricmc:sponge-mixin:0.15.3+mixin.0.8.7",
                  url: "https://maven.fabricmc.net/",
                },
              ],
            },
            mainClass: { client: "net.fabricmc.loader.impl.launch.knot.KnotClient" },
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    const result = await FabricMetaResolver.resolveFabricRuntime(runtime, undefined, {
      fetchFn: mockFetch as any,
    });
    expect(result.libraries.length).toBeGreaterThan(0);
    const spongeLib = result.libraries.find((l: any) => l.name.includes("sponge-mixin"));
    expect(spongeLib).toBeDefined();
    expect(spongeLib?.sha256).toBeUndefined();
    expect(spongeLib?.sha1).toBeUndefined();
  });

  test("downloadVerified completes without error when expectedHash is undefined", async () => {
    const payload = Buffer.from("arbitrary-binary-content-without-checksum");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(payload);
      },
    });
    activeHttpServers.push(server);

    const destPath = path.join(gameDir, "downloaded-unverified.jar");
    const bytes = await downloadVerified(`http://127.0.0.1:${server.port}/blob`, destPath, {
      expectedHash: undefined,
    });

    expect(bytes).toBe(payload.length);
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath)).toEqual(payload);
  });
});

describe("Phase 0 Security Characterization — SEC-09: Logging Redaction Gaps", () => {
  test("LauncherLoggerService.sanitize redacts standard keys but misses underscore fields", () => {
    const camel = '{"token": "secret_bearer_token"}';
    expect(LauncherLoggerService.sanitize(camel)).toBe('{"token": "[REDACTED]"}');

    const underRefresh = '{"refresh_token": "secret_refresh_token_value"}';
    expect(LauncherLoggerService.sanitize(underRefresh)).toBe(underRefresh);

    const underAccess = '{"access_token": "secret_access_token_value"}';
    expect(LauncherLoggerService.sanitize(underAccess)).toBe(underAccess);
  });

  test("LauncherLoggerService.sanitize does not redact authorization codes in URL query strings", () => {
    const queryWithCode = "https://dev.lampas.town/callback?code=sensitive_authorization_code_12345&state=abc";
    expect(LauncherLoggerService.sanitize(queryWithCode)).toBe(queryWithCode);
  });

  test("LauncherLoggerService.sanitize does not redact CLI command arguments", () => {
    const cliLine = "Starting java with --accessToken sensitive_session_token_xyz --version 26.2";
    expect(LauncherLoggerService.sanitize(cliLine)).toBe(cliLine);
  });

  test("ProcessLogFramer truncates oversized lines before redaction, leaking split secrets", () => {
    let emitted: string | null = null;
    const framer = new ProcessLogFramer("INFO", (entry) => {
      emitted = entry.message;
    }, { maxLineLength: 50 });

    const line = 'A'.repeat(30) + '{"token": "sensitive_leaked_secret_token_12345"}\n';

    framer.pushChunk(Buffer.from(line));
    framer.flush();

    expect(emitted).not.toBeNull();
    expect(emitted!).toContain("sensitive");
    expect(emitted!).toContain("...[TRUNCATED]");
  });
});
