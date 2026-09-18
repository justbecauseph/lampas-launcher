import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Phase 3 Security Failure Reproductions (SEC-03, SEC-08)
 *
 * Exercises real production operations against failure paths identified in
 * Review Gate 3 amendment requirements:
 * 1. Timeout / cancellation / supersession in login lifecycle
 * 2. Failed credential deletion during logout and prevention of silent resurrection
 * 3. Failed account replacement preventing stale account resurrection
 * 4. Duplicate encrypted / plaintext records migration
 * 5. Scrub-write failure and recovery on restart
 * 6. Cross-account optional-token inheritance
 * 7. Fixed-temporary-path symlink / hardlink collision vulnerability
 */

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-repro-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : testRoot),
    getName: () => "Lampas Launcher",
    getVersion: () => "1.3.0",
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
let LauncherAuth: any;
let CredentialStore: any;
let SessionManager: any;
let PortalPolicy: any;

class MockSafeStorage {
  available = true;
  failEncrypt = false;
  isEncryptionAvailable() { return this.available; }
  encryptString(plain: string) {
    if (this.failEncrypt) throw new Error("Disk full / encrypt failed");
    return Buffer.from("ENC:" + plain);
  }
  decryptString(buf: Buffer) {
    const s = buf.toString("utf-8");
    if (!s.startsWith("ENC:")) throw new Error("Invalid ciphertext");
    return s.slice(4);
  }
}

beforeAll(async () => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });

  const configMod = await import("../src/config");
  ConfigManager = configMod.ConfigManager;
  normalizePortalUrl = configMod.normalizePortalUrl;
  PortalPolicy = configMod.PortalPolicy;

  const authMod = await import("../src/auth");
  LauncherAuth = authMod.LauncherAuth;

  const credMod = await import("../src/credential-store");
  CredentialStore = credMod.CredentialStore;

  const sessMod = await import("../src/session-manager");
  SessionManager = sessMod.SessionManager;
});

beforeEach(() => {
  PortalPolicy?.configureDevelopmentPolicy({ allowLoopback: true });
  CredentialStore?.resetForTesting();
  SessionManager?.resetForTesting();
  ConfigManager?.resetForTesting();
  CredentialStore?.setSafeStorageMockForTesting(new MockSafeStorage() as any);
  CredentialStore?.setCustomUserDataDirForTesting(userDataDir);
});

afterAll(() => {
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {}
});

describe("Phase 3 Failure Path Reproductions", () => {
  test("Reproduce: Cancellation, timeout, and supersession settle login promise and clean up resources", async () => {
    // 1. Cancellation path
    const loginPromise1 = LauncherAuth.loginWithPortal();
    expect(LauncherAuth.activeLoginContext).not.toBeNull();
    const epoch1 = LauncherAuth.activeLoginContext.epoch;

    LauncherAuth.cancelLogin();
    expect(LauncherAuth.activeLoginContext).toBeNull();
    await expect(loginPromise1).rejects.toThrow("Authentication cancelled by user");

    // 2. Supersession path
    const loginPromise2 = LauncherAuth.loginWithPortal();
    const context2 = LauncherAuth.activeLoginContext;
    expect(context2).not.toBeNull();

    // Start a second login while first is in-flight -> supersedes first
    const loginPromise3 = LauncherAuth.loginWithPortal();
    await expect(loginPromise2).rejects.toThrow("superseded");

    // Clean up second
    LauncherAuth.cancelLogin();
    await expect(loginPromise3).rejects.toThrow("cancelled");
  });

  test("Reproduce: Failed credential deletion on logout must report failure and prevent silent resurrection", () => {
    // Setup initial valid credential record on disk
    CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "secret-token-victim",
      refreshToken: "secret-refresh-victim",
      portalAccountId: "user-victim",
      portalUsername: "VictimUser",
    });

    const credFile = CredentialStore.getCredentialsFilePath();
    expect(fs.existsSync(credFile)).toBe(true);

    // Make the credential file un-deletable (simulating EBUSY or permission denied)
    const origUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((p: any) => {
      if (p.toString().includes("credentials.enc")) {
        const err: any = new Error("EBUSY: resource busy or locked");
        err.code = "EBUSY";
        throw err;
      }
      return origUnlink(p);
    });

    try {
      const clearResult = CredentialStore.clearCredentials();

      // Clear must report failure (not falsely claim success!)
      expect(clearResult.success).toBe(false);
      expect(clearResult.error).toContain("busy or locked");
      expect(CredentialStore.getLastCleanupError()).toBeDefined();

      // On restart / loadCredentials: if file could not be deleted,
      // it MUST NOT silently resurrect the logged-out victim credentials!
      // (Either zeroed out, invalidated, or loadCredentials rejects it)
      const reloaded = CredentialStore.loadCredentials();
      expect(reloaded).toBeNull();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  test("Reproduce: Failed account replacement prevents resurrection of older account", () => {
    // 1. Account A is established and persisted
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-acc-a",
      refreshToken: "refresh-acc-a",
      portalAccountId: "acc-a",
      portalUsername: "Alice",
    });
    expect(SessionManager.getCredentials()?.token).toBe("token-acc-a");

    // 2. Account B login starts, but disk persistence write fails
    const mockStorage = new MockSafeStorage();
    mockStorage.failEncrypt = true;
    CredentialStore.setSafeStorageMockForTesting(mockStorage as any);

    // When save fails, establishNewSession must clean up disk so Account A does NOT resurrect
    const result = SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-acc-b",
      refreshToken: "refresh-acc-b",
      portalAccountId: "acc-b",
      portalUsername: "Bob",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // In-memory session is active for Account B in session_only mode
    expect(SessionManager.getCredentials()?.token).toBe("token-acc-b");

    // Invariant: Disk must NOT resurrect Account A on restart!
    mockStorage.failEncrypt = false;
    const reloaded = CredentialStore.loadCredentials();
    expect(reloaded).toBeNull();
  });

  test("Reproduce: Duplicate encrypted and plaintext records prioritize protected record and scrub plaintext", () => {
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      portalUrl: "https://dev.lampas.town",
      sessionPortalUrl: "https://dev.lampas.town",
      token: "plaintext-token-old",
      refreshToken: "plaintext-refresh-old",
    }, null, 2));

    CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "encrypted-token-active",
      refreshToken: "encrypted-refresh-active",
      portalAccountId: "acc-active",
      portalUsername: "ActiveUser",
    });

    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    const outcome = SessionManager.initialize(configPath, "https://dev.lampas.town");

    expect(outcome.protectedLoaded).toBe(true);
    expect(outcome.legacyScrubbed).toBe(true);
    expect(SessionManager.getCredentials()?.token).toBe("encrypted-token-active");

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDisk.token).toBeUndefined();
    expect(onDisk.refreshToken).toBeUndefined();
  });

  test("Reproduce: Scrub-write failure on config.json is tracked and retried on restart", () => {
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      portalUrl: "https://dev.lampas.town",
      sessionPortalUrl: "https://dev.lampas.town",
      token: "plaintext-scrub-target",
    }, null, 2));

    // Simulate write error when attempting to scrub config.json
    const origWrite = fs.writeFileSync.bind(fs);
    let failScrub = true;
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((p: any, data: any, opts: any) => {
      if (failScrub && p.toString().includes("config.json")) {
        const err: any = new Error("EPERM: permission denied");
        err.code = "EPERM";
        throw err;
      }
      return origWrite(p, data, opts);
    });

    try {
      SessionManager.resetForTesting();
      const outcome1 = SessionManager.initialize(configPath, "https://dev.lampas.town");
      expect(outcome1.legacyScrubbed).toBe(false);
      expect(outcome1.error).toContain("EPERM");

      // Disk still has plaintext because scrub failed
      expect(fs.readFileSync(configPath, "utf-8")).toContain("plaintext-scrub-target");

      // Restart: Write permission is restored
      failScrub = false;
      SessionManager.resetForTesting();
      const outcome2 = SessionManager.initialize(configPath, "https://dev.lampas.town");
      expect(outcome2.legacyScrubbed).toBe(true);
      expect(fs.readFileSync(configPath, "utf-8")).not.toContain("plaintext-scrub-target");
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("Reproduce: Cross-account optional token inheritance must never occur in establishNewSession", () => {
    // 1. Account A logs in with all optional tokens
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-acc-a",
      refreshToken: "refresh-acc-a",
      minecraftAccessToken: "mc-token-acc-a-secret",
      portalAccountId: "acc-a",
      portalUsername: "Alice",
      minecraftUuid: "uuid-a",
      minecraftUsername: "AliceMC",
    });

    expect(SessionManager.getCredentials()?.minecraftAccessToken).toBe("mc-token-acc-a-secret");

    // 2. Account B logs in without minecraftAccessToken
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-acc-b",
      refreshToken: "refresh-acc-b",
      portalAccountId: "acc-b",
      portalUsername: "Bob",
    });

    // Invariant: Account B must NOT inherit Account A's minecraftAccessToken or UUID!
    const credsB = SessionManager.getCredentials();
    const recordB = SessionManager.getCurrentRecord();
    expect(credsB?.token).toBe("token-acc-b");
    expect(credsB?.minecraftAccessToken).toBeUndefined();
    expect(recordB?.minecraftUuid).toBeUndefined();
    expect(recordB?.minecraftUsername).toBeUndefined();
  });

  test("Reproduce: Fixed temporary path link case — pre-existing temporary file or link must be prevented from clobbering", () => {
    // If credential store used a fixed temporary path (credentials.enc.tmp):
    // A pre-existing file or symlink at that path could be overwritten or followed!
    const fixedTemp = CredentialStore.getTempFilePath();
    const targetPayload = "ATTACKER_OR_SENSITIVE_PRE_EXISTING_DATA";
    fs.writeFileSync(fixedTemp, targetPayload, "utf-8");

    // Saving credentials uses unique temporary files with O_CREAT | O_EXCL and verifies regular file
    const saveResult = CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "secret-token-hardened",
      refreshToken: "secret-refresh-hardened",
      portalAccountId: "acc-hardened",
      portalUsername: "HardenedUser",
    });

    expect(saveResult.success).toBe(true);
    // Pre-existing fixed temporary file was NOT clobbered or hijacked as the swap target
    expect(fs.readFileSync(fixedTemp, "utf-8")).toBe(targetPayload);

    // Clean up
    fs.unlinkSync(fixedTemp);
  });

  test("Reproduce Defect 1: Persist A, restart with provider unavailable, establish B in session-only mode, restore provider and restart — A must not resurrect", () => {
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ portalUrl: "https://dev.lampas.town" }));

    // Step 1: Persist A
    const mockStorage = new MockSafeStorage();
    CredentialStore.setSafeStorageMockForTesting(mockStorage as any);
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-acc-a",
      refreshToken: "refresh-acc-a",
      portalAccountId: "acc-a",
      portalUsername: "Alice",
    });
    expect(SessionManager.getCredentials()?.token).toBe("token-acc-a");
    expect(CredentialStore.hasStoredCredentialsFile()).toBe(true);

    // Step 2: Restart with provider unavailable
    mockStorage.available = false;
    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    SessionManager.initialize(configPath, "https://dev.lampas.town");
    expect(SessionManager.getCredentials()).toBeNull();
    expect(SessionManager.getCurrentRecord()).toBeNull();

    // Step 3: Establish B in session-only mode
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-acc-b",
      refreshToken: "refresh-acc-b",
      portalAccountId: "acc-b",
      portalUsername: "Bob",
    });
    expect(SessionManager.getCredentials()?.token).toBe("token-acc-b");

    // Step 4: Restore provider and restart
    mockStorage.available = true;
    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    SessionManager.initialize(configPath, "https://dev.lampas.town");

    // Account A MUST NOT SILENTLY RESURRECT!
    expect(SessionManager.getCredentials()?.token).not.toBe("token-acc-a");
    expect(CredentialStore.loadCredentials()).toBeNull();
  });

  test("Reproduce Defect 2: Reject invalid authentication data before publication (no session-only downgrade, no placeholders, no Portal-ID-as-Minecraft-UUID)", () => {
    // 1. Missing or empty token must throw, not downgrade to session-only and publish
    expect(() => {
      SessionManager.establishNewSession("https://dev.lampas.town", {
        token: "",
        portalAccountId: "acc-1",
        portalUsername: "User1",
      });
    }).toThrow();
    expect(SessionManager.getCredentials()).toBeNull();

    // 2. Missing account ID or username must throw, not downgrade or use 'account'/'player' placeholder
    expect(() => {
      SessionManager.establishNewSession("https://dev.lampas.town", {
        token: "valid-token",
        portalAccountId: "",
        portalUsername: "",
      });
    }).toThrow();
    expect(SessionManager.getCredentials()).toBeNull();

    // 3. Restoring credentials without minecraftUuid must NOT set minecraftUuid to accountId
    const testRecord: any = {
      version: 1,
      schemaVersion: 1,
      portalUrl: "https://dev.lampas.town",
      token: "token-valid",
      portalAccountId: "portal-id-789",
      portalUsername: "TestUser",
    };
    CredentialStore.saveCredentials(testRecord);
    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ portalUrl: "https://dev.lampas.town" }));
    SessionManager.initialize(configPath, "https://dev.lampas.town");
    const restoredUser = SessionManager.getCurrentUser();
    expect(restoredUser?.id).toBe("portal-id-789");
    expect(restoredUser?.minecraftUuid).not.toBe("portal-id-789");
    expect(restoredUser?.minecraftUuid).toBeUndefined();
  });

  test("Reproduce Defect 3: Malformed legacy data is ineligible without bypassing cleanup; preserves settings", () => {
    CredentialStore.clearCredentials();
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      portalUrl: "https://dev.lampas.town",
      sessionPortalUrl: ":::not-a-valid-url:::", // Malformed URL throws in normalizePortalUrl
      token: 12345, // Malformed non-string token
      refreshToken: true,
      ram: 6,
      gameDir: "C:\\CustomGames",
    }, null, 2));

    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    const outcome = SessionManager.initialize(configPath, "https://dev.lampas.town");

    // Legacy data is ineligible
    expect(outcome.migrated).toBe(false);
    expect(SessionManager.getCredentials()).toBeNull();

    // But cleanup MUST still run and succeed!
    expect(outcome.legacyScrubbed).toBe(true);
    const scrubbed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(scrubbed.token).toBeUndefined();
    expect(scrubbed.sessionPortalUrl).toBeUndefined();
    // Non-secret settings must be preserved
    expect(scrubbed.ram).toBe(6);
    expect(scrubbed.gameDir).toBe("C:\\CustomGames");
  });

  test("Reproduce Defect 4: Short write and invalidation marker persistence contract", () => {
    // 1. Invalidation marker exists and cannot be unlinked -> saveCredentials must NOT report success!
    const markerPath = CredentialStore.getInvalidationMarkerPath();
    fs.writeFileSync(markerPath, JSON.stringify({ invalidatedAt: Date.now() }), "utf-8");

    const origUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((p: any) => {
      if (p.toString().includes("credentials.invalidated")) {
        const err: any = new Error("EPERM: cannot delete invalidation marker");
        err.code = "EPERM";
        throw err;
      }
      return origUnlink(p);
    });

    try {
      const result = CredentialStore.saveCredentials({
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "token-cannot-commit",
        portalAccountId: "acc-fail",
        portalUsername: "UserFail",
      });

      // MUST NOT report success when invalidation marker will reject the record on reload!
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      unlinkSpy.mockRestore();
      try { fs.unlinkSync(markerPath); } catch {}
    }
  });

  test("Reproduce Defect 4b: Independent write failure path unlinks temp and fails cleanly", () => {
    const origWrite = fs.writeSync.bind(fs);
    const writeSpy = spyOn(fs, "writeSync").mockImplementation((...args: any[]) => {
      const err: any = new Error("EIO: I/O error during write");
      err.code = "EIO";
      throw err;
    });

    try {
      const result = CredentialStore.saveCredentials({
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "token-write-fail",
        portalAccountId: "acc-write-fail",
        portalUsername: "WriteFailUser",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      const dir = path.dirname(CredentialStore.getCredentialsFilePath());
      const tempFiles = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(tempFiles.length).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("Reproduce Defect 4c: Independent flush failure path unlinks temp and fails cleanly", () => {
    const origFsync = fs.fsyncSync.bind(fs);
    const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((...args: any[]) => {
      const err: any = new Error("EIO: I/O error during fsync");
      err.code = "EIO";
      throw err;
    });

    try {
      const result = CredentialStore.saveCredentials({
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "token-fsync-fail",
        portalAccountId: "acc-fsync-fail",
        portalUsername: "FsyncFailUser",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      const dir = path.dirname(CredentialStore.getCredentialsFilePath());
      const tempFiles = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(tempFiles.length).toBe(0);
    } finally {
      fsyncSpy.mockRestore();
    }
  });

  test("Reproduce Defect 4d: Independent rename failure path unlinks temp and fails cleanly", () => {
    const origRename = fs.renameSync.bind(fs);
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((oldP: any, newP: any) => {
      if (oldP.toString().includes("credentials.enc.tmp")) {
        const err: any = new Error("EBUSY: resource busy or locked");
        err.code = "EBUSY";
        throw err;
      }
      return origRename(oldP, newP);
    });

    try {
      const result = CredentialStore.saveCredentials({
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "token-rename-fail",
        portalAccountId: "acc-rename-fail",
        portalUsername: "RenameFailUser",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      const dir = path.dirname(CredentialStore.getCredentialsFilePath());
      const tempFiles = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(tempFiles.length).toBe(0);
    } finally {
      renameSpy.mockRestore();
    }
  });

  test("Reproduce Defect 5: Storage status tracks session persistence separately from provider and returns bounded safe error", () => {
    const mockStorage = new MockSafeStorage();
    mockStorage.failEncrypt = true;
    CredentialStore.setSafeStorageMockForTesting(mockStorage as any);

    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-session-mem",
      portalAccountId: "acc-mem",
      portalUsername: "MemUser",
    });

    const status = SessionManager.getStorageStatus();
    expect(status.persistenceAvailable).toBe(true);
    expect(status.sessionOnly).toBe(true);
    expect(status.sessionPersisted).toBe(false);

    if (status.lastPersistenceError) {
      expect(status.lastPersistenceError.includes("C:\\")).toBe(false);
      expect(status.lastPersistenceError.length).toBeLessThanOrEqual(120);
    }
  });

  test("Reproduce Defect 6: Held-exchange cancellation and supersession with deterministic barriers and nonpublication", async () => {
    let barrierResolve: (value: any) => void;
    const barrierPromise = new Promise((resolve) => {
      barrierResolve = resolve;
    });

    // Mock fetch for token exchange to hold at barrier
    const origFetch = globalThis.fetch;
    let exchangeStarted = false;
    let exchangeDone = false;

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      if (url.toString().includes("/api/v1/auth/exchange")) {
        exchangeStarted = true;
        await barrierPromise;
        exchangeDone = true;
        return new Response(
          JSON.stringify({
            token: "late-token-should-not-publish",
            user: {
              id: "late-user-id",
              name: "LateUser",
              minecraftUuid: "11111111-1111-1111-1111-111111111111",
              minecraftUsername: "LateUserMC",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return origFetch(url, init);
    });

    try {
      // Start login flow with error capture
      let loginErr: any = null;
      const loginPromise = LauncherAuth.loginWithPortal();
      loginPromise.catch((err: any) => {
        loginErr = err;
      });

      const context = LauncherAuth.activeLoginContext;
      expect(context).not.toBeNull();

      // Wait until loopback listener is ready and context.authUrl is populated
      while (!context.authUrl) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Send callback request to trigger exchange
      const authUrl = context.authUrl || "";
      const portMatch = authUrl.match(/port=(\d+)/);
      const stateMatch = authUrl.match(/state=([^&]+)/);
      const port = parseInt(portMatch![1], 10);
      const state = decodeURIComponent(stateMatch![1]);

      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: `/callback?code=test-auth-code&state=${encodeURIComponent(state)}`,
        method: "GET",
      });
      clientReq.on("error", () => {});
      clientReq.on("response", (res) => {
        res.resume();
      });
      clientReq.end();

      // Wait until exchange is held at barrier
      while (!exchangeStarted) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Now cancel login WHILE exchange is held
      LauncherAuth.cancelLogin();

      // Release barrier so held exchange completes or aborts
      barrierResolve!(true);

      // Wait for late exchange response to be processed and discarded
      await new Promise((r) => setTimeout(r, 50));

      expect(loginErr).toBeDefined();
      expect(loginErr.message).toContain("cancelled");

      // Explicit nonpublication assertions:
      expect(SessionManager.getCredentials()).toBeNull();
      expect(SessionManager.getCurrentUser()).toBeNull();
      expect(ConfigManager.get().token).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("Reproduce Defect 6b: Held-exchange timeout with deterministic barrier and nonpublication", async () => {
    let barrierResolve: (value: any) => void;
    const barrierPromise = new Promise((resolve) => {
      barrierResolve = resolve;
    });

    let exchangeStarted = false;
    const origFetch = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      if (url.toString().includes("/api/v1/auth/exchange")) {
        exchangeStarted = true;
        await barrierPromise;
        return new Response(
          JSON.stringify({
            token: "timed-out-token-should-not-publish",
            user: {
              id: "timed-out-user-id",
              name: "TimedOutUser",
              minecraftUuid: "22222222-2222-2222-2222-222222222222",
              minecraftUsername: "TimedOutMC",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return origFetch(url, init);
    });

    try {
      let loginErr: any = null;
      const loginPromise = LauncherAuth.loginWithPortal();
      loginPromise.catch((err: any) => {
        loginErr = err;
      });

      const context = LauncherAuth.activeLoginContext;
      expect(context).not.toBeNull();

      while (!context.authUrl) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const authUrl = context.authUrl || "";
      const portMatch = authUrl.match(/port=(\d+)/);
      const stateMatch = authUrl.match(/state=([^&]+)/);
      const port = parseInt(portMatch![1], 10);
      const state = decodeURIComponent(stateMatch![1]);

      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: `/callback?code=timeout-auth-code&state=${encodeURIComponent(state)}`,
        method: "GET",
      });
      clientReq.on("error", () => {});
      clientReq.on("response", (res) => {
        res.resume();
      });
      clientReq.end();

      while (!exchangeStarted) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Simulate timeout termination on active context
      context.terminate("Login timed out after 120s");

      // Release barrier after timeout termination
      barrierResolve!(true);

      // Wait for late response to settle
      await new Promise((r) => setTimeout(r, 50));

      expect(loginErr).toBeDefined();
      expect(loginErr.message).toContain("timed out");

      // Nonpublication assertions
      expect(SessionManager.getCredentials()).toBeNull();
      expect(SessionManager.getCurrentUser()).toBeNull();
      expect(ConfigManager.get().token).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("Reproduce Defect 6c: Held-exchange supersession with deterministic barrier and nonpublication", async () => {
    let barrierResolveA: (value: any) => void;
    const barrierPromiseA = new Promise((resolve) => {
      barrierResolveA = resolve;
    });

    let exchangeAStarted = false;
    let exchangeBStarted = false;
    const origFetch = globalThis.fetch;

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      if (url.toString().includes("/api/v1/auth/exchange")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body.code === "code-A") {
          exchangeAStarted = true;
          await barrierPromiseA;
          return new Response(
            JSON.stringify({
              token: "token-A-superseded",
              user: {
                id: "user-A",
                name: "UserA",
                minecraftUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                minecraftUsername: "UserAMC",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else if (body.code === "code-B") {
          exchangeBStarted = true;
          return new Response(
            JSON.stringify({
              token: "token-B-active",
              user: {
                id: "user-B",
                name: "UserB",
                minecraftUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                minecraftUsername: "UserBMC",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }
      return origFetch(url, init);
    });

    try {
      // 1. Start Login Attempt A
      let loginErrA: any = null;
      const loginPromiseA = LauncherAuth.loginWithPortal();
      loginPromiseA.catch((err: any) => {
        loginErrA = err;
      });

      const contextA = LauncherAuth.activeLoginContext;
      expect(contextA).not.toBeNull();

      while (!contextA.authUrl) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const portA = parseInt(contextA.authUrl.match(/port=(\d+)/)![1], 10);
      const stateA = decodeURIComponent(contextA.authUrl.match(/state=([^&]+)/)![1]);

      // Trigger callback A
      const reqA = http.request({
        hostname: "127.0.0.1",
        port: portA,
        path: `/callback?code=code-A&state=${encodeURIComponent(stateA)}`,
        method: "GET",
      });
      reqA.on("error", () => {});
      reqA.on("response", (res) => {
        res.resume();
      });
      reqA.end();

      while (!exchangeAStarted) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 2. Start Login Attempt B (this supersedes Attempt A while A is held at barrier)
      const loginPromiseB = LauncherAuth.loginWithPortal();
      const contextB = LauncherAuth.activeLoginContext;
      expect(contextB).not.toBeNull();
      expect(contextB).not.toBe(contextA);

      // Attempt A must reject with superseded error
      await new Promise((r) => setTimeout(r, 30));
      expect(loginErrA).toBeDefined();
      expect(loginErrA.message).toContain("superseded");

      while (!contextB.authUrl) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const portB = parseInt(contextB.authUrl.match(/port=(\d+)/)![1], 10);
      const stateB = decodeURIComponent(contextB.authUrl.match(/state=([^&]+)/)![1]);

      // Complete Login Attempt B successfully
      const reqB = http.request({
        hostname: "127.0.0.1",
        port: portB,
        path: `/callback?code=code-B&state=${encodeURIComponent(stateB)}`,
        method: "GET",
      });
      reqB.on("error", () => {});
      reqB.on("response", (res) => {
        res.resume();
      });
      reqB.end();

      const resB = await loginPromiseB;
      expect(resB.user.name).toBe("UserB");
      expect(resB.token).toBe("token-B-active");

      // Verify Attempt B's credentials are published
      expect(SessionManager.getCredentials()?.token).toBe("token-B-active");
      expect(SessionManager.getCurrentUser()?.name).toBe("UserB");

      // 3. Now release barrier for Attempt A's late response
      barrierResolveA!(true);
      await new Promise((r) => setTimeout(r, 50));

      // Attempt A's late response must NOT overwrite Attempt B's credentials!
      expect(SessionManager.getCredentials()?.token).toBe("token-B-active");
      expect(SessionManager.getCurrentUser()?.name).toBe("UserB");
      expect(ConfigManager.get().token).toBe("token-B-active");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

