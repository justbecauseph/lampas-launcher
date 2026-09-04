import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sync-patches-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "1.1.0",
  },
  shell: { openPath: async () => "" },
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

describe("LauncherSync config patches and protocol integration", () => {
  test("rejects manifests or releases requiring unsupported newer protocol", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({ channel: "stable", version: "3.0.0" });
        }
        if (url.pathname === "/api/v1/releases/3.0.0") {
          return Response.json({
            pack: "Lampas 2",
            version: "3.0.0",
            protocol: 4,
          });
        }
        if (url.pathname === "/api/v1/releases/3.0.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "3.0.0",
            protocol: 4,
            files: [],
            mods: [],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: "http://127.0.0.1:" + server.port });

    await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
      /Unsupported modpack protocol: release requires protocol 4, but this launcher only supports up to protocol 3/
    );

    server.stop(true);
  });

  test("rejects releases requiring a newer launcher version", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({ channel: "stable", version: "2.1.0" });
        }
        if (url.pathname === "/api/v1/releases/2.1.0") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.1.0",
            protocol: 3,
            minimumLauncherVersion: "99.0.0",
          });
        }
        if (url.pathname === "/api/v1/releases/2.1.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.1.0",
            protocol: 3,
            files: [],
            mods: [],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: "http://127.0.0.1:" + server.port });

    await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
      /Launcher update required: release requires launcher version 99.0.0 or newer/
    );

    server.stop(true);
  });

  test("end-to-end sync with enforce patch: preserves user settings and restores enforced setting", async () => {
    const configPath = path.join(gameDir, "config/chatting.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    const initialConfig = "// My custom chatting settings\n" + JSON.stringify({
      volume: 0.42,
      chatTabs: true,
      hypixelOnlyChatTabs: true,
      customFavoriteChannel: "#general"
    }, null, 2) + "\n";
    fs.writeFileSync(configPath, initialConfig, "utf-8");

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({ channel: "stable", version: "2.1.0" });
        }
        if (url.pathname === "/api/v1/releases/2.1.0") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.1.0",
            protocol: 3,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.1.0/client-manifest") {
          return Response.json({
            schemaVersion: 2,
            pack: "Lampas 2",
            version: "2.1.0",
            protocol: 3,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            files: [],
            mods: [],
            configPatches: [
              {
                id: "chatting-global-chat-tabs",
                revision: 1,
                path: "config/chatting.json",
                adapter: "json",
                mode: "enforce",
                missingFile: "defer",
                operations: [
                  { op: "set", path: ["hypixelOnlyChatTabs"], value: false },
                ],
              },
            ],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: "http://127.0.0.1:" + server.port });

    // 1. Sync
    const syncRes = await LauncherSync.syncClient(() => {});
    expect(syncRes.success).toBe(true);

    const afterSync1 = fs.readFileSync(configPath, "utf-8");
    expect(afterSync1).toContain('"hypixelOnlyChatTabs": false');
    expect(afterSync1).toContain('"volume": 0.42');
    expect(afterSync1).toContain('"customFavoriteChannel": "#general"');
    expect(afterSync1).toContain("// My custom chatting settings");

    const stateFile = path.join(gameDir, ".lampas/installation.json");
    expect(fs.existsSync(stateFile)).toBe(true);

    // 2. User edits unrelated setting to 0.69
    const userModified = afterSync1.replace('"volume": 0.42', '"volume": 0.69');
    fs.writeFileSync(configPath, userModified, "utf-8");

    // Next sync: user value preserved
    await LauncherSync.syncClient(() => {});
    const afterSync2 = fs.readFileSync(configPath, "utf-8");
    expect(afterSync2).toContain('"volume": 0.69');
    expect(afterSync2).toContain('"hypixelOnlyChatTabs": false');

    // 3. User reverts hypixelOnlyChatTabs to true
    const userReverted = afterSync2.replace('"hypixelOnlyChatTabs": false', '"hypixelOnlyChatTabs": true');
    fs.writeFileSync(configPath, userReverted, "utf-8");

    // Next sync: restores false
    await LauncherSync.syncClient(() => {});
    const afterSync3 = fs.readFileSync(configPath, "utf-8");
    expect(afterSync3).toContain('"hypixelOnlyChatTabs": false');
    expect(afterSync3).toContain('"volume": 0.69');

    server.stop(true);
  });

  test("once mode: applies once, ignores player edits, re-applies on revision bump", async () => {
    const configPath = path.join(gameDir, "config/initial.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"recommendation": "default"}\n', "utf-8");

    let currentRevision = 1;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({ channel: "stable", version: "2.1.0" });
        }
        if (url.pathname === "/api/v1/releases/2.1.0") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.1.0",
            protocol: 3,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.1.0/client-manifest") {
          return Response.json({
            schemaVersion: 2,
            pack: "Lampas 2",
            version: "2.1.0",
            protocol: 3,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            files: [],
            mods: [],
            configPatches: [
              {
                id: "initial-recommendation",
                revision: currentRevision,
                path: "config/initial.json",
                adapter: "json",
                mode: "once",
                missingFile: "defer",
                operations: [
                  { op: "set", path: ["recommendation"], value: "recommended_v" + currentRevision },
                ],
              },
            ],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: "http://127.0.0.1:" + server.port });

    // Sync rev 1
    await LauncherSync.syncClient(() => {});
    expect(fs.readFileSync(configPath, "utf-8")).toContain('"recommended_v1"');

    // User changes recommendation
    fs.writeFileSync(configPath, '{"recommendation": "my_custom_choice"}\n', "utf-8");

    // Sync rev 1 again: user change MUST remain untouched
    await LauncherSync.syncClient(() => {});
    expect(fs.readFileSync(configPath, "utf-8")).toContain('"my_custom_choice"');

    // Server bumps to rev 2
    currentRevision = 2;
    await LauncherSync.syncClient(() => {});
    // Now rev 2 applies once
    expect(fs.readFileSync(configPath, "utf-8")).toContain('"recommended_v2"');

    server.stop(true);
  });

  test("missingFile=defer: missing target does not fail sync, does not create, applies once target exists", async () => {
    const configPath = path.join(gameDir, "config/late-mod.json");
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable") {
          return Response.json({ channel: "stable", version: "2.1.0" });
        }
        if (url.pathname === "/api/v1/releases/2.1.0") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.1.0",
            protocol: 3,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.1.0/client-manifest") {
          return Response.json({
            schemaVersion: 2,
            pack: "Lampas 2",
            version: "2.1.0",
            protocol: 3,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            files: [],
            mods: [],
            configPatches: [
              {
                id: "late-mod-patch",
                revision: 1,
                path: "config/late-mod.json",
                adapter: "json",
                mode: "once",
                missingFile: "defer",
                operations: [{ op: "set", path: ["enabled"], value: true }],
              },
            ],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: "http://127.0.0.1:" + server.port });

    // Sync when file does not exist
    const res1 = await LauncherSync.syncClient(() => {});
    expect(res1.success).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false);

    const stateFile = path.join(gameDir, ".lampas/installation.json");
    const state1 = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(state1.appliedConfigPatches?.["late-mod-patch"]).toBeUndefined();

    // Now mod generates file
    fs.writeFileSync(configPath, '{"enabled": false}\n', "utf-8");

    // Next sync: deferred patch applies
    await LauncherSync.syncClient(() => {});
    expect(fs.readFileSync(configPath, "utf-8")).toContain('"enabled": true');

    const state2 = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(state2.appliedConfigPatches?.["late-mod-patch"]?.revision).toBe(1);

    server.stop(true);
  });
});
