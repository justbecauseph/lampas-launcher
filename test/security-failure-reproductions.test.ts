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
      expect(clearResult.error).toContain("EBUSY");
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
});
