import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-toml-test-"));
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const { LauncherLogger } = await import("../src/logger");
const { tomlAdapter } = await import("../src/config-patches/adapters/toml");
const { reconcileConfigPatches } = await import("../src/config-patches/reconciler");
import type { ConfigPatch, InstallationState } from "../src/types";

describe("TOML conservative targeted adapter preservation tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-toml-game-"));
    LauncherLogger.resetForTesting();
    LauncherLogger.init();
  });

  afterEach(() => {
    LauncherLogger.resetForTesting();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("preserves comments, table headers, inline comments, blank lines, and unrelated keys", () => {
    const tomlFixture = `# Global Pack TOML Header
version = 1 # file version

# Chat module configuration
[chat.tabs]
# Whether chat tabs are enabled
enabled = true
# Hypixel-only chat tabs toggle
hypixelOnly = true # inline comment here
maxTabs = 8

# Another table that must be completely untouched
[audio.effects]
volume = 0.8
spatial = true
`;

    const res = tomlAdapter.apply(tomlFixture, [
      { op: "set", path: ["chat", "tabs", "hypixelOnly"], value: false },
    ]);

    expect(res.changed).toBe(true);
    expect(res.output).toContain("# Global Pack TOML Header");
    expect(res.output).toContain("version = 1 # file version");
    expect(res.output).toContain("# Chat module configuration");
    expect(res.output).toContain("[chat.tabs]");
    expect(res.output).toContain("# Whether chat tabs are enabled");
    expect(res.output).toContain("enabled = true");
    expect(res.output).toContain("# Hypixel-only chat tabs toggle");
    expect(res.output).toContain("hypixelOnly = false # inline comment here");
    expect(res.output).toContain("maxTabs = 8");
    expect(res.output).toContain("[audio.effects]");
    expect(res.output).toContain("volume = 0.8");
    expect(res.output).toContain("spatial = true");

    // Idempotency: second run is unchanged
    const reApply = tomlAdapter.apply(res.output, [
      { op: "set", path: ["chat", "tabs", "hypixelOnly"], value: false },
    ]);
    expect(reApply.changed).toBe(false);
    expect(reApply.output).toBe(res.output);
  });

  test("removes targeted key while preserving surrounding table content", () => {
    const tomlFixture = `[mod.settings]
keepMe = true
removeMe = "obsolete" # to be removed
alsoKeepMe = 100
`;

    const res = tomlAdapter.apply(tomlFixture, [
      { op: "remove", path: ["mod", "settings", "removeMe"] },
    ]);

    expect(res.changed).toBe(true);
    expect(res.output).not.toContain("removeMe");
    expect(res.output).toContain("keepMe = true");
    expect(res.output).toContain("alsoKeepMe = 100");
  });

  test("reconciles TOML patch end-to-end and validates resulting document", async () => {
    const configPath = path.join(tempDir, "config/custom.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    const initialContent = `# Custom mod config
[general]
debug = true
level = 5
`;
    fs.writeFileSync(configPath, initialContent, "utf-8");

    const patch: ConfigPatch = {
      id: "toml-debug-patch",
      revision: 1,
      path: "config/custom.toml",
      adapter: "toml",
      mode: "enforce",
      missingFile: "defer",
      operations: [{ op: "set", path: ["general", "debug"], value: false }],
    };

    const prevState: InstallationState = {
      pack: "Lampas 2",
      version: "2.0.0",
      installedAt: new Date().toISOString(),
      files: {},
    };

    const res = await reconcileConfigPatches({
      gameDir: tempDir,
      patches: [patch],
      prevState,
    });

    expect(res.appliedCount).toBe(1);
    const patchedContent = fs.readFileSync(configPath, "utf-8");
    expect(patchedContent).toContain("debug = false");
    expect(patchedContent).toContain("level = 5");
    expect(patchedContent).toContain("# Custom mod config");
  });
});
