import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-launcher-test-"));
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

const { ConfigManager } = await import("../src/config");
const { ClientModManager } = await import("../src/client-mods");
const { parseJavaArgs } = await import("../src/game-runner");

beforeEach(() => {
  ConfigManager.resetForTesting();
  ConfigManager.set({ gameDir: path.join(testRoot, "game"), customClientMods: [], disabledClientMods: [] });
});

afterAll(() => {
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("launcher settings", () => {
  test("parses quoted Java arguments without corrupting Windows paths", () => {
    expect(parseJavaArgs('-Dlabel="Lampas client" -Dpath=C:\\Games\\Lampas -XX:+UseStringDeduplication')).toEqual([
      "-Dlabel=Lampas client",
      "-Dpath=C:\\Games\\Lampas",
      "-XX:+UseStringDeduplication",
    ]);
    expect(() => parseJavaArgs('-Dlabel="unfinished')).toThrow("unclosed quote");
  });

  test("tracks, disables, and removes an imported local mod", () => {
    const source = path.join(testRoot, "example-client.jar");
    fs.writeFileSync(source, "test mod");

    ClientModManager.add([source]);
    const enabledPath = path.join(testRoot, "game", "mods", "example-client.jar");
    const disabledPath = `${enabledPath}.disabled`;
    expect(fs.existsSync(enabledPath)).toBe(true);
    expect(ConfigManager.get().customClientMods?.[0]?.enabled).toBe(true);

    ClientModManager.setEnabled("example-client.jar", false);
    expect(fs.existsSync(enabledPath)).toBe(false);
    expect(fs.existsSync(disabledPath)).toBe(true);

    ClientModManager.remove("example-client.jar");
    expect(fs.existsSync(disabledPath)).toBe(false);
    expect(ConfigManager.get().customClientMods).toEqual([]);
  });

  test("rejects path traversal in local mod operations", () => {
    ConfigManager.set({
      customClientMods: [{ filename: "../example-client.jar", enabled: true, addedAt: new Date().toISOString(), size: 1 }],
    });
    expect(() => ClientModManager.remove("../example-client.jar")).toThrow("Invalid local mod filename");
    ConfigManager.set({ customClientMods: [] });
  });

  test("normalizes portal URLs and upgrades HTTP to HTTPS for remote portals", () => {
    const { normalizePortalUrl } = require("../src/config");
    expect(normalizePortalUrl("http://dev.lampas.town")).toBe("https://dev.lampas.town");
    expect(normalizePortalUrl("dev.lampas.town")).toBe("https://dev.lampas.town");
    expect(normalizePortalUrl("http://dev.lampas.town/")).toBe("https://dev.lampas.town");
    expect(normalizePortalUrl("https://dev.lampas.town")).toBe("https://dev.lampas.town");
    expect(normalizePortalUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizePortalUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  test("resolves default gameDir when unconfigured", () => {
    const { getDefaultGameDir } = require("../src/config");
    process.env.LAMPAS_DEFAULT_GAME_DIR = path.join(testRoot, "default-env-game");
    ConfigManager.resetForTesting();
    expect(getDefaultGameDir()).toBe(path.join(testRoot, "default-env-game"));
    delete process.env.LAMPAS_DEFAULT_GAME_DIR;
  });

  test("generic config update sanitization preserves gameDir and gameDirConfigured", () => {
    ConfigManager.set({ gameDir: path.join(testRoot, "initial-dir"), gameDirConfigured: true });
    const payload: any = {
      gameDir: path.join(testRoot, "malicious-change"),
      gameDirConfigured: false,
      allocatedRamGb: 8,
    };
    delete payload.gameDir;
    delete payload.gameDirConfigured;
    ConfigManager.set(payload);

    const updated = ConfigManager.get();
    expect(updated.gameDir).toBe(path.join(testRoot, "initial-dir"));
    expect(updated.gameDirConfigured).toBe(true);
    expect(updated.allocatedRamGb).toBe(8);
  });

  test("noSync defaults to false (off by default) and toggles cleanly", () => {
    ConfigManager.resetForTesting();
    // Default config check
    expect(ConfigManager.get().noSync).toBe(false);

    // Toggle on
    ConfigManager.set({ noSync: true });
    expect(ConfigManager.get().noSync).toBe(true);

    // Persists across re-reading from disk
    ConfigManager.resetForTesting();
    expect(ConfigManager.get().noSync).toBe(true);

    // Toggle off
    ConfigManager.set({ noSync: false });
    expect(ConfigManager.get().noSync).toBe(false);

    ConfigManager.resetForTesting();
    expect(ConfigManager.get().noSync).toBe(false);
  });
});
