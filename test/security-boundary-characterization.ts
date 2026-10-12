import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import { mock, spyOn } from "bun:test";

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

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-boundary-test-"),
);
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

process.env.LAMPAS_DEFAULT_GAME_DIR = gameDir;

fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(gameDir, { recursive: true });

// Tracked harness state
const ipcHandlers = new Map<string, Function>();
const ipcListeners = new Map<string, Function>();
const openedPaths: string[] = [];
const openedExternals: string[] = [];
const interceptedProcesses: Array<{ command: string; args: any[] }> = [];

function createMockChildProcess(command: string, args: any[] = []) {
  interceptedProcesses.push({ command, args });
  const proc = new EventEmitter() as any;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  proc.pid = 99999;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = () => true;
  proc.unref = () => {};
  proc.ref = () => {};
  process.nextTick(() => {
    proc.emit("spawn");
  });
  return proc;
}

// Intercept unintended process execution via spyOn
spyOn(cp, "spawn").mockImplementation(((command: string, args: any[] = []) => {
  return createMockChildProcess(command, args);
}) as any);
spyOn(cp, "exec").mockImplementation(((command: string) => {
  interceptedProcesses.push({ command, args: [] });
  throw new Error(`Unexpected child_process.exec invocation for: ${command}`);
}) as any);
spyOn(cp, "execFile").mockImplementation(((
  command: string,
  args: any[] = [],
) => {
  interceptedProcesses.push({ command, args });
  throw new Error(
    `Unexpected child_process.execFile invocation for: ${command}`,
  );
}) as any);
spyOn(cp, "fork").mockImplementation(((
  modulePath: string,
  args: any[] = [],
) => {
  interceptedProcesses.push({ command: modulePath, args });
  throw new Error(
    `Unexpected child_process.fork invocation for: ${modulePath}`,
  );
}) as any);

// Also configure mock.module as second line of defense
mock.module("node:child_process", () => ({
  ...cp,
  spawn: (command: string, args: any[] = []) => {
    return createMockChildProcess(command, args);
  },
  exec: (command: string) => {
    interceptedProcesses.push({ command, args: [] });
    throw new Error(`Unexpected child_process.exec invocation for: ${command}`);
  },
  execFile: (command: string, args: any[] = []) => {
    interceptedProcesses.push({ command, args });
    throw new Error(
      `Unexpected child_process.execFile invocation for: ${command}`,
    );
  },
  fork: (modulePath: string, args: any[] = []) => {
    interceptedProcesses.push({ command: modulePath, args });
    throw new Error(
      `Unexpected child_process.fork invocation for: ${modulePath}`,
    );
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
    throw new Error(
      `[OutboundPolicyViolation] Malformed request URL: ${urlStr}`,
    );
  }

  if (
    !allowedDestinations.has(parsed.origin) &&
    !allowedDestinations.has(parsed.host)
  ) {
    attemptedViolations.push(urlStr);
    throw new Error(
      `[OutboundPolicyViolation] Request to unapproved destination: ${urlStr}`,
    );
  }

  return originalFetch(input, init);
}) as any;

const mockDialog = {
  showOpenDialog: mock(async () => ({
    canceled: false,
    filePaths: [] as string[],
  })),
  showMessageBox: mock(async () => ({ response: 0 })),
};

class MockWebContents {
  id = 1;
  private _url = "http://localhost:5173";
  mainFrame: any = {
    parent: null,
    url: "http://localhost:5173",
    isDestroyed: () => false,
  };
  get url() {
    return this._url;
  }
  set url(val: string) {
    this._url = val;
    this.mainFrame.url = val;
  }
  private listeners = new Map<string, Function[]>();
  getURL() {
    return this._url;
  }
  on(event: string, fn: Function) {
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }
  once(event: string, fn: Function) {
    const wrapper = (...args: any[]) => {
      this.removeListener(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }
  removeListener(event: string, fn: Function) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(
      event,
      list.filter((l) => l !== fn),
    );
    return this;
  }
  emit(event: string, ...args: any[]) {
    const list = this.listeners.get(event) || [];
    for (const fn of [...list]) {
      fn(...args);
    }
    return list.length > 0;
  }
  send() {}
  isLoading() {
    return false;
  }
  isDestroyed() {
    return false;
  }
  setWindowOpenHandler(handler: Function) {
    this.windowOpenHandler = handler;
  }
  windowOpenHandler?: Function;
  session = {
    permissionRequestHandler: null as any,
    permissionCheckHandler: null as any,
    headersReceivedHandler: null as any,
    setPermissionRequestHandler: (fn: any) => {
      this.session.permissionRequestHandler = fn;
    },
    setPermissionCheckHandler: (fn: any) => {
      this.session.permissionCheckHandler = fn;
    },
    webRequest: {
      onHeadersReceived: (fn: any) => {
        this.session.headersReceivedHandler = fn;
      },
    },
  };
}

class MockBrowserWindow {
  static allWindows: MockBrowserWindow[] = [];
  static getAllWindows(): MockBrowserWindow[] {
    return MockBrowserWindow.allWindows;
  }
  webContents = new MockWebContents();
  isDestroyed() {
    return false;
  }
  isMaximized() {
    return false;
  }
  minimize() {}
  maximize() {}
  unmaximize() {}
  close() {}
  destroy() {}
  loadURL(url: string) {
    this.webContents.url = url;
  }
  loadFile(file: string) {
    this.webContents.url = `file:///${path.resolve(file).replace(/\\/g, "/")}`;
  }
  show() {}
  on() {
    return this;
  }
  once() {
    return this;
  }
  constructor() {
    MockBrowserWindow.allWindows.push(this);
  }
}

function getValidEvent(overrides: any = {}) {
  const win = MockBrowserWindow.allWindows[0];
  const frame =
    overrides?.senderFrame !== undefined
      ? overrides.senderFrame
      : win?.webContents?.mainFrame;
  return {
    sender: overrides?.sender || win?.webContents,
    senderFrame: frame,
    ...overrides,
  };
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

// Controlled file-access fixture for offline fallback (Requirement 2)
// In production, sync.ts reads path.join(__dirname, "../../manifest/client-manifest.json") and release.json.
// We intercept existsSync and readFileSync ONLY for these two paths, avoiding any creation or mutation of sibling directories.
const expectedManifestPath = path.normalize(
  path.resolve(
    path.join(import.meta.dir, "../src", "../../manifest/client-manifest.json"),
  ),
);
const expectedReleasePath = path.normalize(
  path.resolve(
    path.join(import.meta.dir, "../src", "../../manifest/release.json"),
  ),
);

const fallbackManifestContent = JSON.stringify({
  schemaVersion: 2,
  pack: "Lampas Offline Fallback Pack",
  version: "2.0.0-offline",
  target: "client",
  protocol: 3,
  minecraft: "26.2",
  loader: { type: "fabric", version: "0.19.3" },
  files: [],
  mods: [],
});

const fallbackReleaseContent = JSON.stringify({
  schemaVersion: 1,
  pack: "Lampas Offline Fallback Pack",
  version: "2.0.0-offline",
  protocol: 3,
  minecraft: "26.2",
  loader: { type: "fabric", version: "0.19.3" },
  minimumLauncherVersion: "1.0.0",
  created: "2026-01-01T00:00:00Z",
  clientManifest: "/api/v1/releases/2.0.0-offline/client-manifest",
  serverManifest: "/api/v1/releases/2.0.0-offline/server-manifest",
});

let enableControlledFallbackFixture = true;
const realExistsSync = fs.existsSync.bind(fs);
const realReadFileSync = fs.readFileSync.bind(fs);

mock.module("node:fs", () => ({
  ...fs,
  existsSync: (p: any) => {
    if (enableControlledFallbackFixture) {
      const norm = path.normalize(path.resolve(String(p)));
      if (norm === expectedManifestPath || norm === expectedReleasePath) {
        return true;
      }
    }
    return realExistsSync(p);
  },
  readFileSync: ((p: any, ...args: any[]) => {
    if (enableControlledFallbackFixture && typeof p === "string") {
      const norm = path.normalize(path.resolve(p));
      if (norm === expectedManifestPath) {
        const opts = args[0];
        return opts === "utf-8" || opts?.encoding === "utf-8"
          ? fallbackManifestContent
          : Buffer.from(fallbackManifestContent, "utf-8");
      }
      if (norm === expectedReleasePath) {
        const opts = args[0];
        return opts === "utf-8" || opts?.encoding === "utf-8"
          ? fallbackReleaseContent
          : Buffer.from(fallbackReleaseContent, "utf-8");
      }
    }
    return (realReadFileSync as any)(p, ...args);
  }) as any,
}));

// Mock Electron before any imports
mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : testRoot),
    getName: () => "Lampas Launcher",
    getVersion: () => "1.4.0",
    whenReady: () => readyPromise,
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: MockBrowserWindow,
  ipcMain: {
    handle: (channel: string, handler: Function) => {
      const wrapped = (event: any, ...args: any[]) => {
        const effectiveEvent =
          event && (event.sender || event.senderFrame || event.rawEmptyEvent)
            ? event
            : getValidEvent(event);
        return handler(effectiveEvent, ...args);
      };
      (wrapped as any).rawHandler = handler;
      ipcHandlers.set(channel, wrapped);
    },
    on: (channel: string, listener: Function) => {
      const wrapped = (event: any, ...args: any[]) => {
        const effectiveEvent =
          event && (event.sender || event.senderFrame || event.rawEmptyEvent)
            ? event
            : getValidEvent(event);
        return listener(effectiveEvent, ...args);
      };
      ipcListeners.set(channel, wrapped);
    },
  },
  shell: mockShell,
  nativeImage: { createFromPath: () => ({}) },
  dialog: mockDialog,
}));

const results = {
  totalPassed: 0,
  totalSkipped: 0,
  skippedPlatformCoverage: [] as Array<{ name: string; reason: string }>,
  tests: [] as Array<{
    name: string;
    passed: boolean;
    skipped?: boolean;
    error?: string;
  }>,
};

function skipPlatformCoverage(reason: string): never {
  const err = new Error(reason);
  (err as any)._skipped = true;
  throw err;
}

function runTest(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      results.totalPassed++;
      results.tests.push({ name, passed: true });
    } catch (e: any) {
      if (e?._skipped) {
        results.totalSkipped++;
        results.skippedPlatformCoverage.push({ name, reason: e.message });
        results.tests.push({
          name,
          passed: false,
          skipped: true,
          error: e.message,
        });
        return;
      }
      results.tests.push({
        name,
        passed: false,
        error: e?.message || String(e),
      });
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
  ConfigManager.set({ gameDir });
  const LauncherAuth = authMod.LauncherAuth;
  LauncherLogger = loggerMod.LauncherLogger;
  const LauncherSync = syncMod.LauncherSync;
  const ServerStatusClient = serverStatusMod.ServerStatusClient;
  const downloadVerified = fileTransferMod.downloadVerified;
  const PortalPolicy = configMod.PortalPolicy;
  const normalizePortalUrl = configMod.normalizePortalUrl;
  const ipcBoundaryMod = await import("../src/ipc-boundary");
  const {
    IpcBoundary,
    IpcSecurityError,
    IpcValidationError,
    UserCancelledError,
    OperationConflictError,
    InstallationStateError,
    ModPolicyError,
    isPrivilegedJavaArg,
    classifyJavaArgs,
    parseJavaArgs,
    APPROVAL_TTL_MS,
    MAX_CUSTOM_MOD_FILE_SIZE_BYTES,
    normalizeApprovalTarget,
    sanitizeIpcError,
  } = ipcBoundaryMod;
  const gameRunnerMod = await import("../src/game-runner");
  const { GameRunner, buildLaunchArguments } = gameRunnerMod;
  const operationsMod = await import("../src/operations");
  const { OperationCoordinator, OperationBusyError, GameRunningConflictError } =
    operationsMod;
  const javaRuntimeMod = await import("../src/java-runtime");
  const { JavaRuntimeManager } = javaRuntimeMod;
  const bootstrapMod = await import("../src/minecraft-bootstrap");
  const { MinecraftBootstrap } = bootstrapMod;
  const credentialStoreMod = await import("../src/credential-store");
  const { CredentialStore } = credentialStoreMod;
  const sessionManagerMod = await import("../src/session-manager");
  const { SessionManager } = sessionManagerMod;

  class MockSafeStorage {
    private key = crypto.randomBytes(32);
    private iv = crypto.randomBytes(16);
    public available: boolean = true;
    public backend: string =
      process.platform === "linux" ? "gnome_libsecret" : "windows_dpapi";
    public failEncryption: boolean = false;
    public failDecryption: boolean = false;
    public onEncryptCallback: (() => void) | null = null;

    isEncryptionAvailable(): boolean {
      return this.available;
    }

    getSelectedStorageBackend(): string {
      return this.backend;
    }

    setUsePlainTextEncryption(_usePlainText: boolean): void {}

    encryptString(plainText: string): Buffer {
      if (!this.available)
        throw new Error("SafeStorage encryption not available");
      if (this.failEncryption)
        throw new Error("SafeStorage encryption internal error");
      if (this.onEncryptCallback) {
        this.onEncryptCallback();
      }
      const cipher = crypto.createCipheriv("aes-256-cbc", this.key, this.iv);
      return Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    }

    decryptString(encrypted: Buffer): string {
      if (!this.available)
        throw new Error("SafeStorage encryption not available");
      if (this.failDecryption)
        throw new Error("Decryption failed: bad key or MAC mismatch");
      const decipher = crypto.createDecipheriv(
        "aes-256-cbc",
        this.key,
        this.iv,
      );
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString("utf8");
    }
  }

  // Supply explicit development policy for test harness
  PortalPolicy.configureDevelopmentPolicy({
    allowLoopback: true,
    allowedRemoteHosts: ["portal-a.lampas.test", "portal-b.lampas.test"],
  });

  // Import production main.ts to register IPC channels
  await import("../src/main");

  // Signal readiness and await deterministic registration of all 39 handles + 1 listener
  readyResolver!();

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (ipcHandlers.size >= 35 && ipcListeners.size >= 1) {
        resolve();
      } else if (Date.now() > deadline) {
        reject(
          new Error(
            `Timed out waiting for IPC registrations (handlers: ${ipcHandlers.size}, listeners: ${ipcListeners.size})`,
          ),
        );
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });

  ConfigManager.set({ gameDir });

  // 1. Inbound IPC Registration Inventory
  await runTest(
    "Registration harness confirms 40 handles and 1 on channel",
    () => {
      if (ipcHandlers.size !== 40)
        throw new Error(`Expected 40 handles, got ${ipcHandlers.size}`);
      if (ipcListeners.size !== 1)
        throw new Error(`Expected 1 listener, got ${ipcListeners.size}`);
      if (!ipcListeners.has("game:logAck"))
        throw new Error("Missing game:logAck listener");
      if (!ipcHandlers.has("utils:openSourcePage"))
        throw new Error("Missing utils:openSourcePage handle");
      if (!ipcHandlers.has("utils:openKnownLocation"))
        throw new Error("Missing utils:openKnownLocation handle");
      if (!ipcHandlers.has("auth:getStorageStatus"))
        throw new Error("Missing auth:getStorageStatus handle");
      if (!ipcHandlers.has("cosmetics:getAvatar"))
        throw new Error("Missing cosmetics:getAvatar handle");
      if (!ipcHandlers.has("cosmetics:getModIcon"))
        throw new Error("Missing cosmetics:getModIcon handle");
    },
  );

  // 2. Production utils:openPath handler rejects unapproved arbitrary local paths
  await runTest(
    "utils:openPath rejects arbitrary local paths and never calls shell.openPath",
    async () => {
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
        throw new Error(
          "Expected utils:openPath to throw for unapproved local path",
        );
      }
      if (openedPaths.length !== 0) {
        throw new Error(
          `Expected openedPaths to be empty, got: ${JSON.stringify(openedPaths)}`,
        );
      }
      if (openedExternals.length !== 0) {
        throw new Error(
          `Expected openedExternals to be empty, got: ${JSON.stringify(openedExternals)}`,
        );
      }
    },
  );

  // 3. Production utils:openPath handler invokes shell.openExternal for HTTP(S) targets
  await runTest(
    "utils:openPath calls shell.openExternal for HTTP(S) paths",
    async () => {
      openedPaths.length = 0;
      openedExternals.length = 0;
      const handler = ipcHandlers.get("utils:openPath")!;
      const testUrl = "https://dev.lampas.town/releases";
      await handler({}, testUrl);
      if (openedExternals.length !== 1 || openedExternals[0] !== testUrl) {
        throw new Error(
          `Expected openedExternals to contain [${testUrl}], got: ${JSON.stringify(openedExternals)}`,
        );
      }
      if (openedPaths.length !== 0) {
        throw new Error(
          `Expected openedPaths to be empty, got: ${JSON.stringify(openedPaths)}`,
        );
      }
    },
  );

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
    if (
      (current as any).javaPath !== patch.javaPath ||
      current.javaArgs !== patch.javaArgs
    ) {
      throw new Error(
        `ConfigManager did not persist patch: ${JSON.stringify(current)}`,
      );
    }
  });

  // 5. utils:openSourcePage validates URL and calls shell.openExternal, rejecting dangerous schemes
  await runTest(
    "utils:openSourcePage opens valid web URLs and rejects file/dangerous protocols",
    async () => {
      openedExternals.length = 0;
      openedPaths.length = 0;
      const handler = ipcHandlers.get("utils:openSourcePage")!;
      const testUrl = "https://lampas.town/about";
      await handler({}, testUrl);
      if (openedExternals.length !== 1 || openedExternals[0] !== testUrl) {
        throw new Error(
          `Expected openedExternals to have [${testUrl}], got: ${JSON.stringify(openedExternals)}`,
        );
      }
      let threw = false;
      try {
        await handler({}, "file:///C:/Windows/System32/calc.exe");
      } catch {
        threw = true;
      }
      if (!threw)
        throw new Error(
          "Expected utils:openSourcePage to reject file: protocol",
        );
      if (openedPaths.length !== 0)
        throw new Error("Expected openedPaths to remain empty");
    },
  );

  // 6. utils:openKnownLocation opens approved locations and rejects arbitrary targets
  await runTest(
    "utils:openKnownLocation opens approved locations and rejects arbitrary targets",
    async () => {
      openedExternals.length = 0;
      openedPaths.length = 0;
      const handler = ipcHandlers.get("utils:openKnownLocation")!;
      await handler({}, "gameDir");
      if (openedPaths.length !== 1)
        throw new Error(
          `Expected openedPaths to have 1 entry, got: ${JSON.stringify(openedPaths)}`,
        );
      let threw = false;
      try {
        await handler({}, "arbitraryExploit");
      } catch {
        threw = true;
      }
      if (!threw)
        throw new Error(
          "Expected utils:openKnownLocation to reject unknown key",
        );
    },
  );

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
  let serverAFailChannelWith500 = false;
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
          res.writeHead(code, {
            Location: `${attackerPortal}/api/v1/auth/verify`,
          });
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
        res.end(
          JSON.stringify({
            valid: true,
            user: {
              id: "u1",
              name: "BoundaryUser",
              minecraftUsername: "BoundaryUser",
              minecraftUuid: "00000000-0000-0000-0000-000000000001",
            },
          }),
        );
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
          res.writeHead(code, {
            Location: `${attackerPortal}/api/v1/auth/refresh`,
          });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            valid: true,
            token: "syn-refreshed-token-a",
            refreshToken: "syn-refreshed-refresh-a",
            user: {
              id: "u1",
              name: "BoundaryUser",
              minecraftUsername: "BoundaryUser",
              minecraftUuid: "00000000-0000-0000-0000-000000000001",
            },
          }),
        );
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
          res.writeHead(code, {
            Location: `${attackerPortal}/api/v1/auth/exchange`,
          });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: "syn-exchanged-token-a",
            refreshToken: "syn-exchanged-refresh-a",
            user: {
              id: "u1",
              name: "BoundaryUser",
              minecraftUsername: "BoundaryUser",
              minecraftUuid: "00000000-0000-0000-0000-000000000001",
            },
          }),
        );
        return;
      }

      // 4. Server status endpoint
      if (req.url === "/api/v1/server/status") {
        if (serverARedirectStatusToB > 0) {
          const code = serverARedirectStatusToB;
          res.writeHead(code, {
            Location: `${attackerPortal}/api/v1/server/status`,
          });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ online: true, players: { online: 5, max: 20 } }),
        );
        return;
      }

      // 5. Channel endpoint
      if (req.url?.startsWith("/api/v1/channels/")) {
        if (serverAFailChannelWith500) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Portal internal error" }));
          return;
        }
        if (serverARedirectChannelToB > 0) {
          const code = serverARedirectChannelToB;
          res.writeHead(code, { Location: `${attackerPortal}${req.url}` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            channel: "stable",
            version: "2.0.0",
            release: "/api/v1/releases/2.0.0",
          }),
        );
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
        res.end(
          JSON.stringify({
            schemaVersion: 2,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "client",
            protocol: 3,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            files: [],
            mods: [],
          }),
        );
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
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            protocol: 3,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            minimumLauncherVersion: "1.0.0",
            created: "2026-01-01T00:00:00Z",
            clientManifest: "/api/v1/releases/2.0.0/client-manifest",
            serverManifest: "/api/v1/releases/2.0.0/server-manifest",
          }),
        );
        return;
      }

      // 8. Blob redirect
      if (
        serverARedirectBlobUrl &&
        req.url?.startsWith("/api/v1/blobs/test-blob-redirect")
      ) {
        res.writeHead(302, { Location: serverARedirectBlobUrl });
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await Promise.all([
    new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve()),
    ),
    new Promise<void>((resolve) =>
      serverA!.listen(0, "127.0.0.1", () => resolve()),
    ),
  ]);

  const serverPort = (server.address() as any).port;
  const attackerPortal = `http://127.0.0.1:${serverPort}`;
  const portA = (serverA.address() as any).port;
  const originAPortal = `http://127.0.0.1:${portA}`;

  allowedDestinations.add(attackerPortal);
  allowedDestinations.add(originAPortal);

  async function triggerOAuthCallback(
    code: string = "test-auth-code",
  ): Promise<Response> {
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
    return fetch(
      `${cbOrigin}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    );
  }

  // 7. [Service-Level] LauncherAuth.verifySession ignores caller portalUrl and protects bound session
  await runTest(
    "[Service-Level] LauncherAuth.verifySession ignores caller portalUrl and protects bound session",
    async () => {
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
        throw new Error(
          `Credential leaked to attackerPortal! Captured: ${JSON.stringify(capturedRequests)}`,
        );
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(
          `Expected 1 request to originA, got ${capturedRequestsA.length}`,
        );
      }
      const req = capturedRequestsA[0];
      if (req.method !== "POST" || req.url !== "/api/v1/auth/verify") {
        throw new Error(
          `Unexpected request to originA: ${req.method} ${req.url}`,
        );
      }
      if (
        req.headers["authorization"] !== "Bearer syn-test-bearer-token-12345"
      ) {
        throw new Error(
          `Unexpected authorization header: ${req.headers["authorization"]}`,
        );
      }
    },
  );

  // 8. [Service-Level] LauncherAuth.refreshSession ignores caller portalUrl and protects bound session
  await runTest(
    "[Service-Level] LauncherAuth.refreshSession ignores caller portalUrl and protects bound session",
    async () => {
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
        throw new Error(
          `Credential leaked to attackerPortal! Captured: ${JSON.stringify(capturedRequests)}`,
        );
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(
          `Expected 1 request to originA, got ${capturedRequestsA.length}`,
        );
      }
      const req = capturedRequestsA[0];
      if (req.method !== "POST" || req.url !== "/api/v1/auth/refresh") {
        throw new Error(
          `Unexpected request to originA: ${req.method} ${req.url}`,
        );
      }
      if (
        req.headers["authorization"] !== "Bearer syn-test-bearer-token-12345"
      ) {
        throw new Error(
          `Unexpected authorization header: ${req.headers["authorization"]}`,
        );
      }
    },
  );

  // 9. [IPC-Level] auth:verify production handler credential routing
  await runTest(
    "[IPC-Level] auth:verify ignores caller-supplied portalUrl and routes to bound portal",
    async () => {
      ConfigManager.establishSession(originAPortal, {
        token: "syn-test-bearer-token-12345",
        refreshToken: "syn-test-refresh-token-67890",
      });
      capturedRequests = [];
      capturedRequestsA = [];
      const handler = ipcHandlers.get("auth:verify")!;
      const res = await handler({}, attackerPortal);
      if (!res.valid)
        throw new Error("Expected valid session response from originA");
      if (capturedRequests.length !== 0) {
        throw new Error(
          `Credential leaked to attackerPortal via IPC! Captured: ${JSON.stringify(capturedRequests)}`,
        );
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(
          `Expected 1 request to originA, got ${capturedRequestsA.length}`,
        );
      }
    },
  );

  // 10. [IPC-Level] auth:refresh production handler credential routing
  await runTest(
    "[IPC-Level] auth:refresh ignores caller-supplied portalUrl and routes to bound portal",
    async () => {
      ConfigManager.establishSession(originAPortal, {
        token: "syn-test-bearer-token-12345",
        refreshToken: "syn-test-refresh-token-67890",
      });
      capturedRequests = [];
      capturedRequestsA = [];
      const handler = ipcHandlers.get("auth:refresh")!;
      const res = await handler({}, attackerPortal);
      if (!res.valid)
        throw new Error("Expected valid session response from originA");
      if (capturedRequests.length !== 0) {
        throw new Error(
          `Credential leaked to attackerPortal via IPC! Captured: ${JSON.stringify(capturedRequests)}`,
        );
      }
      if (capturedRequestsA.length !== 1) {
        throw new Error(
          `Expected 1 request to originA, got ${capturedRequestsA.length}`,
        );
      }
    },
  );

  // 11. [Policy] Packaged production rejects loopback destinations and ignores env trust expansion
  await runTest(
    "[Policy] Packaged production rejects loopback destinations and ignores env trust expansion",
    () => {
      try {
        PortalPolicy.setProductionOverride(true);
        process.env.LAMPAS_ALLOWED_PORTAL_HOSTS =
          "attacker.invalid,custom-portal.test";
        process.env.NODE_ENV = "development";

        let threw = false;
        try {
          normalizePortalUrl("http://localhost:3000");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected loopback to be rejected in packaged production",
          );

        threw = false;
        try {
          normalizePortalUrl("https://attacker.invalid");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected unapproved remote host to be rejected in packaged production",
          );

        threw = false;
        try {
          normalizePortalUrl("https://custom-portal.test");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected env-expanded host to be rejected in packaged production",
          );

        const lampasUrl = normalizePortalUrl("https://dev.lampas.town");
        if (lampasUrl !== "https://dev.lampas.town") {
          throw new Error(
            `Expected dev.lampas.town to be allowed in production, got: ${lampasUrl}`,
          );
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
    },
  );

  // 12. [Opener] resolveAndValidateKnownLocation rejects escaping symlinks and ancestor escapes to outside sentinels
  await runTest(
    "[Opener] resolveAndValidateKnownLocation rejects escaping symlinks and ancestor escapes to outside sentinels",
    async () => {
      openedPaths.length = 0;
      openedExternals.length = 0;
      ConfigManager.set({ gameDir });

      const outsideSentinelDir = path.join(testRoot, "outside-sentinel-dir");
      const outsideSentinelFile = path.join(
        testRoot,
        "outside-sentinel-file.txt",
      );
      if (!fs.existsSync(outsideSentinelDir))
        fs.mkdirSync(outsideSentinelDir, { recursive: true });
      fs.writeFileSync(outsideSentinelFile, "sentinel-payload");

      // 1. Escaping symlink: <gameDir>/mods is a symlink pointing to outsideSentinelDir
      const modsPath = path.join(gameDir, "mods");
      if (fs.existsSync(modsPath))
        fs.rmSync(modsPath, { recursive: true, force: true });
      try {
        fs.symlinkSync(
          outsideSentinelDir,
          modsPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (err: any) {
        skipPlatformCoverage(
          `Unable to create modsDir junction: ${err?.message}`,
        );
      }

      if (fs.existsSync(modsPath)) {
        const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
        let threw = false;
        try {
          await knownHandler({}, "modsDir");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openKnownLocation to reject escaping modsDir symlink",
          );
        if (openedPaths.length !== 0)
          throw new Error("Escaping symlink triggered shell.openPath!");

        const pathHandler = ipcHandlers.get("utils:openPath")!;
        threw = false;
        try {
          await pathHandler({}, "modsDir");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openPath to reject escaping modsDir symlink",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Escaping symlink triggered shell.openPath via openPath!",
          );

        fs.rmSync(modsPath, { recursive: true, force: true });
      }

      // 2. Escaping ancestor: <gameDir>/logs is a symlink to outsideSentinelDir containing latest.log
      const logsPath = path.join(gameDir, "logs");
      if (fs.existsSync(logsPath))
        fs.rmSync(logsPath, { recursive: true, force: true });
      const outsideLatestLog = path.join(outsideSentinelDir, "latest.log");
      fs.writeFileSync(outsideLatestLog, "minecraft log data");
      try {
        fs.symlinkSync(
          outsideSentinelDir,
          logsPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (err: any) {
        skipPlatformCoverage(
          `Unable to create gameDir/logs junction: ${err?.message}`,
        );
      }

      if (fs.existsSync(logsPath)) {
        const mcLogHandler = ipcHandlers.get("utils:openMinecraftLog")!;
        let threw = false;
        try {
          await mcLogHandler({});
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openMinecraftLog to reject escaping logs ancestor symlink",
          );
        if (openedPaths.length !== 0)
          throw new Error("Escaping ancestor triggered shell.openPath!");

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
      if (!threw)
        throw new Error("Expected utils:openPath to reject javascript: URL");
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
      if (!threw)
        throw new Error(
          "Expected utils:openPath to reject direct outside sentinel path",
        );
      if (openedPaths.length !== 0)
        throw new Error("Outside sentinel triggered shell.openPath!");

      // 5. Legitimate known locations succeed
      fs.mkdirSync(path.join(gameDir, "mods"), { recursive: true });
      const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
      await knownHandler({}, "modsDir");
      if ((openedPaths.length as number) !== 1)
        throw new Error("Expected legitimate modsDir to open");
      const opened = openedPaths[0];
      if (opened !== fs.realpathSync(path.join(gameDir, "mods"))) {
        throw new Error(`Expected canonical modsDir opened, got: ${opened}`);
      }
      openedPaths.length = 0;
    },
  );

  // 13. [Opener: launcherLog] Normal launcher log opens successfully via registered handlers
  await runTest(
    "[Opener: launcherLog] Normal launcher log opens successfully via registered handlers",
    async () => {
      const normalLogsDir = path.join(userDataDir, "logs");
      fs.mkdirSync(normalLogsDir, { recursive: true });
      const normalLogFile = path.join(normalLogsDir, "launcher.log");
      fs.writeFileSync(normalLogFile, "=== Normal Session Log ===\n", "utf-8");
      const expectedCanonical = fs.realpathSync(normalLogFile);

      // utils:openLogFile
      openedPaths.length = 0;
      const logFileHandler = ipcHandlers.get("utils:openLogFile")!;
      const res1 = await logFileHandler({});
      if (
        openedPaths.length !== 1 ||
        openedPaths[0] !== expectedCanonical ||
        res1 !== expectedCanonical
      ) {
        throw new Error(
          `Expected utils:openLogFile to open ${expectedCanonical}, got: ${JSON.stringify(openedPaths)}`,
        );
      }

      // utils:openKnownLocation("launcherLog")
      openedPaths.length = 0;
      const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
      const res2 = await knownHandler({}, "launcherLog");
      if (
        openedPaths.length !== 1 ||
        openedPaths[0] !== expectedCanonical ||
        res2 !== expectedCanonical
      ) {
        throw new Error(
          `Expected utils:openKnownLocation(launcherLog) to open ${expectedCanonical}`,
        );
      }

      // utils:openPath("launcherLog")
      openedPaths.length = 0;
      const pathHandler = ipcHandlers.get("utils:openPath")!;
      const res3 = await pathHandler({}, "launcherLog");
      if (
        openedPaths.length !== 1 ||
        openedPaths[0] !== expectedCanonical ||
        res3 !== expectedCanonical
      ) {
        throw new Error(
          `Expected utils:openPath(launcherLog) to open ${expectedCanonical}`,
        );
      }

      // utils:openPath(normalLogFile)
      openedPaths.length = 0;
      const res4 = await pathHandler({}, normalLogFile);
      if (
        openedPaths.length !== 1 ||
        openedPaths[0] !== expectedCanonical ||
        res4 !== expectedCanonical
      ) {
        throw new Error(
          `Expected utils:openPath(${normalLogFile}) to open ${expectedCanonical}`,
        );
      }
      openedPaths.length = 0;
    },
  );

  // 14. [Opener: launcherLog] userData/logs linked or junctioned to an outside directory is rejected across registered handlers
  await runTest(
    "[Opener: launcherLog] userData/logs linked or junctioned to an outside directory is rejected across registered handlers",
    async () => {
      openedPaths.length = 0;
      const outsideLogsDir = path.join(testRoot, "outside-logs-dir");
      const outsideLogFile = path.join(outsideLogsDir, "launcher.log");
      if (!fs.existsSync(outsideLogsDir))
        fs.mkdirSync(outsideLogsDir, { recursive: true });
      fs.writeFileSync(outsideLogFile, "malicious outside log data", "utf-8");

      const userLogsDir = path.join(userDataDir, "logs");
      if (fs.existsSync(userLogsDir)) {
        fs.rmSync(userLogsDir, { recursive: true, force: true });
      }

      try {
        fs.symlinkSync(
          outsideLogsDir,
          userLogsDir,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (err: any) {
        skipPlatformCoverage(
          `Unable to create directory junction for userData/logs: ${err?.message}`,
        );
      }

      try {
        // utils:openLogFile
        openedPaths.length = 0;
        const logFileHandler = ipcHandlers.get("utils:openLogFile")!;
        let threw = false;
        try {
          await logFileHandler({});
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openLogFile to reject escaping userData/logs junction",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Junction escape triggered shell.openPath via openLogFile!",
          );

        // utils:openKnownLocation("launcherLog")
        const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
        threw = false;
        try {
          await knownHandler({}, "launcherLog");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openKnownLocation(launcherLog) to reject escaping userData/logs junction",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Junction escape triggered shell.openPath via openKnownLocation!",
          );

        // utils:openLogsDir
        const logsDirHandler = ipcHandlers.get("utils:openLogsDir")!;
        threw = false;
        try {
          await logsDirHandler({});
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openLogsDir to reject escaping userData/logs junction",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Junction escape triggered shell.openPath via openLogsDir!",
          );

        // utils:openKnownLocation("logsDir")
        threw = false;
        try {
          await knownHandler({}, "logsDir");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openKnownLocation(logsDir) to reject escaping userData/logs junction",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Junction escape triggered shell.openPath via openKnownLocation(logsDir)!",
          );

        // utils:openPath("launcherLog")
        const pathHandler = ipcHandlers.get("utils:openPath")!;
        threw = false;
        try {
          await pathHandler({}, "launcherLog");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openPath(launcherLog) to reject escaping userData/logs junction",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Junction escape triggered shell.openPath via openPath(launcherLog)!",
          );

        // utils:openPath(path.join(userLogsDir, "launcher.log"))
        threw = false;
        try {
          await pathHandler({}, path.join(userLogsDir, "launcher.log"));
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openPath(direct) to reject escaping userData/logs junction",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Junction escape triggered shell.openPath via direct path!",
          );
      } finally {
        fs.rmSync(userLogsDir, { recursive: true, force: true });
      }
    },
  );

  // 15. [Opener: launcherLog] launcher-log file linked outside authorized root is rejected across registered handlers
  await runTest(
    "[Opener: launcherLog] launcher-log file linked outside authorized root is rejected across registered handlers",
    async () => {
      openedPaths.length = 0;
      const userLogsDir = path.join(userDataDir, "logs");
      fs.mkdirSync(userLogsDir, { recursive: true });

      const outsideLogSentinel = path.join(testRoot, "outside-secret-log.txt");
      fs.writeFileSync(
        outsideLogSentinel,
        "secret external log content",
        "utf-8",
      );

      const linkedLogFile = path.join(userLogsDir, "launcher.log");
      if (fs.existsSync(linkedLogFile))
        fs.rmSync(linkedLogFile, { force: true });

      try {
        fs.symlinkSync(outsideLogSentinel, linkedLogFile, "file");
      } catch (err: any) {
        skipPlatformCoverage(
          `Unable to create file symlink for launcher.log: ${err?.message}`,
        );
      }

      try {
        // utils:openLogFile
        openedPaths.length = 0;
        const logFileHandler = ipcHandlers.get("utils:openLogFile")!;
        let threw = false;
        try {
          await logFileHandler({});
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openLogFile to reject escaping file symlink",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Symlink escape triggered shell.openPath via openLogFile!",
          );

        // utils:openKnownLocation("launcherLog")
        const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
        threw = false;
        try {
          await knownHandler({}, "launcherLog");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openKnownLocation(launcherLog) to reject escaping file symlink",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Symlink escape triggered shell.openPath via openKnownLocation!",
          );

        // utils:openPath("launcherLog")
        const pathHandler = ipcHandlers.get("utils:openPath")!;
        threw = false;
        try {
          await pathHandler({}, "launcherLog");
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openPath(launcherLog) to reject escaping file symlink",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Symlink escape triggered shell.openPath via openPath!",
          );

        // utils:openPath(linkedLogFile)
        threw = false;
        try {
          await pathHandler({}, linkedLogFile);
        } catch {
          threw = true;
        }
        if (!threw)
          throw new Error(
            "Expected utils:openPath(direct) to reject escaping file symlink",
          );
        if (openedPaths.length !== 0)
          throw new Error(
            "Symlink escape triggered shell.openPath via direct path!",
          );
      } finally {
        fs.rmSync(linkedLogFile, { force: true });
      }
    },
  );

  // 16. [Opener: launcherLog] Missing-target and wrong-file-type cases are rejected across registered handlers
  await runTest(
    "[Opener: launcherLog] Missing-target and wrong-file-type cases are rejected across registered handlers",
    async () => {
      const userLogsDir = path.join(userDataDir, "logs");
      fs.mkdirSync(userLogsDir, { recursive: true });
      const logFile = path.join(userLogsDir, "launcher.log");
      if (fs.existsSync(logFile))
        fs.rmSync(logFile, { recursive: true, force: true });

      // A. Missing launcher.log file
      openedPaths.length = 0;
      const logFileHandler = ipcHandlers.get("utils:openLogFile")!;
      let threw = false;
      try {
        await logFileHandler({});
      } catch (e: any) {
        threw = true;
        if (!e.message.includes("does not exist")) {
          throw new Error(
            `Unexpected error message for missing log: ${e.message}`,
          );
        }
      }
      if (!threw)
        throw new Error(
          "Expected utils:openLogFile to reject missing log file",
        );
      if (openedPaths.length !== 0)
        throw new Error("Missing log triggered shell.openPath!");

      const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;
      threw = false;
      try {
        await knownHandler({}, "launcherLog");
      } catch {
        threw = true;
      }
      if (!threw)
        throw new Error(
          "Expected utils:openKnownLocation to reject missing log file",
        );
      if (openedPaths.length !== 0)
        throw new Error(
          "Missing log triggered shell.openPath via openKnownLocation!",
        );

      // B. Wrong file type: launcher.log is a directory
      fs.mkdirSync(logFile, { recursive: true });
      threw = false;
      try {
        await logFileHandler({});
      } catch (e: any) {
        threw = true;
        if (!e.message.includes("Expected file")) {
          throw new Error(
            `Unexpected error for directory launcher.log: ${e.message}`,
          );
        }
      }
      if (!threw)
        throw new Error(
          "Expected utils:openLogFile to reject directory target",
        );
      if (openedPaths.length !== 0)
        throw new Error("Directory target triggered shell.openPath!");
      fs.rmSync(logFile, { recursive: true, force: true });

      // C. Wrong file type: logsDir is a regular file
      if (fs.existsSync(userLogsDir))
        fs.rmSync(userLogsDir, { recursive: true, force: true });
      fs.writeFileSync(userLogsDir, "I am a file, not a directory", "utf-8");

      const logsDirHandler = ipcHandlers.get("utils:openLogsDir")!;
      threw = false;
      try {
        await logsDirHandler({});
      } catch (e: any) {
        threw = true;
        if (!e.message.includes("Expected directory")) {
          throw new Error(`Unexpected error for file logsDir: ${e.message}`);
        }
      }
      if (!threw)
        throw new Error("Expected utils:openLogsDir to reject file target");
      if (openedPaths.length !== 0)
        throw new Error(
          "File target triggered shell.openPath via openLogsDir!",
        );

      // Cleanup and restore valid directory and file
      fs.rmSync(userLogsDir, { force: true });
      fs.mkdirSync(userLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(userLogsDir, "launcher.log"),
        "restored log session\n",
        "utf-8",
      );
    },
  );

  // 17. [Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B
  await runTest(
    "[Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B",
    async () => {
      ConfigManager.establishSession(originAPortal, {
        token: "secret-token-origin-a-9999",
        refreshToken: "secret-refresh-origin-a-9999",
      });

      const handler = ipcHandlers.get("config:set")!;
      let rejectedForgery = false;
      try {
        await handler(
          {},
          {
            portalUrl: attackerPortal,
            sessionPortalUrl: attackerPortal,
          },
        );
      } catch (err: any) {
        rejectedForgery = true;
      }
      if (!rejectedForgery) {
        throw new Error(
          "Expected config:set to reject unapproved sessionPortalUrl field",
        );
      }

      // Changing portalUrl legitimately wipes credentials and protects origin isolation
      await handler(
        {},
        {
          portalUrl: attackerPortal,
        },
      );

      const afterSet = ConfigManager.get();
      if (afterSet.sessionPortalUrl === attackerPortal) {
        throw new Error("sessionPortalUrl was forged via config:set!");
      }
      if (afterSet.token !== undefined) {
        throw new Error(
          "token was not wiped when changing portalUrl to attackerPortal!",
        );
      }

      capturedRequests = [];
      capturedRequestsA = [];

      const verifyRes = await LauncherAuth.verifySession(attackerPortal);
      if (verifyRes.valid !== false) {
        throw new Error(
          "Expected verifySession to reject unauthenticated session",
        );
      }

      const refreshRes = await LauncherAuth.refreshSession(attackerPortal);
      if (refreshRes.valid !== false) {
        throw new Error(
          "Expected refreshSession to reject unauthenticated session",
        );
      }

      let statusThrew = false;
      try {
        await ServerStatusClient.getStatus();
      } catch (err: any) {
        statusThrew = true;
        if (!err.message.includes("Portal session is not available")) {
          throw new Error(
            `Expected 'Portal session is not available', got: ${err.message}`,
          );
        }
      }
      if (!statusThrew) {
        throw new Error(
          "Expected ServerStatusClient.getStatus to fail when session is invalid",
        );
      }

      let syncThrew = false;
      try {
        await LauncherSync.syncClient(() => {});
      } catch (err: any) {
        syncThrew = true;
        if (!err.message.includes("Authentication required")) {
          throw new Error(
            `Expected authentication required error, got: ${err.message}`,
          );
        }
      }
      if (!syncThrew) {
        throw new Error(
          "Expected syncClient to fail due to lack of authentication",
        );
      }

      for (const r of capturedRequests) {
        const authHeader = (r.headers["authorization"] || "") as string;
        if (
          authHeader.includes("secret-token-origin-a-9999") ||
          authHeader.includes("secret-refresh-origin-a-9999")
        ) {
          throw new Error(
            `Origin A credential leaked to Origin B in request: ${r.method} ${r.url}`,
          );
        }
        if (
          r.body.includes("secret-token-origin-a-9999") ||
          r.body.includes("secret-refresh-origin-a-9999")
        ) {
          throw new Error(
            `Origin A credential leaked to Origin B in body: ${r.method} ${r.url}`,
          );
        }
      }
    },
  );

  // 14. [Regression Gate 1] Real OAuth login flow successfully completes code exchange and establishes session
  await runTest(
    "[Regression Gate 1] Real OAuth login flow successfully completes code exchange and establishes session",
    async () => {
      ConfigManager.resetForTesting();
      ConfigManager.set({ portalUrl: originAPortal });
      openedExternals.length = 0;

      const loginPromise = LauncherAuth.loginWithPortal();
      const cbRes = await triggerOAuthCallback("auth-code-legitimate");
      if (!cbRes.ok) {
        throw new Error(
          `Expected callback to return 200, got: ${cbRes.status}`,
        );
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
        throw new Error(
          `sessionPortalUrl not established: ${current.sessionPortalUrl}`,
        );
      }
    },
  );

  // 15. [Regression Gate 1] Origin-change invalidation: Case 1 - Fresh logged-out login at A, settings A->B->A before callback
  await runTest(
    "[Regression Gate 1] Origin-change invalidation: Case 1 - Fresh logged-out login at A, settings A->B->A before callback",
    async () => {
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
      const cbRes = await fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=code-1&state=${state}`,
      );
      if (cbRes.status !== 400) {
        throw new Error(
          `Expected callback to return 400, got: ${cbRes.status}`,
        );
      }

      let loginThrew = false;
      try {
        await loginPromise;
      } catch {
        loginThrew = true;
      }
      if (!loginThrew)
        throw new Error(
          "Expected login to fail when origin changed A->B->A before callback",
        );

      const current = ConfigManager.get();
      if (current.token !== undefined) {
        throw new Error(
          "Token was established despite invalidated login flow!",
        );
      }
    },
  );

  // 16. [Regression Gate 1] Origin-change invalidation: Case 2 - Fresh logged-out login at A, settings A->B->A during exchange
  await runTest(
    "[Regression Gate 1] Origin-change invalidation: Case 2 - Fresh logged-out login at A, settings A->B->A during exchange",
    async () => {
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

      fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=code-2&state=${state}`,
      ).catch(() => {});
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
      if (!loginThrew)
        throw new Error(
          "Expected login to fail when origin changed A->B->A during exchange",
        );

      const current = ConfigManager.get();
      if (current.token !== undefined) {
        throw new Error(
          "Token was established despite origin change during exchange!",
        );
      }
      serverAExchangeBarrier = null;
    },
  );

  // 17. [Regression Gate 1] Origin-change invalidation: Case 3 - Fresh logged-out login at A, settings A->B without returning to A
  await runTest(
    "[Regression Gate 1] Origin-change invalidation: Case 3 - Fresh logged-out login at A, settings A->B without returning to A",
    async () => {
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

      fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=code-3&state=${state}`,
      ).catch(() => {});
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
      if (!loginThrew)
        throw new Error("Expected login to fail when origin changed A->B");

      const current = ConfigManager.get();
      if (current.token !== undefined) {
        throw new Error(
          "Token was established on origin B from origin A exchange!",
        );
      }
      serverAExchangeBarrier = null;
    },
  );

  // 18. [Regression Gate 1] Origin-change invalidation: Case 4 - Unchanged portal does not invalidate in-flight login
  await runTest(
    "[Regression Gate 1] Origin-change invalidation: Case 4 - Unchanged portal does not invalidate in-flight login",
    async () => {
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

      fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=code-4&state=${state}`,
      ).catch(() => {});
      await barrier.requestReceived;

      // Unchanged portalUrl and unrelated setting
      ConfigManager.set({ portalUrl: originAPortal, allocatedRamGb: 6 });
      barrier.release();

      const res = await loginPromise;
      if (!res.token)
        throw new Error("Expected login to succeed when portal was unchanged");

      const current = ConfigManager.get();
      if (current.token !== "syn-exchanged-token-a") {
        throw new Error(`Token not established: ${current.token}`);
      }
      if (current.allocatedRamGb !== 6) {
        throw new Error(`Setting not preserved: ${current.allocatedRamGb}`);
      }
      serverAExchangeBarrier = null;
    },
  );

  // 19. [Regression Gate 1] Origin-change invalidation: Case 5 - In-flight exchange while credentials exist
  await runTest(
    "[Regression Gate 1] Origin-change invalidation: Case 5 - In-flight exchange while credentials exist",
    async () => {
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

      fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=code-5&state=${state}`,
      ).catch(() => {});
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
      if (!loginThrew)
        throw new Error(
          "Expected login to fail when origin changed during exchange",
        );

      const current = ConfigManager.get();
      if (current.token !== undefined) {
        throw new Error(`Credentials resurrected: ${current.token}`);
      }
      serverAExchangeBarrier = null;
    },
  );

  // 20. [Regression Gate 1] Origin-change invalidation: Case 6 - Refresh while origin changes
  await runTest(
    "[Regression Gate 1] Origin-change invalidation: Case 6 - Refresh while origin changes",
    async () => {
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
        throw new Error(
          "Expected refresh to be marked invalid after origin changed",
        );
      }

      const current = ConfigManager.get();
      if (current.token !== undefined) {
        throw new Error(
          `Token resurrected after origin change during refresh: ${current.token}`,
        );
      }
      serverARefreshBarrier = null;
    },
  );

  // 21. [Regression Gate 1] Race safety: portal A -> B switch during in-flight verify ignores late A completion
  await runTest(
    "[Regression Gate 1] Race safety: portal A -> B switch during in-flight verify ignores late A completion",
    async () => {
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
        throw new Error(
          `portalUrl corrupted: expected ${attackerPortal}, got ${current.portalUrl}`,
        );
      }
      if (current.sessionPortalUrl !== attackerPortal) {
        throw new Error(
          `sessionPortalUrl corrupted: expected ${attackerPortal}, got ${current.sessionPortalUrl}`,
        );
      }
      if (current.token !== "b-token-active") {
        throw new Error(
          `token overwritten by old session: got ${current.token}`,
        );
      }
    },
  );

  // 22. [Regression Gate 1] Race safety: rapid portal A -> B -> A switching rejects stale response
  await runTest(
    "[Regression Gate 1] Race safety: rapid portal A -> B -> A switching rejects stale response",
    async () => {
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
        throw new Error(
          `Stale generation 1 response overwrote generation 3 token! Current: ${current.token}`,
        );
      }
    },
  );

  // 23. [Regression Gate 1] Race safety: logout during in-flight refresh discards late tokens
  await runTest(
    "[Regression Gate 1] Race safety: logout during in-flight refresh discards late tokens",
    async () => {
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
        throw new Error(
          "Expected in-flight refresh to be marked invalid after logout",
        );
      }

      const current = ConfigManager.get();
      if (current.token !== undefined) {
        throw new Error(
          `Late refresh resurrected token after logout: ${current.token}`,
        );
      }
      if (current.sessionPortalUrl !== undefined) {
        throw new Error(
          `Late refresh resurrected sessionPortalUrl after logout: ${current.sessionPortalUrl}`,
        );
      }
    },
  );

  // 24. [Regression Gate 1] Race safety: old 401 failure arriving after new session establishment does not clear new credentials
  await runTest(
    "[Regression Gate 1] Race safety: old 401 failure arriving after new session establishment does not clear new credentials",
    async () => {
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
        throw new Error(
          `Old 401 cleared new session credentials! Token is: ${current.token}`,
        );
      }
      if (current.sessionPortalUrl !== attackerPortal) {
        throw new Error(
          `Old 401 cleared new session portal! sessionPortalUrl is: ${current.sessionPortalUrl}`,
        );
      }
    },
  );

  // 25. [Regression Gate 1] Independent redirect: auth:verify rejects 302/307/308 redirects with 0 requests to B
  await runTest(
    "[Regression Gate 1] Independent redirect: auth:verify rejects 302/307/308 redirects with 0 requests to B",
    async () => {
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
          throw new Error(
            `Expected 1 verify request at Origin A for ${code}, got ${capturedRequestsA.length}`,
          );
        }
        if (capturedRequests.length !== 0) {
          throw new Error(
            `Requests leaked to Destination B during verify ${code}! Captured: ${JSON.stringify(capturedRequests)}`,
          );
        }
      }
      serverARedirectVerifyToB = 0;
    },
  );

  // 26. [Regression Gate 1] Independent redirect: auth:refresh rejects 302/307/308 redirects with 0 requests to B
  await runTest(
    "[Regression Gate 1] Independent redirect: auth:refresh rejects 302/307/308 redirects with 0 requests to B",
    async () => {
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
          throw new Error(
            `Expected 1 refresh request at Origin A for ${code}, got ${capturedRequestsA.length}`,
          );
        }
        if (capturedRequests.length !== 0) {
          throw new Error(
            `Requests leaked to Destination B during refresh ${code}! Captured: ${JSON.stringify(capturedRequests)}`,
          );
        }
      }
      serverARedirectRefreshToB = 0;
    },
  );

  // 27. [Regression Gate 1] Independent redirect: auth token exchange rejects 302/307/308 redirects with 0 requests to B
  await runTest(
    "[Regression Gate 1] Independent redirect: auth token exchange rejects 302/307/308 redirects with 0 requests to B",
    async () => {
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
          throw new Error(
            `Expected token exchange to fail on ${code} redirect`,
          );
        }
        if (capturedRequestsA.length !== 1) {
          throw new Error(
            `Expected 1 exchange request at Origin A for ${code}, got ${capturedRequestsA.length}`,
          );
        }
        if (capturedRequests.length !== 0) {
          throw new Error(
            `Requests reached Destination B during exchange ${code}! Captured: ${JSON.stringify(capturedRequests)}`,
          );
        }
      }
      serverARedirectExchangeToB = 0;
    },
  );

  // 28. [Regression Gate 1] Independent redirect: server status metadata endpoint rejects 302/307/308 redirects with 0 requests to B
  await runTest(
    "[Regression Gate 1] Independent redirect: server status metadata endpoint rejects 302/307/308 redirects with 0 requests to B",
    async () => {
      for (const code of [302, 307, 308]) {
        ConfigManager.establishSession(originAPortal, {
          token: `status-tok-${code}`,
        });
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
          throw new Error(
            `Expected ServerStatusClient.getStatus to reject ${code} redirect`,
          );
        }
        if (capturedRequestsA.length !== 1) {
          throw new Error(
            `Expected 1 status request at Origin A for ${code}, got ${capturedRequestsA.length}`,
          );
        }
        if (capturedRequests.length !== 0) {
          throw new Error(
            `Requests leaked to Destination B during status ${code}! Captured: ${JSON.stringify(capturedRequests)}`,
          );
        }
      }
      serverARedirectStatusToB = 0;
    },
  );

  // 33. [Regression Gate 1] Local fallback fixture: positive control proves fallback is valid, reachable, and succeeds on non-redirect error
  await runTest(
    "[Regression Gate 1] Local fallback fixture: positive control proves fallback is valid, reachable, and succeeds on non-redirect error",
    async () => {
      ConfigManager.establishSession(originAPortal, {
        token: "fallback-pos-control-token",
      });
      serverAFailChannelWith500 = true;
      capturedRequests = [];
      capturedRequestsA = [];

      const stateDir = path.join(gameDir, ".lampas");
      if (fs.existsSync(stateDir))
        fs.rmSync(stateDir, { recursive: true, force: true });

      enableControlledFallbackFixture = true;

      try {
        const result = await LauncherSync.syncClient(() => {});
        if (!result || result.success !== true) {
          throw new Error(
            `Expected syncClient to succeed via local fallback, got: ${JSON.stringify(result)}`,
          );
        }
        if (result.version !== "2.0.0-offline") {
          throw new Error(
            `Expected fallback version '2.0.0-offline', got: ${result.version}`,
          );
        }
        const stateFile = path.join(gameDir, ".lampas", "installation.json");
        if (!fs.existsSync(stateFile)) {
          throw new Error(
            "Installation state was not written by successful fallback sync",
          );
        }
        const saved = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        if (saved.version !== "2.0.0-offline") {
          throw new Error(
            `Expected saved installation version '2.0.0-offline', got: ${saved.version}`,
          );
        }
        if (
          capturedRequestsA.length !== fileTransferMod.DEFAULT_TRANSFER_ATTEMPTS
        ) {
          throw new Error(
            `Expected ${fileTransferMod.DEFAULT_TRANSFER_ATTEMPTS} retry channel requests to origin A, got ${capturedRequestsA.length}`,
          );
        }
        if (capturedRequests.length !== 0) {
          throw new Error(
            `Requests reached B during fallback: ${JSON.stringify(capturedRequests)}`,
          );
        }
      } finally {
        serverAFailChannelWith500 = false;
        if (fs.existsSync(stateDir))
          fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  // 34. [Regression Gate 1] Independent redirect: channel sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present
  await runTest(
    "[Regression Gate 1] Independent redirect: channel sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present",
    async () => {
      const stateDir = path.join(gameDir, ".lampas");
      if (fs.existsSync(stateDir))
        fs.rmSync(stateDir, { recursive: true, force: true });

      enableControlledFallbackFixture = true;

      for (const code of [302, 307, 308]) {
        ConfigManager.establishSession(originAPortal, {
          token: `chan-tok-${code}`,
        });
        serverARedirectChannelToB = code;
        capturedRequests = [];
        capturedRequestsA = [];

        let policyErr: any = null;
        try {
          await LauncherSync.syncClient(() => {});
        } catch (err: any) {
          policyErr = err;
        }

        if (!policyErr) {
          throw new Error(
            `Expected syncClient to fail on channel ${code} redirect despite local fallback`,
          );
        }
        if (policyErr.name !== "PortalRedirectPolicyError") {
          throw new Error(
            `Expected PortalRedirectPolicyError, got: ${policyErr.name} (${policyErr.message})`,
          );
        }
        if (
          !capturedRequestsA.some((r) => r.url?.startsWith("/api/v1/channels/"))
        ) {
          throw new Error(`Expected channel request at Origin A for ${code}`);
        }
        if (capturedRequests.length !== 0) {
          throw new Error(
            `Requests reached Destination B on channel ${code}! Captured: ${JSON.stringify(capturedRequests)}`,
          );
        }
        const stateFile = path.join(gameDir, ".lampas", "installation.json");
        if (fs.existsSync(stateFile)) {
          throw new Error(
            `Installation state was mutated during rejected channel ${code} redirect!`,
          );
        }
      }
      serverARedirectChannelToB = 0;
    },
  );

  // 35. [Regression Gate 1] Independent redirect: release sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present
  await runTest(
    "[Regression Gate 1] Independent redirect: release sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present",
    async () => {
      const stateDir = path.join(gameDir, ".lampas");
      if (fs.existsSync(stateDir))
        fs.rmSync(stateDir, { recursive: true, force: true });

      enableControlledFallbackFixture = true;

      for (const code of [302, 307, 308]) {
        ConfigManager.establishSession(originAPortal, {
          token: `rel-tok-${code}`,
        });
        serverARedirectReleaseToB = code;
        capturedRequests = [];
        capturedRequestsA = [];

        let policyErr: any = null;
        try {
          await LauncherSync.syncClient(() => {});
        } catch (err: any) {
          policyErr = err;
        }

        if (!policyErr) {
          throw new Error(
            `Expected syncClient to fail on release ${code} redirect despite local fallback`,
          );
        }
        if (policyErr.name !== "PortalRedirectPolicyError") {
          throw new Error(
            `Expected PortalRedirectPolicyError, got: ${policyErr.name} (${policyErr.message})`,
          );
        }
        if (
          !capturedRequestsA.some(
            (r) =>
              r.url?.startsWith("/api/v1/releases/2.0.0") &&
              !r.url?.includes("/client-manifest"),
          )
        ) {
          throw new Error(`Expected release request at Origin A for ${code}`);
        }
        if (capturedRequests.length !== 0) {
          throw new Error(
            `Requests reached Destination B on release ${code}! Captured: ${JSON.stringify(capturedRequests)}`,
          );
        }
        const stateFile = path.join(gameDir, ".lampas", "installation.json");
        if (fs.existsSync(stateFile)) {
          throw new Error(
            `Installation state was mutated during rejected release ${code} redirect!`,
          );
        }
      }
      serverARedirectReleaseToB = 0;
    },
  );

  // 36. [Regression Gate 1] Independent redirect: manifest sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present
  await runTest(
    "[Regression Gate 1] Independent redirect: manifest sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present",
    async () => {
      const stateDir = path.join(gameDir, ".lampas");
      if (fs.existsSync(stateDir))
        fs.rmSync(stateDir, { recursive: true, force: true });

      enableControlledFallbackFixture = true;

      for (const code of [302, 307, 308]) {
        ConfigManager.establishSession(originAPortal, {
          token: `man-tok-${code}`,
        });
        serverARedirectManifestToB = code;
        capturedRequests = [];
        capturedRequestsA = [];

        let policyErr: any = null;
        try {
          await LauncherSync.syncClient(() => {});
        } catch (err: any) {
          policyErr = err;
        }

        if (!policyErr) {
          throw new Error(
            `Expected syncClient to fail on manifest ${code} redirect despite local fallback`,
          );
        }
        if (policyErr.name !== "PortalRedirectPolicyError") {
          throw new Error(
            `Expected PortalRedirectPolicyError, got: ${policyErr.name} (${policyErr.message})`,
          );
        }
        if (
          !capturedRequestsA.some((r) => r.url?.includes("/client-manifest"))
        ) {
          throw new Error(`Expected manifest request at Origin A for ${code}`);
        }
        if (capturedRequests.length !== 0) {
          throw new Error(
            `Requests reached Destination B on manifest ${code}! Captured: ${JSON.stringify(capturedRequests)}`,
          );
        }
        const stateFile = path.join(gameDir, ".lampas", "installation.json");
        if (fs.existsSync(stateFile)) {
          throw new Error(
            `Installation state was mutated during rejected manifest ${code} redirect!`,
          );
        }
      }
      serverARedirectManifestToB = 0;
    },
  );

  // 32. [Regression Gate 1] Legitimate file download follows safe redirect without auth headers
  await runTest(
    "[Regression Gate 1] Legitimate file download follows safe redirect without auth headers",
    async () => {
      const testContent = Buffer.from(
        "legitimate file content from storage CDN",
      );
      const testHash = crypto
        .createHash("sha256")
        .update(testContent)
        .digest("hex");

      serverARedirectBlobUrl = `${attackerPortal}/cdn-storage/test-blob.jar`;
      attackerBlobContent = {
        path: "/cdn-storage/test-blob.jar",
        content: testContent,
      };

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
        },
      );

      const downloadedContent = fs.readFileSync(destPath);
      if (!downloadedContent.equals(testContent)) {
        throw new Error("Downloaded content does not match expected content");
      }

      const cdnReq = capturedRequests.find(
        (r) => r.url === "/cdn-storage/test-blob.jar",
      );
      if (!cdnReq) {
        throw new Error(
          "Destination B (CDN) did not receive the redirected download request",
        );
      }
      if (cdnReq.headers["authorization"] !== undefined) {
        throw new Error(
          `Redirected blob download leaked Authorization header: ${cdnReq.headers["authorization"]}`,
        );
      }

      serverARedirectBlobUrl = "";
      attackerBlobContent = null;
    },
  );

  // 33. [Regression Gate 1] ConfigManager.get performs durable disk scrubbing of unbound tokens on disk
  await runTest(
    "[Regression Gate 1] ConfigManager.get performs durable disk scrubbing of unbound tokens on disk",
    async () => {
      const configFilePath = path.join(userDataDir, "config.json");
      fs.writeFileSync(
        configFilePath,
        JSON.stringify({
          portalUrl: originAPortal,
          token: "unbound-token-on-disk-to-scrub",
          refreshToken: "unbound-refresh-on-disk-to-scrub",
          minecraftAccessToken: "unbound-mc-on-disk-to-scrub",
        }),
        "utf-8",
      );

      ConfigManager.resetForTesting();
      const loaded = ConfigManager.get();
      if (
        loaded.token !== undefined ||
        loaded.refreshToken !== undefined ||
        loaded.minecraftAccessToken !== undefined
      ) {
        throw new Error(
          "ConfigManager.get() did not clear in-memory unbound tokens",
        );
      }

      const onDisk = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
      if (
        onDisk.token !== undefined ||
        onDisk.refreshToken !== undefined ||
        onDisk.minecraftAccessToken !== undefined
      ) {
        throw new Error(
          `Durable disk scrubbing failed: disk still has secrets: ${JSON.stringify(onDisk)}`,
        );
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // Phase 2 Regressions & Security Boundary Tests
  // ═══════════════════════════════════════════════════════════════════════════════

  // 39. [Phase 2 Gate] IPC invocation from unauthorized caller: child frame, unapproved URL, foreign window, and navigated document are rejected
  await runTest(
    "[Phase 2 Gate] IPC invocation from unauthorized caller: child frame, unapproved URL, foreign window, and navigated document are rejected",
    async () => {
      const rawHandler = (ipcHandlers.get("utils:getAppVersion") as any)
        .rawHandler;
      const win = MockBrowserWindow.allWindows[0];

      // 1. Missing or empty event
      let threw = false;
      try {
        await rawHandler({ rawEmptyEvent: true });
      } catch (e: any) {
        threw = true;
        if (
          !e.message.includes("Security violation") &&
          !e.message.includes("Unauthorized IPC caller")
        )
          throw new Error(`Unexpected error: ${e.message}`);
      }
      if (!threw) throw new Error("Expected empty event to be rejected");

      // 2. Child frame / iframe
      threw = false;
      try {
        await rawHandler({
          sender: win.webContents,
          senderFrame: {
            parent: {},
            url: "http://localhost:5173",
            isDestroyed: () => false,
          },
        });
      } catch (e: any) {
        threw = true;
        if (
          !e.message.includes("Security violation") &&
          !e.message.includes("child frames")
        )
          throw new Error(`Unexpected error: ${e.message}`);
      }
      if (!threw) throw new Error("Expected child frame to be rejected");

      // 3. Foreign window/webContents
      threw = false;
      try {
        await rawHandler({
          sender: { id: 999, isDestroyed: () => false },
          senderFrame: {
            parent: null,
            url: "http://localhost:5173",
            isDestroyed: () => false,
          },
        });
      } catch (e: any) {
        threw = true;
        if (
          !e.message.includes("Security violation") &&
          !e.message.includes("caller webContents")
        )
          throw new Error(`Unexpected error: ${e.message}`);
      }
      if (!threw)
        throw new Error("Expected foreign webContents to be rejected");

      // 4. Unapproved document URL
      threw = false;
      try {
        await rawHandler({
          sender: win.webContents,
          senderFrame: {
            parent: null,
            url: "https://attacker.example.com",
            isDestroyed: () => false,
          },
        });
      } catch (e: any) {
        threw = true;
        if (
          !e.message.includes("Security violation") &&
          !e.message.includes("approved")
        )
          throw new Error(`Unexpected error: ${e.message}`);
      }
      if (!threw)
        throw new Error("Expected unapproved document URL to be rejected");

      // 5. Blank document
      threw = false;
      try {
        await rawHandler({
          sender: win.webContents,
          senderFrame: {
            parent: null,
            url: "about:blank",
            isDestroyed: () => false,
          },
        });
      } catch (e: any) {
        threw = true;
        if (
          !e.message.includes("Security violation") &&
          !e.message.includes("blank")
        )
          throw new Error(`Unexpected error: ${e.message}`);
      }
      if (!threw)
        throw new Error("Expected about:blank document to be rejected");

      // 6. In-window navigation desync
      win.webContents.url = "http://localhost:5173/navigated";
      threw = false;
      try {
        await rawHandler({
          sender: win.webContents,
          senderFrame: {
            parent: null,
            url: "http://localhost:5173",
            isDestroyed: () => false,
          },
        });
      } catch (e: any) {
        threw = true;
        if (
          !e.message.includes("Security violation") &&
          !e.message.includes("navigated")
        )
          throw new Error(`Unexpected error: ${e.message}`);
      }
      win.webContents.url = "http://localhost:5173";
      if (!threw) throw new Error("Expected navigated desync to be rejected");
    },
  );

  // 40. [Phase 2 Gate] Schema enforcement: config:set and path channels reject unknown keys and invalid types
  await runTest(
    "[Phase 2 Gate] Schema enforcement: config:set and path channels reject unknown keys and invalid types",
    async () => {
      const configHandler = ipcHandlers.get("config:set")!;
      const knownHandler = ipcHandlers.get("utils:openKnownLocation")!;

      // 1. Unknown settings keys rejected
      const forbiddenKeys = [
        "gameDir",
        "gameDirConfigured",
        "token",
        "refreshToken",
        "minecraftAccessToken",
        "sessionPortalUrl",
        "evilField",
      ];
      for (const key of forbiddenKeys) {
        let threw = false;
        try {
          await configHandler({}, { [key]: "forbidden" });
        } catch (e: any) {
          threw = true;
          if (!e.message.includes("Unknown or unauthorized settings field"))
            throw new Error(`Unexpected error for ${key}: ${e.message}`);
        }
        if (!threw)
          throw new Error(
            `Expected config:set to reject unknown field '${key}'`,
          );
      }

      // 2. Invalid types rejected
      const invalidPayloads = [
        { portalUrl: "" },
        { portalUrl: 123 },
        { selectedChannel: "nightly" },
        { allocatedRamGb: 1 },
        { allocatedRamGb: 128 },
        { allocatedRamGb: 4.5 },
        { noSync: "false" },
      ];
      for (const p of invalidPayloads) {
        let threw = false;
        try {
          await configHandler({}, p);
        } catch (e: any) {
          threw = true;
        }
        if (!threw)
          throw new Error(
            `Expected config:set to reject invalid payload ${JSON.stringify(p)}`,
          );
      }

      // 3. Invalid known location identifier rejected
      let threw = false;
      try {
        await knownHandler({}, "secretPasswords");
      } catch (e: any) {
        threw = true;
        if (!e.message.includes("Invalid known location"))
          throw new Error(`Unexpected error: ${e.message}`);
      }
      if (!threw)
        throw new Error(
          "Expected utils:openKnownLocation to reject unknown location identifier",
        );
    },
  );

  // 41. [Phase 2 Gate] Launch execution is main-owned: ignores renderer-supplied user and release overrides
  await runTest(
    "[Phase 2 Gate] Launch execution is main-owned: ignores renderer-supplied user and release overrides",
    async () => {
      const launchHandler = ipcHandlers.get("game:launch")!;

      // Case A: Unauthenticated launch attempt fails closed even if caller passes fake user
      ConfigManager.resetForTesting();
      let threw = false;
      try {
        await launchHandler(
          {},
          {
            id: "fake-user",
            name: "Attacker",
            minecraftUuid: "12345678-1234-1234-1234-123456789abc",
            minecraftUsername: "Attacker",
          },
          { fakeRelease: true },
        );
      } catch (e: any) {
        threw = true;
        if (
          !e.message.includes("Authentication required") &&
          !e.message.includes("Session expired")
        ) {
          throw new Error(`Unexpected launch rejection message: ${e.message}`);
        }
      }
      if (!threw)
        throw new Error(
          "Expected unauthenticated launch to fail closed regardless of renderer-supplied user",
        );

      // Case B: Even with established session, renderer-supplied user and release override are completely ignored
      ConfigManager.establishSession(originAPortal, {
        token: "valid-session-token",
        refreshToken: "valid-refresh-token",
      });

      // Mock release on disk
      const lampasDir = path.join(gameDir, ".lampas");
      fs.mkdirSync(lampasDir, { recursive: true });
      const releaseOnDisk = {
        pack: "Lampas Real Pack",
        version: "2.0.0",
        protocol: 3,
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        manifestId: "real-manifest-1",
        files: [],
        mods: [],
      };
      fs.writeFileSync(
        path.join(lampasDir, "release.json"),
        JSON.stringify(releaseOnDisk),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(lampasDir, "installation.json"),
        JSON.stringify({
          version: "2.0.0",
          syncGeneration: "sync-1",
        }),
        "utf-8",
      );
    },
  );

  // 42. [Phase 2 Gate] Mod authority: official mod disablement rejected when catalog prohibits it
  await runTest(
    "[Phase 2 Gate] Mod authority: official mod disablement rejected when catalog prohibits it",
    async () => {
      const toggleHandler = ipcHandlers.get("mods:setOfficialEnabled")!;

      // Attempting to disable a required/non-client or unknown official mod
      let threw = false;
      try {
        await toggleHandler({}, "unknown-mod-id", false);
      } catch (e: any) {
        threw = true;
        if (!e.message.includes("Cannot disable unknown official mod")) {
          throw new Error(`Unexpected error: ${e.message}`);
        }
      }
      if (!threw)
        throw new Error(
          "Expected disablement of unknown official mod to fail closed",
        );

      // Re-enabling an official mod is safe and succeeds
      const enabledList = await toggleHandler({}, "test-mod", true);
      if (!Array.isArray(enabledList)) {
        throw new Error("Expected array of disabled mods");
      }
    },
  );

  // 43. [Phase 2 Gate] Custom mod import validation and destination confinement
  await runTest(
    "[Phase 2 Gate] Custom mod import validation and destination confinement",
    async () => {
      const addPathsHandler = ipcHandlers.get("mods:addPaths")!;

      // 1. Non-jar file rejected by schema
      let threw = false;
      try {
        await addPathsHandler({}, ["C:\\evil\\payload.exe"]);
      } catch (e: any) {
        threw = true;
        if (!e.message.includes(".jar extension"))
          throw new Error(`Unexpected error: ${e.message}`);
      }
      if (!threw) throw new Error("Expected non-jar mod import to be rejected");

      // 2. Empty array rejected
      threw = false;
      try {
        await addPathsHandler({}, []);
      } catch (e: any) {
        threw = true;
      }
      if (!threw)
        throw new Error("Expected empty mod paths array to be rejected");

      // 3. Verify single-use approvals
      const tempModFile = path.join(testRoot, "valid-mod.jar");
      fs.writeFileSync(tempModFile, "PK\x03\x04fake-jar-data", "utf-8");

      IpcBoundary.grantApproval("mod:import", tempModFile);
      if (!IpcBoundary.hasApproval("mod:import", tempModFile)) {
        throw new Error("Approval was not registered");
      }

      // Single-use: consuming approval removes it
      const consumed = IpcBoundary.consumeApproval("mod:import", tempModFile);
      if (!consumed) throw new Error("Failed to consume approval");
      if (IpcBoundary.hasApproval("mod:import", tempModFile)) {
        throw new Error("Approval was not consumed single-use");
      }
    },
  );

  // 44. [Phase 2 Gate] Native approval enforcement for privileged path selection and javaArgs
  await runTest(
    "[Phase 2 Gate] Native approval enforcement for privileged path selection and javaArgs",
    async () => {
      // 1. Privileged Java arguments detection
      const privilegedCases = [
        "-javaagent:C:\\evil\\agent.jar",
        "-agentlib:jdwp",
        "-agentpath:C:\\evil\\lib.dll",
        "@C:\\evil\\args.txt",
        "-cp",
        "--class-path",
        "--module-path",
        "-Djava.system.class.loader=com.evil.Loader",
        "-Xbootclasspath:C:\\evil",
      ];

      for (const arg of privilegedCases) {
        if (!isPrivilegedJavaArg(arg)) {
          throw new Error(`Expected isPrivilegedJavaArg to flag: ${arg}`);
        }
      }

      const benignCases = [
        "-Xmx4G",
        "-Xms2G",
        "-XX:+UseG1GC",
        "-Dfile.encoding=UTF-8",
      ];

      for (const arg of benignCases) {
        if (isPrivilegedJavaArg(arg)) {
          throw new Error(
            `Expected isPrivilegedJavaArg to NOT flag benign arg: ${arg}`,
          );
        }
      }

      // 2. Native approval registry: target normalization and TTL
      const targetDir = path.join(testRoot, "custom-game-dir");
      IpcBoundary.grantApproval("gameDir:target", targetDir, { ttlMs: 100 });
      if (!IpcBoundary.hasApproval("gameDir:target", targetDir)) {
        throw new Error("Approval should exist immediately");
      }

      // Expired TTL check
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (IpcBoundary.hasApproval("gameDir:target", targetDir)) {
        throw new Error("Expired approval was not invalidated");
      }
    },
  );

  // 45. [Phase 2 Gate] Packaged build ignores dev-server environment variables and enforces strict document validation
  await runTest(
    "[Phase 2 Gate] Packaged build ignores dev-server environment variables and enforces strict document validation",
    async () => {
      const originalPolicy = IpcBoundary.getStartupPolicy();
      const win = MockBrowserWindow.allWindows[0];

      try {
        IpcBoundary.initializeStartupPolicy({
          isPackaged: true,
          devEndpoint: undefined,
          appPath: testRoot,
        });

        // In packaged production, HTTP loopback URL is rejected
        let threw = false;
        try {
          win.webContents.url = "http://localhost:5173";
          IpcBoundary.validateIpcSender({
            sender: win.webContents,
            senderFrame: win.webContents.mainFrame,
          } as any);
        } catch (e: any) {
          threw = true;
          if (
            !e.message.includes("prohibited in packaged production") &&
            !e.message.includes("Packaged application requires file:// URL")
          ) {
            throw new Error(
              `Unexpected error message in packaged production: ${e.message}`,
            );
          }
        }
        if (!threw)
          throw new Error(
            "Expected packaged production to reject http:// renderer URL",
          );
      } finally {
        if (originalPolicy) {
          IpcBoundary.initializeStartupPolicy(originalPolicy);
        }
      }
    },
  );

  // 46. [Phase 2 Positive Path] End-to-end authorized operations: configuration, mod toggles, and approved tuning succeed
  await runTest(
    "[Phase 2 Positive Path] End-to-end authorized operations: configuration, mod toggles, and approved tuning succeed",
    async () => {
      const configHandler = ipcHandlers.get("config:set")!;
      const getHandler = ipcHandlers.get("config:get")!;

      // 1. Authorized configuration update
      const updated = await configHandler(
        {},
        {
          selectedChannel: "dev",
          allocatedRamGb: 6,
          noSync: true,
          javaArgs: "-Xmx6G -XX:+UseG1GC",
        },
      );

      if (
        updated.selectedChannel !== "dev" ||
        updated.allocatedRamGb !== 6 ||
        updated.noSync !== true
      ) {
        throw new Error(`Config update failed: ${JSON.stringify(updated)}`);
      }

      const retrieved = await getHandler({});
      if (
        retrieved.selectedChannel !== "dev" ||
        retrieved.allocatedRamGb !== 6 ||
        retrieved.noSync !== true
      ) {
        throw new Error(
          `Config retrieval mismatch: ${JSON.stringify(retrieved)}`,
        );
      }

      // 2. Verify window status handlers
      const isMaximizedHandler = ipcHandlers.get("window:isMaximized")!;
      const isMax = await isMaximizedHandler({});
      if (typeof isMax !== "boolean") {
        throw new Error("Expected window:isMaximized to return boolean");
      }
    },
  );

  // 47. [Phase 2 Gate] Complete Java-argument privilege classification across full taxonomy
  await runTest(
    "[Phase 2 Gate] Complete Java-argument privilege classification across full taxonomy",
    async () => {
      // 1. Launch target override detection across complete taxonomy (positional, -jar, @args, --module, --source, operands, launch authority properties)
      const targetOverrideCases = [
        "-jar evil.jar",
        "-jar=evil.jar",
        "com.evil.MainClass",
        "Script.java",
        "--source 17 Script.java",
        "--source=17 Script.java",
        "--module=evil/com.evil.Main",
        "-m=evil/com.evil.Main",
        "--module evil/com.evil.Main",
        "-m evil/com.evil.Main",
        "@/path/to/args.txt",
        "@C:\\evil\\args.txt",
        "@args.txt",
        // Prohibited argument files following classpath and module options (separate-token and equals forms)
        "-cp @args.txt",
        "-classpath @args.txt",
        "--class-path @args.txt",
        "--class-path=@args.txt",
        "-cp=@args.txt",
        "-p @args.txt",
        "--module-path @args.txt",
        "--module-path=@args.txt",
        "-p=@args.txt",
        "--upgrade-module-path @args.txt",
        "--upgrade-module-path=@args.txt",
        "--patch-module mod=@args.txt",
        "--patch-module=mod=@args.txt",
        "-cp /lib/foo.jar:@args.txt",
        "--class-path=/lib/foo.jar;@args.txt",
        // Prohibited launch authority and native-library search path system properties (prohibited fail-closed, not merely confirmation-gated)
        "-Djava.library.path=/evil/lib",
        "-Dfabric.addMods=/evil/mod.jar",
        "-Dfabric.modsFolder=/custom/mods",
        "-Dquilt.addMods=/evil/mod.jar",
        "-Dforge.modsFolder=/custom/mods",
        "-Dneoforge.modsFolder=/custom/mods",
        "-Dorg.lwjgl.librarypath=/evil/lib",
        "-Dminecraft.applet.TargetDirectory=/evil",
        "-Djava.system.class.loader=com.evil.Loader",
        "-Djava.security.manager=default",
        "-Dcom.sun.management.jmxremote",
        "-Djdk.module.main=com.evil.Main",
      ];
      for (const raw of targetOverrideCases) {
        const tokens = parseJavaArgs(raw);
        const res = classifyJavaArgs(tokens);
        if (!res.hasLaunchTargetOverride) {
          throw new Error(
            `Expected classifyJavaArgs to detect launch target override in: ${raw}`,
          );
        }
      }

      // 2. Sensitive / privileged options detection: separate-token & equals forms receive equivalent decisions
      const privilegedCases = [
        // Equals forms
        "--upgrade-module-path=/evil/mods",
        "--patch-module=java.base=/evil/patch",
        "--add-reads=java.base=ALL-UNNAMED",
        "--add-exports=java.base/sun.security.x509=ALL-UNNAMED",
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
        "--class-path=/evil/classes",
        "--module-path=/evil/modules",
        // Separate-token forms
        "--upgrade-module-path /evil/mods",
        "--patch-module java.base=/evil/patch",
        "--add-reads java.base=ALL-UNNAMED",
        "--add-exports java.base/sun.security.x509=ALL-UNNAMED",
        "--add-opens java.base/java.lang=ALL-UNNAMED",
        "-cp /evil/classes",
        "--class-path /evil/classes",
        "-classpath /evil/classes",
        "-p /evil/modules",
        "--module-path /evil/modules",
        // Agents, native hooks, debuggers
        "-javaagent:C:\\agent.jar",
        "-agentlib:jdwp=transport=dt_socket",
        "-agentpath:/lib/libevil.so",
        "-Xbootclasspath:/evil/boot",
        '-XX:OnError="cmd.exe /c calc.exe"',
        '-XX:OnOutOfMemoryError="calc.exe"',
        '-XX:ErrorFile="C:\\evil\\dump.log"',
        // Unknown properties require native approval
        "-Dcustom.feature.flag=true",
        "-Dmy.unknown.opt=123",
      ];
      for (const raw of privilegedCases) {
        const tokens = parseJavaArgs(raw);
        const res = classifyJavaArgs(tokens);
        if (!res.isPrivileged) {
          throw new Error(
            `Expected classifyJavaArgs to flag privileged option: ${raw}`,
          );
        }
        if (res.hasLaunchTargetOverride) {
          throw new Error(
            `Expected privileged option to NOT be flagged as launch target override: ${raw}`,
          );
        }
      }

      // 3. Reviewed ordinary tuning options permitted without native approval
      const ordinaryTuning =
        "-Xmx8G -Xms2G -XX:+UseG1GC -XX:+UseZGC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:+UseStringDeduplication -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 -Duser.language=en -Duser.country=US -Djava.awt.headless=true -Dorg.lwjgl.util.Debug=false -Dfabric.disableTelemetry=true";
      const ordinaryTokens = parseJavaArgs(ordinaryTuning);
      const ordinaryRes = classifyJavaArgs(ordinaryTokens);
      if (ordinaryRes.hasLaunchTargetOverride || ordinaryRes.isPrivileged) {
        throw new Error(
          `Expected ordinary tuning options to be permitted without approval: ${JSON.stringify(ordinaryRes)}`,
        );
      }

      // 4. Actual settings handler (config:set) rejects launch target override fail-closed even when confirmation mock would approve
      const configHandler = ipcHandlers.get("config:set")!;
      const getHandler = ipcHandlers.get("config:get")!;
      const win = MockBrowserWindow.allWindows[0];
      const event = {
        sender: win.webContents,
        senderFrame: win.webContents.mainFrame,
      };

      const launchTargetOverridesToTest = [
        "-jar evil.jar",
        "com.evil.Main",
        "--module=evil",
        "@args.txt",
        "--source 17 Script.java",
        "-cp @args.txt",
        "--class-path=@args.txt",
        "-p @args.txt",
        "--module-path=@args.txt",
        "--patch-module=mod=@args.txt",
        "--patch-module mod=@args.txt",
        "-Djava.library.path=/evil/lib",
        "-Dfabric.addMods=/evil/mod.jar",
      ];

      for (const overrideArg of launchTargetOverridesToTest) {
        const beforeState = (await getHandler({})).javaArgs;
        let dialogPrompted = false;
        mockDialog.showMessageBox.mockReset();
        mockDialog.showMessageBox.mockImplementationOnce(async () => {
          dialogPrompted = true;
          return { response: 0 };
        });

        let threw = false;
        try {
          await configHandler(event as any, { javaArgs: overrideArg });
        } catch (e: any) {
          threw = true;
          if (
            !e.message.includes(
              "Custom Java arguments cannot override launch target",
            )
          ) {
            throw new Error(
              `Unexpected error message for '${overrideArg}': ${e.message}`,
            );
          }
        }
        if (!threw)
          throw new Error(
            `Expected config:set to reject launch target override: '${overrideArg}'`,
          );
        if (dialogPrompted) {
          throw new Error(
            `Expected config:set to reject '${overrideArg}' before native confirmation dialog`,
          );
        }
        const afterState = (await getHandler({})).javaArgs;
        if (afterState !== beforeState) {
          throw new Error(
            `Launch target override attempt corrupted stored javaArgs: ${afterState} !== ${beforeState}`,
          );
        }
      }

      // 5. Actual settings handler: ordinary tuning permitted without dialog confirmation
      let dialogCalled = false;
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(async () => {
        dialogCalled = true;
        return { response: 0 };
      });
      const ordinaryUpdate = await configHandler(event as any, {
        javaArgs: "-Xmx4G -Dfile.encoding=UTF-8",
      });
      if (dialogCalled) {
        throw new Error(
          "Expected ordinary tuning (-Xmx4G -Dfile.encoding=UTF-8) to succeed without native dialog prompt",
        );
      }
      if (ordinaryUpdate.javaArgs !== "-Xmx4G -Dfile.encoding=UTF-8") {
        throw new Error(
          `Failed to update ordinary javaArgs: ${ordinaryUpdate.javaArgs}`,
        );
      }

      // 6. Actual settings handler requires confirmation for sensitive / unknown properties; cancellation leaves settings unchanged
      const preCancelConfig = (await getHandler({})).javaArgs;
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(async () => ({
        response: 1,
      })); // Cancel
      let cancelThrew = false;
      try {
        await configHandler(event as any, {
          javaArgs: "-Dcustom.unknown.property=123",
        });
      } catch (e: any) {
        cancelThrew = true;
        if (
          !e.message.includes("Privileged Java arguments rejected by user.")
        ) {
          throw new Error(`Unexpected cancellation error: ${e.message}`);
        }
      }
      if (!cancelThrew)
        throw new Error(
          "Expected cancelled privileged option dialog to reject config:set",
        );
      const postCancelConfig = (await getHandler({})).javaArgs;
      if (postCancelConfig !== preCancelConfig) {
        throw new Error(
          `Cancelled dialog must leave settings unchanged! Got '${postCancelConfig}', expected '${preCancelConfig}'`,
        );
      }

      // When confirmed, privileged option succeeds
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(async () => ({
        response: 0,
      })); // Confirm
      const confirmedRes = await configHandler(event as any, {
        javaArgs: "-javaagent:C:\\agent.jar",
      });
      if (confirmedRes.javaArgs !== "-javaagent:C:\\agent.jar") {
        throw new Error(
          `Expected confirmed javaArgs to update, got: ${confirmedRes.javaArgs}`,
        );
      }

      // 7. Process argument sink (buildLaunchArguments) validation
      const dummyRuntime = {
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        launch: {},
      };
      // Benign custom arguments are included in process argument sink
      const benignSinkArgs = buildLaunchArguments({
        gameDir,
        ramGb: 4,
        runtime: dummyRuntime as any,
        assetIndex: "26.2",
        username: "Player",
        uuid: "00000000000000000000000000000001",
        token: "0",
        userType: "legacy",
        customJavaArgs: ["-Xmx4G", "-XX:+UseG1GC", "-Dfile.encoding=UTF-8"],
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        classpathString: "libraries.jar",
      });
      if (
        !benignSinkArgs.includes("-Xmx4G") ||
        !benignSinkArgs.includes("-XX:+UseG1GC") ||
        !benignSinkArgs.includes("-Dfile.encoding=UTF-8")
      ) {
        throw new Error(
          "Expected buildLaunchArguments to include benign custom tuning",
        );
      }

      // Process argument sink rejects launch target overrides fail-closed without process execution
      const sinkBadArgs = [
        ["-jar", "evil.jar"],
        ["com.evil.Main"],
        ["--module=foo"],
        ["--source", "17", "App.java"],
        ["@args.txt"],
        ["-cp", "@args.txt"],
        ["--class-path=@args.txt"],
        ["-p", "@args.txt"],
        ["--module-path=@args.txt"],
        ["--patch-module=mod=@args.txt"],
        ["--patch-module", "mod=@args.txt"],
        ["-Djava.library.path=/evil/lib"],
        ["-Dfabric.addMods=/evil/mod.jar"],
      ];

      for (const badArg of sinkBadArgs) {
        interceptedProcesses.length = 0;
        let sinkThrew = false;
        try {
          buildLaunchArguments({
            gameDir,
            ramGb: 4,
            runtime: dummyRuntime as any,
            assetIndex: "26.2",
            username: "Player",
            uuid: "00000000000000000000000000000001",
            token: "0",
            userType: "legacy",
            customJavaArgs: badArg,
            mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
            classpathString: "libraries.jar",
          });
        } catch (e: any) {
          sinkThrew = true;
          if (
            !e.message.includes(
              "Process argument sink rejected launch target override",
            )
          ) {
            throw new Error(`Unexpected sink error: ${e.message}`);
          }
        }
        if (!sinkThrew)
          throw new Error(
            `Expected buildLaunchArguments to reject: ${badArg.join(" ")}`,
          );
        if (interceptedProcesses.length !== 0) {
          throw new Error(
            `Process argument sink executed process for launch target override: ${badArg.join(" ")}`,
          );
        }
      }
    },
  );

  // 48. [Phase 2 Gate] Document trust independent of load observations and strict sender frame validation
  await runTest(
    "[Phase 2 Gate] Document trust independent of load observations and strict sender frame validation",
    async () => {
      const win = MockBrowserWindow.allWindows[0];
      const originalPolicy = IpcBoundary.getStartupPolicy();

      try {
        IpcBoundary.initializeStartupPolicy({
          isPackaged: false,
          devEndpoint: "http://localhost:5173",
          appPath: testRoot,
        });

        // 1. did-finish-load event does NOT automatically approve arbitrary documents
        win.webContents.url = "data:text/html,<h1>attack</h1>";
        win.webContents.emit("did-finish-load");
        IpcBoundary.onDocumentLoaded();

        let loadThrew = false;
        try {
          IpcBoundary.validateIpcSender({
            sender: win.webContents,
            senderFrame: win.webContents.mainFrame,
          } as any);
        } catch (e: any) {
          loadThrew = true;
          if (
            !e.message.includes("disallowed document scheme") &&
            !e.message.includes("Security violation")
          ) {
            throw new Error(`Unexpected error on data: URL: ${e.message}`);
          }
        }
        if (!loadThrew)
          throw new Error(
            "Expected did-finish-load on data: URL to NOT approve the document",
          );

        // 2. Unapproved dev server URL with wrong port is rejected
        win.webContents.url = "http://localhost:9999";
        win.webContents.emit("did-finish-load");
        IpcBoundary.onDocumentLoaded();

        let portThrew = false;
        try {
          IpcBoundary.validateIpcSender({
            sender: win.webContents,
            senderFrame: win.webContents.mainFrame,
          } as any);
        } catch (e: any) {
          portThrew = true;
          if (
            !e.message.includes("not an approved application document") &&
            !e.message.includes("Security violation")
          ) {
            throw new Error(
              `Unexpected error on unapproved dev port: ${e.message}`,
            );
          }
        }
        if (!portThrew)
          throw new Error("Expected unapproved port 9999 to be rejected");

        // 3. Sender frame not matching active mainFrame is rejected
        win.webContents.url = "http://localhost:5173";
        const detachedFrame = {
          parent: null,
          url: "http://localhost:5173",
          isDestroyed: () => false,
        };
        let frameThrew = false;
        try {
          IpcBoundary.validateIpcSender({
            sender: win.webContents,
            senderFrame: detachedFrame,
          } as any);
        } catch (e: any) {
          frameThrew = true;
          if (
            !e.message.includes("sender frame is not the active main frame")
          ) {
            throw new Error(`Unexpected detached frame error: ${e.message}`);
          }
        }
        if (!frameThrew)
          throw new Error(
            "Expected detached senderFrame !== mainFrame to be rejected",
          );

        // 4. Foreign file-URL authority is rejected
        win.webContents.url = "file://evil.com/app/index.html";
        let foreignFileThrew = false;
        try {
          IpcBoundary.validateIpcSender({
            sender: win.webContents,
            senderFrame: win.webContents.mainFrame,
          } as any);
        } catch (e: any) {
          foreignFileThrew = true;
          if (!e.message.includes("foreign file URL authority")) {
            throw new Error(`Unexpected foreign file URL error: ${e.message}`);
          }
        }
        if (!foreignFileThrew)
          throw new Error("Expected foreign file URL authority to be rejected");
        win.webContents.url = "http://localhost:5173";

        // 5. Missing or destroyed mainFrame fails closed
        const savedMainFrame = win.webContents.mainFrame;
        try {
          (win.webContents as any).mainFrame = null;
          let missingMainFrameThrew = false;
          try {
            IpcBoundary.validateIpcSender({
              sender: win.webContents,
              senderFrame: savedMainFrame,
            } as any);
          } catch (e: any) {
            missingMainFrameThrew = true;
            if (!e.message.includes("missing or destroyed main frame")) {
              throw new Error(
                `Unexpected missing mainFrame error: ${e.message}`,
              );
            }
          }
          if (!missingMainFrameThrew)
            throw new Error("Expected missing mainFrame to fail closed");
        } finally {
          (win.webContents as any).mainFrame = savedMainFrame;
        }

        // 6. Destroyed sender frame fails closed
        const destroyedFrame = {
          ...savedMainFrame,
          parent: null,
          url: "http://localhost:5173",
          isDestroyed: () => true,
        };
        let destroyedFrameThrew = false;
        try {
          IpcBoundary.validateIpcSender({
            sender: win.webContents,
            senderFrame: destroyedFrame,
          } as any);
        } catch (e: any) {
          destroyedFrameThrew = true;
          if (
            !e.message.includes("destroyed") &&
            !e.message.includes("detached") &&
            !e.message.includes("Security violation")
          ) {
            throw new Error(`Unexpected destroyed frame error: ${e.message}`);
          }
        }
        if (!destroyedFrameThrew)
          throw new Error("Expected destroyed sender frame to fail closed");

        // 7. Destroyed WebContents fails closed
        const origIsDestroyed = win.webContents.isDestroyed;
        win.webContents.isDestroyed = () => true;
        let destroyedWebContentsThrew = false;
        try {
          IpcBoundary.validateIpcSender({
            sender: win.webContents,
            senderFrame: savedMainFrame,
          } as any);
        } catch (e: any) {
          destroyedWebContentsThrew = true;
          if (
            !e.message.includes("webContents is unavailable or destroyed") &&
            !e.message.includes("Security violation")
          ) {
            throw new Error(
              `Unexpected destroyed webContents error: ${e.message}`,
            );
          }
        } finally {
          win.webContents.isDestroyed = origIsDestroyed;
        }
        if (!destroyedWebContentsThrew)
          throw new Error("Expected destroyed WebContents to fail closed");

        // 8. Explicit detached sender frame fails closed at entry
        const detachedEntrySender = {
          ...savedMainFrame,
          detached: true,
          parent: null,
          url: "http://localhost:5173",
          isDestroyed: () => false,
        };
        let detachedSenderThrew = false;
        try {
          IpcBoundary.validateIpcSender({
            sender: win.webContents,
            senderFrame: detachedEntrySender,
          } as any);
        } catch (e: any) {
          detachedSenderThrew = true;
          if (!e.message.includes("sender frame is detached")) {
            throw new Error(
              `Unexpected error on detached sender frame: ${e.message}`,
            );
          }
        }
        if (!detachedSenderThrew)
          throw new Error(
            "Expected detached sender frame at entry to fail closed",
          );

        // 9. Explicit detached main frame fails closed at entry
        const detachedEntryMain = {
          ...savedMainFrame,
          detached: true,
          parent: null,
          url: "http://localhost:5173",
          isDestroyed: () => false,
        };
        try {
          (win.webContents as any).mainFrame = detachedEntryMain;
          let detachedMainThrew = false;
          try {
            IpcBoundary.validateIpcSender({
              sender: win.webContents,
              senderFrame: savedMainFrame,
            } as any);
          } catch (e: any) {
            detachedMainThrew = true;
            if (!e.message.includes("main frame is detached")) {
              throw new Error(
                `Unexpected error on detached main frame: ${e.message}`,
              );
            }
          }
          if (!detachedMainThrew)
            throw new Error(
              "Expected detached main frame at entry to fail closed",
            );
        } finally {
          (win.webContents as any).mainFrame = savedMainFrame;
        }
      } finally {
        win.webContents.url = "http://localhost:5173";
        if (originalPolicy) {
          IpcBoundary.initializeStartupPolicy(originalPolicy);
        }
      }
    },
  );

  // 49. [Phase 2 Gate] Native approval binding: snapshot revalidation, operation barriers, single-use, and case normalization
  await runTest(
    "[Phase 2 Gate] Native approval binding: snapshot revalidation, operation barriers, single-use, and case normalization",
    async () => {
      const win = MockBrowserWindow.allWindows[0];
      const event = {
        sender: win.webContents,
        senderFrame: win.webContents.mainFrame,
      };

      // 1. Generation equality checks across actual generations below (15), at (50), and above (75)
      // with controlled clock (Date.now mock); verify 60s lifetime (+30s valid, +59s valid, +61s expired),
      // stale/future rejection, expiry, and single-use behavior.
      const originalGen = IpcBoundary.getDocumentGeneration();
      try {
        for (const testGen of [15, 50, 75]) {
          IpcBoundary.setDocumentGeneration(testGen);
          const testTarget = path.join(testRoot, `target-gen-${testGen}`);

          // A. Stale generation (below current) rejects fail-closed
          let staleThrew = false;
          try {
            IpcBoundary.grantApproval("gameDir:target", testTarget, {
              generation: testGen - 1,
            });
          } catch (e: any) {
            staleThrew = true;
            if (!e.message.includes("Approval generation mismatch")) {
              throw new Error(
                `Unexpected stale generation error: ${e.message}`,
              );
            }
          }
          if (!staleThrew)
            throw new Error(
              `Expected stale generation (${testGen - 1}) to reject for current ${testGen}`,
            );

          // B. Future generation (above current) rejects fail-closed
          let futureThrew = false;
          try {
            IpcBoundary.grantApproval("gameDir:target", testTarget, {
              generation: testGen + 1,
            });
          } catch (e: any) {
            futureThrew = true;
            if (!e.message.includes("Approval generation mismatch")) {
              throw new Error(
                `Unexpected future generation error: ${e.message}`,
              );
            }
          }
          if (!futureThrew)
            throw new Error(
              `Expected future generation (${testGen + 1}) to reject for current ${testGen}`,
            );

          // C. Controlled clock verification for 60s TTL (+30s valid, +59s valid, +61s expired)
          const baseTime = 1_700_000_000_000;
          let mockNow = baseTime;
          const dateSpy = spyOn(Date, "now").mockImplementation(() => mockNow);

          try {
            // Grant approval at t0
            IpcBoundary.grantApproval("gameDir:target", testTarget, {
              generation: testGen,
            });

            // +30s: valid
            mockNow = baseTime + 30_000;
            if (!IpcBoundary.hasApproval("gameDir:target", testTarget)) {
              throw new Error(
                `Expected approval to be valid at +30s for gen ${testGen}`,
              );
            }

            // +59s: valid
            mockNow = baseTime + 59_000;
            if (!IpcBoundary.hasApproval("gameDir:target", testTarget)) {
              throw new Error(
                `Expected approval to be valid at +59s for gen ${testGen}`,
              );
            }

            // +61s: expired
            mockNow = baseTime + 61_000;
            if (IpcBoundary.hasApproval("gameDir:target", testTarget)) {
              throw new Error(
                `Expected approval to be expired at +61s for gen ${testGen}`,
              );
            }

            // D. Single-use behavior
            mockNow = baseTime + 10_000;
            IpcBoundary.grantApproval("gameDir:target", testTarget, {
              generation: testGen,
            });
            const firstConsume = IpcBoundary.consumeApproval(
              "gameDir:target",
              testTarget,
            );
            const secondConsume = IpcBoundary.consumeApproval(
              "gameDir:target",
              testTarget,
            );
            if (!firstConsume)
              throw new Error(
                `Expected first consumeApproval to succeed for gen ${testGen}`,
              );
            if (secondConsume)
              throw new Error(
                `Expected second consumeApproval to fail (single-use) for gen ${testGen}`,
              );
          } finally {
            dateSpy.mockRestore();
          }
        }
      } finally {
        IpcBoundary.setDocumentGeneration(originalGen);
      }

      // 2. Snapshot revalidation: document generation invalidation while awaiting confirmation
      const snapshot = IpcBoundary.createApprovalSnapshot(event as any);
      IpcBoundary.onNavigation(); // Navigation occurs
      let navThrew = false;
      try {
        IpcBoundary.validateApprovalSnapshot(snapshot);
      } catch (e: any) {
        navThrew = true;
        if (
          !e.message.includes(
            "Document generation changed while awaiting native user approval.",
          )
        ) {
          throw new Error(`Unexpected generation mismatch error: ${e.message}`);
        }
      }
      if (!navThrew)
        throw new Error(
          "Expected snapshot revalidation to fail on document generation change",
        );

      // 3. Snapshot revalidation: frame detachment while awaiting native approval
      // A. Snapshot frame detached after deferred dialog
      const snapshotDetached = IpcBoundary.createApprovalSnapshot(event as any);
      snapshotDetached.frame = {
        ...snapshotDetached.frame,
        detached: true,
      } as any;
      let snapDetachedThrew = false;
      try {
        IpcBoundary.validateApprovalSnapshot(snapshotDetached);
      } catch (e: any) {
        snapDetachedThrew = true;
        if (
          !e.message.includes(
            "Sender frame detached while awaiting native user approval.",
          )
        ) {
          throw new Error(
            `Unexpected error on detached snapshot frame: ${e.message}`,
          );
        }
      }
      if (!snapDetachedThrew)
        throw new Error("Expected detached snapshot frame to fail closed");

      // B. Active main frame detached after deferred dialog
      const snapshotMainDetached = IpcBoundary.createApprovalSnapshot(
        event as any,
      );
      try {
        (win.webContents.mainFrame as any).detached = true;
        let snapMainDetachedThrew = false;
        try {
          IpcBoundary.validateApprovalSnapshot(snapshotMainDetached);
        } catch (e: any) {
          snapMainDetachedThrew = true;
          if (
            !e.message.includes(
              "Active main frame detached while awaiting native user approval.",
            )
          ) {
            throw new Error(
              `Unexpected error on detached active main frame: ${e.message}`,
            );
          }
        }
        if (!snapMainDetachedThrew)
          throw new Error("Expected detached active main frame to fail closed");
      } finally {
        (win.webContents.mainFrame as any).detached = false;
      }

      // 4. Deferred native dialogs on actual handlers: Navigation during dialog in gameDir:browse
      const browseHandler = ipcHandlers.get("gameDir:browse")!;
      let resolveDialog!: (val: {
        canceled: boolean;
        filePaths: string[];
      }) => void;
      const dialogPromise = new Promise<{
        canceled: boolean;
        filePaths: string[];
      }>((resolve) => {
        resolveDialog = resolve;
      });
      mockDialog.showOpenDialog.mockImplementationOnce(() => dialogPromise);

      const browsePromise = browseHandler(event as any);
      await new Promise((r) => setTimeout(r, 10));
      // While dialog is awaiting, navigation occurs:
      IpcBoundary.onNavigation();
      const testDirChoice = path.join(testRoot, "nav-during-dialog");
      resolveDialog({ canceled: false, filePaths: [testDirChoice] });

      let browseNavThrew = false;
      try {
        await browsePromise;
      } catch (e: any) {
        browseNavThrew = true;
        if (
          !e.message.includes("Document generation changed") &&
          !e.message.includes("Security violation")
        ) {
          throw new Error(
            `Unexpected deferred dialog navigation error: ${e.message}`,
          );
        }
      }
      if (!browseNavThrew)
        throw new Error(
          "Expected navigation during deferred dialog to fail closed",
        );
      if (IpcBoundary.hasApproval("gameDir:target", testDirChoice)) {
        throw new Error(
          "Approval was granted despite navigation during dialog!",
        );
      }

      // 5. Deferred native dialogs on actual handlers: config:set
      const configHandler = ipcHandlers.get("config:set")!;
      const getHandler = ipcHandlers.get("config:get")!;
      const preConflictJavaArgs = (await getHandler({})).javaArgs;
      let resolveMsgBox!: (val: { response: number }) => void;
      const msgBoxPromise = new Promise<{ response: number }>((resolve) => {
        resolveMsgBox = resolve;
      });
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(() => msgBoxPromise);

      const configPromise = configHandler(event as any, {
        javaArgs: "-Dcustom.deferred.flag=1",
      });
      await new Promise((r) => setTimeout(r, 10));
      // While dialog is awaiting, conflicting operation starts:
      const activeSync = OperationCoordinator.acquire(
        "sync",
        "Background modpack synchronization active",
      );
      resolveMsgBox({ response: 0 }); // User clicked confirm, but background operation is active

      let conflictOpThrew = false;
      try {
        await configPromise;
      } catch (e: any) {
        conflictOpThrew = true;
        if (!e.message.includes("is currently in progress")) {
          throw new Error(`Unexpected conflict op error: ${e.message}`);
        }
      } finally {
        activeSync.release();
      }
      if (!conflictOpThrew)
        throw new Error(
          "Expected conflicting operation during dialog to reject config:set",
        );
      const postConflictJavaArgs = (await getHandler({})).javaArgs;
      if (postConflictJavaArgs !== preConflictJavaArgs) {
        throw new Error("Conflicting operation during dialog modified config!");
      }

      // config:set cancellation
      const preCancelJavaArgs = (await getHandler({})).javaArgs;
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(async () => ({
        response: 1,
      })); // Cancel
      let cancelThrew = false;
      try {
        await configHandler(event as any, {
          javaArgs: "-Dcustom.cancel.flag=2",
        });
      } catch (e: any) {
        cancelThrew = true;
        if (
          !e.message.includes("Privileged Java arguments rejected by user.")
        ) {
          throw new Error(`Unexpected cancellation error: ${e.message}`);
        }
      }
      if (!cancelThrew)
        throw new Error(
          "Expected cancelled privileged option dialog to reject config:set",
        );
      const postCancelJavaArgs = (await getHandler({})).javaArgs;
      if (postCancelJavaArgs !== preCancelJavaArgs) {
        throw new Error("Cancelled dialog must leave config unchanged!");
      }

      // config:set missing dialog fails closed
      const originalMessageBox = mockDialog.showMessageBox;
      delete (mockDialog as any).showMessageBox;
      let missingDialogThrew = false;
      try {
        await configHandler(event as any, {
          javaArgs: "-Dcustom.missing.flag=3",
        });
      } catch (e: any) {
        missingDialogThrew = true;
        if (
          !e.message.includes("Native dialog service unavailable") &&
          !e.message.includes("Security violation")
        ) {
          throw new Error(`Unexpected missing dialog error: ${e.message}`);
        }
      } finally {
        mockDialog.showMessageBox = originalMessageBox;
      }
      if (!missingDialogThrew)
        throw new Error("Expected missing dialog service to fail closed");

      // config:set confirmed succeeds
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(async () => ({
        response: 0,
      }));
      const validConfirmed = await configHandler(event as any, {
        javaArgs: "-Dcustom.confirmed.flag=4",
      });
      if (validConfirmed.javaArgs !== "-Dcustom.confirmed.flag=4") {
        throw new Error(
          `Failed to apply confirmed config: ${validConfirmed.javaArgs}`,
        );
      }

      // 6. Deferred native dialogs on actual handlers: gameDir:configure
      const configureHandler = ipcHandlers.get("gameDir:configure")!;
      const testConfigureDir = path.join(testRoot, "deferred-configure-target");

      // A. Cancellation of configure dialog
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(async () => ({
        response: 1,
      })); // Cancel
      let configureCancelThrew = false;
      try {
        await configureHandler(event as any, testConfigureDir);
      } catch (e: any) {
        configureCancelThrew = true;
        if (!e.message.includes("Configuration cancelled by user.")) {
          throw new Error(
            `Unexpected configure cancellation error: ${e.message}`,
          );
        }
      }
      if (!configureCancelThrew)
        throw new Error(
          "Expected cancelled configure dialog to throw UserCancelledError",
        );

      // B. Conflicting operation during configure dialog
      let resolveCfgBox!: (val: { response: number }) => void;
      const cfgBoxPromise = new Promise<{ response: number }>((resolve) => {
        resolveCfgBox = resolve;
      });
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(() => cfgBoxPromise);
      const cfgPromise = configureHandler(event as any, testConfigureDir);
      await new Promise((r) => setTimeout(r, 10));
      const activeSyncForCfg = OperationCoordinator.acquire(
        "sync",
        "Active sync during configure",
      );
      resolveCfgBox({ response: 0 }); // User clicked confirm, but operation is busy
      let cfgConflictThrew = false;
      try {
        await cfgPromise;
      } catch (e: any) {
        cfgConflictThrew = true;
        if (!e.message.includes("is currently in progress")) {
          throw new Error(
            `Unexpected error on configure op conflict: ${e.message}`,
          );
        }
      } finally {
        activeSyncForCfg.release();
      }
      if (!cfgConflictThrew)
        throw new Error(
          "Expected conflicting operation during configure dialog to fail closed",
        );

      // 7. Deferred native dialogs on actual handlers: gameDir:move
      const moveHandler = ipcHandlers.get("gameDir:move")!;
      const testMoveDir = path.join(testRoot, "deferred-move-target");

      // A. Cancellation of move dialog
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(async () => ({
        response: 1,
      })); // Cancel
      let moveCancelThrew = false;
      try {
        await moveHandler(event as any, testMoveDir);
      } catch (e: any) {
        moveCancelThrew = true;
        if (!e.message.includes("Move cancelled by user.")) {
          throw new Error(`Unexpected move cancellation error: ${e.message}`);
        }
      }
      if (!moveCancelThrew)
        throw new Error(
          "Expected cancelled move dialog to throw UserCancelledError",
        );

      // B. Conflicting operation during move dialog
      let resolveMoveBox!: (val: { response: number }) => void;
      const moveBoxPromise = new Promise<{ response: number }>((resolve) => {
        resolveMoveBox = resolve;
      });
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(() => moveBoxPromise);
      const movePromise = moveHandler(event as any, testMoveDir);
      await new Promise((r) => setTimeout(r, 10));
      const activeSyncForMove = OperationCoordinator.acquire(
        "sync",
        "Active sync during move",
      );
      resolveMoveBox({ response: 0 }); // User clicked confirm, but operation is busy
      let moveConflictThrew = false;
      try {
        await movePromise;
      } catch (e: any) {
        moveConflictThrew = true;
        if (!e.message.includes("is currently in progress")) {
          throw new Error(`Unexpected error on move op conflict: ${e.message}`);
        }
      } finally {
        activeSyncForMove.release();
      }
      if (!moveConflictThrew)
        throw new Error(
          "Expected conflicting operation during move dialog to fail closed",
        );

      // 8. Deferred native dialogs on actual handlers: mods:addPaths
      const modsAddHandler = ipcHandlers.get("mods:addPaths")!;
      const testModFile = path.join(testRoot, "deferred-test-mod.jar");
      fs.writeFileSync(testModFile, "PK\x03\x04testmodcontent");

      // A. Cancellation of mod import dialog
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(async () => ({
        response: 1,
      })); // Cancel
      let modCancelThrew = false;
      try {
        await modsAddHandler(event as any, [testModFile]);
      } catch (e: any) {
        modCancelThrew = true;
        if (!e.message.includes("Mod import cancelled by user.")) {
          throw new Error(
            `Unexpected mod import cancellation error: ${e.message}`,
          );
        }
      }
      if (!modCancelThrew)
        throw new Error(
          "Expected cancelled mod import dialog to throw UserCancelledError",
        );

      // B. Conflicting operation during mod import dialog
      let resolveModBox!: (val: { response: number }) => void;
      const modBoxPromise = new Promise<{ response: number }>((resolve) => {
        resolveModBox = resolve;
      });
      mockDialog.showMessageBox.mockReset();
      mockDialog.showMessageBox.mockImplementationOnce(() => modBoxPromise);
      const modPromise = modsAddHandler(event as any, [testModFile]);
      await new Promise((r) => setTimeout(r, 10));
      const activeSyncForMod = OperationCoordinator.acquire(
        "sync",
        "Active sync during mod import",
      );
      resolveModBox({ response: 0 }); // User clicked confirm, but operation is busy
      let modConflictThrew = false;
      try {
        await modPromise;
      } catch (e: any) {
        modConflictThrew = true;
        if (!e.message.includes("is currently in progress")) {
          throw new Error(
            `Unexpected error on mod import op conflict: ${e.message}`,
          );
        }
      } finally {
        activeSyncForMod.release();
      }
      if (!modConflictThrew)
        throw new Error(
          "Expected conflicting operation during mod import dialog to fail closed",
        );

      // 9. Single-use consumption of granted approval
      const singleUseTarget = path.join(testRoot, "single-use-target");
      IpcBoundary.grantApproval("gameDir:target", singleUseTarget);
      const firstConsume = IpcBoundary.consumeApproval(
        "gameDir:target",
        singleUseTarget,
      );
      const secondConsume = IpcBoundary.consumeApproval(
        "gameDir:target",
        singleUseTarget,
      );
      if (!firstConsume)
        throw new Error("Expected first consumeApproval to succeed");
      if (secondConsume)
        throw new Error("Expected second consumeApproval to fail (single-use)");

      // 10. Platform-correct path normalization
      if (process.platform === "win32") {
        const p1 = "C:\\Games\\Minecraft\\Data";
        const p2 = "c:\\games\\minecraft\\data";
        if (normalizeApprovalTarget(p1) !== normalizeApprovalTarget(p2)) {
          throw new Error(
            "Expected Windows path identity to be case-insensitive",
          );
        }
      } else {
        const p1 = "/tmp/CustomDir/Mods";
        const p2 = "/tmp/customdir/mods";
        if (normalizeApprovalTarget(p1) === normalizeApprovalTarget(p2)) {
          throw new Error(
            "Expected POSIX path identity to remain case-distinct",
          );
        }
      }

      // 11. Intended TTL constant verification (60 seconds)
      if (APPROVAL_TTL_MS !== 60_000) {
        throw new Error(
          `Expected APPROVAL_TTL_MS to be 60000ms (60s), got ${APPROVAL_TTL_MS}`,
        );
      }
    },
  );

  // 50. [Phase 2 Gate] Main-owned launch admission: consolidated auth, mandatory installation state, and intercepted spawn
  await runTest(
    "[Phase 2 Gate] Main-owned launch admission: consolidated auth, mandatory installation state, and intercepted spawn",
    async () => {
      const gameDir = path.join(testRoot, "launch-admission-game");
      const launchHandler = ipcHandlers.get("game:launch")!;
      const lampasDir = path.join(gameDir, ".lampas");
      fs.mkdirSync(lampasDir, { recursive: true });

      // Setup release descriptor and valid installation state
      const releasePath = path.join(lampasDir, "release.json");
      const installPath = path.join(lampasDir, "installation.json");

      const validRelease = {
        schemaVersion: 1,
        pack: "Lampas 2",
        version: "2.0.0",
        syncGeneration: "gen-1",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        launch: {},
        minimumLauncherVersion: "1.0.0",
        protocol: 3,
        created: "2026-01-01T00:00:00.000Z",
        clientManifest: "/api/v1/releases/2.0.0/client-manifest",
        serverManifest: "/api/v1/releases/2.0.0/server-manifest",
      };
      fs.writeFileSync(releasePath, JSON.stringify(validRelease, null, 2));

      // Ensure session credentials are present for LauncherAuth.refreshSession
      ConfigManager.set({ gameDir });
      ConfigManager.establishSession(originAPortal, {
        token: "valid-launch-token",
        refreshToken: "valid-launch-refresh",
      });

      // Spy Java runtime and bootstrap to isolate process execution sink
      const javaSpy = spyOn(
        JavaRuntimeManager,
        "ensureJava25",
      ).mockImplementation(async () => "C:\\Java25\\bin\\java.exe");
      const bootstrapSpy = spyOn(
        MinecraftBootstrap,
        "prepareGameEnvironment",
      ).mockImplementation(async () => ({
        classpath: ["C:\\Game\\libraries\\fabric.jar"],
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        assetIndex: "26.2",
      }));

      try {
        // 1. Missing installation.json fails closed
        fs.rmSync(installPath, { force: true });
        let missingStateThrew = false;
        try {
          await launchHandler({});
        } catch (e: any) {
          missingStateThrew = true;
          if (!e.message.includes("Missing installation state metadata")) {
            throw new Error(`Unexpected missing state error: ${e.message}`);
          }
        }
        if (!missingStateThrew)
          throw new Error(
            "Expected launch to reject missing installation.json fail-closed",
          );

        // 2. Empty installation.json ({}) fails closed
        fs.writeFileSync(installPath, "{}");
        let emptyStateThrew = false;
        try {
          await launchHandler({});
        } catch (e: any) {
          emptyStateThrew = true;
          if (!e.message.includes("Installation state metadata is empty")) {
            throw new Error(`Unexpected empty state error: ${e.message}`);
          }
        }
        if (!emptyStateThrew)
          throw new Error(
            "Expected launch to reject empty installation.json fail-closed",
          );

        // 3. installation.json missing version field fails closed
        fs.writeFileSync(
          installPath,
          JSON.stringify({ syncGeneration: "gen-1" }),
        );
        let noVersionThrew = false;
        try {
          await launchHandler({});
        } catch (e: any) {
          noVersionThrew = true;
          if (!e.message.includes("missing mandatory 'version' field")) {
            throw new Error(`Unexpected missing version error: ${e.message}`);
          }
        }
        if (!noVersionThrew)
          throw new Error(
            "Expected launch to reject installation.json without version field",
          );

        // 4. Version mismatch between installation.json and release.json fails closed
        fs.writeFileSync(
          installPath,
          JSON.stringify({ version: "1.0.0", syncGeneration: "gen-1" }),
        );
        let mismatchThrew = false;
        try {
          await launchHandler({});
        } catch (e: any) {
          mismatchThrew = true;
          if (!e.message.includes("Incompatible installation state detected")) {
            throw new Error(`Unexpected mismatch error: ${e.message}`);
          }
        }
        if (!mismatchThrew)
          throw new Error(
            "Expected launch to reject version mismatch fail-closed",
          );

        // 5. noSync: true does NOT bypass installation state admission
        ConfigManager.set({ noSync: true });
        let noSyncBypassThrew = false;
        try {
          await launchHandler({});
        } catch {
          noSyncBypassThrew = true;
        }
        ConfigManager.set({ noSync: false });
        if (!noSyncBypassThrew)
          throw new Error(
            "Expected noSync: true to still require valid installation state",
          );

        // 6. Valid installation state admits launch and executes intercepted spawn observed out-of-band
        fs.writeFileSync(
          installPath,
          JSON.stringify({
            pack: "Lampas 2",
            version: "2.0.0",
            syncGeneration: "gen-1",
            files: {},
          }),
        );
        interceptedProcesses.length = 0;

        await launchHandler({});

        if (interceptedProcesses.length === 0) {
          throw new Error(
            "Expected authenticated game launch to reach process execution sink",
          );
        }

        const launchCall =
          interceptedProcesses[interceptedProcesses.length - 1];
        const args = launchCall.args;
        const getFlagVal = (flag: string, argList: string[] = args) => {
          const idx = argList.indexOf(flag);
          if (idx === -1 || idx + 1 >= argList.length) return null;
          return argList[idx + 1];
        };

        // Assert exact argument/value pairs
        if (getFlagVal("--username") !== "BoundaryUser") {
          throw new Error(
            `Expected exact pair --username BoundaryUser, got: ${getFlagVal("--username")}`,
          );
        }
        if (getFlagVal("--version") !== "26.2") {
          throw new Error(
            `Expected exact pair --version 26.2, got: ${getFlagVal("--version")}`,
          );
        }
        if (getFlagVal("--gameDir") !== gameDir) {
          throw new Error(
            `Expected exact pair --gameDir ${gameDir}, got: ${getFlagVal("--gameDir")}`,
          );
        }
        if (getFlagVal("--uuid") !== "00000000000000000000000000000001") {
          throw new Error(
            `Expected exact pair --uuid 00000000000000000000000000000001, got: ${getFlagVal("--uuid")}`,
          );
        }
        if (getFlagVal("--accessToken") !== "0") {
          throw new Error(
            `Expected exact pair --accessToken 0, got: ${getFlagVal("--accessToken")}`,
          );
        }
        if (getFlagVal("--userType") !== "legacy") {
          throw new Error(
            `Expected exact pair --userType legacy, got: ${getFlagVal("--userType")}`,
          );
        }
        if (getFlagVal("--versionType") !== "release") {
          throw new Error(
            `Expected exact pair --versionType 'release', got: ${getFlagVal("--versionType")}`,
          );
        }

        // 7. Forged renderer arguments cannot influence launch
        GameRunner.resetForTesting();
        interceptedProcesses.length = 0;
        await (launchHandler as any)(
          {},
          {
            user: { name: "AttackerPlayer", minecraftUuid: "forged-uuid-999" },
            release: { version: "99.9.9", pack: "ForgedPack" },
          },
        );
        if (interceptedProcesses.length === 0) {
          throw new Error("Expected launch to execute process execution sink");
        }
        const forgedCall =
          interceptedProcesses[interceptedProcesses.length - 1];
        if (
          forgedCall.args.includes("AttackerPlayer") ||
          forgedCall.args.includes("forged-uuid-999") ||
          forgedCall.args.includes("99.9.9") ||
          forgedCall.args.includes("ForgedPack")
        ) {
          throw new Error(
            `Forged renderer arguments leaked into process execution sink! Args: ${JSON.stringify(forgedCall.args)}`,
          );
        }
        if (getFlagVal("--username", forgedCall.args) !== "BoundaryUser") {
          throw new Error(
            "Main-owned consolidated user identity was overridden by forged renderer input",
          );
        }
      } finally {
        javaSpy.mockRestore();
        bootstrapSpy.mockRestore();
        GameRunner.resetForTesting();
      }
    },
  );

  // 51. [Phase 2 Gate] Renderer permission lockdown and error sanitization
  await runTest(
    "[Phase 2 Gate] Renderer permission lockdown and error sanitization",
    async () => {
      const win = MockBrowserWindow.allWindows[0];

      // 1. Permission check handler denies all checks fail-closed
      const checkHandler = win.webContents.session.permissionCheckHandler;
      if (typeof checkHandler !== "function") {
        throw new Error(
          "Expected setPermissionCheckHandler to register a function on session",
        );
      }
      const deniedMedia = checkHandler(
        win.webContents,
        "media",
        "http://localhost:5173",
        {},
      );
      const deniedGeo = checkHandler(
        win.webContents,
        "geolocation",
        "http://localhost:5173",
        {},
      );
      const deniedNotif = checkHandler(
        win.webContents,
        "notifications",
        "http://localhost:5173",
        {},
      );
      const deniedClip = checkHandler(
        win.webContents,
        "clipboard-read",
        "http://localhost:5173",
        {},
      );
      if (
        deniedMedia !== false ||
        deniedGeo !== false ||
        deniedNotif !== false ||
        deniedClip !== false
      ) {
        throw new Error(
          `Expected all permission checks to return false fail-closed: media=${deniedMedia}, geo=${deniedGeo}, notif=${deniedNotif}, clip=${deniedClip}`,
        );
      }

      // 2. Permission request handler denies all requests fail-closed
      const reqHandler = win.webContents.session.permissionRequestHandler;
      if (typeof reqHandler !== "function") {
        throw new Error(
          "Expected setPermissionRequestHandler to register a function on session",
        );
      }
      let mediaGranted: any = true;
      reqHandler(
        win.webContents,
        "media",
        (granted: boolean) => {
          mediaGranted = granted;
        },
        {},
      );
      if (mediaGranted !== false) {
        throw new Error(
          "Expected permission request for media to be denied fail-closed",
        );
      }

      // 3. Public IPC error contract: Unexpected backend failures return stable generic public error
      const typeErr = sanitizeIpcError(
        new TypeError(
          "Cannot read properties of undefined (reading 'secretKey')",
        ),
      );
      if (
        typeErr.message !==
        "Operation failed: An unexpected internal error occurred."
      ) {
        throw new Error(
          `Expected generic error for unexpected TypeError, got: '${typeErr.message}'`,
        );
      }

      const unhandledBackendErr = sanitizeIpcError(
        new Error(
          "Fatal backend sqlite database disk image is malformed at block 4096",
        ),
      );
      if (
        unhandledBackendErr.message !==
        "Operation failed: An unexpected internal error occurred."
      ) {
        throw new Error(
          `Expected generic error for unhandled backend error, got: '${unhandledBackendErr.message}'`,
        );
      }

      const rangeErr = sanitizeIpcError(
        new RangeError(
          "Maximum call stack size exceeded in internal cryptographic routine",
        ),
      );
      if (
        rangeErr.message !==
        "Operation failed: An unexpected internal error occurred."
      ) {
        throw new Error(
          `Expected generic error for RangeError, got: '${rangeErr.message}'`,
        );
      }

      // 4. Production error sanitization bypass removal regressions:
      // A. Error with [SecurityHarness] marker and synthetic secret/path collapses to generic error
      const harnessSecretErr = sanitizeIpcError(
        new Error(
          "[SecurityHarness] leaked secret token=secret-token-12345 at C:\\Users\\Admin\\config.json",
        ),
      );
      if (
        harnessSecretErr.message !==
        "Operation failed: An unexpected internal error occurred."
      ) {
        throw new Error(
          `Expected generic error for harness marker with secret, got: '${harnessSecretErr.message}'`,
        );
      }
      if (
        harnessSecretErr.message.includes("[SecurityHarness]") ||
        harnessSecretErr.message.includes("secret-token") ||
        harnessSecretErr.message.includes("Admin")
      ) {
        throw new Error(
          `Information leaked in sanitized harness error: '${harnessSecretErr.message}'`,
        );
      }

      // B. Long error message containing [SecurityHarness] collapses to generic error and stays bounded
      const harnessLongErr = sanitizeIpcError(
        new Error("[SecurityHarness] " + "FatalErrorDetails".repeat(50)),
      );
      if (
        harnessLongErr.message !==
        "Operation failed: An unexpected internal error occurred."
      ) {
        throw new Error(
          `Expected generic error for long harness error, got: '${harnessLongErr.message}'`,
        );
      }

      // C. Generic error without harness marker containing synthetic secrets/paths collapses to generic error
      const plainSecretErr = sanitizeIpcError(
        new Error(
          "Database connection failed for user=admin password=SecretPassword123! path=/etc/shadow",
        ),
      );
      if (
        plainSecretErr.message !==
        "Operation failed: An unexpected internal error occurred."
      ) {
        throw new Error(
          `Expected generic error for plain error with credentials, got: '${plainSecretErr.message}'`,
        );
      }

      // D. Deceptive backend error containing operational-looking phrases plus quoted JSON credentials
      const deceptiveErr = sanitizeIpcError(
        new Error(
          'Cannot start operation: operation is currently in progress: {"token": "secret-auth-token-1234", "password": "super-secret"}',
        ),
      );
      if (
        deceptiveErr.message !==
        "Operation failed: An unexpected internal error occurred."
      ) {
        throw new Error(
          `Deceptive operational backend error leaked information: '${deceptiveErr.message}'`,
        );
      }

      // 5. Public IPC error contract: Security violations return exact masked security error
      const securityError = sanitizeIpcError(
        new IpcSecurityError(
          "detailed secret frame mismatch: frame id 12 != 14 from http://evil.com",
        ),
      );
      if (
        securityError.message !== "Security violation: IPC request rejected."
      ) {
        throw new Error(
          `Expected masked security error message, got: '${securityError.message}'`,
        );
      }

      // 6. Public IPC error contract: Main-owned errors scrub synthetic secrets, paths, multiline stacks, and bound length <= 120
      // A. Synthetic JWT secrets scrubbed in main-owned validation error
      const jwtError = sanitizeIpcError(
        new IpcValidationError(
          "Invalid token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ",
        ),
      );
      if (
        jwtError.message.includes("eyJ") ||
        jwtError.message.includes("TJVA95")
      ) {
        throw new Error(
          `Synthetic JWT secret leaked in sanitized error: '${jwtError.message}'`,
        );
      }
      if (!jwtError.message.includes("<redacted>")) {
        throw new Error(
          `Expected <redacted> token placeholder in: '${jwtError.message}'`,
        );
      }

      // B. Synthetic password and hex tokens scrubbed in main-owned validation error
      const credError = sanitizeIpcError(
        new IpcValidationError(
          "Auth failed with password=SuperSecretPassword123! token=0123456789abcdef0123456789abcdef",
        ),
      );
      if (
        credError.message.includes("SuperSecretPassword123") ||
        credError.message.includes("0123456789abcdef")
      ) {
        throw new Error(
          `Synthetic credentials leaked in sanitized error: '${credError.message}'`,
        );
      }
      if (!credError.message.includes("<redacted>")) {
        throw new Error(
          `Expected <redacted> credential placeholder in: '${credError.message}'`,
        );
      }

      // C. Multiline errors collapsed and stack traces stripped in main-owned error
      const multilineError = sanitizeIpcError(
        new IpcValidationError(
          "Validation failed for field 'options':\n    at validateOptions (/app/src/validator.ts:42:15)\n    at Object.handle (/app/src/ipc.ts:100:12)",
        ),
      );
      if (
        multilineError.message.includes("\n") ||
        multilineError.message.includes("\r") ||
        multilineError.message.includes("validator.ts")
      ) {
        throw new Error(
          `Multiline error / stack trace leaked in sanitized error: '${multilineError.message}'`,
        );
      }

      // D. Windows drive paths scrubbed in main-owned error
      const winPathError = sanitizeIpcError(
        new IpcValidationError(
          "Cannot access file at C:\\Users\\Administrator\\secret\\config.json: Access denied",
        ),
      );
      if (winPathError.message.includes("C:\\Users")) {
        throw new Error(
          `Expected Windows drive path to be scrubbed: '${winPathError.message}'`,
        );
      }
      if (!winPathError.message.includes("<path>")) {
        throw new Error(
          `Expected placeholder <path> in sanitized error: '${winPathError.message}'`,
        );
      }

      // E. Single-component POSIX paths scrubbed (/etc, /tmp, /secret) in main-owned error
      for (const singlePosix of ["/etc", "/tmp", "/secret"]) {
        const posixSingleError = sanitizeIpcError(
          new IpcValidationError(`Refusing to access path ${singlePosix}`),
        );
        if (posixSingleError.message.includes(singlePosix)) {
          throw new Error(
            `Expected single-component POSIX path '${singlePosix}' to be scrubbed: '${posixSingleError.message}'`,
          );
        }
        if (!posixSingleError.message.includes("<path>")) {
          throw new Error(
            `Expected <path> placeholder for '${singlePosix}', got: '${posixSingleError.message}'`,
          );
        }
      }

      // F. Multi-component POSIX paths scrubbed in main-owned error
      const posixMultiError = sanitizeIpcError(
        new IpcValidationError(
          "Cannot access file at /home/markj/lampas-launcher/secret/file.txt: Access denied",
        ),
      );
      if (posixMultiError.message.includes("/home/markj")) {
        throw new Error(
          `Expected POSIX path to be scrubbed: '${posixMultiError.message}'`,
        );
      }
      if (!posixMultiError.message.includes("<path>")) {
        throw new Error(
          `Expected placeholder <path> in sanitized error: '${posixMultiError.message}'`,
        );
      }

      // G. Main-owned domain errors: Cancellation, OperationBusy, InstallationState, ModPolicy
      const userCancelSanitized = sanitizeIpcError(
        new UserCancelledError(
          "Configuration cancelled by user at C:\\secret\\dir",
        ),
      );
      if (
        !userCancelSanitized.message.includes(
          "Configuration cancelled by user",
        ) ||
        userCancelSanitized.message.includes("C:\\secret")
      ) {
        throw new Error(
          `UserCancelledError not properly scrubbed: '${userCancelSanitized.message}'`,
        );
      }

      const busySanitized = sanitizeIpcError(
        new OperationBusyError(
          {
            id: "op-1",
            type: "sync",
            description: "Syncing",
            startTime: Date.now(),
          },
          "move",
        ),
      );
      if (
        !busySanitized.message.includes("Cannot start 'move'") ||
        !busySanitized.message.includes("currently in progress")
      ) {
        throw new Error(
          `OperationBusyError not properly formatted: '${busySanitized.message}'`,
        );
      }

      const runningSanitized = sanitizeIpcError(
        new GameRunningConflictError("delete mod"),
      );
      if (
        !runningSanitized.message.includes(
          "Cannot perform 'delete mod' while Minecraft is running",
        )
      ) {
        throw new Error(
          `GameRunningConflictError not properly formatted: '${runningSanitized.message}'`,
        );
      }

      const installStateSanitized = sanitizeIpcError(
        new InstallationStateError(
          "Missing installation state metadata: No installed modpack found.",
        ),
      );
      if (
        !installStateSanitized.message.includes(
          "Missing installation state metadata",
        )
      ) {
        throw new Error(
          `InstallationStateError not properly formatted: '${installStateSanitized.message}'`,
        );
      }

      const modPolicySanitized = sanitizeIpcError(
        new ModPolicyError("Cannot disable unknown official mod: 'core'"),
      );
      if (
        !modPolicySanitized.message.includes(
          "Cannot disable unknown official mod",
        )
      ) {
        throw new Error(
          `ModPolicyError not properly formatted: '${modPolicySanitized.message}'`,
        );
      }

      // H. Final length bound: EVERY public error result is <= 120 characters
      const allSanitizedErrors = [
        typeErr,
        unhandledBackendErr,
        rangeErr,
        harnessSecretErr,
        harnessLongErr,
        plainSecretErr,
        deceptiveErr,
        securityError,
        jwtError,
        credError,
        multilineError,
        winPathError,
        posixMultiError,
        userCancelSanitized,
        busySanitized,
        runningSanitized,
        installStateSanitized,
        modPolicySanitized,
      ];

      for (const serr of allSanitizedErrors) {
        if (serr.message.length > 120) {
          throw new Error(
            `Public IPC error exceeds 120 chars (${serr.message.length}): '${serr.message}'`,
          );
        }
      }

      // Long unknown keys / messages bounded to at most 120 characters and ending with '...'
      const longMsg =
        "This is an extremely long validation failure message describing multiple parameter violations across different structures that exceeds the maximum allowed boundary length for errors.";
      const boundedError = sanitizeIpcError(new IpcValidationError(longMsg));
      if (boundedError.message.length > 120) {
        throw new Error(
          `Expected bounded validation error <= 120 chars, got ${boundedError.message.length}: '${boundedError.message}'`,
        );
      }
      if (!boundedError.message.endsWith("...")) {
        throw new Error(
          `Expected truncated bounded error to end with '...', got: '${boundedError.message}'`,
        );
      }

      // 7. Mod file size boundary (100 MB)
      if (MAX_CUSTOM_MOD_FILE_SIZE_BYTES !== 100 * 1024 * 1024) {
        throw new Error(
          `Expected MAX_CUSTOM_MOD_FILE_SIZE_BYTES to be 100MB (104857600 bytes), got ${MAX_CUSTOM_MOD_FILE_SIZE_BYTES}`,
        );
      }
    },
  );

  // 52. [Phase 3] Secure-store round trip, encryption integrity, and application restart
  await runTest(
    "[Phase 3] Secure-store round trip, encryption integrity, and application restart",
    async () => {
      SessionManager.resetForTesting();
      const mockStorage = new MockSafeStorage();
      CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
      CredentialStore.setCustomUserDataDirForTesting(userDataDir);

      const record = {
        version: 1 as const,
        portalUrl: originAPortal,
        accountId: "player-uuid-1234",
        accountUsername: "PlayerOne",
        token: "secret-bearer-token-val",
        refreshToken: "secret-refresh-token-val",
        minecraftAccessToken: "secret-mc-access-token-val",
        createdAt: 1000,
        updatedAt: 2000,
      };

      const saveResult = CredentialStore.saveCredentials(record);
      if (!saveResult.success || saveResult.sessionOnly) {
        throw new Error(
          `Expected successful secure save, got: ${JSON.stringify(saveResult)}`,
        );
      }

      // Disk integrity: credentials.enc exists, is non-empty, and contains NO plaintext secrets
      const credPath = CredentialStore.getCredentialsFilePath();
      if (!fs.existsSync(credPath)) {
        throw new Error(`credentials.enc does not exist at ${credPath}`);
      }
      const rawDisk = fs.readFileSync(credPath);
      const rawStr = rawDisk.toString("utf-8");
      if (
        rawStr.includes("secret-bearer-token-val") ||
        rawStr.includes("secret-refresh-token-val") ||
        rawStr.includes("PlayerOne")
      ) {
        throw new Error(
          "Plaintext credentials found on disk in credentials.enc!",
        );
      }

      // Decryption round-trip
      const loaded = CredentialStore.loadCredentials();
      if (!loaded)
        throw new Error("loadCredentials returned null after successful save");
      if (
        loaded.token !== record.token ||
        loaded.accountUsername !== "PlayerOne" ||
        loaded.accountId !== "player-uuid-1234"
      ) {
        throw new Error(`Decrypted record mismatch: ${JSON.stringify(loaded)}`);
      }

      // Application restart simulation
      SessionManager.resetForTesting();
      const configPath = path.join(userDataDir, "config.json");
      SessionManager.initialize(configPath, originAPortal);

      if (!SessionManager.isAuthenticated()) {
        throw new Error("Session was not restored on restart");
      }
      const creds = SessionManager.getCredentials();
      if (creds?.token !== "secret-bearer-token-val") {
        throw new Error(`Token mismatch after restart: ${creds?.token}`);
      }
      const user = SessionManager.getCurrentUser();
      if (user?.minecraftUsername !== "PlayerOne") {
        throw new Error(
          `User mismatch after restart: ${user?.minecraftUsername}`,
        );
      }

      CredentialStore.clearCredentials();
    },
  );

  // 53. [Phase 3] Session-only behavior with unavailable or insecure storage backends
  await runTest(
    "[Phase 3] Session-only behavior with unavailable or insecure storage backends",
    async () => {
      SessionManager.resetForTesting();
      const mockStorage = new MockSafeStorage();
      CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
      CredentialStore.setCustomUserDataDirForTesting(userDataDir);

      const record = {
        version: 1 as const,
        portalUrl: originAPortal,
        accountId: "player-uuid-53",
        accountUsername: "SessionOnlyUser",
        token: "session-only-token-53",
        createdAt: 1000,
        updatedAt: 2000,
      };

      // Case A: Encryption unavailable
      mockStorage.available = false;
      if (CredentialStore.detectStorageBackend() !== "session_only") {
        throw new Error(
          "Expected session_only backend when encryption unavailable",
        );
      }
      const resA = CredentialStore.saveCredentials(record);
      if (!resA.success || !resA.sessionOnly) {
        throw new Error(
          `Expected sessionOnly=true when unavailable, got ${JSON.stringify(resA)}`,
        );
      }
      if (fs.existsSync(CredentialStore.getCredentialsFilePath())) {
        throw new Error(
          "credentials.enc was created on disk in session_only mode!",
        );
      }
      if (CredentialStore.loadCredentials() !== null) {
        throw new Error(
          "loadCredentials did not return null in session_only mode",
        );
      }

      // Case B: Insecure Linux fallback (basic_text / unknown)
      mockStorage.available = true;
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, "platform", {
          value: "linux",
          configurable: true,
        });

        mockStorage.backend = "basic_text";
        if (CredentialStore.detectStorageBackend() !== "session_only") {
          throw new Error(
            "Expected basic_text on Linux to resolve to session_only",
          );
        }
        const resB = CredentialStore.saveCredentials(record);
        if (!resB.sessionOnly)
          throw new Error("basic_text did not trigger sessionOnly");

        mockStorage.backend = "unknown";
        if (CredentialStore.detectStorageBackend() !== "session_only") {
          throw new Error(
            "Expected unknown backend on Linux to resolve to session_only",
          );
        }

        // Valid Linux keyring
        mockStorage.backend = "gnome_libsecret";
        if (CredentialStore.detectStorageBackend() !== "linux_keyring") {
          throw new Error(
            "Expected gnome_libsecret to resolve to linux_keyring",
          );
        }
      } finally {
        Object.defineProperty(process, "platform", {
          value: origPlatform,
          configurable: true,
        });
      }
    },
  );

  // 54. [Phase 3] Locked provider and corrupt ciphertext handling fail closed without crashing
  await runTest(
    "[Phase 3] Locked provider and corrupt ciphertext handling fail closed without crashing",
    async () => {
      SessionManager.resetForTesting();
      const mockStorage = new MockSafeStorage();
      CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
      CredentialStore.setCustomUserDataDirForTesting(userDataDir);

      const credPath = CredentialStore.getCredentialsFilePath();

      // 1. Corrupt ciphertext bytes on disk
      fs.writeFileSync(
        credPath,
        Buffer.from("not-valid-aes-ciphertext-random-junk"),
      );
      mockStorage.failDecryption = true;

      // loadCredentials must catch error, delete corrupt file, and return null
      const loaded = CredentialStore.loadCredentials();
      if (loaded !== null) {
        throw new Error("Expected null for corrupt ciphertext");
      }
      if (fs.existsSync(credPath)) {
        throw new Error("Corrupted credentials.enc was not unlinked from disk");
      }

      // 2. Schema corruption (valid decryption, but malformed JSON schema)
      mockStorage.failDecryption = false;
      const malformedBuffer = mockStorage.encryptString(
        JSON.stringify({
          version: 99,
          token: "leaked",
        }),
      );
      fs.writeFileSync(credPath, malformedBuffer);

      const loadedSchema = CredentialStore.loadCredentials();
      if (loadedSchema !== null) {
        throw new Error("Expected null for invalid schema version");
      }
      if (fs.existsSync(credPath)) {
        throw new Error(
          "Malformed schema credentials.enc was not unlinked from disk",
        );
      }
    },
  );

  // 55. [Phase 3] Origin mismatch and stale records are purged fail-closed on initialization
  await runTest(
    "[Phase 3] Origin mismatch and stale records are purged fail-closed on initialization",
    async () => {
      SessionManager.resetForTesting();
      const mockStorage = new MockSafeStorage();
      CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
      CredentialStore.setCustomUserDataDirForTesting(userDataDir);

      // Save record for originAPortal
      CredentialStore.saveCredentials({
        version: 1,
        portalUrl: originAPortal,
        accountId: "acc-1",
        accountUsername: "UserA",
        token: "token-for-origin-a",
        createdAt: 100,
        updatedAt: 200,
      });

      // Initialize with attackerPortal (mismatch)
      const configPath = path.join(userDataDir, "config.json");
      SessionManager.initialize(configPath, attackerPortal);

      if (SessionManager.isAuthenticated()) {
        throw new Error("Wrong-origin credentials were authenticated!");
      }
      if (fs.existsSync(CredentialStore.getCredentialsFilePath())) {
        throw new Error("Wrong-origin credentials were not purged from disk!");
      }

      // SessionManager.onPortalUrlChanged wipes mismatched active session
      SessionManager.establishSession(originAPortal, { token: "new-token-a" });
      if (!SessionManager.isAuthenticated())
        throw new Error("Failed to establish session");
      SessionManager.onPortalUrlChanged(attackerPortal);
      if (SessionManager.isAuthenticated()) {
        throw new Error(
          "Session remained active after portal changed to attackerPortal",
        );
      }
    },
  );

  // 56. [Phase 3] Migration state machine handles each checkpoint failure cleanly without resurrecting plaintext
  await runTest(
    "[Phase 3] Migration state machine handles each checkpoint failure cleanly without resurrecting plaintext",
    async () => {
      SessionManager.resetForTesting();
      const mockStorage = new MockSafeStorage();
      CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
      CredentialStore.setCustomUserDataDirForTesting(userDataDir);
      const configPath = path.join(userDataDir, "config.json");

      // Checkpoint A: Unbound origin in config.json
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          portalUrl: originAPortal,
          token: "unbound-token",
          refreshToken: "unbound-refresh",
        }),
      );
      SessionManager.resetForTesting();
      SessionManager.initialize(configPath, originAPortal);
      if (SessionManager.isAuthenticated())
        throw new Error("Unbound credentials were authenticated");
      const rawA = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (rawA.token || rawA.refreshToken)
        throw new Error(
          "Unbound plaintext tokens were not scrubbed from config.json",
        );

      // Checkpoint B: Mismatched sessionPortalUrl
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          portalUrl: originAPortal,
          sessionPortalUrl: attackerPortal,
          token: "mismatched-token",
        }),
      );
      SessionManager.resetForTesting();
      SessionManager.initialize(configPath, originAPortal);
      if (SessionManager.isAuthenticated())
        throw new Error("Mismatched credentials were authenticated");
      const rawB = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (rawB.token)
        throw new Error(
          "Mismatched plaintext tokens were not scrubbed from config.json",
        );

      // Checkpoint C: Storage is session_only
      mockStorage.available = false;
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          portalUrl: originAPortal,
          sessionPortalUrl: originAPortal,
          token: "session-only-migrated",
          portalAccountId: "user-migrated",
          portalUsername: "MigratedUser",
        }),
      );
      SessionManager.resetForTesting();
      SessionManager.initialize(configPath, originAPortal);
      if (
        !SessionManager.isAuthenticated() ||
        SessionManager.getCredentials()?.token !== "session-only-migrated"
      ) {
        throw new Error("Failed to migrate into session_only memory");
      }
      const rawC = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (rawC.token)
        throw new Error(
          "Plaintext tokens not scrubbed from config.json in session_only migration",
        );
      if (fs.existsSync(CredentialStore.getCredentialsFilePath())) {
        throw new Error(
          "credentials.enc was created in session_only migration",
        );
      }

      // Checkpoint D: Encryption failure during migration
      mockStorage.available = true;
      mockStorage.failEncryption = true;
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          portalUrl: originAPortal,
          sessionPortalUrl: originAPortal,
          token: "fail-encrypt-token",
          portalAccountId: "user-migrated",
          portalUsername: "MigratedUser",
        }),
      );
      SessionManager.resetForTesting();
      SessionManager.initialize(configPath, originAPortal);
      if (SessionManager.isAuthenticated())
        throw new Error("Authenticated despite encryption failure");
      const rawD = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (rawD.token)
        throw new Error("Plaintext not scrubbed on encryption failure");

      // Checkpoint E: Read-back verification failure
      mockStorage.failEncryption = false;
      mockStorage.failDecryption = true;
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          portalUrl: originAPortal,
          sessionPortalUrl: originAPortal,
          token: "fail-verify-token",
          portalAccountId: "user-migrated",
          portalUsername: "MigratedUser",
        }),
      );
      SessionManager.resetForTesting();
      SessionManager.initialize(configPath, originAPortal);
      if (SessionManager.isAuthenticated())
        throw new Error("Authenticated despite read-back verification failure");
      const rawE = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (rawE.token)
        throw new Error(
          "Plaintext not scrubbed on read-back verification failure",
        );

      mockStorage.failDecryption = false;
    },
  );

  // 57. [Phase 3] Logout during persistent credential write invalidates session epoch and rolls back disk store
  await runTest(
    "[Phase 3] Logout during persistent credential write invalidates session epoch and rolls back disk store",
    async () => {
      SessionManager.resetForTesting();
      const mockStorage = new MockSafeStorage();
      CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
      CredentialStore.setCustomUserDataDirForTesting(userDataDir);

      // Hook encryption step to simulate a concurrent logout occurring during encryption
      mockStorage.onEncryptCallback = () => {
        SessionManager.clearSession();
      };

      SessionManager.establishSession(originAPortal, {
        token: "aborted-race-token",
        refreshToken: "aborted-race-refresh",
      });

      if (SessionManager.isAuthenticated()) {
        throw new Error(
          "Session was established despite concurrent logout during encryption!",
        );
      }
      if (SessionManager.getCredentials() !== null) {
        throw new Error(
          "Credentials leaked into memory despite concurrent logout!",
        );
      }
      if (fs.existsSync(CredentialStore.getCredentialsFilePath())) {
        throw new Error(
          "Disk store was not rolled back after concurrent logout during write!",
        );
      }
      mockStorage.onEncryptCallback = null;
    },
  );

  // 58. [Phase 3] Invalidation barriers discard late responses and prevent cross-session contamination
  await runTest(
    "[Phase 3] Invalidation barriers discard late responses and prevent cross-session contamination",
    async () => {
      SessionManager.resetForTesting();
      ConfigManager.set({ portalUrl: originAPortal });

      // Establish session
      SessionManager.establishSession(originAPortal, {
        token: "session-58-token",
        refreshToken: "session-58-refresh",
      });

      // Simulate in-flight refresh with delay
      delayNextServerAResponse = 40;
      const inFlight = LauncherAuth.refreshSession();

      await new Promise((r) => setTimeout(r, 5));

      // Logout while refresh is in flight
      LauncherAuth.logout();
      if (SessionManager.isAuthenticated()) {
        throw new Error("Expected session to be logged out");
      }

      const res = await inFlight;
      if (res.valid !== false) {
        throw new Error(
          "Expected late refresh to resolve to valid: false after logout",
        );
      }
      if (SessionManager.isAuthenticated()) {
        throw new Error("Late refresh resurrected session after logout!");
      }
      if (ConfigManager.get().token !== undefined) {
        throw new Error("Late refresh resurrected token in config!");
      }
    },
  );

  // 59. [Phase 3] Single-flight refresh coalesces concurrent callers and superseding login invalidates in-flight operations
  await runTest(
    "[Phase 3] Single-flight refresh coalesces concurrent callers and superseding login invalidates in-flight operations",
    async () => {
      SessionManager.resetForTesting();
      ConfigManager.set({ portalUrl: originAPortal });
      ConfigManager.establishSession(originAPortal, {
        token: "singleflight-token",
        refreshToken: "singleflight-refresh",
      });

      delayNextServerAResponse = 40;
      capturedRequestsA.length = 0;

      const p1 = LauncherAuth.refreshSession();
      const p2 = LauncherAuth.refreshSession();

      // Verify coalesced promise
      if (p1 !== p2) {
        throw new Error(
          "Expected concurrent refresh callers to share the same promise",
        );
      }

      const [r1, r2] = await Promise.all([p1, p2]);
      if (!r1.valid || !r2.valid) {
        throw new Error(
          "Expected both callers to receive valid refresh result",
        );
      }

      // Only 1 network request dispatched to /api/v1/auth/refresh
      const refreshRequests = capturedRequestsA.filter(
        (r) => r.url === "/api/v1/auth/refresh",
      );
      if (refreshRequests.length !== 1) {
        throw new Error(
          `Expected 1 network request, got ${refreshRequests.length}`,
        );
      }

      // Superseding login cancels in-flight refresh
      delayNextServerAResponse = 40;
      const pendingRefresh = LauncherAuth.refreshSession();
      await new Promise((r) => setTimeout(r, 5));

      // Superseding login begins
      SessionManager.nextLoginEpoch();
      const refreshResult = await pendingRefresh;
      if (refreshResult.valid !== false) {
        throw new Error(
          "Expected in-flight refresh to be invalidated by superseding login",
        );
      }
    },
  );

  // 60. [Phase 3] Loopback OAuth listener enforces method, path, host, single-use, and deterministic cleanup
  await runTest(
    "[Phase 3] Loopback OAuth listener enforces method, path, host, single-use, and deterministic cleanup",
    async () => {
      SessionManager.resetForTesting();
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
      const cbOrigin = `http://127.0.0.1:${callbackPort}`;
      allowedDestinations.add(cbOrigin);
      // 1. Method constraint: POST rejected
      const postRes = await fetch(
        `${cbOrigin}/callback?code=foo&state=${state}`,
        { method: "POST" },
      );
      if (postRes.status !== 405) {
        throw new Error(
          `Expected 405 Method Not Allowed, got: ${postRes.status}`,
        );
      }

      // 2. URI length constraint: >2048 chars rejected
      const longParam = "a".repeat(2100);
      const longRes = await fetch(
        `${cbOrigin}/callback?code=${longParam}&state=${state}`,
      );
      if (longRes.status !== 414) {
        throw new Error(`Expected 414 URI Too Long, got: ${longRes.status}`);
      }

      // 3. Host header constraint: mismatch rejected
      const badHostRes = await fetch(
        `${cbOrigin}/callback?code=foo&state=${state}`,
        {
          headers: { Host: "evil.attacker.invalid" },
        },
      );
      if (badHostRes.status !== 400) {
        throw new Error(
          `Expected 400 Host Header Mismatch, got: ${badHostRes.status}`,
        );
      }

      // 4. Noise tolerance: non-callback path returns 404 without closing server
      const noiseRes = await fetch(`${cbOrigin}/favicon.ico`);
      if (noiseRes.status !== 404) {
        throw new Error(`Expected 404 for noise path, got: ${noiseRes.status}`);
      }

      // 5. State mismatch returns 400 without terminating server
      const badStateRes = await fetch(
        `${cbOrigin}/callback?code=test-code&state=wrong-state`,
      );
      if (badStateRes.status !== 400) {
        throw new Error(
          `Expected 400 for bad state, got: ${badStateRes.status}`,
        );
      }

      // 6. Concurrently send valid callback and replay request: first gets 200, replay gets 409
      const [resA, resB] = await Promise.all([
        fetch(
          `${cbOrigin}/callback?code=auth-code-legitimate&state=${encodeURIComponent(state)}`,
        ),
        fetch(
          `${cbOrigin}/callback?code=auth-code-legitimate&state=${encodeURIComponent(state)}`,
        ),
      ]);

      const statuses = [resA.status, resB.status].sort();
      if (statuses[0] !== 200 || statuses[1] !== 409) {
        throw new Error(
          `Expected statuses [200, 409], got: [${resA.status}, ${resB.status}]`,
        );
      }
      const successRes = resA.status === 200 ? resA : resB;
      const htmlBody = await successRes.text();
      if (htmlBody.includes("auth-code-legitimate")) {
        throw new Error("Raw authorization code reflected into HTML response!");
      }

      const authResult = await loginPromise;
      if (!authResult.token)
        throw new Error("Expected token from loginPromise");

      // 7. Cancellation cleanup
      LauncherAuth.cancelLogin();
    },
  );

  // 61. [Phase 3] Complete absence of synthetic secrets from settings, IPC responses, and disk metadata
  await runTest(
    "[Phase 3] Complete absence of synthetic secrets from settings, IPC responses, and disk metadata",
    async () => {
      const mockStorage = new MockSafeStorage();
      CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
      CredentialStore.setCustomUserDataDirForTesting(userDataDir);
      SessionManager.resetForTesting();

      const synSecretToken = "syn-bearer-token-secret-999";
      const synSecretRefresh = "syn-refresh-token-secret-888";
      const synSecretMc = "syn-mc-token-secret-777";

      ConfigManager.establishSession(originAPortal, {
        token: synSecretToken,
        refreshToken: synSecretRefresh,
        minecraftAccessToken: synSecretMc,
      });

      // 1. Inspect config.json on disk
      const configPath = path.join(userDataDir, "config.json");
      const rawConfig = fs.readFileSync(configPath, "utf-8");
      if (
        rawConfig.includes(synSecretToken) ||
        rawConfig.includes(synSecretRefresh) ||
        rawConfig.includes(synSecretMc)
      ) {
        throw new Error("Synthetic secrets leaked into config.json on disk!");
      }

      // 2. Inspect IPC config:get response
      const configGetHandler = ipcHandlers.get("config:get")!;
      const settingsDto = await configGetHandler({});
      const serializedDto = JSON.stringify(settingsDto);
      if (
        serializedDto.includes(synSecretToken) ||
        serializedDto.includes(synSecretRefresh) ||
        serializedDto.includes(synSecretMc)
      ) {
        throw new Error(
          `Synthetic secrets leaked into config:get IPC response: ${serializedDto}`,
        );
      }
      if (
        (settingsDto as any).token ||
        (settingsDto as any).refreshToken ||
        (settingsDto as any).minecraftAccessToken ||
        (settingsDto as any).sessionPortalUrl
      ) {
        throw new Error("Credential fields leaked into RendererSettingsDto!");
      }

      // 3. Inspect IPC sync:getInstalledRuntime
      const runtimeHandler = ipcHandlers.get("sync:getInstalledRuntime")!;
      const runtimeDto = await runtimeHandler({});
      if (runtimeDto) {
        const serializedRuntime = JSON.stringify(runtimeDto);
        if (
          serializedRuntime.includes(synSecretToken) ||
          serializedRuntime.includes(synSecretRefresh) ||
          serializedRuntime.includes(synSecretMc)
        ) {
          throw new Error(
            "Synthetic secrets leaked into getInstalledRuntime response!",
          );
        }
      }

      // Cleanup
      SessionManager.clearSession();
    },
  );

  // Assert outbound request policy compliance: zero unapproved network attempts
  if (attemptedViolations.length > 0) {
    throw new Error(
      `[OutboundPolicyViolation] Forbidden outbound request attempts detected: ${JSON.stringify(attemptedViolations)}`,
    );
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
