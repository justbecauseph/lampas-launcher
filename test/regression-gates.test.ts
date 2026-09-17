import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * REGRESSION GATES (Phases 1-7)
 * 
 * These tests define the TARGET invariants required by PLAN.md.
 * In Phase 0 (Baseline), these tests fail because the underlying defects (F06, F08)
 * are still present in the baseline codebase.
 * 
 * They are marked `test.skip` by default so the Phase 0 baseline test run remains green.
 * As each phase is implemented (e.g. Phase 1 for operation guard, Phase 3 for full repair),
 * the corresponding tests here will be unskipped and become required passing gates.
 */

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-gate-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
}));

const { LauncherLogger } = await import("../src/logger");
const { ConfigManager, PortalPolicy } = await import("../src/config");
const { ClientModManager } = await import("../src/client-mods");
const { GameRunner } = await import("../src/game-runner");
const { MinecraftBootstrap } = await import("../src/minecraft-bootstrap");

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
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

afterEach(() => {
  GameRunner.resetForTesting();
});

afterAll(() => {
  PortalPolicy.resetForTesting();
  GameRunner.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Phase 1 Regression Gate — Guarded Mod Mutators (F08)", () => {
  test("[Phase 1 Gate] ClientModManager.add rejects mutations when an installation operation or game is running", () => {
    // When Phase 1 centralizes operation guard:
    // Any mutation attempt during an active operation must throw or be rejected.
    const modFile = path.join(testRoot, "unauthorized-mod.jar");
    fs.writeFileSync(modFile, "dummy-jar");

    // Simulating active operation or running game
    (GameRunner as any).runningProcess = { killed: false } as any;

    expect(() => {
      ClientModManager.add([modFile]);
    }).toThrow(/Cannot modify client mods while an operation or Minecraft is running/);
  });

  test("[Phase 1 Gate] GameRunner.killGame retains runningProcess until actual exit settlement", () => {
    // When Phase 1 fixes process lifecycle:
    // isGameRunning() must stay true until child process emits exit
    const fakeProc: any = {
      killed: false,
      kill: () => { fakeProc.killed = true; },
    };
    (GameRunner as any).runningProcess = fakeProc;

    GameRunner.killGame();
    // In Phase 1, process state must not be immediately cleared before actual exit
    expect(GameRunner.isGameRunning()).toBe(true);
  });
});

describe("Phase 3 Regression Gate — Full Repair Asset & Native Invariants (F06)", () => {
  test("[Phase 3 Gate] Full repair replaces existing asset index if its SHA-1 hash is corrupt", async () => {
    const assetsDir = path.join(gameDir, "assets");
    const indexDir = path.join(assetsDir, "indexes");
    fs.mkdirSync(indexDir, { recursive: true });

    const assetIndexPath = path.join(indexDir, "26.2.json");
    fs.writeFileSync(assetIndexPath, JSON.stringify({ objects: {} })); // corrupt hash

    // Pre-create the asset object with matching SHA-1 and size so full repair verifies it without downloading
    const assetContent = Buffer.from("test-asset-data");
    const assetHash = require("node:crypto").createHash("sha1").update(assetContent).digest("hex");
    const objPath = path.join(assetsDir, "objects", assetHash.substring(0, 2), assetHash);
    fs.mkdirSync(path.dirname(objPath), { recursive: true });
    fs.writeFileSync(objPath, assetContent);

    const responseBody = JSON.stringify({ objects: { "test.png": { hash: assetHash, size: assetContent.length } } });
    const correctSha1 = require("node:crypto").createHash("sha1").update(responseBody).digest("hex");

    let redownloaded = false;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        redownloaded = true;
        return new Response(responseBody, { headers: { "Content-Type": "application/json" } });
      },
    });

    try {
      await (MinecraftBootstrap as any).ensureAssets(
        assetsDir,
        {
          id: "26.2",
          sha1: correctSha1,
          url: `http://127.0.0.1:${server.port}/index.json`,
          size: Buffer.byteLength(responseBody),
        },
        () => {},
        "full"
      );
      expect(redownloaded).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("[Phase 3 Gate] Full repair re-extracts missing natives even if native marker file exists", async () => {
    const nativesDir = path.join(gameDir, "natives");
    fs.mkdirSync(nativesDir, { recursive: true });

    const markerPath = path.join(gameDir, ".lampas", "natives-26.2-" + process.platform + ".complete");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString(), "utf-8");

    // Create a mock native jar with a native dll
    const { zipSync } = await import("fflate");
    const mockNativeJar = path.join(testRoot, "mock-native.jar");
    const nativeBytes = zipSync({
      "lwjgl.dll": new Uint8Array(Buffer.from("mock native binary")),
    });
    fs.writeFileSync(mockNativeJar, Buffer.from(nativeBytes));

    // Full repair must inspect native directory contents or re-extract
    // rather than skipping because of the marker.
    await (MinecraftBootstrap as any).ensureNatives(
      gameDir,
      "26.2",
      [{ path: mockNativeJar, changed: false }],
      () => {},
      "full"
    );

    expect(fs.readdirSync(nativesDir).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(nativesDir, "lwjgl.dll"))).toBe(true);
  });
});
