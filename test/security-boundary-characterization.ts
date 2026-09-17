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

class RequestBarrier {
  private requestReceivedResolve!: () => void;
  private releaseResolve!: () => void;
  public requestReceived: Promise<void>;
  public releasePromise: Promise<void>;

  constructor() {
    this.requestReceived = new Promise<void>((r) => {
      this.requestReceivedResolve = r;
    });
    this.releasePromise = new Promise<void>((r) => {
      this.releaseResolve = r;
    });
  }

  notifyRequestReceived(): void {
    this.requestReceivedResolve();
  }

  waitToRelease(): Promise<void> {
    return this.releasePromise;
  }

  release(): void {
    this.releaseResolve();
  }
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
  const PortalPolicy = configMod.PortalPolicy;
  const normalizePortalUrl = configMod.normalizePortalUrl;

  // Supply explicit development policy for test harness
  PortalPolicy.configureDevelopmentPolicy({
    allowLoopback: true,
    allowedRemoteHosts: ["portal-a.lampas.test", "portal-b.lampas.test"],
  });

  // Import production main.ts to register IPC channels
  await import("../src/main");

  // Signal readiness and await deterministic registration of all 37 handles + 1 listener
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

  ConfigManager.set({ gameDir });

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

  // 6. utils:openKnownLocation opens approved locations and rejects arbitrary targets
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

  // Setup loopback fixtures: Origin A (legitimate portal) and Destination B (attacker portal)
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
  let serverAExchangeBarrier: RequestBarrier | null = null;
  let serverARefreshBarrier: RequestBarrier | null = null;
  let serverARedirectVerifyToB = 0;
  let serverARedirectRefreshToB = 0;
  let serverARedirectExchangeToB = 0;
  let serverARedirectStatusToB = 0;
  let serverARedirectChannelToB = 0;
  let serverARedirectReleaseToB = 0;
  let serverARedirectManifestToB = 0;
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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: false, error: "Unauthorized on B" }));
    });
  });

  serverA = http.createServer(async (req, res) => {
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

      // 1. Verify endpoint
      if (req.url === "/api/v1/auth/verify") {
        if (serverARedirectVerifyToB > 0) {
          const code = serverARedirectVerifyToB;
          res.writeHead(code, { Location: `${attackerPortal}/api/v1/auth/verify` });
          res.end();
          return;
        }
        if (serverARespondWith401) {
          serverARespondWith401 = false;
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          valid: true,
          user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" },
        }));
        return;
      }

      // 2. Refresh endpoint
      if (req.url === "/api/v1/auth/refresh") {
        if (serverARefreshBarrier) {
          const barrier = serverARefreshBarrier;
          barrier.notifyRequestReceived();
          await barrier.waitToRelease();
        }
        if (serverARedirectRefreshToB > 0) {
          const code = serverARedirectRefreshToB;
          res.writeHead(code, { Location: `${attackerPortal}/api/v1/auth/refresh` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          valid: true,
          token: "syn-refreshed-token-a",
          refreshToken: "syn-refreshed-refresh-a",
          user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" },
        }));
        return;
      }

      // 3. Token exchange endpoint
      if (req.url === "/api/v1/auth/exchange") {
        if (serverAExchangeBarrier) {
          const barrier = serverAExchangeBarrier;
          barrier.notifyRequestReceived();
          await barrier.waitToRelease();
        }
        if (serverARedirectExchangeToB > 0) {
          const code = serverARedirectExchangeToB;
          res.writeHead(code, { Location: `${attackerPortal}/api/v1/auth/exchange` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          token: "syn-exchanged-token-a",
          refreshToken: "syn-exchanged-refresh-a",
          user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" },
        }));
        return;
      }

      // 4. Server status endpoint
      if (req.url === "/api/v1/server/status") {
        if (serverARedirectStatusToB > 0) {
          const code = serverARedirectStatusToB;
          res.writeHead(code, { Location: `${attackerPortal}/api/v1/server/status` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ online: true, players: { online: 5, max: 20 } }));
        return;
      }

      // 5. Channel endpoint
      if (req.url?.startsWith("/api/v1/channels/")) {
        if (serverARedirectChannelToB > 0) {
          const code = serverARedirectChannelToB;
          res.writeHead(code, { Location: `${attackerPortal}${req.url}` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ channel: "stable", releaseId: "rel-1", version: "2.0.0" }));
        return;
      }

      // 6. Manifest endpoint: /api/v1/releases/<version>/client-manifest
      if (req.url?.includes("/client-manifest")) {
        if (serverARedirectManifestToB > 0) {
          const code = serverARedirectManifestToB;
          res.writeHead(code, { Location: `${attackerPortal}${req.url}` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          version: "2.0.0",
          protocol: 3,
          files: [],
          mods: [],
        }));
        return;
      }

      // 7. Release endpoint: /api/v1/releases/
      if (req.url?.startsWith("/api/v1/releases/")) {
        if (serverARedirectReleaseToB > 0) {
          const code = serverARedirectReleaseToB;
          res.writeHead(code, { Location: `${attackerPortal}${req.url}` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          pack: "Lampas 2",
          version: "2.0.0",
          protocol: 3,
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          manifestId: "man-1",
          files: [],
          mods: [],
        }));
        return;
      }

      // 8. Blob redirect
      if (serverARedirectBlobUrl && req.url?.startsWith("/api/v1/blobs/test-blob-redirect")) {
        res.writeHead(302, { Location: serverARedirectBlobUrl });
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

  async function triggerOAuthCallback(code: string = "test-auth-code"): Promise<Response> {
    const deadline = Date.now() + 3000;
    while (openedExternals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (openedExternals.length === 0) {
      throw new Error("openExternal was not called during OAuth initiation");
    }
    const lastUrl = openedExternals[openedExternals.length - 1];
    const parsed = new URL(lastUrl);
    const callbackPort = parsed.searchParams.get("port");
    const state = parsed.searchParams.get("state");
    if (!callbackPort || !state) {
      throw new Error(`Invalid OAuth authUrl opened: ${lastUrl}`);
    }
    const cbOrigin = `http://127.0.0.1:${callbackPort}`;
    allowedDestinations.add(cbOrigin);
    return fetch(`${cbOrigin}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  }

  // 7. [Service-Level] LauncherAuth.verifySession ignores caller portalUrl and protects bound session
  await runTest("[Service-Level] LauncherAuth.verifySession ignores caller portalUrl and protects bound session", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
      minecraftAccessToken: "syn-test-mc-token-abcdef",
    });
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
    ConfigManager.establishSession(originAPortal, {
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
      minecraftAccessToken: "syn-test-mc-token-abcdef",
    });
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

  // 11. [Policy] Packaged production rejects loopback destinations and ignores env trust expansion
  await runTest("[Policy] Packaged production rejects loopback destinations and ignores env trust expansion", () => {
    try {
      PortalPolicy.setProductionOverride(true);
      process.env.LAMPAS_ALLOWED_PORTAL_HOSTS = "attacker.invalid,custom-portal.test";
      process.env.NODE_ENV = "development";

      let threw = false;
      try {
        normalizePortalUrl("http://localhost:3000");
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("Expected loopback to be rejected in packaged production");

      threw = false;
      try {
        normalizePortalUrl("https://attacker.invalid");
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("Expected unapproved remote host to be rejected in packaged production");

      threw = false;
      try {
        normalizePortalUrl("https://custom-portal.test");
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("Expected env-expanded host to be rejected in packaged production");

      const lampasUrl = normalizePortalUrl("https://dev.lampas.town");
      if (lampasUrl !== "https://dev.lampas.town") {
        throw new Error(`Expected dev.lampas.town to be allowed in production, got: ${lampasUrl}`);
      }
    } finally {
      PortalPolicy.setProductionOverride(null);
      delete process.env.LAMPAS_ALLOWED_PORTAL_HOSTS;
      process.env.NODE_ENV = "test";
      PortalPolicy.configureDevelopmentPolicy({
        allowLoopback: true,
        allowedRemoteHosts: ["portal-a.lampas.test", "portal-b.lampas.test"],
      });
    }
  });

  // 12. [Opener] resolveAndValidateKnownLocation rejects escaping symlinks and ancestor escapes to outside sentinels
  await runTest("[Opener] resolveAndValidateKnownLocation rejects escaping symlinks and ancestor escapes to outside sentinels", async () => {
    openedPaths.length = 0;
    openedExternals.length = 0;
    ConfigManager.set({ gameDir });

    const outsideSentinelDir = path.join(testRoot, "outside-sentinel-dir");
    const outsideSentinelFile = path.join(testRoot, "outside-sentinel-file.txt");
    if (!fs.existsSync(outsideSentinelDir)) fs.mkdirSync(outsideSentinelDir, { recursive: true });
    fs.writeFileSync(outsideSentinelFile, "sentinel-payload");

    // 1. Escaping symlink: <gameDir>/mods is a symlink pointing to outsideSentinelDir
    const modsPath = path.join(gameDir, "mods");
    if (fs.existsSync(modsPath)) fs.rmSync(modsPath, { recursive: true, force: true });
    try {
      fs.symlinkSync(outsideSentinelDir, modsPath, process.platform === "win32" ? "junction" : "dir");
    } catch {}

    if (fs.existsSync(modsPath)) {
      const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
      let threw = false;
      try {
        await knownHandler({}, "modsDir");
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("Expected utils:openKnownLocation to reject escaping modsDir symlink");
      if (openedPaths.length !== 0) throw new Error("Escaping symlink triggered shell.openPath!");

      const pathHandler = ipcHandlers.get("utils:openPath")!;
      threw = false;
      try {
        await pathHandler({}, "modsDir");
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("Expected utils:openPath to reject escaping modsDir symlink");
      if (openedPaths.length !== 0) throw new Error("Escaping symlink triggered shell.openPath via openPath!");

      fs.rmSync(modsPath, { recursive: true, force: true });
    }

    // 2. Escaping ancestor: <gameDir>/logs is a symlink to outsideSentinelDir containing latest.log
    const logsPath = path.join(gameDir, "logs");
    if (fs.existsSync(logsPath)) fs.rmSync(logsPath, { recursive: true, force: true });
    const outsideLatestLog = path.join(outsideSentinelDir, "latest.log");
    fs.writeFileSync(outsideLatestLog, "minecraft log data");
    try {
      fs.symlinkSync(outsideSentinelDir, logsPath, process.platform === "win32" ? "junction" : "dir");
    } catch {}

    if (fs.existsSync(logsPath)) {
      const mcLogHandler = ipcHandlers.get("utils:openMinecraftLog")!;
      let threw = false;
      try {
        await mcLogHandler({});
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("Expected utils:openMinecraftLog to reject escaping logs ancestor symlink");
      if (openedPaths.length !== 0) throw new Error("Escaping ancestor triggered shell.openPath!");

      fs.rmSync(logsPath, { recursive: true, force: true });
    }

    // 3. Failed web link does NOT fall back to local opening
    const pathHandler = ipcHandlers.get("utils:openPath")!;
    let threw = false;
    try {
      await pathHandler({}, "javascript:alert(1)");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected utils:openPath to reject javascript: URL");
    if (openedPaths.length !== 0 || openedExternals.length !== 0) {
      throw new Error("Rejected web link triggered shell opener!");
    }

    // 4. Direct outside sentinel path rejected
    threw = false;
    try {
      await pathHandler({}, outsideSentinelFile);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("Expected utils:openPath to reject direct outside sentinel path");
    if (openedPaths.length !== 0) throw new Error("Outside sentinel triggered shell.openPath!");

    // 5. Legitimate known locations succeed
    fs.mkdirSync(path.join(gameDir, "mods"), { recursive: true });
    const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
    await knownHandler({}, "modsDir");
    if ((openedPaths.length as number) !== 1) throw new Error("Expected legitimate modsDir to open");
    const opened = openedPaths[0];
    if (opened !== fs.realpathSync(path.join(gameDir, "mods"))) {
      throw new Error(`Expected canonical modsDir opened, got: ${opened}`);
    }
    openedPaths.length = 0;
  });

  // 13. [Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B
  await runTest("[Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "secret-token-origin-a-9999",
      refreshToken: "secret-refresh-origin-a-9999",
    });

    const handler = ipcHandlers.get("config:set")!;
    await handler({}, {
      portalUrl: attackerPortal,
      sessionPortalUrl: attackerPortal,
    });

    const afterSet = ConfigManager.get();
    if (afterSet.sessionPortalUrl === attackerPortal) {
      throw new Error("sessionPortalUrl was forged via config:set!");
    }
    if (afterSet.token !== undefined) {
      throw new Error("token was not wiped when changing portalUrl to attackerPortal!");
    }

    capturedRequests = [];
    capturedRequestsA = [];

    const verifyRes = await LauncherAuth.verifySession(attackerPortal);
    if (verifyRes.valid !== false) {
      throw new Error("Expected verifySession to reject unauthenticated session");
    }

    const refreshRes = await LauncherAuth.refreshSession(attackerPortal);
    if (refreshRes.valid !== false) {
      throw new Error("Expected refreshSession to reject unauthenticated session");
    }

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

  // 14. [Regression Gate 1] Real OAuth login flow successfully completes code exchange and establishes session
  await runTest("[Regression Gate 1] Real OAuth login flow successfully completes code exchange and establishes session", async () => {
    ConfigManager.resetForTesting();
    ConfigManager.set({ portalUrl: originAPortal });
    openedExternals.length = 0;

    const loginPromise = LauncherAuth.loginWithPortal();
    const cbRes = await triggerOAuthCallback("auth-code-legitimate");
    if (!cbRes.ok) {
      throw new Error(`Expected callback to return 200, got: ${cbRes.status}`);
    }

    const loginResult = await loginPromise;
    if (!loginResult.token || loginResult.token !== "syn-exchanged-token-a") {
      throw new Error(`Unexpected token from login: ${loginResult.token}`);
    }

    const current = ConfigManager.get();
    if (current.token !== "syn-exchanged-token-a") {
      throw new Error(`Token not established: ${current.token}`);
    }
    if (current.sessionPortalUrl !== originAPortal) {
      throw new Error(`sessionPortalUrl not established: ${current.sessionPortalUrl}`);
    }
  });

  // 15. [Regression Gate 1] Origin-change invalidation: Case 1 - Fresh logged-out login at A, settings A->B->A before callback
  await runTest("[Regression Gate 1] Origin-change invalidation: Case 1 - Fresh logged-out login at A, settings A->B->A before callback", async () => {
    ConfigManager.resetForTesting();
    ConfigManager.set({ portalUrl: originAPortal });
    openedExternals.length = 0;

    const loginPromise = LauncherAuth.loginWithPortal();
    const deadline = Date.now() + 3000;
    while (openedExternals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const lastUrl = openedExternals[openedExternals.length - 1];
    const parsed = new URL(lastUrl);
    const callbackPort = parsed.searchParams.get("port")!;
    const state = parsed.searchParams.get("state")!;
    allowedDestinations.add(`http://127.0.0.1:${callbackPort}`);

    // Settings change A -> B -> A before callback
    ConfigManager.set({ portalUrl: attackerPortal });
    ConfigManager.set({ portalUrl: originAPortal });

    // Trigger callback
    const cbRes = await fetch(`http://127.0.0.1:${callbackPort}/callback?code=code-1&state=${state}`);
    if (cbRes.status !== 400) {
      throw new Error(`Expected callback to return 400, got: ${cbRes.status}`);
    }

    let loginThrew = false;
    try {
      await loginPromise;
    } catch {
      loginThrew = true;
    }
    if (!loginThrew) throw new Error("Expected login to fail when origin changed A->B->A before callback");

    const current = ConfigManager.get();
    if (current.token !== undefined) {
      throw new Error("Token was established despite invalidated login flow!");
    }
  });

  // 16. [Regression Gate 1] Origin-change invalidation: Case 2 - Fresh logged-out login at A, settings A->B->A during exchange
  await runTest("[Regression Gate 1] Origin-change invalidation: Case 2 - Fresh logged-out login at A, settings A->B->A during exchange", async () => {
    ConfigManager.resetForTesting();
    ConfigManager.set({ portalUrl: originAPortal });
    openedExternals.length = 0;

    const barrier = new RequestBarrier();
    serverAExchangeBarrier = barrier;

    const loginPromise = LauncherAuth.loginWithPortal();
    const deadline = Date.now() + 3000;
    while (openedExternals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const lastUrl = openedExternals[openedExternals.length - 1];
    const parsed = new URL(lastUrl);
    const callbackPort = parsed.searchParams.get("port")!;
    const state = parsed.searchParams.get("state")!;
    allowedDestinations.add(`http://127.0.0.1:${callbackPort}`);

    fetch(`http://127.0.0.1:${callbackPort}/callback?code=code-2&state=${state}`).catch(() => {});
    await barrier.requestReceived;

    // During exchange: settings change A -> B -> A
    ConfigManager.set({ portalUrl: attackerPortal });
    ConfigManager.set({ portalUrl: originAPortal });
    barrier.release();

    let loginThrew = false;
    try {
      await loginPromise;
    } catch {
      loginThrew = true;
    }
    if (!loginThrew) throw new Error("Expected login to fail when origin changed A->B->A during exchange");

    const current = ConfigManager.get();
    if (current.token !== undefined) {
      throw new Error("Token was established despite origin change during exchange!");
    }
    serverAExchangeBarrier = null;
  });

  // 17. [Regression Gate 1] Origin-change invalidation: Case 3 - Fresh logged-out login at A, settings A->B without returning to A
  await runTest("[Regression Gate 1] Origin-change invalidation: Case 3 - Fresh logged-out login at A, settings A->B without returning to A", async () => {
    ConfigManager.resetForTesting();
    ConfigManager.set({ portalUrl: originAPortal });
    openedExternals.length = 0;

    const barrier = new RequestBarrier();
    serverAExchangeBarrier = barrier;

    const loginPromise = LauncherAuth.loginWithPortal();
    const deadline = Date.now() + 3000;
    while (openedExternals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const lastUrl = openedExternals[openedExternals.length - 1];
    const parsed = new URL(lastUrl);
    const callbackPort = parsed.searchParams.get("port")!;
    const state = parsed.searchParams.get("state")!;
    allowedDestinations.add(`http://127.0.0.1:${callbackPort}`);

    fetch(`http://127.0.0.1:${callbackPort}/callback?code=code-3&state=${state}`).catch(() => {});
    await barrier.requestReceived;

    // Settings change A -> B
    ConfigManager.set({ portalUrl: attackerPortal });
    barrier.release();

    let loginThrew = false;
    try {
      await loginPromise;
    } catch {
      loginThrew = true;
    }
    if (!loginThrew) throw new Error("Expected login to fail when origin changed A->B");

    const current = ConfigManager.get();
    if (current.token !== undefined) {
      throw new Error("Token was established on origin B from origin A exchange!");
    }
    serverAExchangeBarrier = null;
  });

  // 18. [Regression Gate 1] Origin-change invalidation: Case 4 - Unchanged portal does not invalidate in-flight login
  await runTest("[Regression Gate 1] Origin-change invalidation: Case 4 - Unchanged portal does not invalidate in-flight login", async () => {
    ConfigManager.resetForTesting();
    ConfigManager.set({ portalUrl: originAPortal });
    openedExternals.length = 0;

    const barrier = new RequestBarrier();
    serverAExchangeBarrier = barrier;

    const loginPromise = LauncherAuth.loginWithPortal();
    const deadline = Date.now() + 3000;
    while (openedExternals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const lastUrl = openedExternals[openedExternals.length - 1];
    const parsed = new URL(lastUrl);
    const callbackPort = parsed.searchParams.get("port")!;
    const state = parsed.searchParams.get("state")!;
    allowedDestinations.add(`http://127.0.0.1:${callbackPort}`);

    fetch(`http://127.0.0.1:${callbackPort}/callback?code=code-4&state=${state}`).catch(() => {});
    await barrier.requestReceived;

    // Unchanged portalUrl and unrelated setting
    ConfigManager.set({ portalUrl: originAPortal, allocatedRamGb: 6 });
    barrier.release();

    const res = await loginPromise;
    if (!res.token) throw new Error("Expected login to succeed when portal was unchanged");

    const current = ConfigManager.get();
    if (current.token !== "syn-exchanged-token-a") {
      throw new Error(`Token not established: ${current.token}`);
    }
    if (current.allocatedRamGb !== 6) {
      throw new Error(`Setting not preserved: ${current.allocatedRamGb}`);
    }
    serverAExchangeBarrier = null;
  });

  // 19. [Regression Gate 1] Origin-change invalidation: Case 5 - In-flight exchange while credentials exist
  await runTest("[Regression Gate 1] Origin-change invalidation: Case 5 - In-flight exchange while credentials exist", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "existing-pre-exchange-token",
      refreshToken: "existing-pre-exchange-refresh",
    });
    openedExternals.length = 0;

    const barrier = new RequestBarrier();
    serverAExchangeBarrier = barrier;

    const loginPromise = LauncherAuth.loginWithPortal();
    const deadline = Date.now() + 3000;
    while (openedExternals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const lastUrl = openedExternals[openedExternals.length - 1];
    const parsed = new URL(lastUrl);
    const callbackPort = parsed.searchParams.get("port")!;
    const state = parsed.searchParams.get("state")!;
    allowedDestinations.add(`http://127.0.0.1:${callbackPort}`);

    fetch(`http://127.0.0.1:${callbackPort}/callback?code=code-5&state=${state}`).catch(() => {});
    await barrier.requestReceived;

    // Settings change A -> B wipes credentials and advances generation
    ConfigManager.set({ portalUrl: attackerPortal });
    barrier.release();

    let loginThrew = false;
    try {
      await loginPromise;
    } catch {
      loginThrew = true;
    }
    if (!loginThrew) throw new Error("Expected login to fail when origin changed during exchange");

    const current = ConfigManager.get();
    if (current.token !== undefined) {
      throw new Error(`Credentials resurrected: ${current.token}`);
    }
    serverAExchangeBarrier = null;
  });

  // 20. [Regression Gate 1] Origin-change invalidation: Case 6 - Refresh while origin changes
  await runTest("[Regression Gate 1] Origin-change invalidation: Case 6 - Refresh while origin changes", async () => {
    ConfigManager.establishSession(originAPortal, {
      token: "refresh-test-token-case6",
      refreshToken: "refresh-test-refresh-case6",
    });

    const barrier = new RequestBarrier();
    serverARefreshBarrier = barrier;

    const refreshPromise = LauncherAuth.refreshSession();
    await barrier.requestReceived;

    // Settings change A -> B -> A during in-flight refresh
    ConfigManager.set({ portalUrl: attackerPortal });
    ConfigManager.set({ portalUrl: originAPortal });
    barrier.release();

    const res = await refreshPromise;
    if (res.valid !== false) {
      throw new Error("Expected refresh to be marked invalid after origin changed");
    }

    const current = ConfigManager.get();
    if (current.token !== undefined) {
      throw new Error(`Token resurrected after origin change during refresh: ${current.token}`);
    }
    serverARefreshBarrier = null;
  });

  // 21. [Regression Gate 1] Race safety: portal A -> B switch during in-flight verify ignores late A completion
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

  // 22. [Regression Gate 1] Race safety: rapid portal A -> B -> A switching rejects stale response
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

  // 23. [Regression Gate 1] Race safety: logout during in-flight refresh discards late tokens
  await runTest("[Regression Gate 1] Race safety: logout during in-flight refresh discards late tokens", async () => {
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

  // 24. [Regression Gate 1] Race safety: old 401 failure arriving after new session establishment does not clear new credentials
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

  // 25. [Regression Gate 1] Independent redirect: auth:verify rejects 302/307/308 redirects with 0 requests to B
  await runTest("[Regression Gate 1] Independent redirect: auth:verify rejects 302/307/308 redirects with 0 requests to B", async () => {
    for (const code of [302, 307, 308]) {
      ConfigManager.establishSession(originAPortal, {
        token: `v-tok-${code}`,
        refreshToken: `v-ref-${code}`,
      });
      serverARedirectVerifyToB = code;
      capturedRequests = [];
      capturedRequestsA = [];

      const res = await LauncherAuth.verifySession();
      if (res.valid !== false) {
        throw new Error(`Expected verifySession to reject ${code} redirect`);
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(`Expected 1 verify request at Origin A for ${code}, got ${capturedRequestsA.length}`);
      }
      if (capturedRequests.length !== 0) {
        throw new Error(`Requests leaked to Destination B during verify ${code}! Captured: ${JSON.stringify(capturedRequests)}`);
      }
    }
    serverARedirectVerifyToB = 0;
  });

  // 26. [Regression Gate 1] Independent redirect: auth:refresh rejects 302/307/308 redirects with 0 requests to B
  await runTest("[Regression Gate 1] Independent redirect: auth:refresh rejects 302/307/308 redirects with 0 requests to B", async () => {
    for (const code of [302, 307, 308]) {
      ConfigManager.establishSession(originAPortal, {
        token: `r-tok-${code}`,
        refreshToken: `r-ref-${code}`,
      });
      serverARedirectRefreshToB = code;
      capturedRequests = [];
      capturedRequestsA = [];

      const res = await LauncherAuth.refreshSession();
      if (res.valid !== false) {
        throw new Error(`Expected refreshSession to reject ${code} redirect`);
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(`Expected 1 refresh request at Origin A for ${code}, got ${capturedRequestsA.length}`);
      }
      if (capturedRequests.length !== 0) {
        throw new Error(`Requests leaked to Destination B during refresh ${code}! Captured: ${JSON.stringify(capturedRequests)}`);
      }
    }
    serverARedirectRefreshToB = 0;
  });

  // 27. [Regression Gate 1] Independent redirect: auth token exchange rejects 302/307/308 redirects with 0 requests to B
  await runTest("[Regression Gate 1] Independent redirect: auth token exchange rejects 302/307/308 redirects with 0 requests to B", async () => {
    for (const code of [302, 307, 308]) {
      ConfigManager.resetForTesting();
      ConfigManager.set({ portalUrl: originAPortal });
      serverARedirectExchangeToB = code;
      capturedRequests = [];
      capturedRequestsA = [];
      openedExternals.length = 0;

      const loginPromise = LauncherAuth.loginWithPortal();
      await triggerOAuthCallback(`code-redirect-${code}`);

      let threw = false;
      try {
        await loginPromise;
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`Expected token exchange to fail on ${code} redirect`);
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(`Expected 1 exchange request at Origin A for ${code}, got ${capturedRequestsA.length}`);
      }
      if (capturedRequests.length !== 0) {
        throw new Error(`Requests reached Destination B during exchange ${code}! Captured: ${JSON.stringify(capturedRequests)}`);
      }
    }
    serverARedirectExchangeToB = 0;
  });

  // 28. [Regression Gate 1] Independent redirect: server status metadata endpoint rejects 302/307/308 redirects with 0 requests to B
  await runTest("[Regression Gate 1] Independent redirect: server status metadata endpoint rejects 302/307/308 redirects with 0 requests to B", async () => {
    for (const code of [302, 307, 308]) {
      ConfigManager.establishSession(originAPortal, { token: `status-tok-${code}` });
      serverARedirectStatusToB = code;
      capturedRequests = [];
      capturedRequestsA = [];

      let threw = false;
      try {
        await ServerStatusClient.getStatus();
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`Expected ServerStatusClient.getStatus to reject ${code} redirect`);
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(`Expected 1 status request at Origin A for ${code}, got ${capturedRequestsA.length}`);
      }
      if (capturedRequests.length !== 0) {
        throw new Error(`Requests leaked to Destination B during status ${code}! Captured: ${JSON.stringify(capturedRequests)}`);
      }
    }
    serverARedirectStatusToB = 0;
  });

  // 29. [Regression Gate 1] Independent redirect: channel sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present
  await runTest("[Regression Gate 1] Independent redirect: channel sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present", async () => {
    // Setup valid local fallback fixture on disk in gameDir
    fs.mkdirSync(path.join(gameDir, ".lampas"), { recursive: true });
    fs.writeFileSync(path.join(gameDir, ".lampas", "release.json"), JSON.stringify({
      pack: "Lampas 2",
      version: "2.0.0",
      protocol: 3,
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      manifestId: "fallback-man",
      files: [],
      mods: [],
    }));
    fs.writeFileSync(path.join(gameDir, ".lampas", "installation.json"), JSON.stringify({
      version: "2.0.0",
      completedAt: new Date().toISOString(),
    }));

    for (const code of [302, 307, 308]) {
      ConfigManager.establishSession(originAPortal, { token: `chan-tok-${code}` });
      serverARedirectChannelToB = code;
      capturedRequests = [];
      capturedRequestsA = [];

      let threw = false;
      try {
        await LauncherSync.syncClient(() => {});
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`Expected syncClient to fail on channel ${code} redirect despite local fallback`);
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(`Expected 1 channel request at Origin A for ${code}, got ${capturedRequestsA.length}`);
      }
      if (capturedRequests.length !== 0) {
        throw new Error(`Requests reached Destination B on channel ${code}! Captured: ${JSON.stringify(capturedRequests)}`);
      }
    }
    serverARedirectChannelToB = 0;
  });

  // 30. [Regression Gate 1] Independent redirect: release sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present
  await runTest("[Regression Gate 1] Independent redirect: release sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present", async () => {
    for (const code of [302, 307, 308]) {
      ConfigManager.establishSession(originAPortal, { token: `rel-tok-${code}` });
      serverARedirectReleaseToB = code;
      capturedRequests = [];
      capturedRequestsA = [];

      let threw = false;
      try {
        await LauncherSync.syncClient(() => {});
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`Expected syncClient to fail on release ${code} redirect despite local fallback`);
      }
      if (capturedRequests.length !== 0) {
        throw new Error(`Requests reached Destination B on release ${code}! Captured: ${JSON.stringify(capturedRequests)}`);
      }
    }
    serverARedirectReleaseToB = 0;
  });

  // 31. [Regression Gate 1] Independent redirect: manifest sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present
  await runTest("[Regression Gate 1] Independent redirect: manifest sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present", async () => {
    for (const code of [302, 307, 308]) {
      ConfigManager.establishSession(originAPortal, { token: `man-tok-${code}` });
      serverARedirectManifestToB = code;
      capturedRequests = [];
      capturedRequestsA = [];

      let threw = false;
      try {
        await LauncherSync.syncClient(() => {});
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`Expected syncClient to fail on manifest ${code} redirect despite local fallback`);
      }
      if (capturedRequests.length !== 0) {
        throw new Error(`Requests reached Destination B on manifest ${code}! Captured: ${JSON.stringify(capturedRequests)}`);
      }
    }
    serverARedirectManifestToB = 0;
  });

  // 32. [Regression Gate 1] Legitimate file download follows safe redirect without auth headers
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

  // 33. [Regression Gate 1] ConfigManager.get performs durable disk scrubbing of unbound tokens on disk
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
