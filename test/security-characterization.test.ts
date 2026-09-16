import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

// Disposable test directories
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sec-char-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

// Tracked calls for Electron harness
const ipcHandlers = new Map<string, Function>();
const ipcListeners = new Map<string, Function>();
const openedPaths: string[] = [];
const openedExternals: string[] = [];

class MockWebContents {
  id = 1;
  on() { return this; }
  once() { return this; }
  send() {}
  isLoading() { return false; }
  isDestroyed() { return false; }
}

class MockBrowserWindow {
  static allWindows: MockBrowserWindow[] = [];
  static getAllWindows(): MockBrowserWindow[] {
    return MockBrowserWindow.allWindows;
  }
  webContents = new MockWebContents();
  isDestroyed() { return false; }
  isMaximized() { return false; }
  minimize() {}
  maximize() {}
  unmaximize() {}
  close() {}
  destroy() {}
  loadURL() {}
  loadFile() {}
  show() {}
  on() { return this; }
  once() { return this; }
  constructor() {
    MockBrowserWindow.allWindows.push(this);
  }
}

const mockShell = {
  openPath: mock(async (targetPath: string) => {
    openedPaths.push(targetPath);
    return "";
  }),
  openExternal: mock(async (url: string) => {
    openedExternals.push(url);
  }),
};

let readyResolver: () => void;
const readyPromise = new Promise<void>((resolve) => {
  readyResolver = resolve;
});

const electronHarness = {
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : testRoot),
    getName: () => "Lampas Launcher",
    getVersion: () => "1.3.0",
    whenReady: () => readyPromise,
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: MockBrowserWindow,
  ipcMain: {
    handle: (channel: string, handler: Function) => {
      ipcHandlers.set(channel, handler);
    },
    on: (channel: string, listener: Function) => {
      ipcListeners.set(channel, listener);
    },
  },
  shell: mockShell,
  nativeImage: { createFromPath: () => ({}) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
};

mock.module("mock-electron-sec-harness", () => electronHarness);
mock.module("electron", () => electronHarness);

// Load modules
const { LauncherLogger, LauncherLoggerService } = await import("../src/logger");
const { ConfigManager, normalizePortalUrl } = await import("../src/config");
const { isPathProtected, isSafeRelativePath } = await import("../src/sync");
const { GameDirectoryManager } = await import("../src/game-directory");
const { FabricMetaResolver } = await import("../src/fabric-meta");
const { downloadVerified } = await import("../src/file-transfer");
const { ProcessLogFramer } = await import("../src/game-log-stream");

// Load production LauncherAuth via an isolated runner file in testRoot to bypass
// Bun's process-wide mock.module("../src/auth") cached from game-runner.test.ts
const authSrcPath = path.resolve(__dirname, "../src/auth.ts");
const authSourceCode = fs.readFileSync(authSrcPath, "utf-8");
const srcDirPath = path.resolve(__dirname, "../src").replace(/\\/g, "/");
const transformedAuthCode = authSourceCode
  .replace(/from "\.\//g, `from "${srcDirPath}/`)
  .replace('from "electron"', 'from "mock-electron-sec-harness"');
const tempAuthRunner = path.join(testRoot, "real-auth-runner.ts");
fs.writeFileSync(tempAuthRunner, transformedAuthCode, "utf-8");
const authModule = await import(tempAuthRunner);
const LauncherAuth = authModule.LauncherAuth;

// Load production main.ts to trigger actual IPC registrations through the mock harness.
// We rewrite 'from "electron"' to 'from "mock-electron-sec-harness"' to account for Bun's
// process-wide module-mock caching where prior test suites only mock { app, shell }.
const mainSrcPath = path.resolve(__dirname, "../src/main.ts");
const mainSourceCode = fs.readFileSync(mainSrcPath, "utf-8");
const transformedMainCode = mainSourceCode
  .replace(/from "\.\//g, `from "${srcDirPath}/`)
  .replace('from "electron"', 'from "mock-electron-sec-harness"');

const tempMainRunner = path.join(testRoot, "main-harness-runner.ts");
fs.writeFileSync(tempMainRunner, transformedMainCode, "utf-8");
await import(tempMainRunner);
readyResolver!();
// Await registration microtasks
await new Promise((r) => setTimeout(r, 80));

let activeHttpServers: Array<{ stop: (closeActive?: boolean) => Promise<void> | void }> = [];

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
  openedPaths.length = 0;
  openedExternals.length = 0;
  mockShell.openPath.mockClear();
  mockShell.openExternal.mockClear();
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
  try {
    await LauncherLogger.close();
  } catch {}
  for (const win of MockBrowserWindow.allWindows) {
    try { win.destroy(); } catch {}
  }
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Phase 0 Security Characterization — SEC-01: Portal Destination & Credential Routing", () => {
  test("normalizePortalUrl allows HTTP bypass when 'localhost' is part of domain name", () => {
    const bypassUrl = "http://localhost.attacker.invalid";
    expect(normalizePortalUrl(bypassUrl)).toBe("http://localhost.attacker.invalid");
  });

  test("normalizePortalUrl allows HTTP bypass when '127.0.0.1' is in query or path", () => {
    const bypassUrl = "http://attacker.invalid/auth?ip=127.0.0.1";
    expect(normalizePortalUrl(bypassUrl)).toBe("http://attacker.invalid/auth?ip=127.0.0.1");
  });

  test("normalizePortalUrl allows HTTP bypass when scheme is uppercase HTTP://", () => {
    const bypassUrl = "HTTP://remote.example.com";
    expect(normalizePortalUrl(bypassUrl)).toBe("HTTP://remote.example.com");
  });

  test("[Service-Level] LauncherAuth.verifySession forwards bearer credentials to caller-supplied portalUrl override", async () => {
    let capturedAuthHeader: string | null = null;
    let capturedUrl: string | null = null;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        capturedUrl = req.url;
        capturedAuthHeader = req.headers.get("Authorization");
        return Response.json({
          valid: true,
          user: {
            id: "u1",
            name: "Player",
            minecraftUsername: "Player",
            minecraftUuid: "00000000-0000-0000-0000-000000000001",
          },
        });
      },
    });
    activeHttpServers.push(server);

    const attackerPortal = `http://127.0.0.1:${server.port}`;
    const result = await LauncherAuth.verifySession(attackerPortal);

    expect(result.valid).toBe(true);
    expect(capturedUrl).toBe(`${attackerPortal}/api/v1/auth/verify`);
    expect(capturedAuthHeader).toBe("Bearer syn-test-bearer-token-12345");
  });

  test("[Service-Level] LauncherAuth.refreshSession forwards refresh token and bearer credentials to caller-supplied portalUrl override", async () => {
    let capturedBody: any = null;
    let capturedUrl: string | null = null;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        capturedUrl = req.url;
        capturedBody = await req.json();
        return Response.json({
          token: "new-token-999",
          refreshToken: "new-refresh-888",
          user: {
            id: "u1",
            name: "Player",
            minecraftUsername: "Player",
            minecraftUuid: "00000000-0000-0000-0000-000000000001",
          },
        });
      },
    });
    activeHttpServers.push(server);

    const attackerPortal = `http://127.0.0.1:${server.port}`;
    const result = await LauncherAuth.refreshSession(attackerPortal);

    expect(result.valid).toBe(true);
    expect(capturedUrl).toBe(`${attackerPortal}/api/v1/auth/refresh`);
    expect(capturedBody.refreshToken).toBe("syn-test-refresh-token-67890");
    expect(capturedBody.token).toBe("syn-test-bearer-token-12345");
  });

  test("[IPC-Level] auth:verify production handler forwards caller-supplied portalUrl override to transport sink", async () => {
    let capturedAuthHeader: string | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        capturedAuthHeader = req.headers.get("Authorization");
        return Response.json({
          valid: true,
          user: {
            id: "u1",
            name: "Player",
            minecraftUsername: "Player",
            minecraftUuid: "00000000-0000-0000-0000-000000000001",
          },
        });
      },
    });
    activeHttpServers.push(server);

    const attackerPortal = `http://127.0.0.1:${server.port}`;
    const handler = ipcHandlers.get("auth:verify");
    expect(handler).toBeDefined();

    const response = await handler!({}, attackerPortal);
    expect(response.valid).toBe(true);
    expect(capturedAuthHeader).toBe("Bearer syn-test-bearer-token-12345");
  });

  test("[IPC-Level] auth:refresh production handler forwards caller-supplied portalUrl override to transport sink", async () => {
    let capturedBody: any = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        capturedBody = await req.json();
        return Response.json({
          token: "new-token-111",
          refreshToken: "new-refresh-222",
          user: {
            id: "u1",
            name: "Player",
            minecraftUsername: "Player",
            minecraftUuid: "00000000-0000-0000-0000-000000000001",
          },
        });
      },
    });
    activeHttpServers.push(server);

    const attackerPortal = `http://127.0.0.1:${server.port}`;
    const handler = ipcHandlers.get("auth:refresh");
    expect(handler).toBeDefined();

    ConfigManager.set({
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
    });

    const response = await handler!({}, attackerPortal);
    expect(response.valid).toBe(true);
    expect(capturedBody.refreshToken).toBe("syn-test-refresh-token-67890");
    expect(capturedBody.token).toBe("syn-test-bearer-token-12345");
  });
});

describe("Phase 0 Security Characterization — SEC-02: Broad IPC & Production OS Opener Handler", () => {
  test("[IPC-Level] utils:openPath production handler invokes shell.openPath for non-HTTP targets", async () => {
    const handler = ipcHandlers.get("utils:openPath");
    expect(handler).toBeDefined();

    // Call real handler with non-HTTP target (e.g. calc.exe)
    await handler!({}, "calc.exe");

    expect(mockShell.openPath).toHaveBeenCalledWith("calc.exe");
    expect(mockShell.openExternal).not.toHaveBeenCalledWith("calc.exe");
  });

  test("[IPC-Level] utils:openPath production handler invokes shell.openExternal for HTTP(S) targets", async () => {
    const handler = ipcHandlers.get("utils:openPath");
    expect(handler).toBeDefined();

    await handler!({}, "https://lampas.town/mods/example");

    expect(mockShell.openExternal).toHaveBeenCalledWith("https://lampas.town/mods/example");
    expect(mockShell.openPath).not.toHaveBeenCalledWith("https://lampas.town/mods/example");
  });

  test("[IPC-Level] config:set production handler permits arbitrary runtime fields like javaPath and javaArgs", async () => {
    const handler = ipcHandlers.get("config:set");
    expect(handler).toBeDefined();

    const result = await handler!({}, {
      javaPath: "C:\\untrusted\\custom-java.exe",
      javaArgs: "-javaagent:C:\\untrusted\\agent.jar",
    });

    expect(result.javaPath).toBe("C:\\untrusted\\custom-java.exe");
    expect(result.javaArgs).toBe("-javaagent:C:\\untrusted\\agent.jar");
  });

  test("Registration harness confirms 35 ipcMain.handle registrations and 1 ipcMain.on registration in main.ts", () => {
    expect(ipcHandlers.size).toBe(35);
    expect(ipcListeners.size).toBe(1);
    expect(ipcListeners.has("game:logAck")).toBe(true);
  });
});

describe("Phase 0 Security Characterization — SEC-03: Plaintext Credential Persistence", () => {
  test("ConfigManager persists authentication secrets in unencrypted plaintext JSON", () => {
    ConfigManager.set({
      token: "super-secret-portal-jwt-token",
      refreshToken: "super-secret-refresh-uuid",
      minecraftAccessToken: "super-secret-mc-session-token",
    });

    const configFilePath = path.join(userDataDir, "config.json");
    expect(fs.existsSync(configFilePath)).toBe(true);

    const rawFileContent = fs.readFileSync(configFilePath, "utf-8");
    const parsedOnDisk = JSON.parse(rawFileContent);

    expect(parsedOnDisk.token).toBe("super-secret-portal-jwt-token");
    expect(parsedOnDisk.refreshToken).toBe("super-secret-refresh-uuid");
    expect(parsedOnDisk.minecraftAccessToken).toBe("super-secret-mc-session-token");
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
      fs.rmSync(outsideSentinelDir, { recursive: true, force: true });
    }
  });
});

describe("Phase 0 Security Characterization — SEC-05: Move Recovery Recursive Deletion of Staging", () => {
  test("recoverInterruptedMove recursively deletes arbitrary unvalidated staging path in 'preparing' phase", async () => {
    const outsideVictimDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-victim-staging-"));
    const victimFile = path.join(outsideVictimDir, "important-document.docx");
    fs.writeFileSync(victimFile, "vital user data");

    const journalPath = path.join(userDataDir, "directory-move.json");
    const maliciousJournal = {
      operationId: "op-corrupt-staging",
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
    const mockRuntime = {
      minecraft: "26.2",
      loader: { type: "fabric" as const, version: "0.19.3" },
    };

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.endsWith(".sha256") || urlStr.endsWith(".sha1")) {
        return new Response("Not Found", { status: 404 });
      }
      return Response.json({
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        launcherMeta: {
          mainClass: { client: "net.fabricmc.loader.impl.launch.knot.KnotClient" },
          libraries: {
            common: [
              { name: "net.fabricmc:sponge-mixin:0.15.3+mixin.0.8.7" },
            ],
          },
        },
      });
    };

    const result = await FabricMetaResolver.resolveFabricRuntime(mockRuntime, undefined, {
      fetchFn: mockFetch,
      timeoutMs: 1000,
      resolveSidecars: true,
    });

    expect(result.libraries.length).toBeGreaterThan(0);
    const spongeLib = result.libraries.find((l) => l.name.includes("sponge-mixin"));
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
