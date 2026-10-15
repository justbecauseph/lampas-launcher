import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

// Shaped like a Microsoft-issued Minecraft token (a JWT); launches refuse anything else.
const TEST_MINECRAFT_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "test", exp: 4102444800 })).toString("base64url")}.signature`;

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-sync-pub-test-"),
);
const userDataDir = path.join(testRoot, "user-data");
let gameDir = path.join(testRoot, "game");
function cachedReleaseFixture(version: string, syncGeneration?: string) {
  return {
    schemaVersion: 1,
    pack: "Lampas 2",
    version,
    minecraft: "26.2",
    loader: { type: "fabric", version: "0.19.3" },
    minimumLauncherVersion: "1.0.0",
    protocol: 3,
    created: "2026-01-01T00:00:00.000Z",
    clientManifest: `/api/v1/releases/${version}/client-manifest`,
    serverManifest: `/api/v1/releases/${version}/server-manifest`,
    ...(syncGeneration ? { syncGeneration } : {}),
  };
}

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
const { ConfigManager, PortalPolicy } = await import("../src/config");
const { LauncherSync } = await import("../src/sync");
const { GameRunner } = await import("../src/game-runner");
const { MinecraftBootstrap } = await import("../src/minecraft-bootstrap");
const { JavaRuntimeManager } = await import("../src/java-runtime");
const { LauncherAuth } = await import("../src/auth");

const authSpy = spyOn(LauncherAuth, "refreshSession").mockImplementation(
  async () => ({
    valid: true,
    user: {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "00000000-0000-0000-0000-000000000001",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    },
  }),
);

const javaSpy = spyOn(JavaRuntimeManager, "ensureJava25").mockImplementation(
  async () => "C:\\Java25\\bin\\java.exe",
);
const bootstrapSpy = spyOn(
  MinecraftBootstrap,
  "prepareGameEnvironment",
).mockImplementation(async () => ({
  classpath: ["C:\\libraries\\dummy.jar"],
  mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
  assetIndex: "26.2",
}));

describe("Phase 4 — Sync Efficiency & Reliable State Publication", () => {
  beforeEach(() => {
    fs.mkdirSync(userDataDir, { recursive: true });
    gameDir = fs.mkdtempSync(path.join(testRoot, "game-"));
    PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
    ConfigManager.resetForTesting();
    GameRunner.resetForTesting();
    ConfigManager.set({
      portalUrl: "http://localhost:3000",
      selectedChannel: "stable",
      gameDir,
      customClientMods: [],
      disabledClientMods: [],
    });
    ConfigManager.establishSession("http://localhost:3000", {
      token: "mock-token",
    });
  });

  afterAll(() => {
    PortalPolicy.resetForTesting();
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
    fs.writeFileSync(
      stateFile,
      JSON.stringify(initialInstallation, null, 2),
      "utf-8",
    );

    // Make release.json unwritable (e.g. create a directory where release.json file would be)
    const releaseFilePath = path.join(stateDir, "release.json");
    fs.mkdirSync(releaseFilePath, { recursive: true }); // directory will cause writeAtomicFile to fail

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({
            channel: "stable",
            version: "2.0.0",
            release: "/api/v1/releases/2.0.0",
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            minimumLauncherVersion: "1.0.0",
            protocol: 3,
            created: "2026-01-01T00:00:00Z",
            clientManifest: "/api/v1/releases/2.0.0/client-manifest",
            serverManifest: "/api/v1/releases/2.0.0/server-manifest",
            launch: {},
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
          return Response.json({
            schemaVersion: 2,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "client",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            protocol: 3,
            files: [],
            mods: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, {
      token: "mock-token",
    });

    let completeEmitted = false;
    try {
      await expect(
        LauncherSync.syncClient((p) => {
          if (p.status === "complete") completeEmitted = true;
        }),
      ).rejects.toThrow();

      // Ensure no completion event was emitted
      expect(completeEmitted).toBe(false);

      // Verify installation.json was NOT updated to 2.0.0
      const currentInstallation = JSON.parse(
        fs.readFileSync(stateFile, "utf-8"),
      );
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
      JSON.stringify(cachedReleaseFixture("1.0.0")),
    );

    // Newer installation state v2.0.0 (incomplete or mismatched sync state)
    fs.writeFileSync(
      path.join(stateDir, "installation.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        installedAt: new Date().toISOString(),
        files: {},
      }),
    );

    const dummyUser = {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "11111111-2222-3333-4444-555555555555",
      minecraftAccessToken: TEST_MINECRAFT_TOKEN,
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    await expect(
      GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/Incompatible installation state detected/);
  });

  test("GameRunner.launchGame rejects launch when syncGeneration IDs mismatch", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });

    // Release descriptor with generation A
    fs.writeFileSync(
      path.join(stateDir, "release.json"),
      JSON.stringify(cachedReleaseFixture("2.0.0", "gen-alpha")),
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
      }),
    );

    const dummyUser = {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "11111111-2222-3333-4444-555555555555",
      minecraftAccessToken: TEST_MINECRAFT_TOKEN,
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    await expect(
      GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/Incompatible installation generation detected/);
  });

  test("GameRunner.launchGame maintains backward compatibility with legacy states lacking syncGeneration", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });

    // Legacy release descriptor without syncGeneration
    fs.writeFileSync(
      path.join(stateDir, "release.json"),
      JSON.stringify(cachedReleaseFixture("2.0.0")),
    );

    // Legacy installation state without syncGeneration
    fs.writeFileSync(
      path.join(stateDir, "installation.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        installedAt: new Date().toISOString(),
        files: {},
      }),
    );

    const dummyUser = {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "11111111-2222-3333-4444-555555555555",
      minecraftAccessToken: TEST_MINECRAFT_TOKEN,
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    const launched = await GameRunner.launchGame(
      dummyUser,
      () => {},
      () => {},
    );
    expect(launched).toBe(true);
    GameRunner.killGame();
  });

  test("GameRunner.launchGame rejects launch if installation.json is corrupted JSON", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, "release.json"),
      JSON.stringify(cachedReleaseFixture("2.0.0")),
    );

    // Corrupted non-JSON installation state
    fs.writeFileSync(
      path.join(stateDir, "installation.json"),
      "{ corrupt json !!!",
    );

    const dummyUser = {
      id: "user-1",
      name: "Player",
      minecraftUsername: "Player",
      minecraftUuid: "11111111-2222-3333-4444-555555555555",
      minecraftAccessToken: TEST_MINECRAFT_TOKEN,
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    await expect(
      GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/Installation state metadata is corrupted/);
  });

  test("cached launch metadata rejects oversized releases and poisoned prior paths before Java execution", async () => {
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });
    const releasePath = path.join(stateDir, "release.json");
    const statePath = path.join(stateDir, "installation.json");
    const user = {
      id: "fixture",
      name: "Fixture",
      minecraftUuid: "11111111-2222-4333-8444-555555555555",
      minecraftAccessToken: TEST_MINECRAFT_TOKEN,
      minecraftUsername: "Fixture",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };
    const javaCalls = javaSpy.mock.calls.length;
    fs.writeFileSync(releasePath, "{}");
    fs.truncateSync(releasePath, 8 * 1024 * 1024 + 1);
    fs.writeFileSync(
      statePath,
      JSON.stringify({ pack: "Lampas 2", version: "2.0.0", files: {} }),
    );
    await expect(
      GameRunner.launchGame(
        user,
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/corrupted/);
    fs.writeFileSync(
      releasePath,
      JSON.stringify(cachedReleaseFixture("2.0.0")),
    );
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        files: {
          "../outside.jar": {
            sha256: "a".repeat(64),
            size: 1,
            policy: "MANAGED",
          },
        },
      }),
    );
    await expect(
      GameRunner.launchGame(
        user,
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/invalid/);
    expect(javaSpy.mock.calls.length).toBe(javaCalls);
  });

  test("full mode detects same-size corruption in managed files and replaces corrupt files", async () => {
    const corruptContent = Buffer.from("CORRUPT_MOD_CONTENT_EXACT_LEN");
    const healthyContent = Buffer.from("HEALTHY_MOD_CONTENT_EXACT_LEN");
    expect(corruptContent.length).toBe(healthyContent.length);

    const healthySha = crypto
      .createHash("sha256")
      .update(healthyContent)
      .digest("hex");

    const modPath = path.join(gameDir, "mods", "test-mod.jar");
    fs.mkdirSync(path.dirname(modPath), { recursive: true });
    // Write corrupt content with exact same size to disk
    fs.writeFileSync(modPath, corruptContent);

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({
            channel: "stable",
            version: "2.0.0",
            release: "/api/v1/releases/2.0.0",
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0") {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            minimumLauncherVersion: "1.0.0",
            protocol: 3,
            created: "2026-01-01T00:00:00Z",
            clientManifest: "/api/v1/releases/2.0.0/client-manifest",
            serverManifest: "/api/v1/releases/2.0.0/server-manifest",
            launch: {},
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
          return Response.json({
            schemaVersion: 2,
            pack: "Lampas 2",
            version: "2.0.0",
            target: "client",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            protocol: 3,
            files: [
              {
                path: "mods/test-mod.jar",
                hashes: { sha256: healthySha },
                size: healthyContent.length,
                download: {
                  url: `/api/v1/blobs/${healthySha}`,
                  provider: "lampas",
                },
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

    ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, {
      token: "mock-token",
    });

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
