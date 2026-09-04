import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sync-contract-test-"));
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
  // Clear gameDir
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

describe("LauncherSync contract & runtime cross-validation (PLAN.md Part C & L)", () => {
  test("release == manifest -> succeeds and returns validated runtime definition", async () => {
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
      expect(result.version).toBe("2.0.0");
      expect(result.runtime).toEqual({
        minecraft: "26.2",
        loader: {
          type: "fabric",
          version: "0.19.3",
        },
      });

      // Assert state file recorded
      const stateFile = path.join(gameDir, ".lampas", "installation.json");
      expect(fs.existsSync(stateFile)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("sentinel non-default Loader (0.99.123-test) -> succeeds and returns exact runtime", async () => {
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
            loader: { type: "fabric", version: "0.99.123-test" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.99.123-test" },
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
      expect(result.runtime.loader.version).toBe("0.99.123-test");
    } finally {
      server.stop(true);
    }
  });

  test("Loader mismatch -> rejects before any pack mutation", async () => {
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
            loader: { type: "fabric", version: "0.19.4" },
            files: [],
            mods: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        "Invalid Lampas release: release descriptor requires Fabric 0.19.3, client manifest requires Fabric 0.19.4."
      );

      // Verify no installation state was written
      const stateFile = path.join(gameDir, ".lampas", "installation.json");
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("Minecraft mismatch -> rejects before any pack mutation", async () => {
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
            minecraft: "26.3",
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
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        "Invalid Lampas release: release descriptor requires Minecraft 26.2, client manifest requires Minecraft 26.3."
      );

      const stateFile = path.join(gameDir, ".lampas", "installation.json");
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("unsupported Loader type (neoforge) -> rejects before any file mutation", async () => {
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
            loader: { type: "neoforge", version: "20.4.0" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "neoforge", version: "20.4.0" },
            files: [],
            mods: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /unsupported loader type 'neoforge'. Only 'fabric' is supported/
      );

      const stateFile = path.join(gameDir, ".lampas", "installation.json");
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("missing Loader version -> rejects before any file mutation", async () => {
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
            loader: { type: "fabric" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.0.0",
            minecraft: "26.2",
            loader: { type: "fabric" },
            files: [],
            mods: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    ConfigManager.set({ portalUrl: `http://127.0.0.1:${server.port}` });

    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /missing or empty loader 'version'/
      );

      const stateFile = path.join(gameDir, ".lampas", "installation.json");
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("missing Minecraft version -> rejects before any file mutation", async () => {
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
            loader: { type: "fabric", version: "0.19.3" },
          });
        }
        if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
          return Response.json({
            pack: "Lampas 2",
            version: "2.0.0",
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
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /missing or empty 'minecraft' version/
      );

      const stateFile = path.join(gameDir, ".lampas", "installation.json");
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
