import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-repair-test-"));
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

let bootstrapCalls: Array<{
  gameDir: string;
  runtime: any;
  verificationMode?: string;
}> = [];

mock.module("../src/minecraft-bootstrap", () => ({
  MinecraftBootstrap: {
    prepareGameEnvironment: async (
      targetDir: string,
      runtime: any,
      _onLog: any,
      verificationMode?: string
    ) => {
      bootstrapCalls.push({ gameDir: targetDir, runtime, verificationMode });
      return {
        classpath: ["C:\\Game\\libraries\\fabric.jar"],
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        assetIndex: "26.2",
      };
    },
  },
}));

let javaCalls: Array<{ gameDir: string; mode?: string }> = [];

mock.module("../src/java-runtime", () => ({
  JavaRuntimeManager: {
    ensureJava25: async (targetDir: string, _onLog: any, mode?: string) => {
      javaCalls.push({ gameDir: targetDir, mode });
      return "C:\\Java25\\bin\\java.exe";
    },
  },
}));

const { LauncherLogger } = await import("../src/logger");
const { ConfigManager } = await import("../src/config");
const { LauncherSync } = await import("../src/sync");

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
  LauncherLogger.resetForTesting();
  LauncherLogger.init();
  ConfigManager.resetForTesting();
  bootstrapCalls = [];
  javaCalls = [];
  ConfigManager.set({
    token: "mock-token",
    portalUrl: "http://localhost:3000",
    selectedChannel: "stable",
    gameDir,
    customClientMods: [],
    disabledClientMods: [],
  });
  if (fs.existsSync(gameDir)) {
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.mkdirSync(gameDir, { recursive: true });
  }
});

afterAll(() => {
  LauncherLogger.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("LauncherSync.repairInstallation runtime forwarding (PLAN.md Part E & Section 47)", () => {
  test("Repair forwards the exact runtime (0.99.123-test) returned by Sync and does not inject 0.19.3", async () => {
    const sentinelVersion = "0.99.123-test";
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
            loader: { type: "fabric", version: sentinelVersion },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: sentinelVersion },
            files: [],
            mods: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    try {
      const result = await LauncherSync.repairInstallation(() => {});
      expect(result.success).toBe(true);

      // Verify prepareGameEnvironment was called with full verification
      expect(bootstrapCalls.length).toBe(1);
      expect(bootstrapCalls[0].verificationMode).toBe("full");

      // Verify exact runtime passed
      expect(bootstrapCalls[0].runtime).toEqual({
        minecraft: "26.2",
        loader: {
          type: "fabric",
          version: sentinelVersion,
        },
      });

      // Explicitly assert it did NOT inject 0.19.3
      expect(bootstrapCalls[0].runtime.loader.version).not.toBe("0.19.3");

      // Verify JavaRuntimeManager was also called in full mode
      expect(javaCalls.length).toBe(1);
      expect(javaCalls[0].mode).toBe("full");
    } finally {
      server.stop(true);
    }
  });
});
