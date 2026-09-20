import { describe, expect, test } from "bun:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("Phase 3 Native Evidence — Electron 44.0.0 Windows DPAPI Restart Hardening (SEC-03, SEC-08)", () => {
  const isWindows = process.platform === "win32";
  const electronBin = isWindows
    ? path.resolve(__dirname, "../node_modules/electron/dist/electron.exe")
    : path.resolve(__dirname, "../node_modules/.bin/electron");

  // Deterministically ensure Electron binary is installed if missing on Windows
  if (isWindows && !fs.existsSync(electronBin)) {
    const installerPath = path.resolve(
      __dirname,
      "../node_modules/electron/install.js",
    );
    if (fs.existsSync(installerPath)) {
      try {
        cp.execFileSync("node", [installerPath], { stdio: "inherit" });
      } catch {}
    }
  }

  const launcherRoot = path.resolve(__dirname, "..");
  const credStoreModulePath = path.resolve(
    launcherRoot,
    "dist/credential-store.js",
  );
  const sessionManagerModulePath = path.resolve(
    launcherRoot,
    "dist/session-manager.js",
  );

  interface AclEntry {
    principal: string;
    rights: string;
  }

  function parseIcacls(output: string): AclEntry[] {
    const entries: AclEntry[] = [];
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) => l && !l.startsWith("Successfully") && !l.startsWith("Failed"),
      );
    for (const line of lines) {
      const match = line.match(
        /(?:^.*?\s+)?([A-Za-z0-9_\\\.\-\s]+?):(\((?:[A-Z0-9\(\)]+)\))/,
      );
      if (match) {
        entries.push({ principal: match[1].trim(), rights: match[2].trim() });
      }
    }
    return entries;
  }

  function verifyAclSecurity(targetPath: string): void {
    const output = cp.execFileSync("icacls", [targetPath], {
      encoding: "utf-8",
    });
    const entries = parseIcacls(output);
    expect(entries.length).toBeGreaterThan(0);

    const currentUser = os.userInfo().username.toLowerCase();
    const dangerousPrincipals = [
      "everyone",
      "users",
      "builtin\\users",
      "guests",
      "builtin\\guests",
      "anonymous logon",
      "world",
    ];

    // Invariant 1: No dangerous/world/unprivileged group must have write, modify, or full control rights
    for (const entry of entries) {
      const pLower = entry.principal.toLowerCase();
      const rUpper = entry.rights.toUpperCase();
      for (const dangerous of dangerousPrincipals) {
        if (pLower === dangerous || pLower.endsWith(`\\${dangerous}`)) {
          const hasWriteOrModify =
            rUpper.includes("(F)") ||
            rUpper.includes("(M)") ||
            rUpper.includes("(W)") ||
            rUpper.includes("(WD)") ||
            rUpper.includes("(AD)");
          expect(hasWriteOrModify).toBe(false);
        }
      }
    }

    // Invariant 2: Authorized privileged/owner principals (SYSTEM, Administrators, or current user) must exist
    const hasAuthorizedPrincipal = entries.some((e) => {
      const p = e.principal.toLowerCase();
      return (
        p.includes("system") ||
        p.includes("administrators") ||
        p.includes(currentUser)
      );
    });
    expect(hasAuthorizedPrincipal).toBe(true);
  }

  function runElectron(
    args: string[],
    cwd: string,
    timeoutMs = 12000,
  ): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const proc = cp.spawn(electronBin, args, {
        cwd,
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {}
      }, timeoutMs);

      proc.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        stderr += err.message;
        resolve({ code: -1, stdout, stderr, timedOut });
      });
    });
  }

  // Requirement 6: Mark unavailable native platforms as skipped/unverified
  if (!isWindows) {
    test.skip("Windows DPAPI credential store native verification (unverified on non-Windows platform)", () => {});
  }

  test.skipIf(!isWindows)(
    "Native evidence: Real Electron 44.0.0 exercises built launcher store and session modules across distinct process lifecycles via Windows DPAPI",
    async () => {
      if (!fs.existsSync(electronBin)) {
        throw new Error(`Electron binary not found at ${electronBin}`);
      }
      if (!fs.existsSync(credStoreModulePath)) {
        throw new Error(
          `Built credential store module not found at ${credStoreModulePath}. Run 'bun run build' first.`,
        );
      }
      if (!fs.existsSync(sessionManagerModulePath)) {
        throw new Error(
          `Built session manager module not found at ${sessionManagerModulePath}. Run 'bun run build' first.`,
        );
      }

      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "lampas-dpapi-evidence-"),
      );
      const userDataDir = path.join(testDir, "user-data");
      fs.mkdirSync(userDataDir, { recursive: true });

      const credFile = path.join(userDataDir, "credentials.enc");
      const testSecret =
        "syn-dpapi-secret-token-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2);
      const testRefreshSecret = "syn-refresh-" + testSecret;
      const testAccountId = "dpapi-test-account-123";
      const testUsername = "NativeUser";
      const testMcUuid = "44444444-4444-4444-4444-444444444444";

      try {
        // Step 1: Process 1 — Launch real Electron 44.0.0 and exercise built CredentialStore and SessionManager to persist credentials
        const proc1Script = path.join(testDir, "proc1_save.js");
        fs.writeFileSync(
          proc1Script,
          `
          const { app } = require("electron");
          const path = require("path");
          const fs = require("fs");

          if (process.versions.electron !== "44.0.0") {
            console.error("ELECTRON_VERSION_MISMATCH:" + process.versions.electron);
            process.exit(10);
          }
          console.log("ELECTRON_VERSION:" + process.versions.electron);

          app.setPath("userData", ${JSON.stringify(userDataDir)});

          app.whenReady().then(async () => {
            try {
              const { CredentialStore } = require(${JSON.stringify(credStoreModulePath)});
              const { SessionManager } = require(${JSON.stringify(sessionManagerModulePath)});

              const backend = CredentialStore.detectStorageBackend();
              if (backend !== "windows_dpapi") {
                console.error("UNEXPECTED_BACKEND:" + backend);
                process.exit(2);
                return;
              }

              if (!CredentialStore.isPersistenceAvailable()) {
                console.error("PERSISTENCE_NOT_AVAILABLE");
                process.exit(3);
                return;
              }

              const saveResult = SessionManager.establishNewSession("https://dev.lampas.town", {
                token: ${JSON.stringify(testSecret)},
                refreshToken: ${JSON.stringify(testRefreshSecret)},
                portalAccountId: ${JSON.stringify(testAccountId)},
                portalUsername: ${JSON.stringify(testUsername)},
                minecraftUuid: ${JSON.stringify(testMcUuid)},
              });

              if (!saveResult.success || saveResult.sessionOnly) {
                console.error("SAVE_FAILED:" + JSON.stringify(saveResult));
                process.exit(4);
                return;
              }

              const status = SessionManager.getStorageStatus();
              if (!status.sessionPersisted || status.sessionOnly) {
                console.error("STATUS_MISMATCH:" + JSON.stringify(status));
                process.exit(5);
                return;
              }

              if (!CredentialStore.hasStoredCredentialsFile()) {
                console.error("CREDENTIAL_FILE_MISSING_ON_DISK");
                process.exit(6);
                return;
              }

              console.log("SAVE_SUCCESS");
              app.quit();
            } catch (err) {
              console.error("PROC1_EXCEPTION:", err);
              app.exit(1);
            }
          });
          `,
        );

        const p1 = await runElectron(
          [`--user-data-dir=${userDataDir}`, proc1Script],
          testDir,
          12000,
        );
        if (p1.code !== 0)
          console.error("P1 FAILED:", p1.code, p1.stdout, p1.stderr);
        expect(p1.code).toBe(0);
        expect(p1.stdout).toContain("ELECTRON_VERSION:44.0.0");
        expect(p1.stdout).toContain("SAVE_SUCCESS");
        expect(fs.existsSync(credFile)).toBe(true);

        // Verify on disk: encrypted file does NOT contain plaintext secrets
        const diskBytes = fs.readFileSync(credFile);
        const rawString = diskBytes.toString("utf-8");
        expect(rawString.includes(testSecret)).toBe(false);
        expect(rawString.includes(testRefreshSecret)).toBe(false);
        expect(rawString.includes(testAccountId)).toBe(false);

        // Verify Windows Directory & File ACL with parsed icacls principals & rights
        verifyAclSecurity(userDataDir);
        verifyAclSecurity(credFile);

        // Step 2: Process 2 — Launch completely SEPARATE real Electron 44.0.0 process to decrypt credentials via built modules
        const proc2Script = path.join(testDir, "proc2_restore.js");
        const outputFile = path.join(testDir, "decrypted.json");
        fs.writeFileSync(
          proc2Script,
          `
          const { app } = require("electron");
          const path = require("path");
          const fs = require("fs");

          if (process.versions.electron !== "44.0.0") {
            console.error("ELECTRON_VERSION_MISMATCH:" + process.versions.electron);
            process.exit(10);
          }
          console.log("ELECTRON_VERSION:" + process.versions.electron);

          app.setPath("userData", ${JSON.stringify(userDataDir)});

          app.whenReady().then(async () => {
            try {
              const { CredentialStore } = require(${JSON.stringify(credStoreModulePath)});
              const { SessionManager } = require(${JSON.stringify(sessionManagerModulePath)});

              const loaded = CredentialStore.loadCredentials();
              if (!loaded) {
                console.error("CREDENTIAL_LOAD_NULL");
                process.exit(2);
                return;
              }

              // Verify through SessionManager restoration contract
              const outcome = SessionManager.initialize();
              const sessionCreds = SessionManager.getCredentials();

              const payload = {
                storeLoaded: loaded,
                sessionCreds: sessionCreds,
                migrationOutcome: outcome,
                storageStatus: SessionManager.getStorageStatus(),
              };

              fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify(payload), "utf-8");
              console.log("DECRYPT_SUCCESS");
              app.quit();
            } catch (err) {
              console.error("PROC2_EXCEPTION:", err);
              app.exit(1);
            }
          });
          `,
        );

        const p2 = await runElectron(
          [`--user-data-dir=${userDataDir}`, proc2Script],
          testDir,
          12000,
        );
        if (p2.code !== 0)
          console.error("P2 FAILED:", p2.code, p2.stdout, p2.stderr);
        expect(p2.code).toBe(0);
        expect(p2.stdout).toContain("ELECTRON_VERSION:44.0.0");
        expect(p2.stdout).toContain("DECRYPT_SUCCESS");
        expect(fs.existsSync(outputFile)).toBe(true);

        const restoredData = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
        // Assert loaded credential record integrity
        expect(restoredData.storeLoaded.token).toBe(testSecret);
        expect(restoredData.storeLoaded.refreshToken).toBe(testRefreshSecret);
        expect(restoredData.storeLoaded.portalAccountId).toBe(testAccountId);
        expect(restoredData.storeLoaded.portalUsername).toBe(testUsername);
        expect(restoredData.storeLoaded.minecraftUuid).toBe(testMcUuid);

        // Assert session manager loaded state
        expect(restoredData.sessionCreds.token).toBe(testSecret);
        expect(restoredData.sessionCreds.refreshToken).toBe(testRefreshSecret);
        expect(restoredData.sessionCreds.portalUrl).toBe(
          "https://dev.lampas.town",
        );
        expect(restoredData.storageStatus.sessionPersisted).toBe(true);
        expect(restoredData.storageStatus.sessionOnly).toBe(false);

        // Step 3: Process 3 — Launch separate Electron 44.0.0 process to verify clean credential clearing
        const proc3Script = path.join(testDir, "proc3_clear.js");
        fs.writeFileSync(
          proc3Script,
          `
          const { app } = require("electron");
          const path = require("path");
          const fs = require("fs");

          if (process.versions.electron !== "44.0.0") {
            console.error("ELECTRON_VERSION_MISMATCH:" + process.versions.electron);
            process.exit(10);
          }
          console.log("ELECTRON_VERSION:" + process.versions.electron);

          app.setPath("userData", ${JSON.stringify(userDataDir)});

          app.whenReady().then(async () => {
            try {
              const { CredentialStore } = require(${JSON.stringify(credStoreModulePath)});
              const { SessionManager } = require(${JSON.stringify(sessionManagerModulePath)});

              const clearResult = await SessionManager.clearSession();
              if (!clearResult.success || !clearResult.deletedTarget) {
                console.error("CLEAR_FAILED:" + JSON.stringify(clearResult));
                process.exit(2);
                return;
              }

              const remaining = CredentialStore.loadCredentials();
              if (remaining !== null) {
                console.error("CREDENTIAL_REMAINING:" + JSON.stringify(remaining));
                process.exit(3);
                return;
              }

              console.log("CLEAR_SUCCESS");
              app.quit();
            } catch (err) {
              console.error("PROC3_EXCEPTION:", err);
              app.exit(1);
            }
          });
          `,
        );

        const p3 = await runElectron(
          [`--user-data-dir=${userDataDir}`, proc3Script],
          testDir,
          12000,
        );
        if (p3.code !== 0)
          console.error("P3 FAILED:", p3.code, p3.stdout, p3.stderr);
        expect(p3.code).toBe(0);
        expect(p3.stdout).toContain("ELECTRON_VERSION:44.0.0");
        expect(p3.stdout).toContain("CLEAR_SUCCESS");
        expect(fs.existsSync(credFile)).toBe(false);
      } finally {
        try {
          fs.rmSync(testDir, { recursive: true, force: true });
        } catch {}
      }
    },
    45000,
  );
});
