import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-json-patch-test-"));
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
const { reconcileConfigPatches } = await import("../src/config-patches/reconciler");
const { jsonAdapter } = await import("../src/config-patches/adapters/json");
import type { ConfigPatch, InstallationState } from "../src/types";

describe("JSON and JSONC config patch adapter & reconciliation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-game-dir-"));
    LauncherLogger.resetForTesting();
    LauncherLogger.init();
  });

  afterEach(() => {
    LauncherLogger.resetForTesting();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("preserves unrelated settings, formatting and ordering", () => {
    const input = `{
  "volume": 0.42,
  "chatTabs": true,
  "hypixelOnlyChatTabs": true,
  "someUserThing": "banana"
}`;

    const res = jsonAdapter.apply(input, [
      { op: "set", path: ["hypixelOnlyChatTabs"], value: false },
    ]);

    expect(res.changed).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.volume).toBe(0.42);
    expect(parsed.chatTabs).toBe(true);
    expect(parsed.hypixelOnlyChatTabs).toBe(false);
    expect(parsed.someUserThing).toBe("banana");
  });

  test("preserves JSONC comments (line and block comments) and whitespace", () => {
    const jsoncWithComments = `// Top-level configuration header
{
  // Audio volume preference
  "volume": 0.42,

  /* Chat settings section */
  "chatTabs": true,
  /* Only show tabs on Hypixel server */
  "hypixelOnlyChatTabs": true,

  // Custom user setting
  "someUserThing": "banana"
}
`;

    const res = jsonAdapter.apply(jsoncWithComments, [
      { op: "set", path: ["hypixelOnlyChatTabs"], value: false },
    ]);

    expect(res.changed).toBe(true);
    expect(res.output).toContain("// Top-level configuration header");
    expect(res.output).toContain("// Audio volume preference");
    expect(res.output).toContain("/* Chat settings section */");
    expect(res.output).toContain("/* Only show tabs on Hypixel server */");
    expect(res.output).toContain('"hypixelOnlyChatTabs": false');
    expect(res.output).toContain('"volume": 0.42');
    expect(res.output).toContain('"someUserThing": "banana"');
  });

  test("idempotent: running patch again produces changed=false and byte-identical output", () => {
    const input = `{
  "volume": 0.42,
  "hypixelOnlyChatTabs": false
}`;

    const res = jsonAdapter.apply(input, [
      { op: "set", path: ["hypixelOnlyChatTabs"], value: false },
    ]);

    expect(res.changed).toBe(false);
    expect(res.output).toBe(input);
  });

  test("removes key while preserving surrounding formatting", () => {
    const input = `{
  "keepMe": 123,
  // delete this
  "removeMe": "bye"
}`;

    const res = jsonAdapter.apply(input, [
      { op: "remove", path: ["removeMe"] },
    ]);

    expect(res.changed).toBe(true);
    expect(res.output).not.toContain('"removeMe"');
    expect(res.output).toContain('"keepMe": 123');
  });

  test("end-to-end reconciliation: user changes survive and enforced value is restored", async () => {
    const configRelPath = "config/chatting.json";
    const fullPath = path.join(tempDir, configRelPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // Step 1: User has custom config with hypixelOnlyChatTabs = true
    const initialConfig = `// User personal comments
{
  "volume": 0.42,
  "hypixelOnlyChatTabs": true,
  "customTheme": "dark"
}
`;
    fs.writeFileSync(fullPath, initialConfig, "utf-8");

    const patch: ConfigPatch = {
      id: "chatting-global-chat-tabs",
      revision: 1,
      path: configRelPath,
      adapter: "json",
      mode: "enforce",
      missingFile: "defer",
      operations: [
        { op: "set", path: ["hypixelOnlyChatTabs"], value: false },
      ],
    };

    const prevState: InstallationState = {
      pack: "Lampas 2",
      version: "2.0.0",
      installedAt: new Date().toISOString(),
      files: {},
    };

    // First reconciliation: applies false
    const r1 = await reconcileConfigPatches({
      gameDir: tempDir,
      patches: [patch],
      prevState,
    });

    expect(r1.appliedCount).toBe(1);
    const contentAfterR1 = fs.readFileSync(fullPath, "utf-8");
    expect(contentAfterR1).toContain('"hypixelOnlyChatTabs": false');
    expect(contentAfterR1).toContain('"volume": 0.42');
    expect(contentAfterR1).toContain('"customTheme": "dark"');
    expect(contentAfterR1).toContain("// User personal comments");

    // Step 2: User changes unrelated value to 0.69
    const userModified = contentAfterR1.replace('"volume": 0.42', '"volume": 0.69');
    fs.writeFileSync(fullPath, userModified, "utf-8");

    // Next sync: user change survives and enforced value remains false
    const r2 = await reconcileConfigPatches({
      gameDir: tempDir,
      patches: [patch],
      prevState: { ...prevState, appliedConfigPatches: r1.appliedState },
    });

    expect(r2.unchangedCount).toBe(1);
    const contentAfterR2 = fs.readFileSync(fullPath, "utf-8");
    expect(contentAfterR2).toContain('"volume": 0.69');
    expect(contentAfterR2).toContain('"hypixelOnlyChatTabs": false');
    expect(contentAfterR2).toContain('"customTheme": "dark"');

    // Step 3: User attempts to revert enforced value back to true
    const userTampered = contentAfterR2.replace('"hypixelOnlyChatTabs": false', '"hypixelOnlyChatTabs": true');
    fs.writeFileSync(fullPath, userTampered, "utf-8");

    // Next sync: enforces false again
    const r3 = await reconcileConfigPatches({
      gameDir: tempDir,
      patches: [patch],
      prevState: { ...prevState, appliedConfigPatches: r1.appliedState },
    });

    expect(r3.appliedCount).toBe(1);
    const contentAfterR3 = fs.readFileSync(fullPath, "utf-8");
    expect(contentAfterR3).toContain('"hypixelOnlyChatTabs": false');
    expect(contentAfterR3).toContain('"volume": 0.69');
  });

  test("fails reconciliation on malformed target JSON and leaves original bytes untouched", async () => {
    const configRelPath = "config/broken.json";
    const fullPath = path.join(tempDir, configRelPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const malformed = `{ "broken": true, missing closing brace`;
    fs.writeFileSync(fullPath, malformed, "utf-8");

    const patch: ConfigPatch = {
      id: "broken-patch",
      revision: 1,
      path: configRelPath,
      adapter: "json",
      mode: "enforce",
      missingFile: "defer",
      operations: [{ op: "set", path: ["foo"], value: "bar" }],
    };

    const prevState: InstallationState = {
      pack: "Lampas 2",
      version: "2.0.0",
      installedAt: new Date().toISOString(),
      files: {},
    };

    await expect(
      reconcileConfigPatches({ gameDir: tempDir, patches: [patch], prevState })
    ).rejects.toThrow(/target contained invalid syntax/);

    // Original bytes must remain completely intact
    expect(fs.readFileSync(fullPath, "utf-8")).toBe(malformed);
  });
});
