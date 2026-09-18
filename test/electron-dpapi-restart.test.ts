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

  function runElectron(args: string[], cwd: string, timeoutMs = 12000): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
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

      proc.stdout?.on("data", (d) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d) => { stderr += d.toString(); });

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

  test("Native evidence: Real Electron 44.0.0 safeStorage encrypts and decrypts across distinct process lifecycles via Windows DPAPI", async () => {
    if (!isWindows) {
      console.log("[Notice] Windows DPAPI separate-process restart check is platform-specific to Windows. Linux Secret Service / Keyring validation is executed in Linux CI environments.");
      return;
    }

    if (!fs.existsSync(electronBin)) {
      throw new Error(`Electron binary not found at ${electronBin}`);
    }

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-dpapi-evidence-"));
    const userDataDir = path.join(testDir, "user-data");
    fs.mkdirSync(userDataDir, { recursive: true });

    const credFile = path.join(userDataDir, "credentials.enc");
    const testSecret = "syn-dpapi-secret-token-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const testPayload = JSON.stringify({
      version: 1,
      portalUrl: "https://dev.lampas.town",
      token: testSecret,
      refreshToken: "syn-refresh-" + testSecret,
      portalAccountId: "dpapi-test-account-123",
      minecraftUuid: "mc-uuid-456",
    });

    try {
      // Step 1: Process 1 — Launch real Electron 44.0.0 to encrypt credentials via DPAPI
      const proc1Script = path.join(testDir, "encrypt.js");
      fs.writeFileSync(
        proc1Script,
        `
        const { app, safeStorage } = require("electron");
        const fs = require("fs");

        app.setPath("userData", ${JSON.stringify(userDataDir)});

        app.whenReady().then(() => {
          try {
            if (!safeStorage.isEncryptionAvailable()) {
              console.error("DPAPI_UNAVAILABLE");
              process.exit(2);
              return;
            }

            const payload = ${JSON.stringify(testPayload)};
            const encryptedBuffer = safeStorage.encryptString(payload);
            const sameProcDecrypted = safeStorage.decryptString(encryptedBuffer);
            if (sameProcDecrypted !== payload) {
              throw new Error("Same process decrypt mismatch");
            }
            fs.writeFileSync(${JSON.stringify(credFile)}, encryptedBuffer);
            app.quit();
          } catch (err) {
            console.error("ENCRYPT_ERR:", err);
            app.exit(1);
          }
        });
        `
      );

      const p1 = await runElectron([`--user-data-dir=${userDataDir}`, proc1Script], testDir, 10000);
      if (p1.code !== 0) console.error("P1 FAILED:", p1.code, p1.stdout, p1.stderr);
      expect(p1.code).toBe(0);
      expect(fs.existsSync(credFile)).toBe(true);

      // Verify on disk: encrypted file does NOT contain plaintext secret
      const diskBytes = fs.readFileSync(credFile);
      const rawString = diskBytes.toString("utf-8");
      expect(rawString.includes(testSecret)).toBe(false);
      expect(rawString.includes("syn-refresh-")).toBe(false);
      expect(rawString.includes("dpapi-test-account-123")).toBe(false);

      // Verify Windows File ACL on credentials.enc
      const icaclsOutput = cp.execFileSync("icacls", [credFile], { encoding: "utf-8" });
      expect(icaclsOutput).toContain(path.basename(credFile));
      // Security invariant: file permissions must be private (not open to Everyone or unprivileged world groups)
      expect(icaclsOutput.toLowerCase().includes("everyone")).toBe(false);
      expect(icaclsOutput.toLowerCase().includes("users:(i)(f)")).toBe(false);

      // Step 2: Process 2 — Launch completely SEPARATE real Electron process to decrypt credentials
      const proc2Script = path.join(testDir, "decrypt.js");
      const outputFile = path.join(testDir, "decrypted.txt");
      fs.writeFileSync(
        proc2Script,
        `
        const { app, safeStorage } = require("electron");
        const fs = require("fs");

        app.whenReady().then(() => {
          try {
            if (!safeStorage.isEncryptionAvailable()) {
              console.error("DPAPI_UNAVAILABLE");
              process.exit(2);
              return;
            }

            const encBuffer = fs.readFileSync(${JSON.stringify(credFile)});
            const decrypted = safeStorage.decryptString(encBuffer);
            fs.writeFileSync(${JSON.stringify(outputFile)}, decrypted, "utf-8");
            app.quit();
          } catch (err) {
            console.error("DECRYPT_ERR:", err);
            app.exit(1);
          }
        });
        `
      );

      const p2 = await runElectron([`--user-data-dir=${userDataDir}`, proc2Script], testDir, 10000);
      if (p2.code !== 0) console.error("P2 FAILED:", p2.code, p2.stdout, p2.stderr);
      expect(p2.code).toBe(0);
      expect(fs.existsSync(outputFile)).toBe(true);

      const decryptedPayload = fs.readFileSync(outputFile, "utf-8");
      const parsed = JSON.parse(decryptedPayload);
      expect(parsed.token).toBe(testSecret);
      expect(parsed.portalUrl).toBe("https://dev.lampas.town");
      expect(parsed.portalAccountId).toBe("dpapi-test-account-123");
      expect(parsed.minecraftUuid).toBe("mc-uuid-456");

      // Step 3: Process 3 — Verify clean deletion and restart verification
      const proc3Script = path.join(testDir, "clear.js");
      fs.writeFileSync(
        proc3Script,
        `
        const { app } = require("electron");
        const fs = require("fs");

        app.whenReady().then(() => {
          if (fs.existsSync(${JSON.stringify(credFile)})) {
            fs.unlinkSync(${JSON.stringify(credFile)});
          }
          app.quit();
        });
        `
      );

      const p3 = await runElectron([`--user-data-dir=${userDataDir}`, proc3Script], testDir, 10000);
      expect(p3.code).toBe(0);
      expect(fs.existsSync(credFile)).toBe(false);
    } finally {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  }, 35000);
});
