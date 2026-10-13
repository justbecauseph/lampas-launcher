import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-mod-catalog-cache-test-"),
);
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

const { ConfigManager, PortalPolicy } = await import("../src/config");
const { LauncherSync } = await import("../src/sync");
const { createModIconResolver } = await import("../src/cosmetic-images");

let requests = 0;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    requests++;
    if (url.pathname === "/api/v1/channels/stable") {
      return Response.json({
        channel: "stable",
        version: "3.0.0",
        release: "/api/v1/releases/3.0.0",
      });
    }
    if (url.pathname === "/api/v1/releases/3.0.0") {
      return Response.json({
        schemaVersion: 1,
        pack: "Lampas 2",
        version: "3.0.0",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        minimumLauncherVersion: "1.0.0",
        protocol: 3,
        created: "2026-01-01T00:00:00Z",
        clientManifest: "/api/v1/releases/3.0.0/client-manifest",
        serverManifest: "/api/v1/releases/3.0.0/server-manifest",
      });
    }
    if (url.pathname === "/api/v1/releases/3.0.0/client-manifest") {
      return Response.json({
        schemaVersion: 2,
        pack: "Lampas 2",
        version: "3.0.0",
        target: "client",
        minecraft: "26.2",
        loader: { type: "fabric", version: "0.19.3" },
        protocol: 3,
        files: [],
        mods: [
          {
            id: "sodium",
            name: "Sodium",
            side: "client",
            filename: "sodium.jar",
            size: 1024,
            iconUrl: "https://cdn.modrinth.com/data/AANobbMI/icon.png",
          },
          {
            id: "lithium",
            name: "Lithium",
            side: "both",
            filename: "lithium.jar",
            size: 1024,
          },
        ],
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});
const portalUrl = `http://127.0.0.1:${server.port}`;

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
  PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
  ConfigManager.resetForTesting();
  ConfigManager.set({
    portalUrl,
    selectedChannel: "stable",
    gameDir,
    customClientMods: [],
    disabledClientMods: [],
  });
  LauncherSync.invalidateModCatalog();
  requests = 0;
});

afterAll(() => {
  server.stop(true);
  PortalPolicy.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("mod catalog cache", () => {
  test("concurrent and repeated lookups share one portal fetch", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => LauncherSync.getModCatalog()),
    );
    expect(results.every((mods) => mods.length === 2)).toBe(true);
    // channel + release + client manifest, once.
    expect(requests).toBe(3);

    await LauncherSync.getModCatalog();
    expect(requests).toBe(3);
  });

  test("icon URL lookups reuse the cached catalog", async () => {
    const resolve = createModIconResolver(() => LauncherSync.getModCatalog());
    const urls = await Promise.all(
      Array.from({ length: 40 }, () => resolve("sodium")),
    );
    expect(urls[0]).toBe("https://cdn.modrinth.com/data/AANobbMI/icon.png");
    expect(requests).toBe(3);
  });

  test("local mods and toggles apply without refetching", async () => {
    await LauncherSync.getModCatalog();
    ConfigManager.set({
      disabledClientMods: ["sodium"],
      customClientMods: [
        {
          filename: "my-mod.jar",
          enabled: true,
          addedAt: new Date().toISOString(),
          size: 1,
        },
      ],
    });
    const mods = await LauncherSync.getModCatalog();
    expect(requests).toBe(3);
    expect(mods.find((m) => m.id === "sodium")?.enabled).toBe(false);
    expect(mods.some((m) => m.id === "local:my-mod.jar")).toBe(true);
  });

  test("invalidation (after a sync) fetches the portal again", async () => {
    await LauncherSync.getModCatalog();
    LauncherSync.invalidateModCatalog();
    await LauncherSync.getModCatalog();
    expect(requests).toBe(6);
  });
});
