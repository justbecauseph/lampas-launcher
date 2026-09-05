import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sync-log-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const { LauncherLogger } = await import("../src/logger");
const { ConfigManager } = await import("../src/config");
const { ClientModManager } = await import("../src/client-mods");
const { LauncherSync } = await import("../src/sync");

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
  LauncherLogger.resetForTesting();
  LauncherLogger.init();
  ConfigManager.resetForTesting();
  ConfigManager.set({
    token: "mock-token",
    portalUrl: "http://localhost:3000",
    selectedChannel: "stable",
    gameDir,
    customClientMods: [],
    disabledClientMods: [],
  });
});

afterAll(() => {
  LauncherLogger.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Launcher sync and mod management logging", () => {
  test("ClientModManager logs add, replace, enable, disable, and remove operations", () => {
    const modSource = path.join(testRoot, "sample-mod.jar");
    fs.writeFileSync(modSource, "dummy jar binary data");

    // Add
    ClientModManager.add([modSource]);
    let logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Client Mods] Added custom mod: sample-mod.jar");

    // Replace
    ClientModManager.add([modSource]);
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Client Mods] Replaced custom mod: sample-mod.jar");

    // Disable
    ClientModManager.setEnabled("sample-mod.jar", false);
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Client Mods] Disabled custom mod: sample-mod.jar");

    // Enable
    ClientModManager.setEnabled("sample-mod.jar", true);
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Client Mods] Enabled custom mod: sample-mod.jar");

    // Remove
    ClientModManager.remove("sample-mod.jar");
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Client Mods] Removed custom mod: sample-mod.jar");

    // Toggle official mod
    ClientModManager.setOfficialEnabled("sodium", false);
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Client Mods] Disabled official mod: sodium");

    ClientModManager.setOfficialEnabled("sodium", true);
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Client Mods] Enabled official mod: sodium");
  });

  test("LauncherSync logs plan, cache hit / downloaded files, obsolete deleted files, and completion", async () => {
    const modPayload = Buffer.from("fabric-api-mod-content-data");
    const modSha256 = crypto.createHash("sha256").update(modPayload).digest("hex");
    const modSize = modPayload.length;

    const configPayload = Buffer.from("sodium-options-config-json");
    const configSha256 = crypto.createHash("sha256").update(configPayload).digest("hex");
    const configSize = configPayload.length;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({ channel: "stable", version: "2.0.0" });
        }

        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            launch: {},
          });
        }

        if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            files: [
              {
                path: "mods/fabric-api.jar",
                hashes: { sha256: modSha256 },
                size: modSize,
                download: { url: `/api/v1/blobs/${modSha256}` },
                policy: "MANAGED",
              },
              {
                path: "config/sodium.json",
                hashes: { sha256: configSha256 },
                size: configSize,
                download: { url: `/api/v1/blobs/${configSha256}` },
                policy: "MANAGED",
              },
            ],
            mods: [
              { id: "fabric-api", filename: "fabric-api.jar", side: "both" },
            ],
          });
        }

        if (url.pathname === `/api/v1/blobs/${modSha256}`) {
          return new Response(modPayload, {
            headers: { "Content-Type": "application/java-archive", "Content-Length": modSize.toString() },
          });
        }

        if (url.pathname === `/api/v1/blobs/${configSha256}`) {
          return new Response(configPayload, {
            headers: { "Content-Type": "application/json", "Content-Length": configSize.toString() },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    // Put an obsolete mod on disk that should be deleted
    const obsoleteModDir = path.join(gameDir, "mods");
    fs.mkdirSync(obsoleteModDir, { recursive: true });
    const obsoleteModPath = path.join(obsoleteModDir, "obsolete-mod.jar");
    fs.writeFileSync(obsoleteModPath, "old mod to delete");

    // Pre-populate sodium.json in cache to test Cache Hit logging
    const stateCacheDir = path.join(gameDir, ".lampas", "cache", "sha256", configSha256.substring(0, 2));
    fs.mkdirSync(stateCacheDir, { recursive: true });
    fs.writeFileSync(path.join(stateCacheDir, configSha256), configPayload);

    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(result.version).toBe("2.0.0");

      const logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");

      // Verify sync plan log
      expect(logContent).toContain("[Sync] Synchronizing client: 2 to download, 0 up-to-date, 1 obsolete to delete.");

      // Verify Cache Hit log
      expect(logContent).toContain("⚡ [Cache Hit] config/sodium.json");

      // Verify Downloaded log
      expect(logContent).toContain("✓ [Downloaded] mods/fabric-api.jar");

      // Verify Deleted Obsolete log
      expect(logContent).toContain("🗑 [Deleted Obsolete] mods/obsolete-mod.jar");

      // Verify Completion log
      expect(logContent).toContain("[OK] Client successfully synchronized to Lampas 2 v2.0.0!");

      // Verify obsolete file was indeed deleted from disk
      expect(fs.existsSync(obsoleteModPath)).toBe(false);

      // Verify new files were synced to disk
      expect(fs.existsSync(path.join(gameDir, "mods", "fabric-api.jar"))).toBe(true);
      expect(fs.existsSync(path.join(gameDir, "config", "sodium.json"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("logs whenever noSync toggle is enabled or disabled", () => {
    ConfigManager.set({ noSync: true });
    let logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Settings] No-sync mode enabled");
    expect(logContent).toContain("[Config] noSync changed: false -> true");

    ConfigManager.set({ noSync: false });
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Settings] No-sync mode disabled");
    expect(logContent).toContain("[Config] noSync changed: true -> false");
  });

  test("logs any configuration property changes and redacts sensitive tokens", () => {
    ConfigManager.set({ allocatedRamGb: 8 });
    let logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Config] allocatedRamGb changed: 4 -> 8");

    ConfigManager.set({ selectedChannel: "beta" });
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain('[Config] selectedChannel changed: "stable" -> "beta"');

    ConfigManager.set({ token: "super-secret-token-xyz" });
    logContent = fs.readFileSync(LauncherLogger.getLogPath(), "utf-8");
    expect(logContent).toContain("[Config] token changed: [REDACTED] -> [REDACTED]");
    expect(logContent).not.toContain("super-secret-token-xyz");
  });
});
