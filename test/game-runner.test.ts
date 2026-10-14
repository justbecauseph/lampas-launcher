import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import type { ReleaseDescriptor, UserProfile } from "../src/types";
import type { ProcessProbe } from "../src/game-session";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-runner-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");
const sessionFile = path.join(userDataDir, "game-session.json");

let spawnedCalls: Array<{
  javaExe: string;
  jvmArgs: string[];
  options: any;
}> = [];
let bootstrapCalls: Array<{ gameDir: string; runtime: any }> = [];

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

import * as actualChildProcess from "node:child_process";

let mockSpawnHook: ((proc: any) => void) | null = null;

mock.module("node:child_process", () => ({
  ...actualChildProcess,
  spawn: (javaExe: string, jvmArgs: string[], options?: any) => {
    // The window maximizer helper (PowerShell, started once the game has a
    // pid) goes through this mock too; it is neither a game launch nor a
    // process the spawn hook should see.
    if (/powershell\.exe$/i.test(javaExe)) {
      const helper = new EventEmitter() as any;
      helper.exitCode = null;
      helper.kill = () => {};
      return helper;
    }
    spawnedCalls.push({ javaExe, jvmArgs, options });
    const proc = new EventEmitter() as any;
    proc.pid = 4242;
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
const { GameRunner, buildLaunchArguments } = await import("../src/game-runner");
const { LauncherAuth } = await import("../src/auth");

const javaSpy = spyOn(JavaRuntimeManager, "ensureJava25").mockImplementation(
  async () => "C:\\Java25\\bin\\java.exe",
);
const authSpy = spyOn(LauncherAuth, "refreshSession").mockImplementation(
  async () => ({
    valid: !!mockSessionUser,
    user: mockSessionUser,
  }),
);
const bootstrapSpy = spyOn(
  MinecraftBootstrap,
  "prepareGameEnvironment",
).mockImplementation(async (targetDir: string, runtime: any) => {
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
    allocatedRamGb: 4,
  });
  ConfigManager.establishSession("https://lampas.town", {
    token: "mock-token",
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
  fs.rmSync(sessionFile, { force: true });
  bootstrapCalls = [];
  ConfigManager.set({
    gameDir,
    allocatedRamGb: 4,
  });
  ConfigManager.establishSession("https://lampas.town", {
    token: "mock-token",
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
      release,
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
      release,
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
        release,
      ),
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
        release,
      ),
    ).rejects.toThrow(
      "Unable to prepare required Lampas resource pack. Run Repair and try again.",
    );
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
      release,
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
        () => {},
      ),
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
        () => {},
      ),
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
      release,
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
        invalidRelease,
      ),
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
      release,
    );

    const startLog = loggedMessages.find((m) =>
      m.startsWith("Starting Minecraft client via"),
    );
    expect(startLog).toBeDefined();
    expect(startLog).toBe(
      "Starting Minecraft client via net.fabricmc.loader.impl.launch.knot.KnotClient...",
    );
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
          release,
        ),
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
        release,
      );

      expect(GameRunner.isGameRunning()).toBe(true);

      // Emit runtime post-spawn error (e.g. pipe error or signal error)
      childProc.emit("error", new Error("EPIPE: write to closed pipe"));

      // CRITICAL INVARIANT: runningProcess must NOT be cleared on child 'error'
      // The OS process has not exited; clearing it would allow conflicting mutations!
      expect(GameRunner.isGameRunning()).toBe(true);
      expect(exitReportedCode).toBeNull();
      expect(
        errorLogs.some((msg) => msg.includes("EPIPE: write to closed pipe")),
      ).toBe(true);

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
        release,
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

const sessionMarkerPattern = /^-Dlampas\.launcher\.session=[a-f0-9]{32}$/;

function sessionRelease(): ReleaseDescriptor {
  return {
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
}

const sessionUser: UserProfile = {
  id: "user-123",
  name: "TestPlayer",
  minecraftUsername: "TestPlayer",
  isAdmin: false,
  isTech: false,
  roles: [],
  allowedChannels: ["stable"],
};

function writeSessionRecord(pid: number, sessionId: string): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      version: 1,
      pid,
      sessionId,
      startedAt: new Date().toISOString(),
      gameDir,
    }),
  );
}

function makeFakeProbe(commandLine: string | null) {
  const state = {
    alive: true,
    commandLine,
    terminated: [] as Array<{ pid: number; signal: string }>,
    terminateDelayMs: 0,
  };
  const probe: ProcessProbe = {
    isAlive: () => state.alive,
    readCommandLine: async () => state.commandLine,
    terminate: (pid, signal) => {
      state.terminated.push({ pid, signal });
      setTimeout(() => {
        state.alive = false;
      }, state.terminateDelayMs);
    },
  };
  return { state, probe };
}

describe("GameRunner detached launch and session record", () => {
  test("spawns detached with a hidden window, one session marker before custom args, and records the session", async () => {
    spawnedCalls = [];
    ConfigManager.set({ javaArgs: "-Dcustom.first=1 -Dcustom.second=2" });
    try {
      await GameRunner.launchGame(
        sessionUser,
        () => {},
        () => {},
        sessionRelease(),
      );
    } finally {
      // Config persists to disk and would leak into later tests.
      ConfigManager.set({ javaArgs: "" });
    }

    expect(spawnedCalls.length).toBe(1);
    const { jvmArgs, options } = spawnedCalls[0];
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);

    const markers = jvmArgs.filter((arg) =>
      arg.startsWith("-Dlampas.launcher.session="),
    );
    expect(markers.length).toBe(1);
    expect(markers[0]).toMatch(sessionMarkerPattern);
    const markerIndex = jvmArgs.indexOf(markers[0]);
    expect(markerIndex).toBeLessThan(jvmArgs.indexOf("-Dcustom.first=1"));
    expect(markerIndex).toBeLessThan(jvmArgs.indexOf("-Dcustom.second=2"));
    expect(jvmArgs[markerIndex - 1]).toBe(
      `-Dminecraft.applet.TargetDirectory=${jvmArgs[jvmArgs.indexOf("--gameDir") + 1]}`,
    );

    const record = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    expect(record.version).toBe(1);
    expect(record.pid).toBe(4242);
    expect(record.sessionId).toBe(markers[0].split("=")[1]);
    expect(record.gameDir).toBe(jvmArgs[jvmArgs.indexOf("--gameDir") + 1]);
    expect(path.resolve(record.gameDir)).toBe(path.resolve(gameDir));
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
  });

  test("removes the session record when the game exits", async () => {
    let childProc: any = null;
    mockSpawnHook = (proc) => {
      childProc = proc;
    };
    try {
      await GameRunner.launchGame(
        sessionUser,
        () => {},
        () => {},
        sessionRelease(),
      );
      expect(fs.existsSync(sessionFile)).toBe(true);

      childProc.emit("exit", 0);

      expect(fs.existsSync(sessionFile)).toBe(false);
      expect(GameRunner.isGameRunning()).toBe(false);
    } finally {
      mockSpawnHook = null;
      GameRunner.resetForTesting();
    }
  });

  test("releaseForShutdown detaches from a running game but keeps the session record", async () => {
    let childProc: any = null;
    let unrefCalled = false;
    let stdoutDestroyed = false;
    let stderrDestroyed = false;
    mockSpawnHook = (proc) => {
      childProc = proc;
      proc.unref = () => {
        unrefCalled = true;
      };
      proc.stdout.destroy = () => {
        stdoutDestroyed = true;
      };
      proc.stderr.destroy = () => {
        stderrDestroyed = true;
      };
    };
    try {
      await GameRunner.launchGame(
        sessionUser,
        () => {},
        () => {},
        sessionRelease(),
      );
      expect(fs.existsSync(sessionFile)).toBe(true);

      GameRunner.releaseForShutdown();

      expect(unrefCalled).toBe(true);
      expect(stdoutDestroyed).toBe(true);
      expect(stderrDestroyed).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(true);

      // An exit observed during shutdown must not erase the record either.
      childProc.emit("exit", 0);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      mockSpawnHook = null;
      GameRunner.resetForTesting();
    }
  });
});

describe("GameRunner adoption of a game from a previous launcher session", () => {
  const sessionId = "0123456789abcdef0123456789abcdef";
  const marker = `-Dlampas.launcher.session=${sessionId}`;

  test("adopts a live process carrying the session marker and reports its exit once", async () => {
    writeSessionRecord(4242, sessionId);
    const { state, probe } = makeFakeProbe(
      `java.exe -Xmx4G ${marker} -cp x net.fabricmc.loader.impl.launch.knot.KnotClient`,
    );
    GameRunner._processProbe = probe;
    GameRunner._adoptedPollMs = 20;

    const exitCodes: Array<number | null> = [];
    let onExitCalled!: () => void;
    const exited = new Promise<void>((resolve) => {
      onExitCalled = resolve;
    });

    try {
      const adopted = await GameRunner.adoptRunningGame((code) => {
        exitCodes.push(code);
        onExitCalled();
      });

      expect(adopted).toEqual({ pid: 4242 });
      expect(GameRunner.isGameRunning()).toBe(true);
      expect(GameRunner.getAdoptedPid()).toBe(4242);
      expect(fs.existsSync(sessionFile)).toBe(true);

      state.alive = false;
      await exited;
      // Let several more poll intervals pass to prove the callback is not repeated.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(exitCodes).toEqual([null]);
      expect(fs.existsSync(sessionFile)).toBe(false);
      expect(GameRunner.isGameRunning()).toBe(false);
      expect(GameRunner.getAdoptedPid()).toBeNull();
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("refuses to launch while an adopted game is running", async () => {
    writeSessionRecord(4242, sessionId);
    const { probe } = makeFakeProbe(`java.exe ${marker}`);
    GameRunner._processProbe = probe;
    try {
      await GameRunner.adoptRunningGame(() => {});
      await expect(
        GameRunner.launchGame(
          sessionUser,
          () => {},
          () => {},
          sessionRelease(),
        ),
      ).rejects.toThrow("Minecraft is already running!");
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("does not adopt a process whose command line lacks the marker", async () => {
    writeSessionRecord(4242, sessionId);
    const { probe } = makeFakeProbe(
      "java.exe -Dlampas.launcher.session=ffffffffffffffffffffffffffffffff -cp x",
    );
    GameRunner._processProbe = probe;
    try {
      const adopted = await GameRunner.adoptRunningGame(() => {});

      expect(adopted).toBeNull();
      expect(GameRunner.isGameRunning()).toBe(false);
      expect(fs.existsSync(sessionFile)).toBe(false);
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("does not adopt a dead process", async () => {
    writeSessionRecord(4242, sessionId);
    const { state, probe } = makeFakeProbe(`java.exe ${marker}`);
    state.alive = false;
    GameRunner._processProbe = probe;
    try {
      const adopted = await GameRunner.adoptRunningGame(() => {});

      expect(adopted).toBeNull();
      expect(GameRunner.isGameRunning()).toBe(false);
      expect(fs.existsSync(sessionFile)).toBe(false);
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("a failing probe is not adoptable, leaks nothing, and keeps the record for a later start", async () => {
    writeSessionRecord(4242, sessionId);
    const probe: ProcessProbe = {
      isAlive: () => true,
      readCommandLine: async () => {
        throw new Error("java.exe --accessToken super-secret-token");
      },
      terminate: () => {},
    };
    GameRunner._processProbe = probe;
    GameRunner._adoptionAttempts = 2;
    GameRunner._adoptionRetryMs = 10;
    try {
      const adopted = await GameRunner.adoptRunningGame(() => {});

      expect(adopted).toBeNull();
      expect(GameRunner.isGameRunning()).toBe(false);
      // The process is alive but unverified, so the record must survive for
      // the next launcher start to try again.
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("an unreadable command line is retried, then gives up and keeps the record", async () => {
    writeSessionRecord(4242, sessionId);
    let reads = 0;
    const probe: ProcessProbe = {
      isAlive: () => true,
      readCommandLine: async () => {
        reads++;
        return null;
      },
      terminate: () => {},
    };
    GameRunner._processProbe = probe;
    GameRunner._adoptionAttempts = 3;
    GameRunner._adoptionRetryMs = 10;
    try {
      expect(await GameRunner.adoptRunningGame(() => {})).toBeNull();
      expect(reads).toBe(3);
      expect(GameRunner.isGameRunning()).toBe(false);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("adopts once a previously unreadable command line can be read", async () => {
    writeSessionRecord(4242, sessionId);
    let reads = 0;
    const probe: ProcessProbe = {
      isAlive: () => true,
      readCommandLine: async () =>
        ++reads === 1 ? null : `java.exe ${marker}`,
      terminate: () => {},
    };
    GameRunner._processProbe = probe;
    GameRunner._adoptionAttempts = 3;
    GameRunner._adoptionRetryMs = 10;
    try {
      expect(await GameRunner.adoptRunningGame(() => {})).toEqual({
        pid: 4242,
      });
      expect(reads).toBe(2);
      expect(GameRunner.isGameRunning()).toBe(true);
      expect(GameRunner.getAdoptedPid()).toBe(4242);
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("reports the game as running and refuses to launch while adoption is pending", async () => {
    writeSessionRecord(4242, sessionId);
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const probe: ProcessProbe = {
      isAlive: () => true,
      readCommandLine: () => gate,
      terminate: () => {},
    };
    GameRunner._processProbe = probe;
    try {
      const adoption = GameRunner.adoptRunningGame(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(GameRunner.isAdoptionPending()).toBe(true);
      expect(GameRunner.isGameRunning()).toBe(true);
      await expect(
        GameRunner.launchGame(
          mockSessionUser,
          () => {},
          () => {},
        ),
      ).rejects.toThrow(/previous launcher session/);
      expect(fs.existsSync(sessionFile)).toBe(true);

      release(`java.exe ${marker}`);
      expect(await adoption).toEqual({ pid: 4242 });
      expect(GameRunner.isAdoptionPending()).toBe(false);
      expect(GameRunner.getAdoptedPid()).toBe(4242);
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("returns null when there is no session record", async () => {
    const { probe } = makeFakeProbe(`java.exe ${marker}`);
    GameRunner._processProbe = probe;
    try {
      expect(await GameRunner.adoptRunningGame(() => {})).toBeNull();
      expect(GameRunner.isGameRunning()).toBe(false);
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("killGame on an adopted game sends SIGTERM and resolves once the process is gone", async () => {
    writeSessionRecord(4242, sessionId);
    const { state, probe } = makeFakeProbe(`java.exe ${marker}`);
    state.terminateDelayMs = 150;
    GameRunner._processProbe = probe;
    GameRunner._adoptedPollMs = 20;

    let onExitCalled!: () => void;
    const exited = new Promise<void>((resolve) => {
      onExitCalled = resolve;
    });

    try {
      await GameRunner.adoptRunningGame(() => onExitCalled());

      const start = performance.now();
      await GameRunner.killGame();
      const elapsed = performance.now() - start;

      expect(state.terminated).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
      expect(state.alive).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(100);

      await exited;
      expect(GameRunner.isGameRunning()).toBe(false);
      expect(fs.existsSync(sessionFile)).toBe(false);
    } finally {
      GameRunner.resetForTesting();
    }
  });

  test("releaseForShutdown stops watching an adopted game and keeps its session record", async () => {
    writeSessionRecord(4242, sessionId);
    const { state, probe } = makeFakeProbe(`java.exe ${marker}`);
    GameRunner._processProbe = probe;
    GameRunner._adoptedPollMs = 20;
    let exitCalls = 0;
    try {
      await GameRunner.adoptRunningGame(() => {
        exitCalls++;
      });

      GameRunner.releaseForShutdown();
      state.alive = false;
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(exitCalls).toBe(0);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      GameRunner.resetForTesting();
    }
  });
});

describe("buildLaunchArguments session marker", () => {
  const baseOptions = {
    gameDir: path.join(testRoot, "marker-game"),
    ramGb: 4,
    runtime: { minecraft: "26.2" },
    assetIndex: "26.2",
    username: "TestPlayer",
    uuid: "11111111222233334444555555555555",
    token: "0",
    userType: "legacy",
    customJavaArgs: ["-Dcustom.arg=1"],
    mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
    classpathString: "a.jar",
  };

  test("omits the marker when no sessionId is given", () => {
    const args = buildLaunchArguments(baseOptions);

    expect(
      args.some((arg) => arg.startsWith("-Dlampas.launcher.session")),
    ).toBe(false);
  });

  test("inserts only the marker, right after the target directory, when a sessionId is given", () => {
    const withoutMarker = buildLaunchArguments(baseOptions);
    const withMarker = buildLaunchArguments({
      ...baseOptions,
      sessionId: "0123456789abcdef0123456789abcdef",
    });

    const targetIndex = withoutMarker.findIndex((arg) =>
      arg.startsWith("-Dminecraft.applet.TargetDirectory="),
    );
    const expected = [...withoutMarker];
    expected.splice(
      targetIndex + 1,
      0,
      "-Dlampas.launcher.session=0123456789abcdef0123456789abcdef",
    );
    expect(withMarker).toEqual(expected);
  });
});
