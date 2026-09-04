import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-client-sync-test-"));
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

describe("LauncherSync client sync integration", () => {
  test("replaces managed resource pack on hash change with same filename", async () => {
    const v1Content = Buffer.from("v1-resourcepack-content");
    const v1Sha = crypto.createHash("sha256").update(v1Content).digest("hex");

    const v2Content = Buffer.from("v2-updated-resourcepack-content");
    const v2Sha = crypto.createHash("sha256").update(v2Content).digest("hex");
    const v2Size = v2Content.length;

    // Seed disk with v1 content
    const rpDir = path.join(gameDir, "resourcepacks");
    fs.mkdirSync(rpDir, { recursive: true });
    const packFile = path.join(rpDir, "fa-player-extension.jar");
    fs.writeFileSync(packFile, v1Content);

    // Seed options.txt with user pack + managed pack
    const optionsPath = path.join(gameDir, "options.txt");
    fs.writeFileSync(
      optionsPath,
      'resourcePacks:["vanilla","file/UserTheme.zip","file/fa-player-extension.jar"]\n',
      "utf-8"
    );

    // Mock Portal serving v2 release & manifest
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
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            launch: {
              requiredResourcePacks: [
                {
                  id: "fa-player-extension",
                  filename: "fa-player-extension.jar",
                  path: "resourcepacks/fa-player-extension.jar",
                  sha256: v2Sha,
                },
              ],
            },
          });
        }
        if (url.pathname === "/api/v1/releases/2.1.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.1.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            files: [
              {
                path: "resourcepacks/fa-player-extension.jar",
                hashes: { sha256: v2Sha },
                size: v2Size,
                download: { url: `/api/v1/blobs/${v2Sha}` },
                policy: "MANAGED",
              },
            ],
            mods: [],
          });
        }
        if (url.pathname === `/api/v1/blobs/${v2Sha}`) {
          return new Response(v2Content, {
            headers: { "Content-Type": "application/java-archive", "Content-Length": v2Size.toString() },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(result.version).toBe("2.1.0");

      // Verify file content on disk was replaced with v2
      const diskContent = fs.readFileSync(packFile);
      expect(diskContent.equals(v2Content)).toBe(true);
      expect(crypto.createHash("sha256").update(diskContent).digest("hex")).toBe(v2Sha);

      // Verify options.txt preserved user pack and has managed pack enabled
      const updatedOptions = fs.readFileSync(optionsPath, "utf-8");
      expect(updatedOptions).toContain('resourcePacks:["vanilla","file/UserTheme.zip","file/fa-player-extension.jar"]');

      // Verify installation state has v2 hash
      const installState = JSON.parse(
        fs.readFileSync(path.join(gameDir, ".lampas", "installation.json"), "utf-8")
      );
      expect(installState.files["resourcepacks/fa-player-extension.jar"].sha256).toBe(v2Sha);
    } finally {
      server.stop(true);
    }
  });

  test("preserves unmanifested user resource packs on disk and in options.txt", async () => {
    const userPackFile = path.join(gameDir, "resourcepacks", "CustomUserPack.zip");
    fs.mkdirSync(path.dirname(userPackFile), { recursive: true });
    fs.writeFileSync(userPackFile, "custom user pack data");

    const optionsPath = path.join(gameDir, "options.txt");
    fs.writeFileSync(
      optionsPath,
      'resourcePacks:["vanilla","file/CustomUserPack.zip"]\n',
      "utf-8"
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

    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);

      // Verify user pack file still exists on disk
      expect(fs.existsSync(userPackFile)).toBe(true);

      // Verify user pack remains enabled in options.txt
      const optionsContent = fs.readFileSync(optionsPath, "utf-8");
      expect(optionsContent).toContain('resourcePacks:["vanilla","file/CustomUserPack.zip"]');
    } finally {
      server.stop(true);
    }
  });

  test("does not update installation state if download fails (state poisoning prevention)", async () => {
    const stateFile = path.join(gameDir, ".lampas", "installation.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const initialInstallation = {
      pack: "Lampas 2",
      version: "1.0.0",
      installedAt: "2026-01-01T00:00:00Z",
      files: {},
      managedResourcePacks: [],
    };
    fs.writeFileSync(stateFile, JSON.stringify(initialInstallation, null, 2), "utf-8");

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
                path: "mods/failing-mod.jar",
                hashes: { sha256: "c".repeat(64) },
                size: 500,
                download: { url: "/api/v1/blobs/corrupted" },
                policy: "MANAGED",
              },
            ],
            mods: [],
          });
        }
        if (url.pathname === "/api/v1/blobs/corrupted") {
          return new Response("Internal Error", { status: 500 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow();

      // Verify installation.json was NOT updated to 2.0.0
      const currentInstallation = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(currentInstallation.version).toBe("1.0.0");
    } finally {
      server.stop(true);
    }
  });

  test("fails client sync and leaves installation state untouched when required pack integrity fails", async () => {
    const stateFile = path.join(gameDir, ".lampas", "installation.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const initialInstallation = {
      pack: "Lampas 2",
      version: "1.0.0",
      installedAt: "2026-01-01T00:00:00Z",
      files: {},
      managedResourcePacks: [],
    };
    fs.writeFileSync(stateFile, JSON.stringify(initialInstallation, null, 2), "utf-8");

    // Required pack declares sha256 of "aaa..." but downloaded file has "bbb..."
    const packContent = Buffer.from("pack-content-bbb");
    const packSha = crypto.createHash("sha256").update(packContent).digest("hex");

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
            launch: {
              requiredResourcePacks: [
                {
                  id: "corrupted-required-pack",
                  filename: "corrupted.zip",
                  path: "resourcepacks/corrupted.zip",
                  // Mismatched expected hash
                  sha256: "a".repeat(64),
                },
              ],
            },
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
                path: "resourcepacks/corrupted.zip",
                hashes: { sha256: packSha },
                size: packContent.length,
                download: { url: `/api/v1/blobs/${packSha}` },
                policy: "MANAGED",
              },
            ],
            mods: [],
          });
        }
        if (url.pathname === `/api/v1/blobs/${packSha}`) {
          return new Response(packContent);
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(/failed integrity verification/);

      // State remains previous version
      const currentInstallation = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(currentInstallation.version).toBe("1.0.0");
    } finally {
      server.stop(true);
    }
  });

  test("rejects manifests containing path traversal entries", async () => {
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
                path: "../../malicious.txt",
                hashes: { sha256: "d".repeat(64) },
                size: 10,
                download: { url: "/api/v1/blobs/malicious" },
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
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /Unsafe relative path in manifest/
      );
    } finally {
      server.stop(true);
    }
  });
});
