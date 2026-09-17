import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { mock } from "bun:test";

/**
 * Isolated Security Boundary Characterization
 *
 * Runs in a clean child process to characteristically exercise unchanged production
 * src/main.ts and src/auth.ts with complete Electron mocks, free from parent-process
 * module-mock caching.
 *
 * Test Harness Invariants:
 * 1. Fixture-only outbound request policy: unapproved network destinations are blocked
 *    and recorded as test-failing violations.
 * 2. Unintended process execution interception: child_process calls are intercepted.
 * 3. OS opener interception: shell.openPath and shell.openExternal are tracked without OS launches.
 * 4. Guaranteed cleanup: all startup, import, registration, request, and assertion failures
 *    reach full teardown of servers, loggers, windows, and temporary files.
 */

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-boundary-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(gameDir, { recursive: true });

// Tracked harness state
const ipcHandlers = new Map<string, Function>();
const ipcListeners = new Map<string, Function>();
const openedPaths: string[] = [];
const openedExternals: string[] = [];
const interceptedProcesses: Array<{ command: string; args: any[] }> = [];

// Intercept unintended process execution
mock.module("node:child_process", () => ({
  spawn: (command: string, args: any[] = []) => {
    interceptedProcesses.push({ command, args });
    throw new Error(`[SecurityHarness] child_process.spawn blocked for: ${command}`);
  },
  exec: (command: string) => {
    interceptedProcesses.push({ command, args: [] });
    throw new Error(`[SecurityHarness] child_process.exec blocked for: ${command}`);
  },
  execFile: (command: string, args: any[] = []) => {
    interceptedProcesses.push({ command, args });
    throw new Error(`[SecurityHarness] child_process.execFile blocked for: ${command}`);
  },
  fork: (modulePath: string, args: any[] = []) => {
    interceptedProcesses.push({ command: modulePath, args });
    throw new Error(`[SecurityHarness] child_process.fork blocked for: ${modulePath}`);
  },
}));

// Outbound request policy
const allowedDestinations = new Set<string>();
const attemptedViolations: string[] = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let urlStr: string;
  if (typeof input === "string") {
    urlStr = input;
  } else if (input instanceof URL) {
    urlStr = input.href;
  } else {
    urlStr = input.url;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    attemptedViolations.push(urlStr);
    throw new Error(`[OutboundPolicyViolation] Malformed request URL: ${urlStr}`);
  }

  if (!allowedDestinations.has(parsed.origin) && !allowedDestinations.has(parsed.host)) {
    attemptedViolations.push(urlStr);
    throw new Error(`[OutboundPolicyViolation] Request to unapproved destination: ${urlStr}`);
  }

  return originalFetch(input, init);
}) as any;

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

// Mock Electron before any imports
mock.module("electron", () => ({
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
}));

const results = {
  totalPassed: 0,
  tests: [] as Array<{ name: string; passed: boolean; error?: string }>,
};

function runTest(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      results.totalPassed++;
      results.tests.push({ name, passed: true });
    } catch (e: any) {
      results.tests.push({ name, passed: false, error: e?.message || String(e) });
    }
  })();
}

let server: http.Server | null = null;
let serverA: http.Server | null = null;
let LauncherLogger: any = null;

try {
  // Load production modules directly and unchanged
  const configMod = await import("../src/config");
  const authMod = await import("../src/auth");
  const loggerMod = await import("../src/logger");
  const syncMod = await import("../src/sync");
  const serverStatusMod = await import("../src/server-status");
  const fileTransferMod = await import("../src/file-transfer");
  const ConfigManager = configMod.ConfigManager;
  const LauncherAuth = authMod.LauncherAuth;
  LauncherLogger = loggerMod.LauncherLogger;
  const LauncherSync = syncMod.LauncherSync;
  const ServerStatusClient = serverStatusMod.ServerStatusClient;
  const downloadVerified = fileTransferMod.downloadVerified;

  // Import production main.ts to register IPC channels
  await import("../src/main");

  // Signal readiness and await deterministic registration of all 36 channels
  readyResolver!();

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (ipcHandlers.size >= 35 && ipcListeners.size >= 1) {
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for IPC registrations (handlers: ${ipcHandlers.size}, listeners: ${ipcListeners.size})`));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });

  // 1. Inbound IPC Registration Inventory
  await runTest("Registration harness confirms 37 handles and 1 on channel", () => {
    if (ipcHandlers.size !== 37) throw new Error(`Expected 37 handles, got ${ipcHandlers.size}`);
    if (ipcListeners.size !== 1) throw new Error(`Expected 1 listener, got ${ipcListeners.size}`);
    if (!ipcListeners.has("game:logAck")) throw new Error("Missing game:logAck listener");
    if (!ipcHandlers.has("utils:openSourcePage")) throw new Error("Missing utils:openSourcePage handle");
    if (!ipcHandlers.has("utils:openKnownLocation")) throw new Error("Missing utils:openKnownLocation handle");
  });

  // 2. Production utils:openPath handler rejects unapproved arbitrary local paths
  await runTest("utils:openPath rejects arbitrary local paths and never calls shell.openPath", async () => {
    openedPaths.length = 0;
    openedExternals.length = 0;
    const handler = ipcHandlers.get("utils:openPath")!;
    const testFile = path.join(testRoot, "dummy.txt");
    let threw = false;
    try {
      await handler({}, testFile);
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error("Expected utils:openPath to throw for unapproved local path");
    }
    if (openedPaths.length !== 0) {
      throw new Error(`Expected openedPaths to be empty, got: ${JSON.stringify(openedPaths)}`);
    }
    if (openedExternals.length !== 0) {
      throw new Error(`Expected openedExternals to be empty, got: ${JSON.stringify(openedExternals)}`);
    }
  });

  // 3. Production utils:openPath handler invokes shell.openExternal for HTTP(S) targets
  await runTest("utils:openPath calls shell.openExternal for HTTP(S) paths", async () => {
    openedPaths.length = 0;
    openedExternals.length = 0;
    const handler = ipcHandlers.get("utils:openPath")!;
    const testUrl = "https://dev.lampas.town/releases";
    await handler({}, testUrl);
    if (openedExternals.length !== 1 || openedExternals[0] !== testUrl) {
      throw new Error(`Expected openedExternals to contain [${testUrl}], got: ${JSON.stringify(openedExternals)}`);
    }
    if (openedPaths.length !== 0) {
      throw new Error(`Expected openedPaths to be empty, got: ${JSON.stringify(openedPaths)}`);
    }
  });

  // 4. Production config:set handler permits arbitrary runtime fields (Phase 2 finding)
  await runTest("config:set permits javaPath and javaArgs", async () => {
    const handler = ipcHandlers.get("config:set")!;
    const patch = {
      javaPath: "C:\\untrusted\\custom-java.exe",
      javaArgs: "-javaagent:C:\\untrusted\\agent.jar",
    };
    const dto = await handler({}, patch);
    if (dto.javaPath !== patch.javaPath || dto.javaArgs !== patch.javaArgs) {
      throw new Error(`DTO did not retain patch: ${JSON.stringify(dto)}`);
    }
    const current = ConfigManager.get();
    if ((current as any).javaPath !== patch.javaPath || current.javaArgs !== patch.javaArgs) {
      throw new Error(`ConfigManager did not persist patch: ${JSON.stringify(current)}`);
    }
  });

  // 5. utils:openSourcePage validates URL and calls shell.openExternal, rejecting dangerous schemes
  await runTest("utils:openSourcePage opens valid web URLs and rejects file/dangerous protocols", async () => {
    openedExternals.length = 0;
    openedPaths.length = 0;
    const handler = ipcHandlers.get("utils:openSourcePage")!;
    const testUrl = "https://lampas.town/about";
    await handler({}, testUrl);
    if (openedExternals.length !== 1 || openedExternals[0] !== testUrl) {
      throw new Error(`Expected openedExternals to have [${testUrl}], got: ${JSON.stringify(openedExternals)}`);
    }
    let threw = false;
    try {
      await handler({}, "file:///C:/Windows/System32/calc.exe");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected utils:openSourcePage to reject file: protocol");
    if (openedPaths.length !== 0) throw new Error("Expected openedPaths to remain empty");
  });

  // 6. utils:openKnownLocation opens approved paths and rejects arbitrary targets
  await runTest("utils:openKnownLocation opens approved locations and rejects arbitrary targets", async () => {
    openedExternals.length = 0;
    openedPaths.length = 0;
    const handler = ipcHandlers.get("utils:openKnownLocation")!;
    await handler({}, "gameDir");
    if (openedPaths.length !== 1) throw new Error(`Expected openedPaths to have 1 entry, got: ${JSON.stringify(openedPaths)}`);
    let threw = false;
    try {
      await handler({}, "arbitraryExploit");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected utils:openKnownLocation to reject unknown key");
  });

  // Setup loopback fixtures: Origin A (legitimate portal) and Attacker Portal (Origin B)
  interface CapturedRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }

  let capturedRequests: CapturedRequest[] = [];
  let capturedRequestsA: CapturedRequest[] = [];
  let delayNextServerAResponse = 0;
  let serverARespondWith401 = false;
  let serverARedirectMetadataToB = 0;
  let serverARedirectBlobUrl = "";
  let attackerBlobContent: { path: string; content: Buffer } | null = null;

  server = http.createServer((req, res) => {
    let bodyChunks: Buffer[] = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", () => {
      capturedRequests.push({
        method: req.method || "",
        url: req.url || "",
        headers: req.headers,
        body: Buffer.concat(bodyChunks).toString("utf-8"),
      });

      if (attackerBlobContent && req.url === attackerBlobContent.path) {
        res.writeHead(200, {
          "Content-Type": "application/java-archive",
          "Content-Length": attackerBlobContent.content.length.toString(),
        });
        res.end(attackerBlobContent.content);
        return;
      }

      if (req.url?.startsWith("/api/v1/channels/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ channel: "stable", version: "2.0.0" }));
        return;
      }

      if (req.url?.startsWith("/api/v1/releases/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          pack: "Lampas 2",
          version: "2.0.0",
          protocol: 3,
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          files: [],
          mods: [],
        }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: true, user: { id: "u-attacker", name: "Attacker", minecraftUsername: "Attacker", minecraftUuid: "00000000-0000-0000-0000-000000000000" } }));
    });
  });

  serverA = http.createServer((req, res) => {
    let bodyChunks: Buffer[] = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", async () => {
      capturedRequestsA.push({
        method: req.method || "",
        url: req.url || "",
        headers: req.headers,
        body: Buffer.concat(bodyChunks).toString("utf-8"),
      });

      if (delayNextServerAResponse > 0) {
        const d = delayNextServerAResponse;
        delayNextServerAResponse = 0;
        await new Promise((r) => setTimeout(r, d));
      }

      if (serverARespondWith401) {
        serverARespondWith401 = false;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (serverARedirectMetadataToB > 0 && (req.url?.startsWith("/api/v1/channels") || req.url?.startsWith("/api/v1/releases"))) {
        const code = serverARedirectMetadataToB;
        res.writeHead(code, { Location: `${attackerPortal}${req.url}` });
        res.end();
        return;
      }

      if (serverARedirectBlobUrl && req.url?.startsWith("/api/v1/blobs/test-blob-redirect")) {
        res.writeHead(302, { Location: serverARedirectBlobUrl });
        res.end();
        return;
      }

      if (req.url?.startsWith("/api/v1/channels/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ channel: "stable", version: "2.0.0" }));
        return;
      }

      if (req.url?.startsWith("/api/v1/releases/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          pack: "Lampas 2",
          version: "2.0.0",
          protocol: 3,
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          files: [],
          mods: [],
        }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        valid: true,
        token: "syn-new-token",
        refreshToken: "syn-new-refresh",
        user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" },
      }));
    });
  });

  await Promise.all([
    new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve())),
    new Promise<void>((resolve) => serverA!.listen(0, "127.0.0.1", () => resolve())),
  ]);

  const serverPort = (server.address() as any).port;
  const attackerPortal = `http://127.0.0.1:${serverPort}`;
  const portA = (serverA.address() as any).port;
  const originAPortal = `http://127.0.0.1:${portA}`;

  allowedDestinations.add(attackerPortal);
  allowedDestinations.add(originAPortal);

  // Set synthetic credentials bound to originAPortal
  ConfigManager.establishSession(originAPortal, {
    token: "syn-test-bearer-token-12345",
    refreshToken: "syn-test-refresh-token-67890",
    minecraftAccessToken: "syn-test-mc-token-abcdef",
  });

  // 7. [Service-Level] LauncherAuth.verifySession ignores caller portalUrl and protects bound session
  await runTest("[Service-Level] LauncherAuth.verifySession ignores caller portalUrl and protects bound session", async () => {
    capturedRequests = [];
    capturedRequestsA = [];
    const result = await LauncherAuth.verifySession(attackerPortal);
    if (!result.valid) throw new Error("Expected valid session from originA");
    if (capturedRequests.length !== 0) {
      throw new Error(`Credential leaked to attackerPortal! Captured: ${JSON.stringify(capturedRequests)}`);
    }
    if (capturedRequestsA.length !== 1) {
      throw new Error(`Expected 1 request to originA, got ${capturedRequestsA.length}`);
    }
    const req = capturedRequestsA[0];
    if (req.method !== "POST" || req.url !== "/api/v1/auth/verify") {
      throw new Error(`Unexpected request to originA: ${req.method} ${req.url}`);
    }
    if (req.headers["authorization"] !== "Bearer syn-test-bearer-token-12345") {
      throw new Error(`Unexpected authorization header: ${req.headers["authorization"]}`);
    }
  });

  // 8. [Service-Level] LauncherAuth.refreshSession ignores caller portalUrl and protects bound session
  await runTest("[Service-Level] LauncherAuth.refreshSession ignores caller portalUrl and protects bound session", async () => {
    capturedRequests = [];
    capturedRequestsA = [];
    const result = await LauncherAuth.refreshSession(attackerPortal);
    if (!result.valid) throw new Error("Expected valid session from originA");
    if (capturedRequests.length !== 0) {
      throw new Error(`Credential leaked to attackerPortal! Captured: ${JSON.stringify(capturedRequests)}`);
    }
    if (capturedRequestsA.length !== 1) {
      throw new Error(`Expected 1 request to originA, got ${capturedRequestsA.length}`);
    }
    const req = capturedRequestsA[0];
    if (req.method !== "POST" || req.url !== "/api/v1/auth/refresh") {
      throw new Error(`Unexpected request to originA: ${req.method} ${req.url}`);
    }
    if (req.headers["authorization"] !== "Bearer syn-test-bearer-token-12345") {
      throw new Error(`Unexpected authorization header: ${req.headers["authorization"]}`);
    }
  });

  // 9. [IPC-Level] auth:verify production handler credential routing
  await runTest("[IPC-Level] auth:verify ignores caller-supplied portalUrl and routes to bound portal", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
    });
    capturedRequests = [];
    capturedRequestsA = [];
    const handler = ipcHandlers.get("auth:verify")!;
    const res = await handler({}, attackerPortal);
    if (!res.valid) throw new Error("Expected valid session response from originA");
    if (capturedRequests.length !== 0) {
      throw new Error(`Credential leaked to attackerPortal via IPC! Captured: ${JSON.stringify(capturedRequests)}`);
    }
    if (capturedRequestsA.length !== 1) {
      throw new Error(`Expected 1 request to originA, got ${capturedRequestsA.length}`);
    }
  });

  // 10. [IPC-Level] auth:refresh production handler credential routing
  await runTest("[IPC-Level] auth:refresh ignores caller-supplied portalUrl and routes to bound portal", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
    });
    capturedRequests = [];
    capturedRequestsA = [];
    const handler = ipcHandlers.get("auth:refresh")!;
    const res = await handler({}, attackerPortal);
    if (!res.valid) throw new Error("Expected valid session response from originA");
    if (capturedRequests.length !== 0) {
      throw new Error(`Credential leaked to attackerPortal via IPC! Captured: ${JSON.stringify(capturedRequests)}`);
    }
    if (capturedRequestsA.length !== 1) {
      throw new Error(`Expected 1 request to originA, got ${capturedRequestsA.length}`);
    }
  });

  // 11. [Service-Level] LauncherAuth rejects 3xx redirects
  await runTest("[Service-Level] LauncherAuth.verifySession & refreshSession reject 3xx redirects", async () => {
    let redirectServer: http.Server | null = null;
    try {
      redirectServer = http.createServer((_req, res) => {
        res.writeHead(302, { Location: "http://attacker.invalid/hijack" });
        res.end();
      });
      await new Promise<void>((resolve) => redirectServer!.listen(0, "127.0.0.1", () => resolve()));
      const redirectPort = (redirectServer.address() as any).port;
      const redirectPortal = `http://127.0.0.1:${redirectPort}`;
      allowedDestinations.add(redirectPortal);

      ConfigManager.establishSession(redirectPortal, {
        token: "syn-test-token-redirect",
        refreshToken: "syn-test-refresh-redirect",
      });

      const verifyRes = await LauncherAuth.verifySession();
      if (verifyRes.valid !== false) {
        throw new Error("Expected verifySession to reject 302 redirect");
      }

      const refreshRes = await LauncherAuth.refreshSession();
      if (refreshRes.valid !== false) {
        throw new Error("Expected refreshSession to reject 302 redirect");
      }
    } finally {
      if (redirectServer) {
        await new Promise<void>((resolve) => redirectServer!.close(() => resolve()));
      }
    }
  });

  // 12. [Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B
  await runTest("[Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B", async () => {
    // 1. Establish valid session for Origin A
    ConfigManager.establishSession(originAPortal, {
      token: "secret-token-origin-a-9999",
      refreshToken: "secret-refresh-origin-a-9999",
    });

    // 2. Renderer attempts to forge session binding to attackerPortal (Origin B) via IPC config:set
    const handler = ipcHandlers.get("config:set")!;
    await handler({}, {
      portalUrl: attackerPortal,
      sessionPortalUrl: attackerPortal,
    });

    // Verify sessionPortalUrl was stripped from renderer input and credentials were wiped on origin change
    const afterSet = ConfigManager.get();
    if (afterSet.sessionPortalUrl === attackerPortal) {
      throw new Error("sessionPortalUrl was forged via config:set!");
    }
    if (afterSet.token !== undefined) {
      throw new Error("token was not wiped when changing portalUrl to attackerPortal!");
    }

    // 3. Clear captured requests on Origin B
    capturedRequests = [];
    capturedRequestsA = [];

    // 4. Invoke verify
    const verifyRes = await LauncherAuth.verifySession(attackerPortal);
    if (verifyRes.valid !== false) {
      throw new Error("Expected verifySession to reject unauthenticated session");
    }

    // 5. Invoke refresh
    const refreshRes = await LauncherAuth.refreshSession(attackerPortal);
    if (refreshRes.valid !== false) {
      throw new Error("Expected refreshSession to reject unauthenticated session");
    }

    // 6. Invoke status
    let statusThrew = false;
    try {
      await ServerStatusClient.getStatus();
    } catch (err: any) {
      statusThrew = true;
      if (!err.message.includes("Portal session is not available")) {
        throw new Error(`Expected 'Portal session is not available', got: ${err.message}`);
      }
    }
    if (!statusThrew) {
      throw new Error("Expected ServerStatusClient.getStatus to fail when session is invalid");
    }

    // 7. Invoke sync
    let syncThrew = false;
    try {
      await LauncherSync.syncClient(() => {});
    } catch (err: any) {
      syncThrew = true;
      if (!err.message.includes("Authentication required")) {
        throw new Error(`Expected authentication required error, got: ${err.message}`);
      }
    }
    if (!syncThrew) {
      throw new Error("Expected syncClient to fail due to lack of authentication");
    }

    // 8. Assert ZERO Origin A credentials reached Origin B (attackerPortal)
    for (const r of capturedRequests) {
      const authHeader = (r.headers["authorization"] || "") as string;
      if (authHeader.includes("secret-token-origin-a-9999") || authHeader.includes("secret-refresh-origin-a-9999")) {
        throw new Error(`Origin A credential leaked to Origin B in request: ${r.method} ${r.url}`);
      }
      if (r.body.includes("secret-token-origin-a-9999") || r.body.includes("secret-refresh-origin-a-9999")) {
        throw new Error(`Origin A credential leaked to Origin B in body: ${r.method} ${r.url}`);
      }
    }
  });

  // 13. [Regression Gate 1] Race safety: portal A -> B switch during in-flight verify ignores late A completion
  await runTest("[Regression Gate 1] Race safety: portal A -> B switch during in-flight verify ignores late A completion", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "a-token-for-race",
      refreshToken: "a-refresh-for-race",
    });

    delayNextServerAResponse = 50;
    const inFlightVerify = LauncherAuth.verifySession();

    await new Promise((r) => setTimeout(r, 5));

    ConfigManager.establishSession(attackerPortal, {
      token: "b-token-active",
      refreshToken: "b-refresh-active",
    });

    const lateVerifyResult = await inFlightVerify;
    if (lateVerifyResult.valid !== false) {
      throw new Error("Expected late verify from old portal to be rejected");
    }

    const current = ConfigManager.get();
    if (current.portalUrl !== attackerPortal) {
      throw new Error(`portalUrl corrupted: expected ${attackerPortal}, got ${current.portalUrl}`);
    }
    if (current.sessionPortalUrl !== attackerPortal) {
      throw new Error(`sessionPortalUrl corrupted: expected ${attackerPortal}, got ${current.sessionPortalUrl}`);
    }
    if (current.token !== "b-token-active") {
      throw new Error(`token overwritten by old session: got ${current.token}`);
    }
  });

  // 14. [Regression Gate 1] Race safety: rapid portal A -> B -> A switching rejects stale response
  await runTest("[Regression Gate 1] Race safety: rapid portal A -> B -> A switching rejects stale response", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "gen1-token-a",
      refreshToken: "gen1-refresh-a",
    });

    delayNextServerAResponse = 50;
    const inFlightVerify = LauncherAuth.verifySession();

    await new Promise((r) => setTimeout(r, 5));

    ConfigManager.establishSession(attackerPortal, {
      token: "gen2-token-b",
      refreshToken: "gen2-refresh-b",
    });

    ConfigManager.establishSession(originAPortal, {
      token: "gen3-token-a-new",
      refreshToken: "gen3-refresh-a-new",
    });

    await inFlightVerify;

    const current = ConfigManager.get();
    if (current.token !== "gen3-token-a-new") {
      throw new Error(`Stale generation 1 response overwrote generation 3 token! Current: ${current.token}`);
    }
  });

  // 15. [Regression Gate 1] Race safety: logout during in-flight exchange discards late tokens
  await runTest("[Regression Gate 1] Race safety: logout during in-flight exchange discards late tokens", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "logout-test-token",
      refreshToken: "logout-test-refresh",
    });

    delayNextServerAResponse = 50;
    const inFlightRefresh = LauncherAuth.refreshSession();

    await new Promise((r) => setTimeout(r, 5));

    LauncherAuth.logout();

    const refreshRes = await inFlightRefresh;
    if (refreshRes.valid !== false) {
      throw new Error("Expected in-flight refresh to be marked invalid after logout");
    }

    const current = ConfigManager.get();
    if (current.token !== undefined) {
      throw new Error(`Late refresh resurrected token after logout: ${current.token}`);
    }
    if (current.sessionPortalUrl !== undefined) {
      throw new Error(`Late refresh resurrected sessionPortalUrl after logout: ${current.sessionPortalUrl}`);
    }
  });

  // 16. [Regression Gate 1] Race safety: old 401 failure arriving after new session establishment does not clear new credentials
  await runTest("[Regression Gate 1] Race safety: old 401 failure arriving after new session establishment does not clear new credentials", async () => {
    serverARespondWith401 = true;
    delayNextServerAResponse = 50;

    ConfigManager.establishSession(originAPortal, {
      token: "old-session-token",
      refreshToken: "old-session-refresh",
    });

    const inFlightVerify = LauncherAuth.verifySession();

    await new Promise((r) => setTimeout(r, 5));

    ConfigManager.establishSession(attackerPortal, {
      token: "new-session-b-token",
      refreshToken: "new-session-b-refresh",
    });

    await inFlightVerify;

    const current = ConfigManager.get();
    if (current.token !== "new-session-b-token") {
      throw new Error(`Old 401 cleared new session credentials! Token is: ${current.token}`);
    }
    if (current.sessionPortalUrl !== attackerPortal) {
      throw new Error(`Old 401 cleared new session portal! sessionPortalUrl is: ${current.sessionPortalUrl}`);
    }
  });

  // 17. [Regression Gate 1] Sync metadata 302/307/308 redirects from A to B are rejected with 0 requests to B and no cache fallback
  await runTest("[Regression Gate 1] Sync metadata 302/307/308 redirects from A to B are rejected with 0 requests to B and no cache fallback", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "syn-metadata-secret-token",
      refreshToken: "syn-metadata-secret-refresh",
    });

    // 302 redirect
    serverARedirectMetadataToB = 302;
    capturedRequests = [];
    capturedRequestsA = [];

    let threw = false;
    try {
      await LauncherSync.syncClient(() => {});
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error("Expected syncClient to fail when metadata endpoint returns 302 redirect");
    }
    const reqA = capturedRequestsA.find((r) => r.url === "/api/v1/channels/stable");
    if (!reqA) {
      throw new Error("Origin A was not called with the metadata request before rejection!");
    }
    if (capturedRequests.length !== 0) {
      throw new Error(`Requests unexpectedly reached Destination B during metadata 302! Captured: ${JSON.stringify(capturedRequests)}`);
    }

    // 307 redirect
    serverARedirectMetadataToB = 307;
    capturedRequests = [];
    capturedRequestsA = [];
    threw = false;
    try {
      await LauncherSync.syncClient(() => {});
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected syncClient to reject 307 redirect");
    if (capturedRequests.length !== 0) {
      throw new Error(`Requests reached Destination B during metadata 307! Captured: ${JSON.stringify(capturedRequests)}`);
    }

    // 308 redirect
    serverARedirectMetadataToB = 308;
    capturedRequests = [];
    capturedRequestsA = [];
    threw = false;
    try {
      await LauncherSync.syncClient(() => {});
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected syncClient to reject 308 redirect");
    if (capturedRequests.length !== 0) {
      throw new Error(`Requests reached Destination B during metadata 308! Captured: ${JSON.stringify(capturedRequests)}`);
    }

    serverARedirectMetadataToB = 0;
  });

  // 18. [Regression Gate 1] Legitimate file download follows safe redirect without auth headers
  await runTest("[Regression Gate 1] Legitimate file download follows safe redirect without auth headers", async () => {
    const testContent = Buffer.from("legitimate file content from storage CDN");
    const testHash = crypto.createHash("sha256").update(testContent).digest("hex");

    serverARedirectBlobUrl = `${attackerPortal}/cdn-storage/test-blob.jar`;
    attackerBlobContent = { path: "/cdn-storage/test-blob.jar", content: testContent };

    capturedRequests = [];
    capturedRequestsA = [];

    const destPath = path.join(gameDir, "mods", "redirected-mod.jar");
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await downloadVerified(
      `${originAPortal}/api/v1/blobs/test-blob-redirect`,
      destPath,
      {
        expectedHash: testHash,
        algorithm: "sha256",
        attempts: 3,
      }
    );

    const downloadedContent = fs.readFileSync(destPath);
    if (!downloadedContent.equals(testContent)) {
      throw new Error("Downloaded content does not match expected content");
    }

    const cdnReq = capturedRequests.find((r) => r.url === "/cdn-storage/test-blob.jar");
    if (!cdnReq) {
      throw new Error("Destination B (CDN) did not receive the redirected download request");
    }
    if (cdnReq.headers["authorization"] !== undefined) {
      throw new Error(`Redirected blob download leaked Authorization header: ${cdnReq.headers["authorization"]}`);
    }

    serverARedirectBlobUrl = "";
    attackerBlobContent = null;
  });

  // 19. [Regression Gate 1] ConfigManager.get performs durable disk scrubbing of unbound tokens on disk
  await runTest("[Regression Gate 1] ConfigManager.get performs durable disk scrubbing of unbound tokens on disk", async () => {
    const configFilePath = path.join(userDataDir, "config.json");
    fs.writeFileSync(configFilePath, JSON.stringify({
      portalUrl: originAPortal,
      token: "unbound-token-on-disk-to-scrub",
      refreshToken: "unbound-refresh-on-disk-to-scrub",
      minecraftAccessToken: "unbound-mc-on-disk-to-scrub",
    }), "utf-8");

    ConfigManager.resetForTesting();
    const loaded = ConfigManager.get();
    if (loaded.token !== undefined || loaded.refreshToken !== undefined || loaded.minecraftAccessToken !== undefined) {
      throw new Error("ConfigManager.get() did not clear in-memory unbound tokens");
    }

    const onDisk = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
    if (onDisk.token !== undefined || onDisk.refreshToken !== undefined || onDisk.minecraftAccessToken !== undefined) {
      throw new Error(`Durable disk scrubbing failed: disk still has secrets: ${JSON.stringify(onDisk)}`);
    }
  });

  // 20. [Regression Gate 1] Narrow opener helpers validate paths against approved roots and reject escape attempts
  await runTest("[Regression Gate 1] Narrow opener helpers validate paths against approved roots and reject escape attempts", async () => {
    openedPaths.length = 0;
    openedExternals.length = 0;

    const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
    await knownHandler({}, "logsDir");
    if (openedPaths.length !== 1 || !openedPaths[0].includes("logs")) {
      throw new Error(`Expected logsDir opened, got: ${JSON.stringify(openedPaths)}`);
    }

    let threw = false;
    try {
      await knownHandler({}, "../../../windows/system32");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected utils:openKnownLocation to reject traversal key");

    openedPaths.length = 0;
    const logsDirHandler = ipcHandlers.get("utils:openLogsDir")!;
    await logsDirHandler({});
    if (openedPaths.length !== 1) throw new Error("Expected openLogsDir to open logs directory");

    openedPaths.length = 0;
    openedExternals.length = 0;
    const pathHandler = ipcHandlers.get("utils:openPath")!;
    threw = false;
    try {
      await pathHandler({}, "javascript:alert(1)");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected utils:openPath to reject javascript: URL");
    if (openedPaths.length !== 0 || openedExternals.length !== 0) {
      throw new Error("Rejected URL triggered an opener call!");
    }

    threw = false;
    try {
      await pathHandler({}, "C:\\Windows\\System32\\cmd.exe");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected utils:openPath to reject arbitrary system path");
    if (openedPaths.length !== 0) throw new Error("Rejected path was opened via shell.openPath!");
  });

  // Assert outbound request policy compliance: zero unapproved network attempts
  if (attemptedViolations.length > 0) {
    throw new Error(`[OutboundPolicyViolation] Forbidden outbound request attempts detected: ${JSON.stringify(attemptedViolations)}`);
  }
} catch (fatalError: any) {
  console.error("[Fatal Boundary Harness Error]", fatalError);
  results.tests.push({
    name: "Fatal Harness Setup / Execution",
    passed: false,
    error: fatalError?.message || String(fatalError),
  });
} finally {
  // Guaranteed teardown of owned resources
  if (server) {
    try {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    } catch {}
  }
  if (serverA) {
    try {
      (serverA as any).closeAllConnections?.();
      await new Promise<void>((resolve) => serverA!.close(() => resolve()));
    } catch {}
  }
  if (LauncherLogger) {
    try {
      await LauncherLogger.close();
    } catch {}
  }
  for (const win of MockBrowserWindow.allWindows) {
    try {
      win.destroy();
    } catch {}
  }
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  }
  // Restore original fetch
  globalThis.fetch = originalFetch;
}

// Output JSON summary for machine parsing
console.log("__BOUNDARY_RESULTS__:" + JSON.stringify(results));

const failed = results.tests.filter((t) => !t.passed);
if (failed.length > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
