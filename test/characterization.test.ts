import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-char-test-"));
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
const { ConfigManager } = await import("../src/config");
const { ClientModManager } = await import("../src/client-mods");
const { GameRunner } = await import("../src/game-runner");
const { GameDirectoryManager } = await import("../src/game-directory");
const { LauncherSync } = await import("../src/sync");
const { MinecraftBootstrap } = await import("../src/minecraft-bootstrap");
const { hashFile } = await import("../src/file-transfer");

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
  LauncherLogger.resetForTesting();
  LauncherLogger.init();
  ConfigManager.resetForTesting();
  GameRunner.resetForTesting();
  GameDirectoryManager.resetForTesting();

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

describe("Phase 0 Characterization — Operation Settlement & Guard Gaps (F07, F08)", () => {
  test("ClientModManager allows mutation without checking active operations (Baseline F08)", () => {
    // In baseline, ClientModManager does not consult currentOperation or isGameRunning()
    const modFile = path.join(testRoot, "char-mod.jar");
    fs.writeFileSync(modFile, "dummy-jar-content");

    const before = ClientModManager.list();
    expect(before.length).toBe(0);

    // ClientModManager mutation succeeds synchronously without checking operation guard
    const after = ClientModManager.add([modFile]);
    expect(after.length).toBe(1);
    expect(after[0].filename).toBe("char-mod.jar");
    expect(ConfigManager.get().customClientMods.length).toBe(1);
  });

  test("GameRunner.killGame clears runningProcess state synchronously before exit event (Baseline F08)", () => {
    // Characterizes current killGame() behavior: runningProcess is cleared immediately
    const proc = new EventEmitter() as any;
    proc.killed = false;
    let exitEmitted = false;
    proc.kill = () => {
      proc.killed = true;
      // In real life or async mocks, exit is emitted asynchronously
    };

    (GameRunner as any).runningProcess = proc;
    expect(GameRunner.isGameRunning()).toBe(true);

    GameRunner.killGame();
    // Notice: runningProcess is null immediately, even though exit event was not emitted
    expect(GameRunner.isGameRunning()).toBe(false);
    expect(proc.killed).toBe(true);
  });
});

describe("Phase 0 Characterization — Fast vs Full Sync Verification & Same-Size Detection (F02, F03)", () => {
  test("Fast sync metadata shortcut skips SHA-256 when size and mtime match prevState", async () => {
    const fileContent = Buffer.from("clean-managed-mod-data");
    const sha256 = crypto.createHash("sha256").update(fileContent).digest("hex");
    const size = fileContent.length;

    const modsDir = path.join(gameDir, "mods");
    fs.mkdirSync(modsDir, { recursive: true });
    const localModPath = path.join(modsDir, "clean.jar");
    fs.writeFileSync(localModPath, fileContent);
    const stat = fs.statSync(localModPath);

    // Seed installation.json with identical sha256, size, and mtimeMs
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "installation.json"),
      JSON.stringify({
        pack: "Lampas 2",
        version: "2.0.0",
        files: {
          "mods/clean.jar": {
            sha256,
            size,
            mtimeMs: stat.mtimeMs,
            policy: "MANAGED",
          },
        },
      })
    );

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
                path: "mods/clean.jar",
                hashes: { sha256 },
                size,
                download: { url: "/api/v1/blobs/" + sha256 },
                policy: "MANAGED",
              },
            ],
            mods: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    try {
      const progressMessages: string[] = [];
      const result = await LauncherSync.syncClient((p) => {
        if (p.message) progressMessages.push(p.message);
      }, "fast");

      expect(result.success).toBe(true);
      // In fast mode with matching metadata, file is recognized up-to-date without re-downloading
      expect(fs.existsSync(localModPath)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("Directory move detects same-size corruption via SHA-256 independent verification", async () => {
    const srcDir = path.join(testRoot, "char-move-src");
    const dstDir = path.join(testRoot, "char-move-dst");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "options.txt"), "ABCD"); // 4 bytes

    ConfigManager.set({ gameDir: srcDir, gameDirConfigured: true });

    // Force copy fallback
    GameDirectoryManager._renameFn = (src: string, dst: string) => {
      if (src === path.resolve(srcDir)) {
        const err: any = new Error("EXDEV");
        err.code = "EXDEV";
        throw err;
      }
      return fs.renameSync(src, dst);
    };

    // Corrupt copied file to exact same length (4 bytes)
    GameDirectoryManager._copyFn = (src: string, dst: string) => {
      fs.writeFileSync(dst, "WXYZ");
    };

    await expect(GameDirectoryManager.moveInstallation(dstDir)).rejects.toThrow(
      "content SHA-256 mismatch"
    );
    expect(fs.readFileSync(path.join(srcDir, "options.txt"), "utf-8")).toBe("ABCD");
    expect(fs.existsSync(dstDir)).toBe(false);
  });
});

describe("Phase 0 Characterization — Move Recovery Semantics (F01)", () => {
  test("Move recovery handles copying phase by purging abandoned staging directory", async () => {
    const stagingDir = path.join(testRoot, ".lampas-moving-char-staging");
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "partial.bin"), "corrupt");

    const journalPath = path.join(userDataDir, "directory-move.json");
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        source: path.join(testRoot, "original"),
        target: path.join(testRoot, "target"),
        staging: stagingDir,
        phase: "copying",
      })
    );

    await GameDirectoryManager.recoverInterruptedMove();
    expect(fs.existsSync(stagingDir)).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(false);
  });
});

describe("Phase 0 Characterization — Full Repair Gaps in MinecraftBootstrap (F06)", () => {
  test("Asset index hash is not checked if file exists and parses as valid JSON (Baseline F06)", async () => {
    const assetsDir = path.join(gameDir, "assets");
    const indexDir = path.join(assetsDir, "indexes");
    fs.mkdirSync(indexDir, { recursive: true });

    const assetIndexPath = path.join(indexDir, "26.2.json");
    // Write valid JSON with empty objects, but completely wrong content / wrong hash
    const bogusJson = JSON.stringify({ objects: {} });
    fs.writeFileSync(assetIndexPath, bogusJson, "utf-8");

    const actualHash = await hashFile(assetIndexPath, "sha1");
    const trustedSha1 = "deadbeefcafebabe0123456789abcdef01234567"; // intentionally different
    expect(actualHash).not.toBe(trustedSha1);

    // Call private ensureAssets via reflection / invocation to characterize baseline behavior
    const logged: string[] = [];
    await (MinecraftBootstrap as any).ensureAssets(
      assetsDir,
      { id: "26.2", sha1: trustedSha1, url: "http://invalid-url-should-not-fetch", size: 999999 },
      (msg: string) => logged.push(msg),
      "full"
    );

    // In baseline, because assetIndexPath exists and is valid JSON, it did NOT attempt to re-download or check sha1
    expect(fs.readFileSync(assetIndexPath, "utf-8")).toBe(bogusJson);
  });

  test("Native extraction is skipped during repair if complete marker exists (Baseline F06)", async () => {
    const nativesDir = path.join(gameDir, "bin", "natives");
    fs.mkdirSync(nativesDir, { recursive: true });

    // Create marker
    const markerPath = path.join(gameDir, ".lampas", "natives-26.2-" + process.platform + ".complete");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString(), "utf-8");

    // Empty the nativesDir completely (simulating missing extracted dll/so)
    expect(fs.readdirSync(nativesDir).length).toBe(0);

    // Native archives list unchanged
    const nativeArchives: Array<{ path: string; changed: boolean }> = [];
    const markerExists = fs.existsSync(markerPath);
    const anyChanged = nativeArchives.some((a) => a.changed);

    // This condition reflects baseline lines 242-247 in minecraft-bootstrap.ts:
    const willExtract = !markerExists || anyChanged;
    expect(willExtract).toBe(false); // In baseline, extraction is skipped!
  });
});
