import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import type { ReleaseDescriptor, UserProfile } from "../src/types";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runner-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

let spawnedCalls: Array<{ javaExe: string; jvmArgs: string[] }> = [];
let bootstrapCalls: Array<{ gameDir: string; runtime: any }> = [];

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

import * as actualChildProcess from "node:child_process";

let mockSpawnHook: ((proc: any) => void) | null = null;

mock.module("node:child_process", () => ({
  ...actualChildProcess,
  spawn: (javaExe: string, jvmArgs: string[]) => {
    spawnedCalls.push({ javaExe, jvmArgs });
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.emit("exit", 0);
    };
    if (mockSpawnHook) {
      mockSpawnHook(proc);
    }
    return proc;
  },
}));

let mockSessionUser: any = {
  id: "user-123",
  name: "TestPlayer",
  minecraftUsername: "TestPlayer",
  minecraftUuid: "11111111-2222-3333-4444-555555555555",
  isAdmin: false,
  isTech: false,
  roles: [],
  allowedChannels: ["stable"],
};

const { JavaRuntimeManager } = await import("../src/java-runtime");
const { MinecraftBootstrap } = await import("../src/minecraft-bootstrap");
const { ConfigManager } = await import("../src/config");
const { GameRunner } = await import("../src/game-runner");
const { LauncherAuth } = await import("../src/auth");

const javaSpy = spyOn(JavaRuntimeManager, "ensureJava25").mockImplementation(async () => "C:\\Java25\\bin\\java.exe");
const authSpy = spyOn(LauncherAuth, "refreshSession").mockImplementation(async () => ({
  valid: !!mockSessionUser,
  user: mockSessionUser,
}));
const bootstrapSpy = spyOn(MinecraftBootstrap, "prepareGameEnvironment").mockImplementation(async (targetDir: string, runtime: any) => {
  bootstrapCalls.push({ gameDir: targetDir, runtime });
  return {
    classpath: ["C:\\Game\\libraries\\fabric.jar"],
    mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
    assetIndex: "26.2",
  };
});

beforeAll(() => {
  fs.mkdirSync(gameDir, { recursive: true });
  fs.mkdirSync(path.join(gameDir, ".lampas"), { recursive: true });
  ConfigManager.set({
    gameDir,
    token: "mock-token",
    allocatedRamGb: 4,
  });
});

beforeEach(() => {
  mockSessionUser = {
    id: "user-123",
    name: "TestPlayer",
    minecraftUsername: "TestPlayer",
    minecraftUuid: "11111111-2222-3333-4444-555555555555",
    isAdmin: false,
    isTech: false,
    roles: [],
    allowedChannels: ["stable"],
  };
  GameRunner.resetForTesting();
  ConfigManager.resetForTesting();
  bootstrapCalls = [];
  ConfigManager.set({
    gameDir,
    token: "mock-token",
    allocatedRamGb: 4,
  });
});

afterAll(() => {
  javaSpy.mockRestore();
  bootstrapSpy.mockRestore();
  authSpy.mockRestore();
  GameRunner.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("GameRunner launch flow & Quick Play", () => {
  const dummyUser: UserProfile = {
    id: "user-123",
    name: "TestPlayer",
    minecraftUsername: "TestPlayer",
    isAdmin: false,
    isTech: false,
    roles: [],
    allowedChannels: ["stable"],
  };

  test("autoConnect=true appends --quickPlayMultiplayer with server address", async () => {
    spawnedCalls = [];
    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {
        autoConnect: true,
        server: "play.lampas.town:25565",
      },
    };

    const launched = await GameRunner.launchGame(
      dummyUser,
      () => {},
      () => {},
      release
    );

    expect(launched).toBe(true);
    expect(spawnedCalls.length).toBe(1);
    const { jvmArgs } = spawnedCalls[0];
    const qpIndex = jvmArgs.indexOf("--quickPlayMultiplayer");
    expect(qpIndex).not.toBe(-1);
    expect(jvmArgs[qpIndex + 1]).toBe("play.lampas.town:25565");
  });

  test("autoConnect=false does not append --quickPlayMultiplayer", async () => {
    spawnedCalls = [];
    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {
        autoConnect: false,
        server: "play.lampas.town:25565",
      },
    };

    const launched = await GameRunner.launchGame(
      dummyUser,
      () => {},
      () => {},
      release
    );

    expect(launched).toBe(true);
    expect(spawnedCalls.length).toBe(1);
    const { jvmArgs } = spawnedCalls[0];
    expect(jvmArgs.includes("--quickPlayMultiplayer")).toBe(false);
  });

  test("blocks launch if auto-connect server is malformed", async () => {
    spawnedCalls = [];
    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {
        autoConnect: true,
        server: "https://malformed-url.com",
      },
    };

    await expect(
      GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {},
        release
      )
    ).rejects.toThrow("Malformed auto-connect server address");
  });

  test("blocks launch if required resource pack preparation fails (missing file)", async () => {
    spawnedCalls = [];
    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {
        autoConnect: true,
        server: "play.lampas.town:25565",
        requiredResourcePacks: [
          {
            id: "lampas-resources",
            filename: "Lampas-Resources-Missing.zip",
            path: "resourcepacks/Lampas-Resources-Missing.zip",
            sha256: "a".repeat(64),
          },
        ],
      },
    };

    await expect(
      GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {},
        release
      )
    ).rejects.toThrow("Unable to prepare required Lampas resource pack. Run Repair and try again.");
  });

  test("verifies required resource pack and launches when pack file is present without mutating state", async () => {
    spawnedCalls = [];
    const rpDir = path.join(gameDir, "resourcepacks");
    fs.mkdirSync(rpDir, { recursive: true });
    const content = "dummy zip";
    fs.writeFileSync(path.join(rpDir, "Lampas-Resources-2.0.0.zip"), content);
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    const stateFile = path.join(gameDir, ".lampas", "installation.json");
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {
        autoConnect: true,
        server: "play.lampas.town:25565",
        requiredResourcePacks: [
          {
            id: "lampas-resources",
            filename: "Lampas-Resources-2.0.0.zip",
            path: "resourcepacks/Lampas-Resources-2.0.0.zip",
            sha256: hash,
          },
        ],
      },
    };

    const launched = await GameRunner.launchGame(
      dummyUser,
      () => {},
      () => {},
      release
    );

    expect(launched).toBe(true);
    // GameRunner must NOT write or mutate installation.json
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  test("rejects launch if user has no bound Minecraft UUID", async () => {
    mockSessionUser = {
      id: "user-123",
      name: "UnboundUser",
      minecraftUsername: "UnboundUser",
      minecraftUuid: undefined,
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    await expect(
      GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {}
      )
    ).rejects.toThrow("No bound Minecraft account found in your profile");
  });

  test("rejects launch if user has zero/placeholder Minecraft UUID", async () => {
    mockSessionUser = {
      id: "user-123",
      name: "ZeroUuidUser",
      minecraftUsername: "ZeroUuidUser",
      minecraftUuid: "00000000-0000-0000-0000-000000000000",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: ["stable"],
    };

    await expect(
      GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {}
      )
    ).rejects.toThrow("No bound Minecraft account found in your profile");
  });

  test("propagates exact release runtime (0.99.123-test) to MinecraftBootstrap and JVM args (PLAN.md Section 44)", async () => {
    spawnedCalls = [];
    bootstrapCalls = [];
    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.99.123-test" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {},
    };

    const launched = await GameRunner.launchGame(
      dummyUser,
      () => {},
      () => {},
      release
    );

    expect(launched).toBe(true);
    expect(bootstrapCalls.length).toBe(1);
    expect(bootstrapCalls[0].runtime).toEqual({
      minecraft: "26.2",
      loader: {
        type: "fabric",
        version: "0.99.123-test",
      },
    });

    // Verify JVM arguments received --version 26.2
    expect(spawnedCalls.length).toBe(1);
    const { jvmArgs } = spawnedCalls[0];
    const versionIndex = jvmArgs.indexOf("--version");
    expect(versionIndex).not.toBe(-1);
    expect(jvmArgs[versionIndex + 1]).toBe("26.2");
  });

  test("rejects launch when release specifies unsupported loader type", async () => {
    const invalidRelease: any = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "neoforge", version: "20.4.0" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {},
    };

    await expect(
      GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {},
        invalidRelease
      )
    ).rejects.toThrow("unsupported loader type 'neoforge'");
  });

  test("logs starting Minecraft client via dynamic mainClass without KnotClient hardcode", async () => {
    spawnedCalls = [];
    bootstrapCalls = [];
    const loggedMessages: string[] = [];

    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.99.123-test" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {},
    };

    await GameRunner.launchGame(
      dummyUser,
      (entry) => loggedMessages.push(entry.message),
      () => {},
      release
    );

    const startLog = loggedMessages.find((m) => m.startsWith("Starting Minecraft client via"));
    expect(startLog).toBeDefined();
    expect(startLog).toBe("Starting Minecraft client via net.fabricmc.loader.impl.launch.knot.KnotClient...");
    expect(startLog?.includes("via KnotClient (")).toBe(false);
  });

  test("spawn ENOENT error rejects launchGame and resets running state", async () => {
    mockSpawnHook = (proc) => {
      queueMicrotask(() => {
        const err: any = new Error("spawn java.exe ENOENT");
        err.code = "ENOENT";
        proc.emit("error", err);
      });
    };

    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.99.123-test" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {},
    };

    try {
      await expect(
        GameRunner.launchGame(
          dummyUser,
          () => {},
          () => {},
          release
        )
      ).rejects.toThrow("spawn java.exe ENOENT");

      expect(GameRunner.isGameRunning()).toBe(false);
    } finally {
      mockSpawnHook = null;
    }
  });

  test("Phase 7: post-spawn runtime error does not clear runningProcess until exit or close", async () => {
    let childProc: any = null;
    mockSpawnHook = (proc) => {
      childProc = proc;
    };

    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {},
    };

    const errorLogs: string[] = [];
    let exitReportedCode: number | null = null;

    try {
      await GameRunner.launchGame(
        dummyUser,
        (entry) => {
          if (entry.level === "ERROR") errorLogs.push(entry.message);
        },
        (code) => {
          exitReportedCode = code;
        },
        release
      );

      expect(GameRunner.isGameRunning()).toBe(true);

      // Emit runtime post-spawn error (e.g. pipe error or signal error)
      childProc.emit("error", new Error("EPIPE: write to closed pipe"));

      // CRITICAL INVARIANT: runningProcess must NOT be cleared on child 'error'
      // The OS process has not exited; clearing it would allow conflicting mutations!
      expect(GameRunner.isGameRunning()).toBe(true);
      expect(exitReportedCode).toBeNull();
      expect(errorLogs.some((msg) => msg.includes("EPIPE: write to closed pipe"))).toBe(true);

      // Now emit true exit event
      childProc.emit("exit", 0);

      // Now runningProcess is cleared and exit reported
      expect(GameRunner.isGameRunning()).toBe(false);
      expect(exitReportedCode).toBe(0);
    } finally {
      mockSpawnHook = null;
      GameRunner.resetForTesting();
    }
  });

  test("Phase 7: killGame is awaitable and waits for process exit/close resolution", async () => {
    let childProc: any = null;
    mockSpawnHook = (proc) => {
      childProc = proc;
      // Override kill to simulate delayed graceful termination
      proc.kill = (signal: string) => {
        proc.killed = true;
        setTimeout(() => {
          proc.emit("exit", signal === "SIGKILL" ? 137 : 0);
        }, 50);
      };
    };

    const release: ReleaseDescriptor = {
      schemaVersion: 1,
      pack: "Lampas 2",
      version: "2.0.0",
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
      minimumLauncherVersion: "1.1.0",
      protocol: 2,
      created: new Date().toISOString(),
      clientManifest: "/manifest",
      serverManifest: "/server-manifest",
      launch: {},
    };

    try {
      await GameRunner.launchGame(
        dummyUser,
        () => {},
        () => {},
        release
      );

      expect(GameRunner.isGameRunning()).toBe(true);

      // Await killGame
      const startKill = performance.now();
      await GameRunner.killGame(2000);
      const killDuration = performance.now() - startKill;

      // Verified: killGame awaited the delayed exit
      expect(killDuration).toBeGreaterThanOrEqual(40);
      expect(GameRunner.isGameRunning()).toBe(false);
    } finally {
      mockSpawnHook = null;
      GameRunner.resetForTesting();
    }
  });
});
