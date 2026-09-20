// Run with pinned Electron, an explicit disposable --user-data-dir, and no real account.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const profileArgument = process.argv.find((value) =>
  value.startsWith("--user-data-dir="),
);
if (!profileArgument)
  throw new Error(
    "Native storage probe requires a disposable user-data directory",
  );
const profile = path.resolve(profileArgument.slice("--user-data-dir=".length));
if (!path.basename(profile).startsWith("lampas-native-storage-"))
  throw new Error("Unexpected probe directory");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath("userData", profile);

app
  .whenReady()
  .then(async () => {
    const { CredentialStore } = require("../../dist/credential-store");
    const { LauncherLogger } = require("../../dist/logger");
    const token = "synthetic-native-storage-secret";
    const record = {
      version: 1,
      portalUrl: "https://dev.lampas.town",
      accountId: "native-probe-account",
      accountUsername: "NativeProbe",
      minecraftUuid: "11111111-1111-4111-8111-111111111111",
      minecraftUsername: "NativeProbe",
      token,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      const backend = CredentialStore.detectStorageBackend();
      const saved = CredentialStore.saveCredentials(record);
      assert.equal(saved.success, true);
      if (backend === "session_only") {
        assert.equal(saved.sessionOnly, true);
        assert.equal(
          fs.existsSync(CredentialStore.getCredentialsFilePath()),
          false,
        );
      } else {
        assert.equal(saved.sessionOnly, false);
        const storedBytes = fs.readFileSync(
          CredentialStore.getCredentialsFilePath(),
        );
        assert.equal(storedBytes.includes(Buffer.from(token)), false);
        const restored = CredentialStore.loadCredentials();
        assert.equal(restored.token, token);
        assert.equal(restored.portalUrl, record.portalUrl);
        if (process.platform !== "win32") {
          assert.equal(
            fs.statSync(CredentialStore.getCredentialsFilePath()).mode & 0o077,
            0,
          );
        }
      }
      assert.equal(CredentialStore.clearCredentials().success, true);
      assert.equal(CredentialStore.loadCredentials(), null);
      await LauncherLogger.close();
      const logsPath = path.join(profile, "logs", "launcher.log");
      if (fs.existsSync(logsPath))
        assert.equal(fs.readFileSync(logsPath, "utf8").includes(token), false);
      console.log(
        JSON.stringify({
          nativeStorageProbe: "passed",
          platform: process.platform,
          backend,
          selectedBackend:
            typeof safeStorage.getSelectedStorageBackend === "function"
              ? safeStorage.getSelectedStorageBackend()
              : "platform-native",
          profile,
        }),
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      await LauncherLogger.close();
      app.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
