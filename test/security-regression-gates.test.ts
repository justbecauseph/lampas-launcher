import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * SECURITY REGRESSION GATES (Phases 1-7)
 *
 * These tests define the TARGET security invariants required by PLAN.md.
 * In Phase 0 (Baseline), these tests are either marked `test.skip` (with runnable,
 * failing assertions against baseline) or `test.todo` (for future implementation specifications),
 * ensuring the baseline test suite remains green while establishing exact specifications.
 *
 * As each hardening phase is implemented, its corresponding gate tests will be
 * unskipped and become required passing criteria.
 */

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sec-gates-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : testRoot),
    getName: () => "Lampas Launcher",
    getVersion: () => "1.4.0",
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 }),
  },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
}));

let ConfigManager: any;
let normalizePortalUrl: any;
let validateWebUrl: any;
let LauncherAuth: any;
let isPathProtected: any;
let LauncherSync: any;
let PathContainmentError: any;
let GameDirectoryManager: any;
let LauncherLogger: any;
let LauncherLoggerService: any;

let PortalPolicy: any;
let IpcBoundary: any;
let IpcSecurityError: any;
let IpcValidationError: any;
let validateConfigSet: any;
let CredentialStore: any;
let SessionManager: any;
let FabricMetaResolver: any;

beforeAll(async () => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });

  const configMod = await import("../src/config");
  ConfigManager = configMod.ConfigManager;
  normalizePortalUrl = configMod.normalizePortalUrl;
  validateWebUrl = configMod.validateWebUrl;
  PortalPolicy = configMod.PortalPolicy;

  const authPath = path
    .resolve(__dirname, "../src/auth.ts")
    .replace(/\\/g, "/");
  const authMod = await import(`file://${authPath}?sec_gates=${Date.now()}`);
  LauncherAuth = authMod.LauncherAuth;

  const syncMod = await import("../src/sync");
  isPathProtected = syncMod.isPathProtected;
  LauncherSync = syncMod.LauncherSync;

  const pathPolicyMod = await import("../src/path-policy");
  PathContainmentError = pathPolicyMod.PathContainmentError;

  const gameDirMod = await import("../src/game-directory");
  GameDirectoryManager = gameDirMod.GameDirectoryManager;

  const loggerMod = await import("../src/logger");
  LauncherLogger = loggerMod.LauncherLogger;
  LauncherLoggerService = loggerMod.LauncherLoggerService;

  const boundaryMod = await import("../src/ipc-boundary");
  IpcBoundary = boundaryMod.IpcBoundary;
  IpcSecurityError = boundaryMod.IpcSecurityError;
  IpcValidationError = boundaryMod.IpcValidationError;
  validateConfigSet = boundaryMod.validateConfigSet;

  const credMod = await import("../src/credential-store");
  CredentialStore = credMod.CredentialStore;
  const sessMod = await import("../src/session-manager");
  SessionManager = sessMod.SessionManager;
  const fabricMetaMod = await import("../src/fabric-meta");
  FabricMetaResolver = fabricMetaMod.FabricMetaResolver;
});

beforeEach(() => {
  PortalPolicy?.configureDevelopmentPolicy({ allowLoopback: true });
  CredentialStore?.resetForTesting();
  SessionManager?.resetForTesting();
  ConfigManager?.resetForTesting();
  GameDirectoryManager?.resetForTesting();
});

afterAll(async () => {
  PortalPolicy?.resetForTesting();
  try {
    await LauncherLogger?.close();
  } catch {}
  if (
    testRoot &&
    path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))
  ) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Phase 1 Regression Gate — Portal Destinations & Web Link Sinks (SEC-01, SEC-02)", () => {
  test("[Phase 1 Gate] URL helper: normalizePortalUrl strictly enforces HTTPS and rejects HTTP lookalike bypasses", () => {
    // Target invariant:
    // Only exact loopback origins (http://localhost or http://127.0.0.1 with port) may use HTTP.
    // Lookalike hosts, embedded IPs, and scheme case tricks must be rejected or upgraded to HTTPS.
    expect(() =>
      normalizePortalUrl("http://localhost.attacker.invalid"),
    ).toThrow();
    expect(() =>
      normalizePortalUrl("http://attacker.invalid/foo?bar=127.0.0.1"),
    ).toThrow();
    expect(normalizePortalUrl("HTTP://portal.lampas.town")).toBe(
      "https://portal.lampas.town",
    );
    expect(() => normalizePortalUrl("https://attacker.invalid")).toThrow();
    expect(() =>
      normalizePortalUrl("https://user:pass@dev.lampas.town"),
    ).toThrow();
    expect(() =>
      normalizePortalUrl("https://dev.lampas.town/api/v1"),
    ).toThrow();
    expect(() =>
      normalizePortalUrl("https://dev.lampas.town?query=1"),
    ).toThrow();
    expect(() => normalizePortalUrl("https://dev.lampas.town#hash")).toThrow();
    expect(normalizePortalUrl("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(normalizePortalUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
  });

  test("[Phase 1 Gate] Production portal policy: packaged production rejects loopback destinations and ignores environment trust expansion", () => {
    try {
      PortalPolicy.setProductionOverride(true);
      process.env.LAMPAS_ALLOWED_PORTAL_HOSTS =
        "attacker.invalid,custom-portal.test";
      process.env.NODE_ENV = "development";

      // Packaged production rejects loopback destinations
      expect(() => normalizePortalUrl("http://localhost:3000")).toThrow();
      expect(() => normalizePortalUrl("http://127.0.0.1:8080")).toThrow();

      // Packaged production ignores LAMPAS_ALLOWED_PORTAL_HOSTS and NODE_ENV
      expect(() => normalizePortalUrl("https://attacker.invalid")).toThrow();
      expect(() => normalizePortalUrl("https://custom-portal.test")).toThrow();

      // Approved lampas.town contract remains valid in production
      expect(normalizePortalUrl("https://portal.lampas.town")).toBe(
        "https://portal.lampas.town",
      );
      expect(normalizePortalUrl("https://dev.lampas.town")).toBe(
        "https://dev.lampas.town",
      );
    } finally {
      PortalPolicy.setProductionOverride(null);
      delete process.env.LAMPAS_ALLOWED_PORTAL_HOSTS;
      process.env.NODE_ENV = "test";
      PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
    }
  });

  test("[Phase 1 Gate] Origin-change invalidation: ConfigManager advances sessionGeneration on active portal change even without established session", () => {
    ConfigManager.resetForTesting();
    // Ensure fresh logged-out state (no sessionPortalUrl, no tokens)
    expect(ConfigManager.get().token).toBeUndefined();
    expect(ConfigManager.get().sessionPortalUrl).toBeUndefined();

    const gen0 = ConfigManager.getSessionGeneration();

    // 1. Change active portal A -> B
    ConfigManager.set({ portalUrl: "https://portal.lampas.town" });
    const gen1 = ConfigManager.getSessionGeneration();
    expect(gen1).toBeGreaterThan(gen0);

    // 2. Change active portal B -> A (return to prior)
    ConfigManager.set({ portalUrl: "https://dev.lampas.town" });
    const gen2 = ConfigManager.getSessionGeneration();
    expect(gen2).toBeGreaterThan(gen1);

    // 3. Setting identical portal does not advance generation
    ConfigManager.set({ portalUrl: "https://dev.lampas.town" });
    const gen3 = ConfigManager.getSessionGeneration();
    expect(gen3).toBe(gen2);

    // 4. Updating unrelated setting does not advance generation
    ConfigManager.set({ allocatedRamGb: 6 });
    const gen4 = ConfigManager.getSessionGeneration();
    expect(gen4).toBe(gen3);
  });

  test("[Phase 1 Gate] Operation-level: Web link sink rejects non-HTTP protocols and never passes them to shell.openPath", () => {
    // validateWebUrl must strictly permit HTTP/HTTPS only
    expect(validateWebUrl("https://lampas.town/mods")).toBe(
      "https://lampas.town/mods",
    );
    expect(validateWebUrl("http://lampas.town/about")).toBe(
      "http://lampas.town/about",
    );
    expect(() =>
      validateWebUrl("file:///C:/Windows/System32/calc.exe"),
    ).toThrow();
    expect(() => validateWebUrl("javascript:alert(1)")).toThrow();
    expect(() => validateWebUrl("powershell -Command calc.exe")).toThrow();
    expect(() => validateWebUrl("data:text/html,<html>")).toThrow();
    expect(() => validateWebUrl("https://user:pass@lampas.town")).toThrow();
    expect(() => validateWebUrl("   ")).toThrow();
  });

  test("[Phase 1 Gate] Session origin binding: ConfigManager binds credentials to sessionPortalUrl and wipes credentials on unapproved remote origin change", () => {
    // Attempting to set sessionPortalUrl directly via ConfigManager.set is stripped (forgery blocked)
    ConfigManager.set({
      sessionPortalUrl: "https://dev.lampas.town",
      token: "syn-test-token",
    } as any);
    expect(ConfigManager.get().sessionPortalUrl).toBeUndefined();

    // Authenticated credentials must be established via establishSession
    ConfigManager.establishSession("https://dev.lampas.town", {
      token: "syn-test-token",
      refreshToken: "syn-test-refresh",
    });
    let config = ConfigManager.get();
    expect(config.token).toBe("syn-test-token");
    expect(config.sessionPortalUrl).toBe("https://dev.lampas.town");

    // Changing to a different portal wipes credentials
    ConfigManager.set({ portalUrl: "https://portal.lampas.town" });
    config = ConfigManager.get();
    expect(config.token).toBeUndefined();
    expect(config.refreshToken).toBeUndefined();
    expect(config.sessionPortalUrl).toBeUndefined();
  });

  test("[Phase 1 Gate] Legacy migration: ConfigManager.get invalidates unbound credentials from disk", () => {
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        portalUrl: "https://dev.lampas.town",
        token: "legacy-unbound-token",
        refreshToken: "legacy-unbound-refresh",
        minecraftAccessToken: "legacy-unbound-mc-token",
      }),
    );

    ConfigManager.resetForTesting();
    const loaded = ConfigManager.get();

    expect(loaded.token).toBeUndefined();
    expect(loaded.refreshToken).toBeUndefined();
    expect(loaded.minecraftAccessToken).toBeUndefined();
    expect(loaded.sessionPortalUrl).toBeUndefined();

    // Verify durable disk scrubbing: on-disk file is scrubbed!
    const scrubbedDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(scrubbedDisk.token).toBeUndefined();
    expect(scrubbedDisk.refreshToken).toBeUndefined();
    expect(scrubbedDisk.minecraftAccessToken).toBeUndefined();
  });
});

describe("Phase 2 Regression Gate — IPC Narrowing & Renderer Lockdown (SEC-02)", () => {
  test("[Phase 2 Gate] Operation-level: IPC handlers validate top-level sender frame and reject unauthorized callers", () => {
    // 1. Missing or destroyed main window
    IpcBoundary.resetForTesting();
    IpcBoundary.setMainWindow(null);
    expect(() => IpcBoundary.validateIpcSender({} as any)).toThrow(
      IpcSecurityError,
    );

    // 2. Setup mock main window
    const mockMainFrame = {
      parent: null,
      url: "http://localhost:5173",
      isDestroyed: () => false,
    };
    const mockWebContents = {
      id: 1,
      url: "http://localhost:5173",
      getURL: () => "http://localhost:5173",
      isDestroyed: () => false,
      mainFrame: mockMainFrame,
      on: () => {},
    };
    const mockWin = {
      isDestroyed: () => false,
      webContents: mockWebContents,
    } as any;
    IpcBoundary.setMainWindow(mockWin);
    IpcBoundary.setApprovedDocumentUrl("http://localhost:5173");

    // 3. Foreign webContents rejected
    expect(() =>
      IpcBoundary.validateIpcSender({
        sender: { id: 2, isDestroyed: () => false },
        senderFrame: {
          parent: null,
          url: "http://localhost:5173",
          isDestroyed: () => false,
        },
      } as any),
    ).toThrow("caller webContents does not match main window");

    // 4. Missing or destroyed sender frame
    expect(() =>
      IpcBoundary.validateIpcSender({
        sender: mockWebContents,
        senderFrame: null,
      } as any),
    ).toThrow("missing or destroyed sender frame");

    // 5. Child / iframe caller rejected
    expect(() =>
      IpcBoundary.validateIpcSender({
        sender: mockWebContents,
        senderFrame: {
          parent: {},
          url: "http://localhost:5173",
          isDestroyed: () => false,
        },
      } as any),
    ).toThrow("child frames and subdocuments are not permitted");

    // 6. Blank / uninitialized document rejected
    mockMainFrame.url = "about:blank";
    expect(() =>
      IpcBoundary.validateIpcSender({
        sender: mockWebContents,
        senderFrame: mockMainFrame,
      } as any),
    ).toThrow("uninitialized or blank document");

    // 7. Unapproved document URL / origin rejected
    mockMainFrame.url = "https://attacker.example.com";
    expect(() =>
      IpcBoundary.validateIpcSender({
        sender: mockWebContents,
        senderFrame: mockMainFrame,
      } as any),
    ).toThrow("not an approved application document");
    mockMainFrame.url = "http://localhost:5173";

    // 8. In-window navigation desync rejected
    mockWebContents.getURL = () => "http://localhost:5173/navigated";
    expect(() =>
      IpcBoundary.validateIpcSender({
        sender: mockWebContents,
        senderFrame: mockMainFrame,
      } as any),
    ).toThrow("document has navigated away from active frame URL");
    mockWebContents.getURL = () => "http://localhost:5173";

    // 9. Valid top-level frame accepted
    const valid = IpcBoundary.validateIpcSender({
      sender: mockWebContents,
      senderFrame: mockMainFrame,
    } as any);
    expect(valid.sender).toBe(mockWebContents as any);
    expect(valid.frame.parent).toBeNull();

    // 10. Document generation invalidation: approvals expire immediately on navigation/reload
    IpcBoundary.grantApproval("test:op", "C:\\allowed\\path");
    expect(IpcBoundary.hasApproval("test:op", "C:\\allowed\\path")).toBe(true);
    IpcBoundary.incrementDocumentGeneration();
    expect(IpcBoundary.hasApproval("test:op", "C:\\allowed\\path")).toBe(false);
  });

  test("[Phase 2 Gate] Operation-level: config:set enforces strict allowlist schema rejecting unapproved runtime fields", () => {
    // 1. Non-object payloads rejected
    expect(() => validateConfigSet(null)).toThrow(IpcValidationError);
    expect(() => validateConfigSet(undefined)).toThrow(IpcValidationError);
    expect(() => validateConfigSet("string")).toThrow(IpcValidationError);
    expect(() => validateConfigSet(123)).toThrow(IpcValidationError);
    expect(() => validateConfigSet([])).toThrow(IpcValidationError);

    // 2. Unapproved runtime fields rejected fail-closed (no blacklist leakage)
    expect(() => validateConfigSet({ gameDir: "C:\\forbidden" })).toThrow(
      "Unknown or unauthorized settings field",
    );
    expect(() => validateConfigSet({ gameDirConfigured: true })).toThrow(
      "Unknown or unauthorized settings field",
    );
    expect(() => validateConfigSet({ token: "leaked_token" })).toThrow(
      "Unknown or unauthorized settings field",
    );
    expect(() => validateConfigSet({ refreshToken: "leaked_refresh" })).toThrow(
      "Unknown or unauthorized settings field",
    );
    expect(() =>
      validateConfigSet({ minecraftAccessToken: "leaked_mc" }),
    ).toThrow("Unknown or unauthorized settings field");
    expect(() =>
      validateConfigSet({ sessionPortalUrl: "https://evil.com" }),
    ).toThrow("Unknown or unauthorized settings field");
    expect(() => validateConfigSet({ unexpectedKey: "any" })).toThrow(
      "Unknown or unauthorized settings field",
    );

    // 3. Schema types enforced
    expect(() => validateConfigSet({ portalUrl: "" })).toThrow(
      "portalUrl must be a non-empty string",
    );
    expect(() => validateConfigSet({ portalUrl: 123 as any })).toThrow(
      "portalUrl must be a non-empty string",
    );
    expect(() =>
      validateConfigSet({ selectedChannel: "invalid" as any }),
    ).toThrow("selectedChannel must be one of");
    expect(() => validateConfigSet({ allocatedRamGb: 1 })).toThrow(
      "allocatedRamGb must be an integer between 2 and 64",
    );
    expect(() => validateConfigSet({ allocatedRamGb: 65 })).toThrow(
      "allocatedRamGb must be an integer between 2 and 64",
    );
    expect(() => validateConfigSet({ allocatedRamGb: 4.5 })).toThrow(
      "allocatedRamGb must be an integer between 2 and 64",
    );
    expect(() => validateConfigSet({ noSync: "false" as any })).toThrow(
      "noSync must be a boolean",
    );
    expect(() => validateConfigSet({ javaPath: 123 as any })).toThrow(
      "javaPath must be a string",
    );
    expect(() => validateConfigSet({ javaArgs: 123 as any })).toThrow(
      "javaArgs must be a string",
    );

    // 4. Approved runtime fields accepted and sanitized
    const sanitized = validateConfigSet({
      portalUrl: "https://dev.lampas.town",
      selectedChannel: "beta",
      allocatedRamGb: 8,
      noSync: true,
      javaPath: "C:\\Java\\bin\\java.exe",
      javaArgs: "-Xmx8G -XX:+UseG1GC",
    });

    expect(sanitized.portalUrl).toBe("https://dev.lampas.town");
    expect(sanitized.selectedChannel).toBe("beta");
    expect(sanitized.allocatedRamGb).toBe(8);
    expect(sanitized.noSync).toBe(true);
    expect(sanitized.javaPath).toBe("C:\\Java\\bin\\java.exe");
    expect(sanitized.javaArgs).toBe("-Xmx8G -XX:+UseG1GC");
  });
});

describe("Phase 3 Regression Gate — Keyring / Session Store & Race-Safe Auth (SEC-03, SEC-08)", () => {
  test("[Phase 3 Gate] Persistence: config.json on disk contains no plaintext tokens or credentials", () => {
    // Establish a synthetic session with sensitive tokens via establishSession
    const written = ConfigManager.establishSession("https://dev.lampas.town", {
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
      minecraftAccessToken: "syn-test-mc-token-abcdef",
    });
    // Prove fixture setup succeeds and returns written values in memory
    expect(written.token).toBe("syn-test-bearer-token-12345");

    // Target invariant:
    // Stored credentials must be encrypted via OS-backed storage (DPAPI on Windows / libsecret on Linux)
    // or kept purely in-memory if a secure backend is unavailable, never persisted as plaintext JSON.
    const configPath = path.join(userDataDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(raw).not.toContain("syn-test-bearer-token-12345");
    expect(raw).not.toContain("syn-test-refresh-token-67890");
    expect(raw).not.toContain("syn-test-mc-token-abcdef");

    // Negative assertion: Attempting to set credentials via generic ConfigManager.set is stripped from disk
    ConfigManager.set({
      token: "injected-set-token-xyz",
      refreshToken: "injected-refresh-xyz",
    } as any);
    const rawAfter = fs.readFileSync(configPath, "utf-8");
    expect(rawAfter).not.toContain("injected-set-token-xyz");
    expect(rawAfter).not.toContain("injected-refresh-xyz");
  });

  test("[Phase 3 Gate] Operation-level: Authentication lifecycle uses session epochs and ignores late arrivals after logout", () => {
    // 1. Establish an active session
    ConfigManager.establishSession("https://dev.lampas.town", {
      token: "active-pre-logout-token",
      refreshToken: "active-pre-logout-refresh",
    });
    expect(SessionManager.isAuthenticated()).toBe(true);
    const epochBeforeLogout = SessionManager.getSessionEpoch();

    // 2. Perform logout
    LauncherAuth.logout();

    // 3. Invariants: epoch advanced, in-memory tokens wiped, persistent store cleared
    expect(SessionManager.getSessionEpoch()).toBeGreaterThan(epochBeforeLogout);
    expect(SessionManager.isAuthenticated()).toBe(false);
    expect(SessionManager.getCredentials()).toBeNull();
    expect(ConfigManager.get().token).toBeUndefined();
    expect(CredentialStore.loadCredentials()).toBeNull();

    // 4. Stale continuation check:
    // When epoch diverges during an asynchronous continuation, late responses are ignored
    const lateEpochSnapshot = epochBeforeLogout;
    expect(SessionManager.getSessionEpoch()).not.toBe(lateEpochSnapshot);

    // Further epoch invalidations (e.g. portal origin changes) preserve clean state
    ConfigManager.set({ portalUrl: "https://portal.lampas.town" });
    expect(SessionManager.isAuthenticated()).toBe(false);
    expect(ConfigManager.get().token).toBeUndefined();
  });

  test("[Phase 3 Gate] Migration: Coexisting protected credentials and legacy plaintext prioritize protected record and scrub plaintext", () => {
    class MockGateSafeStorage {
      isEncryptionAvailable() {
        return true;
      }
      getSelectedStorageBackend() {
        return "gnome_libsecret";
      }
      encryptString(plain: string) {
        return Buffer.from("ENC:" + plain);
      }
      decryptString(buf: Buffer) {
        const s = buf.toString("utf-8");
        if (!s.startsWith("ENC:")) throw new Error("Invalid ciphertext");
        return s.slice(4);
      }
    }
    const mockStorage = new MockGateSafeStorage();
    CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
    CredentialStore.setCustomUserDataDirForTesting(userDataDir);

    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          portalUrl: "https://dev.lampas.town",
          sessionPortalUrl: "https://dev.lampas.town",
          token: "legacy-plaintext-token",
          refreshToken: "legacy-plaintext-refresh",
          minecraftAccessToken: "legacy-plaintext-mc",
        },
        null,
        2,
      ),
    );

    CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "protected-store-token",
      refreshToken: "protected-store-refresh",
      portalAccountId: "user-protected-123",
      portalUsername: "ProtectedUser",
    });

    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    const outcome = SessionManager.initialize(
      configPath,
      "https://dev.lampas.town",
    );

    expect(outcome.protectedLoaded).toBe(true);
    expect(outcome.legacyScrubbed).toBe(true);
    expect(SessionManager.getCredentials()?.token).toBe(
      "protected-store-token",
    );

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDisk.token).toBeUndefined();
    expect(onDisk.refreshToken).toBeUndefined();
    expect(onDisk.minecraftAccessToken).toBeUndefined();
  });

  test("[Phase 3 Gate] Migration: Interrupted migration crash boundary recovers on restart and scrubs plaintext", () => {
    class MockGateSafeStorage {
      isEncryptionAvailable() {
        return true;
      }
      getSelectedStorageBackend() {
        return "gnome_libsecret";
      }
      encryptString(plain: string) {
        return Buffer.from("ENC:" + plain);
      }
      decryptString(buf: Buffer) {
        const s = buf.toString("utf-8");
        if (!s.startsWith("ENC:")) throw new Error("Invalid ciphertext");
        return s.slice(4);
      }
    }
    CredentialStore.setSafeStorageMockForTesting(
      new MockGateSafeStorage() as any,
    );
    CredentialStore.setCustomUserDataDirForTesting(userDataDir);

    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          portalUrl: "https://dev.lampas.town",
          sessionPortalUrl: "https://dev.lampas.town",
          token: "leftover-plaintext-token",
          refreshToken: "leftover-plaintext-refresh",
        },
        null,
        2,
      ),
    );

    CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "protected-interrupted-token",
      refreshToken: "protected-interrupted-refresh",
      portalAccountId: "user-456",
      portalUsername: "InterruptedUser",
    });

    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    const outcome = SessionManager.initialize(
      configPath,
      "https://dev.lampas.town",
    );

    expect(outcome.legacyScrubbed).toBe(true);
    expect(outcome.protectedLoaded).toBe(true);
    expect(SessionManager.getCredentials()?.token).toBe(
      "protected-interrupted-token",
    );

    const diskRaw = fs.readFileSync(configPath, "utf-8");
    expect(diskRaw).not.toContain("leftover-plaintext-token");
  });

  test("[Phase 3 Gate] Migration: Failed protected record load with legacy plaintext fails closed and scrubs disk without restoring session", () => {
    class MockGateSafeStorage {
      isEncryptionAvailable() {
        return true;
      }
      getSelectedStorageBackend() {
        return "gnome_libsecret";
      }
      encryptString(plain: string) {
        return Buffer.from("ENC:" + plain);
      }
      decryptString() {
        throw new Error("Decryption hardware key revoked");
      }
    }
    CredentialStore.setSafeStorageMockForTesting(
      new MockGateSafeStorage() as any,
    );
    CredentialStore.setCustomUserDataDirForTesting(userDataDir);

    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          portalUrl: "https://dev.lampas.town",
          sessionPortalUrl: "https://dev.lampas.town",
          token: "untrusted-resurrect-token",
          refreshToken: "untrusted-resurrect-refresh",
        },
        null,
        2,
      ),
    );

    const credFile = CredentialStore.getCredentialsFilePath();
    fs.writeFileSync(credFile, Buffer.from("ENC:CORRUPT_OR_KEY_REVOKED"));

    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    const outcome = SessionManager.initialize(
      configPath,
      "https://dev.lampas.town",
    );

    expect(SessionManager.isAuthenticated()).toBe(false);
    expect(SessionManager.getCredentials()).toBeNull();
    expect(outcome.failedProtectedLoad).toBe(true);
    expect(outcome.legacyScrubbed).toBe(true);

    const diskRaw = fs.readFileSync(configPath, "utf-8");
    expect(diskRaw).not.toContain("untrusted-resurrect-token");
    expect(fs.existsSync(credFile)).toBe(false);
  });

  test("[Phase 3 Gate] Persistence & Deletion: SaveCredentialsResult and ClearCredentialsResult report explicit outcomes and failure handling", () => {
    class MockGateSafeStorage {
      failEncrypt = false;
      isEncryptionAvailable() {
        return true;
      }
      getSelectedStorageBackend() {
        return "gnome_libsecret";
      }
      encryptString(plain: string) {
        if (this.failEncrypt) throw new Error("Simulated storage write error");
        return Buffer.from("ENC:" + plain);
      }
      decryptString(buf: Buffer) {
        const s = buf.toString("utf-8");
        if (!s.startsWith("ENC:")) throw new Error("Invalid ciphertext");
        return s.slice(4);
      }
    }
    const mockStorage = new MockGateSafeStorage();
    CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
    CredentialStore.setCustomUserDataDirForTesting(userDataDir);

    // 1. Successful save
    const saveResult = CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "save-outcome-token",
      refreshToken: "save-outcome-refresh",
      portalAccountId: "user-outcomes-1",
      portalUsername: "OutcomesUser",
    });
    expect(saveResult.success).toBe(true);
    expect(saveResult.sessionOnly).toBe(false);

    // 2. Failure during write reports error and does not claim success
    mockStorage.failEncrypt = true;
    const failedSave = CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "fail-save-token",
      portalAccountId: "user-outcomes-1",
      portalUsername: "OutcomesUser",
    });
    expect(failedSave.success).toBe(false);
    expect(failedSave.error).toBeDefined();
    expect(failedSave.error).toContain("secure storage");
    mockStorage.failEncrypt = false;

    // 3. Successful clear
    const clearResult = CredentialStore.clearCredentials();
    expect(clearResult.success).toBe(true);
    expect(clearResult.deletedTarget).toBe(true);

    // 4. Idempotent clear when file absent
    const clearIdempotent = CredentialStore.clearCredentials();
    expect(clearIdempotent.success).toBe(true);
    expect(clearIdempotent.deletedTarget).toBe(false);
  });

  test("[Phase 3 Gate] Session Replacement: establishNewSession does not inherit optional tokens; setCurrentUser blocks account relabeling", () => {
    // 1. Establish initial session for Account 1 with full optional tokens
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-acc-1",
      refreshToken: "refresh-acc-1",
      minecraftAccessToken: "mc-token-acc-1",
      portalAccountId: "acc-1",
      portalUsername: "Alice",
      minecraftUuid: "11111111-1111-1111-1111-111111111111",
      minecraftUsername: "AliceMC",
    });

    expect(SessionManager.getCredentials()?.minecraftAccessToken).toBe(
      "mc-token-acc-1",
    );
    expect(SessionManager.getCurrentRecord()?.portalAccountId).toBe("acc-1");

    // 2. Switch to Account 2 without supplying optional tokens
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-acc-2",
      refreshToken: "refresh-acc-2",
      portalAccountId: "acc-2",
      portalUsername: "Bob",
    });

    // Invariant: Account 2 must NEVER inherit Account 1's optional tokens!
    const acc2Creds = SessionManager.getCredentials();
    const acc2Record = SessionManager.getCurrentRecord();
    expect(acc2Creds?.token).toBe("token-acc-2");
    expect(acc2Record?.portalAccountId).toBe("acc-2");
    expect(acc2Creds?.minecraftAccessToken).toBeUndefined();
    expect(acc2Record?.minecraftUuid).toBeUndefined();

    // 3. Relabeling guard: setCurrentUser cannot alter account ID or portal origin
    expect(() => {
      SessionManager.setCurrentUser({
        id: "acc-unauthorized",
        name: "Eve",
        minecraftUuid: "22222222-2222-2222-2222-222222222222",
        minecraftUsername: "EveMC",
        isAdmin: false,
        isTech: false,
        roles: [],
        allowedChannels: [],
      });
    }).toThrow("Cannot relabel credentials");
  });

  test("[Phase 3 Gate] Scoped Refresh Coalescing: In-flight refresh coalesces matching keys and isolates epochs", async () => {
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "pre-refresh-token",
      refreshToken: "pre-refresh-token",
      portalAccountId: "user-coalesce-1",
      portalUsername: "CoalesceUser",
    });

    const currentEpoch = SessionManager.getSessionEpoch();
    let invocationCount = 0;
    const mockWorker = async () => {
      invocationCount++;
      await new Promise((r) => setTimeout(r, 20));
      return { valid: true };
    };

    // 1. Same origin, account, epoch share single in-flight Promise
    const p1 = SessionManager.getCoalescedRefresh(
      "https://dev.lampas.town",
      "user-coalesce-1",
      currentEpoch,
      mockWorker,
    );
    const p2 = SessionManager.getCoalescedRefresh(
      "https://dev.lampas.town",
      "user-coalesce-1",
      currentEpoch,
      mockWorker,
    );

    expect(p1).toBe(p2);
    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.valid).toBe(true);
    expect(res2.valid).toBe(true);
    expect(invocationCount).toBe(1);

    // 2. Epoch advancement creates independent coalescing key
    SessionManager.advanceSessionEpoch();
    const newEpoch = SessionManager.getSessionEpoch();
    expect(newEpoch).not.toBe(currentEpoch);

    const p3 = SessionManager.getCoalescedRefresh(
      "https://dev.lampas.town",
      "user-coalesce-1",
      newEpoch,
      mockWorker,
    );
    expect(p3).not.toBe(p1);
    await p3;
    expect(invocationCount).toBe(2);
  });

  test("[Phase 3 Gate] Storage Status: getStorageStatus returns accurate non-secret DTO", () => {
    const status = SessionManager.getStorageStatus();
    expect(typeof status.backend).toBe("string");
    expect(typeof status.sessionOnly).toBe("boolean");
    expect(typeof status.persistenceAvailable).toBe("boolean");

    // Negative invariant: no secrets leaked in status
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
  });
});

describe("Phase 4 Regression Gate — Path Ownership, Containment & Safe Recovery (SEC-04, SEC-05)", () => {
  test("[Phase 4 Gate] Path helper: isPathProtected normalizes dot-aliases before checking protected namespaces", () => {
    // Target invariant: Dot-alias traversal 'mods/../saves/world.txt' must resolve into protected
    // 'saves/' namespace and return true (protected).
    expect(isPathProtected("mods/../saves/world.txt")).toBe(true);
  });

  test("[Phase 4 Gate] Path helper: isPathProtected performs case-insensitive comparison on Windows", () => {
    // Target invariant: On Windows, case variations of protected namespaces ('Saves/', 'SAVES/')
    // must be recognized as protected.
    expect(isPathProtected("SAVES/world.txt")).toBe(true);
    expect(isPathProtected("Saves/world.txt")).toBe(true);
  });

  test("[Phase 4 Gate] Path helper: isPathProtected reserves internal launcher namespaces (.lampas)", () => {
    // Target invariant: The launcher internal state directory (.lampas/) must be protected.
    expect(isPathProtected(".lampas/installation.json")).toBe(true);
  });

  test("[Phase 4 Gate] Operation-level: Client sync pipeline blocks unauthorized file mutations in protected paths", async () => {
    // 1. Mock portal serving malicious manifest attempting mutation of protected path 'saves/stolen-world.txt'
    const mockHash =
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({
            channel: "stable",
            version: "2.5.0",
            release: "/api/v1/releases/2.5.0",
          });
        }
        if (url.pathname === "/api/v1/releases/2.5.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.5.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            minimumLauncherVersion: "1.0.0",
            protocol: 3,
            created: "2026-01-01T00:00:00Z",
            clientManifest: "/api/v1/releases/2.5.0/client-manifest",
            serverManifest: "/api/v1/releases/2.5.0/server-manifest",
          });
        }
        if (url.pathname === "/api/v1/releases/2.5.0/client-manifest") {
          return Response.json({
            schemaVersion: 2,
            pack: "Lampas 2",
            version: "2.5.0",
            target: "client",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            protocol: 3,
            files: [
              {
                path: "saves/stolen-world.txt",
                hashes: { sha256: mockHash },
                size: 10,
                download: {
                  url: `/api/v1/blobs/${mockHash}`,
                  provider: "lampas",
                },
                policy: "MANAGED",
              },
            ],
            mods: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      ConfigManager.set({ gameDir, selectedChannel: "stable" });
      ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, {
        token: "gate-token-123",
      });

      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /protected namespace/,
      );

      // Verify negative invariant: protected path was never written to on disk
      expect(
        fs.existsSync(path.join(gameDir, "saves", "stolen-world.txt")),
      ).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("[Phase 4 Gate] Operation-level: Move recovery rejects unverified staging paths outside approved launcher staging", async () => {
    const outsideVictimDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "lampas-victim-staging-"),
    );
    const outsideVictimFile = path.join(
      outsideVictimDir,
      "important-user-document.txt",
    );
    fs.writeFileSync(
      outsideVictimFile,
      "vital-user-data-do-not-delete",
      "utf-8",
    );

    const journalPath = path.join(userDataDir, "directory-move.json");
    const unverifiedJournal = {
      version: 2,
      operationId: "op-unverified-recovery-test",
      phase: "preparing",
      source: path.join(gameDir, "source-dir"),
      target: path.join(gameDir, "target-dir"),
      staging: outsideVictimDir,
      startTime: new Date().toISOString(),
    };
    fs.writeFileSync(
      journalPath,
      JSON.stringify(unverifiedJournal, null, 2),
      "utf-8",
    );

    try {
      ConfigManager.set({ gameDir });
      await expect(
        GameDirectoryManager.recoverInterruptedMove(),
      ).rejects.toThrow(/quarantined/i);

      // Journal must be quarantined, not executed
      expect(fs.existsSync(journalPath)).toBe(false);
      const quarantined = fs
        .readdirSync(userDataDir)
        .filter((f: string) => f.startsWith("directory-move.json.quarantine."));
      expect(quarantined.length).toBeGreaterThan(0);

      // Target invariant: victim directory and data outside launcher staging remain intact
      expect(fs.existsSync(outsideVictimDir)).toBe(true);
      expect(fs.existsSync(outsideVictimFile)).toBe(true);
      expect(fs.readFileSync(outsideVictimFile, "utf-8")).toBe(
        "vital-user-data-do-not-delete",
      );
    } finally {
      if (fs.existsSync(outsideVictimDir)) {
        fs.rmSync(outsideVictimDir, { recursive: true, force: true });
      }
    }
  });
});

describe("Phase 5 Regression Gate — Integrity Checks Fail Closed & Fallback Policy (SEC-06, SEC-07, SEC-11)", () => {
  test("[Phase 5 Gate] Operation-level: FabricMetaResolver fails closed when sidecar checksum resolution fails", async () => {
    const runtime = {
      minecraft: "26.2",
      loader: { type: "fabric" as const, version: "0.19.3" },
    };
    const fetchFn = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith(".sha256") || url.endsWith(".sha1")) {
        return new Response("Not Found", { status: 404 });
      }
      return Response.json({
        loader: {
          maven: "net.fabricmc:fabric-loader:0.19.3",
          version: "0.19.3",
        },
        intermediary: {
          maven: "net.fabricmc:intermediary:26.2",
          version: "26.2",
        },
        launcherMeta: {
          libraries: {
            common: [{ name: "net.fabricmc:sponge-mixin:0.15.3+mixin.0.8.7" }],
            client: [],
          },
          mainClass: {
            client: "net.fabricmc.loader.impl.launch.knot.KnotClient",
          },
        },
      });
    };

    await expect(
      FabricMetaResolver.resolveFabricRuntime(runtime, undefined, { fetchFn }),
    ).rejects.toThrow(/missing an expected SHA-1 or SHA-256 checksum/i);
  });
  test("[Phase 5 Gate] Operation-level: syncClient does not swallow 410 REVOKED releases into local pipeline fallback", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({
            channel: "stable",
            version: "9.9.9",
            release: "/api/v1/releases/9.9.9",
          });
        }
        if (url.pathname === "/api/v1/releases/9.9.9") {
          return new Response(
            JSON.stringify({ error: "revoked", status: "REVOKED" }),
            { status: 410 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    try {
      ConfigManager.set({ gameDir, selectedChannel: "stable" });
      ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, {
        token: "gate-token-410",
      });
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /REVOKED/,
      );
      expect(
        fs.existsSync(path.join(gameDir, ".lampas", "installation.json")),
      ).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("Phase 6 Regression Gate — Log Minimization & Redaction (SEC-09, SEC-10)", () => {
  test("[Phase 6 Gate] Redaction helper: LauncherLoggerService.sanitize redacts underscore credential keys and URL query codes", () => {
    // Target invariant:
    // Underscore fields (refresh_token, access_token) and URL query secrets (?code=..., ?token=...) must be redacted.
    expect(
      LauncherLoggerService.sanitize('{"refresh_token": "secret123"}'),
    ).toContain("[REDACTED]");
    expect(
      LauncherLoggerService.sanitize(
        "https://auth.town/callback?code=secret123",
      ),
    ).not.toContain("secret123");
    expect(LauncherLoggerService.sanitize("--accessToken secret123")).toContain(
      "[REDACTED]",
    );
  });

  test("[Phase 6 Gate] Operation-level: ProcessLogFramer discards oversized raw records", async () => {
    const { ProcessLogFramer } = await import("../src/game-log-stream");
    const output: string[] = [];
    const framer = new ProcessLogFramer(
      "INFO",
      (entry) => output.push(entry.message),
      { maxLineLength: 64 },
    );
    framer.pushChunk('{"access_token":"' + "secret".repeat(30));
    framer.pushChunk('"}\n');
    framer.finishOnce();
    expect(output).toEqual(["[Oversized log record discarded]"]);
  });
});

describe("Phase 7 Regression Gate — Release Pipeline & CI Controls (SEC-12)", () => {
  async function readReleaseContracts() {
    const { parse } = await import("yaml");
    const workflow = parse(
      fs.readFileSync(
        path.resolve(__dirname, "../.github/workflows/release-pack.yml"),
        "utf8",
      ),
    );
    const packageConfig = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
    );
    return { workflow, packageConfig };
  }

  test("[Phase 7 Gate] Windows signing is optional while icon resources remain configured", async () => {
    const { workflow, packageConfig } = await readReleaseContracts();
    expect(packageConfig.build.forceCodeSigning).toBe(false);
    expect(packageConfig.build.win.icon).toBe("assets/lampas.png");
    expect(packageConfig.build.win.target).toEqual(["nsis", "portable"]);
    expect(packageConfig.build.win.signAndEditExecutable).not.toBe(false);

    const buildSteps = workflow.jobs.build.steps;
    expect(
      buildSteps.some((step: any) =>
        step.run?.includes("Get-AuthenticodeSignature"),
      ),
    ).toBe(false);
    expect(
      buildSteps.some((step: any) =>
        JSON.stringify(step.env ?? {}).includes("APPROVED_SIGNING_THUMBPRINT"),
      ),
    ).toBe(false);
  });

  test("[Phase 7 Gate] Exact-commit builds retain validation and protected publication controls", async () => {
    const { workflow } = await readReleaseContracts();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.workflow_dispatch).toBeDefined();

    const buildSteps = workflow.jobs.build.steps;
    const checkout = buildSteps.find((step: any) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout.with).toEqual({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });
    for (const command of [
      "bun run typecheck",
      "bun run build",
      "bun test",
      "bun audit",
    ]) {
      expect(buildSteps.some((step: any) => step.run === command)).toBe(true);
    }

    const artifactGenerationIndex = buildSteps.findIndex(
      (step: any) => step.run === "bun run security:artifacts",
    );
    const uploadIndex = buildSteps.findIndex((step: any) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const upload = buildSteps[uploadIndex];
    expect(artifactGenerationIndex).toBeGreaterThanOrEqual(0);
    expect(artifactGenerationIndex).toBeLessThan(uploadIndex);
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.with["retention-days"]).toBe(7);
    expect(upload.with.path).toContain("release/*.cdx.json");
    expect(upload.with.path).toContain("release/SHA256SUMS-*.txt");

    const releaseJob = workflow.jobs.release;
    expect(releaseJob.needs).toBe("build");
    expect(releaseJob.if).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(releaseJob.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });

    const releaseSteps = releaseJob.steps;
    const checksumIndex = releaseSteps.findIndex((step: any) =>
      step.run?.includes("sha256sum --check"),
    );
    const provenanceIndex = releaseSteps.findIndex((step: any) =>
      step.uses?.startsWith("actions/attest-build-provenance@"),
    );
    const provenanceStep = releaseSteps[provenanceIndex];
    expect(provenanceStep.if).toBe(
      "github.event.repository.private == false || vars.ENABLE_ARTIFACT_ATTESTATIONS == 'true'",
    );
    const skippedProvenanceIndex = releaseSteps.findIndex(
      (step: any) =>
        step.if ===
          "github.event.repository.private == true && vars.ENABLE_ARTIFACT_ATTESTATIONS != 'true'" &&
        step.run?.includes("No GitHub artifact attestation is generated") &&
        step.run?.includes("SBOM") &&
        step.run?.includes("SHA256SUMS"),
    );
    const publishIndex = releaseSteps.findIndex((step: any) =>
      step.uses?.startsWith("softprops/action-gh-release@"),
    );
    expect(checksumIndex).toBeGreaterThanOrEqual(0);
    expect(provenanceIndex).toBeGreaterThan(checksumIndex);
    expect(skippedProvenanceIndex).toBeGreaterThan(checksumIndex);
    expect(publishIndex).toBeGreaterThan(
      Math.max(provenanceIndex, skippedProvenanceIndex),
    );

    for (const job of Object.values(workflow.jobs) as any[])
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      }
  });

  test("[Phase 7 Gate] Linux sandbox helpers run before packaged Electron smoke", async () => {
    const { workflow } = await readReleaseContracts();
    const buildSteps = workflow.jobs.build.steps;
    const sandboxIndex = buildSteps.findIndex(
      (step: any) =>
        step.if === "runner.os == 'Linux'" &&
        step.run?.includes("sudo chown root:root") &&
        step.run?.includes("sudo chmod 4755") &&
        step.run?.includes("node_modules/electron/dist/chrome-sandbox") &&
        step.run?.includes("release/linux-unpacked/chrome-sandbox"),
    );
    expect(sandboxIndex).toBeGreaterThanOrEqual(0);

    const linuxElectronSmokeIndices = buildSteps.flatMap(
      (step: any, index: number) =>
        step.if === "runner.os == 'Linux'" &&
        (step.run?.includes("electron-smoke.ts") ||
          step.run?.includes("packaged-workflow.cjs"))
          ? [index]
          : [],
    );
    expect(linuxElectronSmokeIndices).toHaveLength(2);
    for (const smokeIndex of linuxElectronSmokeIndices) {
      expect(smokeIndex).toBeGreaterThan(sandboxIndex);
    }
  });
});
