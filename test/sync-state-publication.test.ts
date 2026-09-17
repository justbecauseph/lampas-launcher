import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sync-pub-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
}));

import * as childProcess from "node:child_process";

const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.emit("exit", 0);
  };
  return proc;
});

const { LauncherLogger } = await import("../src/logger");
const { ConfigManager } = await import("../src/config");
const { LauncherSync } = await import("../src/sync");
const { GameRunner } = await import("../src/game-runner");
const { MinecraftBootstrap } = await import("../src/minecraft-bootstrap");
const { JavaRuntimeManager } = await import("../src/java-runtime");
const { LauncherAuth } = await import("../src/auth");

const authSpy = spyOn(LauncherAuth, "refreshSession").mockImplementation(async () => ({
  valid: true,
  user: {
    id: "user-1",
    name: "Player",
    minecraftUsername: "Player",
    minecraftUuid: "11111111-2222-3333-4444-555555555555",
    isAdmin: false,
    isTech: false,
    roles: [],
    allowedChannels: ["stable"],
  },
}));

const javaSpy = spyOn(JavaRuntimeManager, "ensureJava25").mockImplementation(async () => "C:\\Java25\\bin\\java.exe");
const bootstrapSpy = spyOn(MinecraftBootstrap, "prepareGameEnvironment").mockImplementation(async () => ({
  classpath: ["C:\\libraries\\dummy.jar"],
  mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
  assetIndex: "26.2",
}));

describe("Phase 4 — Sync Efficiency & Reliable State Publication", () => {
  beforeEach(() => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(gameDir, { recursive: true });
    ConfigManager.resetForTesting();
    GameRunner.resetForTesting();
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
    authSpy.mockRestore();
    spawnSpy.mockRestore();
    javaSpy.mockRestore();
    bootstrapSpy.mockRestore();
    if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("ConfigManager.set persistence failure preserves cached configuration without leaving it ahead of disk", () => {
    const initialConfig = ConfigManager.get();
    const originalSelectedChannel = initialConfig.selectedChannel;

    // Simulate disk persistence failure by making the config target a directory or invalid path
    const realConfigPath = (ConfigManager as any).configPath;
    // Create a directory at a path that causes write failure
    const badConfigDir = path.join(testRoot, "readonly-dir");
    fs.mkdirSync(badConfigDir, { recursive: true });

    (ConfigManager as any).configPath = badConfigDir; // writing file to a directory name will fail (EISDIR / EPERM)

    expect(() => {
      ConfigManager.set({ selectedChannel: "nightly-exploit" });
    }).toThrow();

    // Restore path
    (ConfigManager as any).configPath = realConfigPath;

    // In-memory cache must NOT have updated to the failed value
    expect(ConfigManager.get().selectedChannel).toBe(originalSelectedChannel);
  });

  test("failure publishing release.json halts sync and prevents installation state update", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });

    const stateFile = path.join(stateDir, "installation.json");
    const initialInstallation = {
      pack: "Lampas 2",
      version: "1.0.0",
      installedAt: "2026-01-01T00:00:00Z",
      syncGeneration: "gen-initial",
      releaseVersion: "1.0.0",
      files: {},
    };
    fs.writeFileSync(stateFile, JSON.stringify(initialInstallation, null, 2), "utf-8");

    // Make release.json unwritable (e.g. create a directory where release.json file would be)
    const releaseFilePath = path.join(stateDir, "release.json");
    fs.mkdirSync(releaseFilePath, { recursive: true }); // directory will cause writeAtomicFile to fail

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
            files: [],
            mods: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    let completeEmitted = false;
    try {
      await expect(
        LauncherSync.syncClient((p) => {
          if (p.status === "complete") completeEmitted = true;
        })
      ).rejects.toThrow();

      // Ensure no completion event was emitted
      expect(completeEmitted).toBe(false);

      // Verify installation.json was NOT updated to 2.0.0
      const currentInstallation = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(currentInstallation.version).toBe("1.0.0");
    } finally {
      server.stop(true);
      fs.rmSync(releaseFilePath, { recursive: true, force: true });
    }
  });

  test("GameRunner.launchGame rejects launch when release.json and installation.json versions mismatch", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });

    // Stale release descriptor v1.0.0
    fs.writeFileSync(
      path.join(stateDir, "release.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "1.0.0",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
      })
    );

    // Newer installation state v2.0.0 (incomplete or mismatched sync state)
    fs.writeFileSync(
      path.join(stateDir, "installation.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        installedAt: new Date().toISOString(),
        files: {},
      })
    );

    const dummyUser = {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "11111111-2222-3333-4444-555555555555",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    await expect(
      GameRunner.launchGame(dummyUser, () => {}, () => {})
    ).rejects.toThrow(/Incompatible installation state detected/);
  });

  test("GameRunner.launchGame rejects launch when syncGeneration IDs mismatch", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });

    // Release descriptor with generation A
    fs.writeFileSync(
      path.join(stateDir, "release.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        syncGeneration: "gen-alpha",
      })
    );

    // Installation state with generation B
    fs.writeFileSync(
      path.join(stateDir, "installation.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        installedAt: new Date().toISOString(),
        syncGeneration: "gen-beta",
        files: {},
      })
    );

    const dummyUser = {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "11111111-2222-3333-4444-555555555555",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    await expect(
      GameRunner.launchGame(dummyUser, () => {}, () => {})
    ).rejects.toThrow(/Incompatible installation generation detected/);
  });

  test("GameRunner.launchGame maintains backward compatibility with legacy states lacking syncGeneration", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });

    // Legacy release descriptor without syncGeneration
    fs.writeFileSync(
      path.join(stateDir, "release.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
      })
    );

    // Legacy installation state without syncGeneration
    fs.writeFileSync(
      path.join(stateDir, "installation.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        installedAt: new Date().toISOString(),
        files: {},
      })
    );

    const dummyUser = {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "11111111-2222-3333-4444-555555555555",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    const launched = await GameRunner.launchGame(dummyUser, () => {}, () => {});
    expect(launched).toBe(true);
    GameRunner.killGame();
  });

  test("GameRunner.launchGame rejects launch if installation.json is corrupted JSON", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, "release.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
      })
    );

    // Corrupted non-JSON installation state
    fs.writeFileSync(path.join(stateDir, "installation.json"), "{ corrupt json !!!");

    const dummyUser = {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "11111111-2222-3333-4444-555555555555",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    await expect(
      GameRunner.launchGame(dummyUser, () => {}, () => {})
    ).rejects.toThrow(/Installation state metadata is corrupted/);
  });

  test("full mode detects same-size corruption in managed files and replaces corrupt files", async () => {
    const corruptContent = Buffer.from("CORRUPT_MOD_CONTENT_EXACT_LEN");
    const healthyContent = Buffer.from("HEALTHY_MOD_CONTENT_EXACT_LEN");
    expect(corruptContent.length).toBe(healthyContent.length);

    const healthySha = crypto.createHash("sha256").update(healthyContent).digest("hex");

    const modPath = path.join(gameDir, "mods", "test-mod.jar");
    fs.mkdirSync(path.dirname(modPath), { recursive: true });
    // Write corrupt content with exact same size to disk
    fs.writeFileSync(modPath, corruptContent);

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
                path: "mods/test-mod.jar",
                hashes: { sha256: healthySha },
                size: healthyContent.length,
                download: { url: `/api/v1/blobs/${healthySha}` },
                policy: "MANAGED",
              },
            ],
            mods: [],
          });
        }
        if (url.pathname === `/api/v1/blobs/${healthySha}`) {
          return new Response(healthyContent);
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, { token: "mock-token" });

    try {
      // In full verification mode, same-size corruption must be detected and replaced
      const result = await LauncherSync.syncClient(() => {}, "full");
      expect(result.success).toBe(true);

      const replacedOnDisk = fs.readFileSync(modPath);
      expect(replacedOnDisk.equals(healthyContent)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
