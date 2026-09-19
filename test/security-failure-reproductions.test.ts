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
let isValidMinecraftUuid: any;
let validateDigestString: any;
let validateManifestMetadata: any;
let canonicalizeRelativePath: any;
let resolveAndContainPath: any;
let sanitizeInstallationState: any;
let PathContainmentError: any;
let GameDirectoryManager: any;
let validateMoveJournal: any;
let MOVE_RECEIPT_FILENAME: any;
let ClientModManager: any;

class MockSafeStorage {
  available = true;
  failEncrypt = false;
  isEncryptionAvailable() { return this.available; }
  getSelectedStorageBackend() { return process.platform === "win32" ? "windows_dpapi" : "gnome_libsecret"; }
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
  isValidMinecraftUuid = sessMod.isValidMinecraftUuid;

  const pathPolicyMod = await import("../src/path-policy");
  validateDigestString = pathPolicyMod.validateDigestString;
  validateManifestMetadata = pathPolicyMod.validateManifestMetadata;
  canonicalizeRelativePath = pathPolicyMod.canonicalizeRelativePath;
  resolveAndContainPath = pathPolicyMod.resolveAndContainPath;
  sanitizeInstallationState = pathPolicyMod.sanitizeInstallationState;
  PathContainmentError = pathPolicyMod.PathContainmentError;

  const gameDirMod = await import("../src/game-directory");
  GameDirectoryManager = gameDirMod.GameDirectoryManager;
  validateMoveJournal = gameDirMod.validateMoveJournal;
  MOVE_RECEIPT_FILENAME = gameDirMod.MOVE_RECEIPT_FILENAME;

  const clientModsMod = await import("../src/client-mods");
  ClientModManager = clientModsMod.ClientModManager;
});

beforeEach(() => {
  PortalPolicy?.configureDevelopmentPolicy({ allowLoopback: true });
  CredentialStore?.resetForTesting();
  SessionManager?.resetForTesting();
  ConfigManager?.resetForTesting();
  GameDirectoryManager?.resetForTesting();
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
      minecraftUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
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

  test("Reproduce Defect 1b: When unlink, overwrite, and marker creation all fail during replacement, replacement account B must NOT be published", () => {
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ portalUrl: "https://dev.lampas.town" }));

    // Step 1: Persist Account A
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

    // Step 2: Provider becomes session-only
    mockStorage.available = false;

    // Step 3: Simulate catastrophic cleanup failure where unlink, truncate overwrite, and marker write all fail
    const targetFile = CredentialStore.getCredentialsFilePath();
    const markerFile = CredentialStore.getInvalidationMarkerPath();
    const origUnlink = fs.unlinkSync.bind(fs);
    const origWrite = fs.writeFileSync.bind(fs);

    let simulateCatastrophe = true;

    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((p: any) => {
      if (simulateCatastrophe && p.toString().includes("credentials.enc")) {
        const err: any = new Error("EBUSY: resource locked");
        err.code = "EBUSY";
        throw err;
      }
      return origUnlink(p);
    });

    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((p: any, data: any, opts: any) => {
      if (simulateCatastrophe && (p.toString().includes("credentials.enc") || p.toString().includes("credentials.invalidated"))) {
        const err: any = new Error("EPERM: disk write protected");
        err.code = "EPERM";
        throw err;
      }
      return origWrite(p, data, opts);
    });

    try {
      // Step 4: Clear credentials directly under catastrophe -> durablyInvalidated must be FALSE
      const clearResult = CredentialStore.clearCredentials();
      expect(clearResult.success).toBe(false);
      expect(clearResult.durablyInvalidated).toBe(false);
      expect(clearResult.staleRecordIneligible).toBe(false);

      // Step 5: Account B attempts login in session-only mode -> MUST THROW and refuse to publish!
      SessionManager.resetForTesting();
      ConfigManager.resetForTesting();

      expect(() => {
        SessionManager.establishNewSession("https://dev.lampas.town", {
          token: "token-acc-b",
          refreshToken: "refresh-acc-b",
          portalAccountId: "acc-b",
          portalUsername: "Bob",
        });
      }).toThrow(/Failed to sanitize disk credentials/);

      // Invariant: Account B must NOT be published in memory!
      expect(SessionManager.isAuthenticated()).toBe(false);
      expect(SessionManager.getCredentials()).toBeNull();
      expect(SessionManager.getCurrentUser()).toBeNull();
    } finally {
      simulateCatastrophe = false;
      unlinkSpy.mockRestore();
      writeSpy.mockRestore();
      mockStorage.available = true;
      CredentialStore.clearCredentials();
    }
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

  test("Reproduce Defect 2b: Literal 'player' synthetic identity is rejected across exchange, session establishment, and stored-record validation", async () => {
    // 1. Stored-record validation must reject 'player' and 'Player'
    const recordWithPlayer: any = {
      version: 1,
      schemaVersion: 1,
      portalUrl: "https://dev.lampas.town",
      token: "valid-token-123",
      portalAccountId: "acc-123",
      portalUsername: "player",
    };
    expect(CredentialStore.validateRecord(recordWithPlayer)).toBe(false);

    const recordWithPlayerUpper: any = {
      ...recordWithPlayer,
      portalUsername: "Player",
    };
    expect(CredentialStore.validateRecord(recordWithPlayerUpper)).toBe(false);

    // 2. establishNewSession must reject 'player' and 'Player'
    expect(() => {
      SessionManager.establishNewSession("https://dev.lampas.town", {
        token: "token-valid",
        portalAccountId: "acc-123",
        portalUsername: "player",
      });
    }).toThrow(/placeholders/);

    expect(() => {
      SessionManager.establishNewSession("https://dev.lampas.town", {
        token: "token-valid",
        portalAccountId: "acc-123",
        portalUsername: "Player",
      });
    }).toThrow(/placeholders/);

    // 3. Token exchange rejection for literal 'player' username
    const origFetch = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      if (url.toString().includes("/api/v1/auth/exchange")) {
        return new Response(
          JSON.stringify({
            token: "syn-token-exchange",
            user: {
              id: "user-legit-id",
              name: "player", // Rejected synthetic identity
              minecraftUuid: "11111111-1111-1111-1111-111111111111",
              minecraftUsername: "PlayerMC",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return origFetch(url, init);
    });

    try {
      SessionManager.clearSession();
      CredentialStore.clearCredentials();
      ConfigManager.resetForTesting();

      let loginErr: any = null;
      const loginPromise = LauncherAuth.loginWithPortal();
      loginPromise.catch((err: any) => {
        loginErr = err;
      });

      const context = LauncherAuth.activeLoginContext;
      expect(context).not.toBeNull();

      while (!context?.authUrl) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const authUrl = context.authUrl || "";
      const portMatch = authUrl.match(/port=(\d+)/);
      const stateMatch = authUrl.match(/state=([^&]+)/);
      const port = parseInt(portMatch![1], 10);
      const state = decodeURIComponent(stateMatch![1]);

      const http = await import("node:http");
      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: `/callback?code=good-code&state=${encodeURIComponent(state)}`,
        method: "GET",
      });
      clientReq.on("error", () => {});
      clientReq.on("response", (res) => {
        res.resume();
      });
      clientReq.end();

      // Exchange must reject and fail the login promise
      await expect(loginPromise).rejects.toThrow(/invalid user identity/);
      expect(SessionManager.isAuthenticated()).toBe(false);
      expect(SessionManager.getCredentials()).toBeNull();
    } finally {
      LauncherAuth.cancelLogin();
      fetchSpy.mockRestore();
    }
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

  test("Reproduce Defect 3b: Syntactically malformed / truncated legacy JSON and present-but-falsy tokens are cleaned up without wiping non-secret settings", () => {
    CredentialStore.clearCredentials();
    const configPath = path.join(userDataDir, "config.json");

    // Case 1: Truncated JSON lacking closing brace but containing settings and secret token
    const truncatedConfig = `{\n  "allocatedRamGb": 8,\n  "gameDir": "C:/CustomGames",\n  "portalUrl": "https://dev.lampas.town",\n  "token": "secret-truncated-token"\n`;
    fs.writeFileSync(configPath, truncatedConfig, "utf-8");

    // JSON.parse on truncatedConfig throws SyntaxError
    expect(() => JSON.parse(truncatedConfig)).toThrow();

    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    const outcome = SessionManager.initialize(configPath, "https://dev.lampas.town");

    expect(outcome.legacyPlaintextDetected).toBe(true);
    expect(outcome.legacyScrubbed).toBe(true);

    // Invariant: Non-secret settings MUST NOT be wiped! File must be recovered to valid JSON
    const diskContent = fs.readFileSync(configPath, "utf-8");
    expect(diskContent).not.toContain("secret-truncated-token");
    const parsed = JSON.parse(diskContent);
    expect(parsed.allocatedRamGb).toBe(8);
    expect(parsed.gameDir).toBe("C:/CustomGames");
    expect(parsed.token).toBeUndefined();

    // Case 2: Present-but-falsy secret fields (e.g. token: "") must be detected and scrubbed
    fs.writeFileSync(configPath, JSON.stringify({
      allocatedRamGb: 6,
      portalUrl: "https://dev.lampas.town",
      token: "", // present-but-falsy
      refreshToken: false, // present-but-falsy
    }, null, 2));

    SessionManager.resetForTesting();
    ConfigManager.resetForTesting();
    const outcome2 = SessionManager.initialize(configPath, "https://dev.lampas.town");
    expect(outcome2.legacyPlaintextDetected).toBe(true);
    expect(outcome2.legacyScrubbed).toBe(true);

    const parsed2 = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect("token" in parsed2).toBe(false);
    expect("refreshToken" in parsed2).toBe(false);
    expect(parsed2.allocatedRamGb).toBe(6);
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

  test("Reproduce Defect 1c: Invalidation marker remains authoritative until replacement is committed (interruption before replacement)", () => {
    // 1. Account A is saved to disk
    const saveA = CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "token-account-A",
      portalAccountId: "acc-A",
      portalUsername: "UserA",
    });
    expect(saveA.success).toBe(true);

    // 2. Establish legitimate degraded-cleanup state:
    // Old target exists (Account A), truncation failed (still contains Account A ciphertext),
    // invalidation marker written.
    const markerPath = CredentialStore.getInvalidationMarkerPath();
    fs.writeFileSync(markerPath, JSON.stringify({ invalidatedAt: Date.now(), reason: "logout_cleanup_degraded" }), "utf-8");
    expect(fs.existsSync(CredentialStore.getCredentialsFilePath())).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);

    // 3. Simulate process interruption / crash BEFORE atomic replacement (before renameSync)
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("SIGKILL / simulated interruption before rename");
    });

    try {
      const saveB = CredentialStore.saveCredentials({
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "token-account-B",
        portalAccountId: "acc-B",
        portalUsername: "UserB",
      });
      expect(saveB.success).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }

    // 4. Assert filesystem state: Account A target remains, Account B not committed,
    // and CRITICALLY: invalidation marker is STILL PRESENT!
    expect(fs.existsSync(CredentialStore.getCredentialsFilePath())).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);

    // 5. On next restart: loadCredentials must refuse to load stale Account A
    const reloadResult = CredentialStore.loadCredentials();
    expect(reloadResult).toBeNull();
  });

  test("Reproduce Defect 1d: Invalidation marker remains authoritative on atomic rename failure", () => {
    // Degraded state: Account A target file exists, invalidation marker exists
    const saveA = CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "token-A-rename-fail",
      portalAccountId: "acc-A",
      portalUsername: "UserA",
    });
    expect(saveA.success).toBe(true);

    const markerPath = CredentialStore.getInvalidationMarkerPath();
    fs.writeFileSync(markerPath, JSON.stringify({ invalidatedAt: Date.now() }), "utf-8");

    const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
      const err: any = new Error("EBUSY: resource locked during rename");
      err.code = "EBUSY";
      throw err;
    });

    try {
      const result = CredentialStore.saveCredentials({
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "token-B",
        portalAccountId: "acc-B",
        portalUsername: "UserB",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Marker must still exist on disk!
      expect(fs.existsSync(markerPath)).toBe(true);

      // Reload refuses to load stale credentials
      expect(CredentialStore.loadCredentials()).toBeNull();
    } finally {
      renameSpy.mockRestore();
    }
  });

  test("Reproduce Defect 1e: Interruption after replacement but before marker removal leaves launcher safely logged out", () => {
    // Degraded state: Account A target file exists, invalidation marker exists
    CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "token-A-stale",
      portalAccountId: "acc-A",
      portalUsername: "UserA",
    });

    const markerPath = CredentialStore.getInvalidationMarkerPath();
    fs.writeFileSync(markerPath, JSON.stringify({ invalidatedAt: Date.now() }), "utf-8");

    // Interruption after renameSync: simulate process crash before marker is unlinked
    const originalUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((p: any) => {
      if (p.toString().includes("credentials.invalidated")) {
        throw new Error("Simulated interruption after rename but before marker removal");
      }
      return originalUnlink(p);
    });

    try {
      const saveB = CredentialStore.saveCredentials({
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "token-B-interrupted",
        portalAccountId: "acc-B",
        portalUsername: "UserB",
      });
      // Persistence reports failure because marker could not be removed
      expect(saveB.success).toBe(false);

      // On restart: loadCredentials sees marker and stays safely logged out.
      // Account A NEVER resurrects!
      const reloaded = CredentialStore.loadCredentials();
      expect(reloaded).toBeNull();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  test("Reproduce Defect 2c: Same-account refresh rejects 'player' and 'Player' without altering published user or session state", async () => {
    // 1. Establish valid session for UserA
    const userA = {
      id: "acc-100",
      name: "GenuineUser",
      minecraftUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      minecraftUsername: "GenuineMC",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: [],
    };

    SessionManager.establishNewSession(
      "https://dev.lampas.town",
      {
        token: "valid-initial-token",
        portalAccountId: userA.id,
        portalUsername: userA.name,
        minecraftUuid: userA.minecraftUuid,
        minecraftUsername: userA.minecraftUsername,
      },
      userA
    );

    expect(SessionManager.getCurrentUser()?.name).toBe("GenuineUser");
    expect(SessionManager.getCredentials()?.token).toBe("valid-initial-token");

    let notifiedCreds: any = null;
    const unsub = SessionManager.addSessionListener((creds) => {
      notifiedCreds = creds;
    });

    try {
      // 2. Attempt same-account refresh returning name: "player"
      const refreshCandidatePlayer = {
        id: userA.id,
        name: "player",
        minecraftUuid: userA.minecraftUuid,
        minecraftUsername: userA.minecraftUsername,
        isAdmin: false,
        isTech: false,
        roles: [],
        allowedChannels: [],
      };

      expect(() => {
        SessionManager.updateSessionFromRefresh(
          "https://dev.lampas.town",
          { token: "new-refresh-token-player" },
          refreshCandidatePlayer
        );
      }).toThrow();

      // Assert state was NOT altered
      expect(SessionManager.getCurrentUser()?.name).toBe("GenuineUser");
      expect(SessionManager.getCredentials()?.token).toBe("valid-initial-token");
      expect(notifiedCreds).toBeNull();

      // 3. Attempt same-account refresh returning name: "Player"
      const refreshCandidateTitlePlayer = {
        ...refreshCandidatePlayer,
        name: "Player",
      };

      expect(() => {
        SessionManager.updateSessionFromRefresh(
          "https://dev.lampas.town",
          { token: "new-refresh-token-Player" },
          refreshCandidateTitlePlayer
        );
      }).toThrow();

      // Assert state was NOT altered
      expect(SessionManager.getCurrentUser()?.name).toBe("GenuineUser");
      expect(SessionManager.getCredentials()?.token).toBe("valid-initial-token");
      expect(notifiedCreds).toBeNull();

      // 4. Exercise LauncherAuth.refreshSession integration:
      // Mock portalFetch to return status 200 with user name "Player"
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response(JSON.stringify({
          valid: true,
          token: "syn-refresh-token-200",
          user: {
            id: userA.id,
            name: "Player",
            minecraftUuid: userA.minecraftUuid,
            minecraftUsername: userA.minecraftUsername,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      });

      try {
        ConfigManager.set({ portalUrl: "https://dev.lampas.town" });
        const refreshOutcome = await LauncherAuth.refreshSession();
        // Must return valid: false because candidate identity was rejected!
        expect(refreshOutcome.valid).toBe(false);

        // Published user remains GenuineUser
        expect(SessionManager.getCurrentUser()?.name).toBe("GenuineUser");
        expect(SessionManager.getCredentials()?.token).toBe("valid-initial-token");
      } finally {
        fetchSpy.mockRestore();
      }
    } finally {
      unsub();
    }
  });

  test("Reproduce Defect 2d: Same-account refresh rejects malformed optional token types and does not downgrade to session-only", async () => {
    const userA = {
      id: "acc-200",
      name: "TypeSafetyUser",
      minecraftUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      minecraftUsername: "TypeMC",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: [],
    };

    SessionManager.establishNewSession(
      "https://dev.lampas.town",
      {
        token: "token-200",
        portalAccountId: userA.id,
        portalUsername: userA.name,
        minecraftUuid: userA.minecraftUuid,
        minecraftUsername: userA.minecraftUsername,
      },
      userA
    );

    expect(SessionManager.getCurrentUser()?.name).toBe("TypeSafetyUser");

    // Candidate with malformed optional token type (number instead of string)
    expect(() => {
      SessionManager.updateSessionFromRefresh(
        "https://dev.lampas.town",
        {
          token: "new-token",
          minecraftAccessToken: 12345 as any,
        },
        userA
      );
    }).toThrow();

    // Published state remains untouched
    expect(SessionManager.getCredentials()?.token).toBe("token-200");
    expect(SessionManager.getCurrentUser()?.name).toBe("TypeSafetyUser");
  });

  test("Reproduce Defect 3c: Tolerant scanning detects escaped keys in malformed JSON and scrubs without losing non-secret settings", () => {
    const configPath = path.join(userDataDir, "config.json");

    // All 4 secret keys tested in escaped unicode format in truncated JSON (omitted closing brace):
    // 1. to\u006ben
    // 2. \u0072efreshToken
    // 3. minecraft\u0041ccessToken
    // 4. session\u0050ortalUrl
    const escapedTruncatedJson =
      '{"allocatedRamGb":8,"gameDir":"C:\\\\Games","to\\u006ben":"DUMMY_SECRET","\\u0072efreshToken":"DUMMY_REFRESH","minecraft\\u0041ccessToken":"DUMMY_MC","session\\u0050ortalUrl":"https://dev.lampas.town"';

    fs.writeFileSync(configPath, escapedTruncatedJson, "utf-8");

    // Initialize session manager
    const outcome = SessionManager.initialize(configPath, "https://dev.lampas.town");

    // Must detect legacy plaintext despite unicode escapes and truncated JSON!
    expect(outcome.legacyPlaintextDetected).toBe(true);
    expect(outcome.legacyScrubbed).toBe(true);
    // Malformed JSON is NOT eligible for migration
    expect(outcome.migrated).toBe(false);

    // Read back config.json from disk
    const onDiskRaw = fs.readFileSync(configPath, "utf-8");
    // Result MUST be valid JSON
    const parsed = JSON.parse(onDiskRaw);

    // Non-secret settings must be preserved!
    expect(parsed.allocatedRamGb).toBe(8);
    expect(parsed.gameDir).toBe("C:\\Games");

    // Zero secret tokens must remain
    expect("token" in parsed).toBe(false);
    expect("refreshToken" in parsed).toBe(false);
    expect("minecraftAccessToken" in parsed).toBe(false);
    expect("sessionPortalUrl" in parsed).toBe(false);
    expect(onDiskRaw).not.toContain("DUMMY_SECRET");
    expect(onDiskRaw).not.toContain("DUMMY_REFRESH");
    expect(onDiskRaw).not.toContain("DUMMY_MC");
  });

  test("Reproduce Defect 3d: Malformed JSON with duplicate and mixed escaped/literal keys scrubs clean and validates output", () => {
    const configPath = path.join(userDataDir, "config.json");

    // Mixed literal and escaped, duplicate keys, present-but-falsy values
    const mixedMalformed =
      '{"allocatedRamGb":16,"to\\u006ben":"token1","token":"token2","\\u0072efreshToken":"","portalUrl":"https://dev.lampas.town"';

    fs.writeFileSync(configPath, mixedMalformed, "utf-8");

    const outcome = SessionManager.initialize(configPath, "https://dev.lampas.town");
    expect(outcome.legacyPlaintextDetected).toBe(true);
    expect(outcome.legacyScrubbed).toBe(true);
    expect(outcome.migrated).toBe(false);

    const onDiskRaw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(onDiskRaw);
    expect(parsed.allocatedRamGb).toBe(16);
    expect(parsed.portalUrl).toBe("https://dev.lampas.town");
    expect("token" in parsed).toBe(false);
    expect("refreshToken" in parsed).toBe(false);
    expect(onDiskRaw).not.toContain("token1");
    expect(onDiskRaw).not.toContain("token2");
  });

  test("Reproduce Defect 3e: Non-secret configuration values named after credential keys are NOT detected as secret material or wiped", () => {
    const configPath = path.join(userDataDir, "config.json");

    // Valid settings where property values equal secret key names
    const safeConfig = {
      allocatedRamGb: 8,
      javaArgs: "token",
      portalUrl: "https://dev.lampas.town",
      gameDir: "refreshToken",
      customSetting: "minecraftAccessToken",
      anotherSetting: "sessionPortalUrl",
    };

    const initialJson = JSON.stringify(safeConfig, null, 2);
    fs.writeFileSync(configPath, initialJson, "utf-8");

    const outcome = SessionManager.initialize(configPath, "https://dev.lampas.town");
    expect(outcome.legacyPlaintextDetected).toBe(false);
    expect(outcome.legacyScrubbed).toBe(false);
    expect(outcome.migrated).toBe(false);

    // Assert disk file is byte-for-byte and semantically preserved (NOT wiped to {})
    const onDiskRaw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(onDiskRaw);
    expect(parsed.allocatedRamGb).toBe(8);
    expect(parsed.javaArgs).toBe("token");
    expect(parsed.gameDir).toBe("refreshToken");
    expect(parsed.customSetting).toBe("minecraftAccessToken");
    expect(parsed.anotherSetting).toBe("sessionPortalUrl");
    expect(onDiskRaw).toBe(initialJson);
  });

  test("Reproduce Defect 2e: Numeric identities violate strict schema and are rejected across validateRecord, saveCredentials, loadCredentials, and validateCandidateSession", () => {
    // 1. validateRecord rejects numeric portalAccountId and portalUsername
    expect(CredentialStore.validateRecord({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "secret-token",
      portalAccountId: 12345,
      portalUsername: 67890,
    } as any)).toBe(false);

    expect(CredentialStore.validateRecord({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "secret-token",
      accountId: 99999,
      accountUsername: 88888,
    } as any)).toBe(false);

    // 2. saveCredentials fails cleanly
    const saveRes = CredentialStore.saveCredentials({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "secret-token",
      portalAccountId: 12345 as any,
      portalUsername: 67890 as any,
    });
    expect(saveRes.success).toBe(false);
    expect(saveRes.error).toBe("Invalid credential record schema");

    // 3. Directly encrypted numeric payload cannot be loaded via loadCredentials
    const targetFile = CredentialStore.getCredentialsFilePath();
    const mock = new MockSafeStorage();
    const encryptedNumeric = mock.encryptString(JSON.stringify({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "secret-token",
      portalAccountId: 12345,
      portalUsername: 67890,
    }));
    fs.writeFileSync(targetFile, encryptedNumeric);

    const loaded = CredentialStore.loadCredentials();
    expect(loaded).toBeNull();

    // 4. validateCandidateSession rejects numeric identities
    const candidateValidation = SessionManager.validateCandidateSession({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "secret-token",
      portalAccountId: 12345 as any,
      portalUsername: 67890 as any,
    });
    expect(candidateValidation.valid).toBe(false);
    expect(candidateValidation.error).toBeDefined();

    // 5. setCurrentUser rejects numeric IDs or names
    expect(() => SessionManager.setCurrentUser({
      id: 12345 as any,
      name: 67890 as any,
      minecraftUuid: "12345678-1234-1234-1234-123456789abc",
      minecraftUsername: "ValidMcUser",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: [],
    })).toThrow("user ID and name must be strings");
  });

  test("Reproduce Defect 5b: sessionPersisted accurately tracks active session and resets to false on logout and resetForTesting", () => {
    // 1. Establish persisted session
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-persisted-status",
      portalAccountId: "user-persisted-id",
      portalUsername: "UserPersisted",
      minecraftUuid: "12345678-1234-1234-1234-123456789abc",
      minecraftUsername: "McPersisted",
    });

    let status = SessionManager.getStorageStatus();
    expect(status.sessionPersisted).toBe(true);
    expect(status.sessionOnly).toBe(false);

    // 2. Clear session (logout)
    const clearResult = SessionManager.clearSession();
    expect(clearResult.success).toBe(true);

    status = SessionManager.getStorageStatus();
    expect(status.sessionPersisted).toBe(false);
    expect(status.sessionOnly).toBe(false); // No active session, not in session-only mode

    // 3. Re-establish persisted session and verify resetForTesting
    SessionManager.establishNewSession("https://dev.lampas.town", {
      token: "token-persisted-status-2",
      portalAccountId: "user-persisted-id-2",
      portalUsername: "UserPersisted2",
      minecraftUuid: "12345678-1234-1234-1234-123456789abc",
      minecraftUsername: "McPersisted2",
    });
    expect(SessionManager.getStorageStatus().sessionPersisted).toBe(true);

    SessionManager.resetForTesting();
    expect(SessionManager.getStorageStatus().sessionPersisted).toBe(false);
  });

  test("Reproduce Defect 2f: Minecraft UUID format enforcement accepts canonical and compact UUIDs and rejects garbage/non-UUID strings", () => {
    // Valid canonical dashed UUID
    expect(isValidMinecraftUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    // Valid 32-hex compact UUID
    expect(isValidMinecraftUuid("550e8400e29b41d4a716446655440000")).toBe(true);

    // Rejected: All-zero UUIDs
    expect(isValidMinecraftUuid("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isValidMinecraftUuid("00000000000000000000000000000000")).toBe(false);

    // Rejected: Non-UUID garbage strings
    expect(isValidMinecraftUuid("garbage")).toBe(false);
    expect(isValidMinecraftUuid("not-a-uuid-at-all")).toBe(false);
    expect(isValidMinecraftUuid("12345")).toBe(false);
    expect(isValidMinecraftUuid(null)).toBe(false);
    expect(isValidMinecraftUuid(undefined)).toBe(false);
    expect(isValidMinecraftUuid(12345)).toBe(false);

    // validateCandidateSession with garbage user UUID fails with UUID format error
    const garbageCandidate = SessionManager.validateCandidateSession(
      {
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "secret-token",
        portalAccountId: "acc-1",
        portalUsername: "user-1",
      },
      {
        id: "acc-1",
        name: "user-1",
        minecraftUuid: "garbage",
        minecraftUsername: "ValidMcUser",
        isAdmin: false,
        isTech: false,
        roles: [],
        allowedChannels: [],
      }
    );
    expect(garbageCandidate.valid).toBe(false);
    expect(garbageCandidate.error).toContain("UUID format");

    // validateCandidateSession with garbage record UUID fails with schema error
    const garbageRecordCandidate = SessionManager.validateCandidateSession(
      {
        version: 1,
        portalUrl: "https://dev.lampas.town",
        token: "secret-token",
        portalAccountId: "acc-1",
        portalUsername: "user-1",
        minecraftUuid: "garbage",
      }
    );
    expect(garbageRecordCandidate.valid).toBe(false);
    expect(garbageRecordCandidate.error).toContain("credential store schema validation");

    // CredentialStore.validateRecord rejects garbage UUID
    expect(CredentialStore.validateRecord({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: "secret-token",
      portalAccountId: "acc-1",
      portalUsername: "user-1",
      minecraftUuid: "garbage",
    })).toBe(false);
  });
});

describe("Phase 4 Security Failure Reproductions (SEC-04, SEC-05)", () => {
  const dummySha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("Defect 4a: Manifest traversal vectors (leading .., embedded .., absolute, UNC) are rejected during preflight", () => {
    const maliciousPaths = [
      "../outside.jar",
      "../../outside.jar",
      "mods/../../outside.jar",
      "mods/subdir/../../../root.txt",
      "/etc/passwd",
      "C:\\Windows\\system32\\cmd.exe",
      "\\\\server\\share\\evil.jar",
      "mods/foo/../bar/../../outside.jar",
    ];

    for (const malPath of maliciousPaths) {
      expect(() => canonicalizeRelativePath(malPath)).toThrow(PathContainmentError);

      const maliciousManifest = {
        pack: "AttackPack",
        version: "1.0.0",
        files: [
          {
            path: malPath,
            hashes: { sha256: dummySha256 },
            size: 100,
            download: { url: "/blob/1" },
            policy: "MANAGED",
          },
        ],
      };
      expect(() => validateManifestMetadata(maliciousManifest)).toThrow(PathContainmentError);
    }
  });

  test("Defect 4b: Windows DOS reserved device names and Alternate Data Streams are rejected", () => {
    const dosNames = [
      "CON",
      "PRN",
      "AUX",
      "NUL",
      "COM1",
      "COM9",
      "LPT1",
      "LPT9",
      "con.txt",
      "aux.json",
      "nul.jar",
      "mods/nul",
      "config/com1.json",
      "data.txt:hidden_stream",
      "mods/normal.jar:zone.identifier",
    ];

    for (const name of dosNames) {
      expect(() => canonicalizeRelativePath(name)).toThrow(PathContainmentError);

      const manifest = {
        pack: "DosDevicePack",
        version: "1.0.0",
        files: [
          {
            path: name,
            hashes: { sha256: dummySha256 },
            size: 50,
            download: { url: "/blob/dos" },
            policy: "MANAGED",
          },
        ],
      };
      expect(() => validateManifestMetadata(manifest)).toThrow(PathContainmentError);
    }
  });

  test("Defect 4c: Duplicate and case-equivalent destination collisions fail closed", () => {
    // Exact duplicate paths
    const exactDupManifest = {
      pack: "DupPack",
      version: "1.0.0",
      files: [
        { path: "mods/example.jar", hashes: { sha256: dummySha256 }, size: 10, download: { url: "/b/1" } },
        { path: "mods/example.jar", hashes: { sha256: dummySha256 }, size: 10, download: { url: "/b/2" } },
      ],
    };
    expect(() => validateManifestMetadata(exactDupManifest)).toThrow(/Duplicate manifest destination/);

    // Case-equivalent collision on Windows (e.g. mods/Mod.jar vs mods/mod.jar)
    if (process.platform === "win32") {
      const caseDupManifest = {
        pack: "CaseDupPack",
        version: "1.0.0",
        files: [
          { path: "mods/ImportantMod.jar", hashes: { sha256: dummySha256 }, size: 10, download: { url: "/b/1" } },
          { path: "mods/importantmod.jar", hashes: { sha256: dummySha256 }, size: 10, download: { url: "/b/2" } },
        ],
      };
      expect(() => validateManifestMetadata(caseDupManifest)).toThrow(/Duplicate manifest destination/);
    }
  });

  test("Defect 4d: Malformed or non-canonical cryptographic digest strings fail validation", () => {
    // SHA-256 validation
    expect(validateDigestString(dummySha256, "sha256")).toBe(dummySha256);
    expect(() => validateDigestString("abc", "sha256")).toThrow(PathContainmentError);
    expect(() => validateDigestString("a".repeat(63), "sha256")).toThrow(PathContainmentError);
    expect(() => validateDigestString("a".repeat(65), "sha256")).toThrow(PathContainmentError);
    expect(() => validateDigestString("g".repeat(64), "sha256")).toThrow(PathContainmentError);
    expect(() => validateDigestString("../" + "a".repeat(61), "sha256")).toThrow(PathContainmentError);
    expect(() => validateDigestString(12345 as any, "sha256")).toThrow(PathContainmentError);

    // SHA-1 validation
    const dummySha1 = "0123456789abcdef0123456789abcdef01234567";
    expect(validateDigestString(dummySha1, "sha1")).toBe(dummySha1);
    expect(() => validateDigestString("a".repeat(39), "sha1")).toThrow(PathContainmentError);
    expect(() => validateDigestString("a".repeat(41), "sha1")).toThrow(PathContainmentError);
    expect(() => validateDigestString("z".repeat(40), "sha1")).toThrow(PathContainmentError);
  });

  test("Defect 4e: Corrupted prevState.files with traversal and protected keys are quarantined", () => {
    const rawState = {
      pack: "CorruptStatePack",
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      files: {
        "../../outside-file.txt": { policy: "MANAGED" },
        "saves/world1/level.dat": { policy: "MANAGED" },
        ".lampas/installation.json": { policy: "MANAGED" },
        "options.txt": { policy: "MANAGED" },
        "screenshots/first.png": { policy: "MANAGED" },
        "mods/legit-mod.jar": { policy: "MANAGED" },
      },
    };

    const { files, quarantinedKeys } = sanitizeInstallationState(rawState, gameDir);

    expect(quarantinedKeys).toContain("../../outside-file.txt");
    expect(quarantinedKeys).toContain("saves/world1/level.dat");
    expect(quarantinedKeys).toContain(".lampas/installation.json");
    expect(quarantinedKeys).toContain("options.txt");
    expect(quarantinedKeys).toContain("screenshots/first.png");

    expect(files["mods/legit-mod.jar"]).toBeDefined();
    expect(files["../../outside-file.txt"]).toBeUndefined();
    expect(files["saves/world1/level.dat"]).toBeUndefined();
    expect(files[".lampas/installation.json"]).toBeUndefined();
    expect(files["options.txt"]).toBeUndefined();
  });

  test("Defect 4f: Collision between whole-file management and config patch is rejected", () => {
    const collidingManifest = {
      pack: "CollidingPack",
      version: "1.0.0",
      files: [
        {
          path: "config/fabric_loader.json",
          hashes: { sha256: dummySha256 },
          size: 100,
          download: { url: "/b/loader" },
          policy: "MANAGED",
        },
      ],
    };

    const releaseData = {
      configPatches: [
        {
          id: "patch-colliding-loader",
          file: "config/fabric_loader.json",
          operations: [],
        },
      ],
    };

    expect(() => validateManifestMetadata(collidingManifest, releaseData)).toThrow(
      /is managed both as a whole file and by config patch/
    );

    // Config patch targeting protected namespace
    const protectedPatchRelease = {
      configPatches: [
        {
          id: "patch-saves",
          file: "saves/world/level.json",
          operations: [],
        },
      ],
    };
    expect(() => validateManifestMetadata({ pack: "P", version: "1", files: [] }, protectedPatchRelease)).toThrow(
      /targets protected namespace/
    );
  });

  test("Defect 4g: Client mod management rejects non-jar extensions, symlink inputs, and symlink destination squatting", () => {
    ConfigManager.set({ gameDir });
    const modsDir = path.join(gameDir, "mods");
    fs.mkdirSync(modsDir, { recursive: true });

    // 1. Non-jar rejected
    const exeFile = path.join(testRoot, "payload.exe");
    fs.writeFileSync(exeFile, "MZ-fake-exe");
    expect(() => ClientModManager.add([exeFile])).toThrow(/Only local \.jar files/);

    // 2. Symlink mod source rejected
    const realJar = path.join(testRoot, "real-source.jar");
    fs.writeFileSync(realJar, "PK-fake-jar");
    const symlinkSource = path.join(testRoot, "symlink-source.jar");

    let symlinkSupported = false;
    try {
      if (fs.existsSync(symlinkSource)) fs.unlinkSync(symlinkSource);
      fs.symlinkSync(realJar, symlinkSource);
      symlinkSupported = true;
    } catch {
      // Symlinks may require elevated privileges on Windows without Developer Mode
    }

    if (symlinkSupported) {
      expect(() => ClientModManager.add([symlinkSource])).toThrow(/symbolic link/);

      // 3. Symlink at destination in mods folder rejected
      const squattedDest = path.join(modsDir, "squatted.jar");
      try {
        if (fs.existsSync(squattedDest)) fs.unlinkSync(squattedDest);
        fs.symlinkSync(realJar, squattedDest);
        const newModJar = path.join(testRoot, "squatted.jar");
        fs.writeFileSync(newModJar, "PK-new-jar");
        expect(() => ClientModManager.add([newModJar])).toThrow(
          /symbolic link|Path containment violation/
        );
      } finally {
        try { fs.unlinkSync(squattedDest); } catch {}
      }
    }
  });

  test("Defect 4h: Move recovery strictly bounds staging and quarantines unverified staging locations", async () => {
    const outsideVictimDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-victim-staging-4h-"));
    const outsideVictimFile = path.join(outsideVictimDir, "secret-user-data.txt");
    fs.writeFileSync(outsideVictimFile, "vital-user-data", "utf-8");

    // Case 1: Staging set to filesystem root
    const rootJournal = {
      version: 2,
      operationId: "op-root-staging",
      phase: "preparing",
      source: gameDir,
      target: path.join(testRoot, "new-game-root-dst"),
      staging: process.platform === "win32" ? "C:\\" : "/",
      startTime: new Date().toISOString(),
    };
    const validationRoot = validateMoveJournal(rootJournal, gameDir, userDataDir);
    expect(validationRoot.valid).toBe(false);
    expect(validationRoot.reason).toContain("root directory");

    // Case 2: Staging set to arbitrary victim folder
    const victimJournal = {
      version: 2,
      operationId: "op-victim-staging",
      phase: "preparing",
      source: gameDir,
      target: path.join(testRoot, "new-game-victim-dst"),
      staging: outsideVictimDir,
      startTime: new Date().toISOString(),
    };
    const validationVictim = validateMoveJournal(victimJournal, gameDir, userDataDir);
    expect(validationVictim.valid).toBe(false);
    expect(validationVictim.reason).toMatch(/is not located in the parent directory|does not match approved launcher staging/);

    // Case 3: recoverInterruptedMove preserves outside staging directory and quarantines journal
    const journalPath = path.join(userDataDir, "directory-move.json");
    fs.writeFileSync(journalPath, JSON.stringify(victimJournal, null, 2), "utf-8");

    try {
      ConfigManager.set({ gameDir });
      await GameDirectoryManager.recoverInterruptedMove();

      expect(fs.existsSync(journalPath)).toBe(false);
      expect(fs.existsSync(outsideVictimFile)).toBe(true);
      expect(fs.existsSync(outsideVictimDir)).toBe(true);
      expect(fs.readFileSync(outsideVictimFile, "utf-8")).toBe("vital-user-data");

      const quarantined = fs.readdirSync(userDataDir).filter((f: string) => f.startsWith("directory-move.json.quarantine."));
      expect(quarantined.length).toBeGreaterThan(0);
    } finally {
      if (fs.existsSync(outsideVictimDir)) {
        fs.rmSync(outsideVictimDir, { recursive: true, force: true });
      }
    }
  });

  test("Defect 4i: Move recovery preserves source directory when target completeness inventory mismatches receipt", async () => {
    const srcDir = path.join(gameDir, "src-mismatch");
    const dstDir = path.join(gameDir, "dst-mismatch");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(dstDir, { recursive: true });

    const sourceFile1 = path.join(srcDir, "save-data.txt");
    const sourceFile2 = path.join(srcDir, "options.txt");
    fs.writeFileSync(sourceFile1, "content-of-file-1", "utf-8");
    fs.writeFileSync(sourceFile2, "content-of-file-2", "utf-8");

    // Only create 1 file in dstDir so inventory mismatches (1 file vs 2 files expected)
    const dstFile1 = path.join(dstDir, "save-data.txt");
    fs.writeFileSync(dstFile1, "content-of-file-1", "utf-8");

    const opId = "op-inventory-mismatch-test";
    const stagingDir = path.resolve(path.dirname(dstDir), `.lampas-moving-${opId}`);

    // Create receipt claiming 2 files / 32 bytes
    const receiptPath = path.join(dstDir, MOVE_RECEIPT_FILENAME);
    fs.writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          operationId: opId,
          source: srcDir,
          target: dstDir,
          staging: stagingDir,
          fileCount: 2,
          totalBytes: 34,
          stagingVerified: true,
          timestamp: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf-8"
    );

    const journalPath = path.join(userDataDir, "directory-move.json");
    const cleaningJournal = {
      version: 2,
      operationId: opId,
      phase: "cleaning",
      source: srcDir,
      target: dstDir,
      staging: stagingDir,
      startTime: new Date().toISOString(),
    };
    fs.writeFileSync(journalPath, JSON.stringify(cleaningJournal, null, 2), "utf-8");

    try {
      ConfigManager.set({ gameDir: srcDir });
      await expect(GameDirectoryManager.recoverInterruptedMove()).rejects.toThrow(
        /target completeness re-verification failed/
      );

      // Journal was preserved for inspection on failed recovery
      expect(fs.existsSync(journalPath)).toBe(true);

      // Target invariant: SOURCE DIRECTORY AND DATA REMAIN INTACT!
      expect(fs.existsSync(srcDir)).toBe(true);
      expect(fs.existsSync(sourceFile1)).toBe(true);
      expect(fs.existsSync(sourceFile2)).toBe(true);
      expect(fs.readFileSync(sourceFile1, "utf-8")).toBe("content-of-file-1");
      expect(fs.readFileSync(sourceFile2, "utf-8")).toBe("content-of-file-2");
    } finally {
      if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true });
      if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true, force: true });
    }
  });
});

