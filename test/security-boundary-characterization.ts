import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
let LauncherLogger: any = null;

try {
  // Load production modules directly and unchanged
  const configMod = await import("../src/config");
  const authMod = await import("../src/auth");
  const loggerMod = await import("../src/logger");
  const ConfigManager = configMod.ConfigManager;
  const LauncherAuth = authMod.LauncherAuth;
  LauncherLogger = loggerMod.LauncherLogger;

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
  await runTest("Registration harness confirms 35 handles and 1 on channel", () => {
    if (ipcHandlers.size !== 35) throw new Error(`Expected 35 handles, got ${ipcHandlers.size}`);
    if (ipcListeners.size !== 1) throw new Error(`Expected 1 listener, got ${ipcListeners.size}`);
    if (!ipcListeners.has("game:logAck")) throw new Error("Missing game:logAck listener");
  });

  // 2. Production utils:openPath handler invokes shell.openPath for local paths
  await runTest("utils:openPath calls shell.openPath for local paths", async () => {
    openedPaths.length = 0;
    openedExternals.length = 0;
    const handler = ipcHandlers.get("utils:openPath")!;
    const testFile = path.join(testRoot, "dummy.txt");
    await handler({}, testFile);
    if (openedPaths.length !== 1 || openedPaths[0] !== testFile) {
      throw new Error(`Expected openedPaths to contain [${testFile}], got: ${JSON.stringify(openedPaths)}`);
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

  // 4. Production config:set handler permits arbitrary runtime fields
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

  // Loopback HTTP fixture for credential routing
  interface CapturedRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }

  let capturedRequests: CapturedRequest[] = [];
  let mockServerResponse: { status: number; body: any } = {
    status: 200,
    body: { valid: true, user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" } },
  };

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
      res.writeHead(mockServerResponse.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockServerResponse.body));
    });
  });

  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve());
  });

  const serverPort = (server.address() as any).port;
  const attackerPortal = `http://127.0.0.1:${serverPort}`;

  // Allow the owned fixture endpoint in the outbound request policy
  allowedDestinations.add(`http://127.0.0.1:${serverPort}`);

  // Set synthetic credentials
  ConfigManager.set({
    token: "syn-test-bearer-token-12345",
    refreshToken: "syn-test-refresh-token-67890",
    minecraftAccessToken: "syn-test-mc-token-abcdef",
  });

  // 5. [Service-Level] LauncherAuth.verifySession credential routing
  await runTest("[Service-Level] LauncherAuth.verifySession routes bearer token to caller portalUrl", async () => {
    capturedRequests = [];
    mockServerResponse = {
      status: 200,
      body: { valid: true, user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" } },
    };
    const result = await LauncherAuth.verifySession(attackerPortal);
    if (!result.valid) throw new Error("Expected valid session");
    if (capturedRequests.length !== 1) throw new Error(`Expected 1 request, got ${capturedRequests.length}`);
    const req = capturedRequests[0];
    if (req.method !== "POST") throw new Error(`Expected POST, got ${req.method}`);
    if (req.url !== "/api/v1/auth/verify") throw new Error(`Expected /api/v1/auth/verify, got ${req.url}`);
    if (req.headers["authorization"] !== "Bearer syn-test-bearer-token-12345") {
      throw new Error(`Unexpected authorization header: ${req.headers["authorization"]}`);
    }
  });

  // 6. [Service-Level] LauncherAuth.refreshSession credential routing
  await runTest("[Service-Level] LauncherAuth.refreshSession routes refresh & bearer token to caller portalUrl", async () => {
    capturedRequests = [];
    mockServerResponse = {
      status: 200,
      body: {
        token: "syn-new-token",
        refreshToken: "syn-new-refresh",
        user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" },
      },
    };
    const result = await LauncherAuth.refreshSession(attackerPortal);
    if (!result.valid) throw new Error("Expected valid session");
    if (capturedRequests.length !== 1) throw new Error(`Expected 1 request, got ${capturedRequests.length}`);
    const req = capturedRequests[0];
    if (req.method !== "POST") throw new Error(`Expected POST, got ${req.method}`);
    if (req.url !== "/api/v1/auth/refresh") throw new Error(`Expected /api/v1/auth/refresh, got ${req.url}`);
    if (req.headers["authorization"] !== "Bearer syn-test-bearer-token-12345") {
      throw new Error(`Unexpected authorization header: ${req.headers["authorization"]}`);
    }
    const parsedBody = JSON.parse(req.body);
    if (parsedBody.refreshToken !== "syn-test-refresh-token-67890") {
      throw new Error(`Unexpected body refreshToken: ${parsedBody.refreshToken}`);
    }
  });

  // 7. [IPC-Level] auth:verify production handler credential routing
  await runTest("[IPC-Level] auth:verify forwards caller-supplied portalUrl to transport sink", async () => {
    ConfigManager.set({
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
    });
    capturedRequests = [];
    mockServerResponse = {
      status: 200,
      body: { valid: true, user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" } },
    };
    const handler = ipcHandlers.get("auth:verify")!;
    const res = await handler({}, attackerPortal);
    if (!res.valid) throw new Error("Expected valid session response");
    if (capturedRequests.length !== 1) throw new Error(`Expected 1 request, got ${capturedRequests.length}`);
    const req = capturedRequests[0];
    if (req.method !== "POST" || req.url !== "/api/v1/auth/verify") {
      throw new Error(`Unexpected request: ${req.method} ${req.url}`);
    }
    if (req.headers["authorization"] !== "Bearer syn-test-bearer-token-12345") {
      throw new Error(`Unexpected authorization: ${req.headers["authorization"]}`);
    }
  });

  // 8. [IPC-Level] auth:refresh production handler credential routing
  await runTest("[IPC-Level] auth:refresh forwards caller-supplied portalUrl to transport sink", async () => {
    ConfigManager.set({
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
    });
    capturedRequests = [];
    mockServerResponse = {
      status: 200,
      body: {
        token: "syn-new-token",
        refreshToken: "syn-new-refresh",
        user: { id: "u1", name: "Player", minecraftUsername: "Player", minecraftUuid: "00000000-0000-0000-0000-000000000001" },
      },
    };
    const handler = ipcHandlers.get("auth:refresh")!;
    const res = await handler({}, attackerPortal);
    if (!res.valid) throw new Error("Expected valid session response");
    if (capturedRequests.length !== 1) throw new Error(`Expected 1 request, got ${capturedRequests.length}`);
    const req = capturedRequests[0];
    if (req.method !== "POST" || req.url !== "/api/v1/auth/refresh") {
      throw new Error(`Unexpected request: ${req.method} ${req.url}`);
    }
    if (req.headers["authorization"] !== "Bearer syn-test-bearer-token-12345") {
      throw new Error(`Unexpected authorization: ${req.headers["authorization"]}`);
    }
    const parsedBody = JSON.parse(req.body);
    if (parsedBody.refreshToken !== "syn-test-refresh-token-67890") {
      throw new Error(`Unexpected body refreshToken: ${parsedBody.refreshToken}`);
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
      await new Promise<void>((resolve) => server!.close(() => resolve()));
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
