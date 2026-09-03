import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-adapters-test-"));
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
const { yamlAdapter } = await import("../src/config-patches/adapters/yaml");
const { propertiesAdapter } = await import("../src/config-patches/adapters/properties");
const { iniAdapter } = await import("../src/config-patches/adapters/ini");
const { textAdapter } = await import("../src/config-patches/adapters/text");
const { reconcileConfigPatches } = await import("../src/config-patches/reconciler");
import type { ConfigPatch, InstallationState } from "../src/types";

describe("YAML, Properties, INI, and Text adapter preservation tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-adapters-game-"));
    LauncherLogger.resetForTesting();
    LauncherLogger.init();
  });

  afterEach(() => {
    LauncherLogger.resetForTesting();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("YAML: preserves comments, weird indentation, ordering, and blank lines", () => {
    const yamlFixture = `# Server Configuration Header
server:
  # Network port
  port: 8080 # default port

  # Enable debug mode
  debug: false

# User chat preferences
chat:
  tabs:
    # Hypixel chat tabs flag
    hypixelOnly: true
    maxTabs: 5

unrelated:
  customUserList:
    - alpha
    - beta
`;

    const res = yamlAdapter.apply(yamlFixture, [
      { op: "set", path: ["chat", "tabs", "hypixelOnly"], value: false },
    ]);

    expect(res.changed).toBe(true);
    expect(res.output).toContain("# Server Configuration Header");
    expect(res.output).toContain("# Network port");
    expect(res.output).toContain("port: 8080 # default port");
    expect(res.output).toContain("# Enable debug mode");
    expect(res.output).toContain("# User chat preferences");
    expect(res.output).toContain("# Hypixel chat tabs flag");
    expect(res.output).toContain("hypixelOnly: false");
    expect(res.output).toContain("- alpha");
    expect(res.output).toContain("- beta");

    // Idempotency check
    const reApply = yamlAdapter.apply(res.output, [
      { op: "set", path: ["chat", "tabs", "hypixelOnly"], value: false },
    ]);
    expect(reApply.changed).toBe(false);
  });

  test("Properties: preserves comments, ordering, spacing, and separator styles", () => {
    const propFixture = `# Minecraft Server Properties
# Generated automatically - do not remove header

# Server port setting
server-port = 25565

# RCON configuration
enable-rcon: false
rcon.password=secret123

# Chatting setting
hypixelOnlyChatTabs=true

# End of file comment
`;

    const res = propertiesAdapter.apply(propFixture, [
      { op: "set", path: ["hypixelOnlyChatTabs"], value: false },
    ]);

    expect(res.changed).toBe(true);
    expect(res.output).toContain("# Minecraft Server Properties");
    expect(res.output).toContain("server-port = 25565");
    expect(res.output).toContain("enable-rcon: false");
    expect(res.output).toContain("rcon.password=secret123");
    expect(res.output).toContain("hypixelOnlyChatTabs=false");
    expect(res.output).toContain("# End of file comment");

    // Idempotency
    const reApply = propertiesAdapter.apply(res.output, [
      { op: "set", path: ["hypixelOnlyChatTabs"], value: false },
    ]);
    expect(reApply.changed).toBe(false);
  });

  test("INI: preserves section headers, comments, and spacing", () => {
    const iniFixture = `; Global INI settings
app_name = Lampas

; Audio section
[audio]
volume = 80
muted = false

; Chatting section
[chat]
# Enable multi-tab chat
enabled = true
hypixelOnlyChatTabs = true

[video]
fov = 90
`;

    const res = iniAdapter.apply(iniFixture, [
      { op: "set", path: ["chat", "hypixelOnlyChatTabs"], value: false },
    ]);

    expect(res.changed).toBe(true);
    expect(res.output).toContain("; Global INI settings");
    expect(res.output).toContain("app_name = Lampas");
    expect(res.output).toContain("[audio]");
    expect(res.output).toContain("volume = 80");
    expect(res.output).toContain("[chat]");
    expect(res.output).toContain("# Enable multi-tab chat");
    expect(res.output).toContain("hypixelOnlyChatTabs = false");
    expect(res.output).toContain("[video]");

    // Idempotency
    const reApply = iniAdapter.apply(res.output, [
      { op: "set", path: ["chat", "hypixelOnlyChatTabs"], value: false },
    ]);
    expect(reApply.changed).toBe(false);
  });

  test("Text: literal matching with expectedMatches requirement and idempotency", () => {
    const textFixture = `# Custom arbitrary config file
hypixelOnlyChatTabs=true
anotherSetting=123
hypixelOnlyChatTabs_comment=true_not_matched
`;

    const res = textAdapter.apply(textFixture, [
      {
        op: "replaceLiteral",
        search: "hypixelOnlyChatTabs=true",
        replacement: "hypixelOnlyChatTabs=false",
        expectedMatches: 1,
      },
    ]);

    expect(res.changed).toBe(true);
    expect(res.output).toContain("hypixelOnlyChatTabs=false");
    expect(res.output).toContain("anotherSetting=123");
    expect(res.output).toContain("hypixelOnlyChatTabs_comment=true_not_matched");

    // Idempotency: second run sees 0 matches for search, but replacement is satisfied
    const reApply = textAdapter.apply(res.output, [
      {
        op: "replaceLiteral",
        search: "hypixelOnlyChatTabs=true",
        replacement: "hypixelOnlyChatTabs=false",
        expectedMatches: 1,
      },
    ]);
    expect(reApply.changed).toBe(false);

    // Mismatch count fails
    expect(() =>
      textAdapter.apply(textFixture, [
        {
          op: "replaceLiteral",
          search: "nonexistent=true",
          replacement: "nonexistent=false",
          expectedMatches: 1,
        },
      ])
    ).toThrow(/matches for 'nonexistent=true', but found 0/);
  });

  test("reconciler integrates YAML, properties, INI and text patches end-to-end", async () => {
    const yamlPath = path.join(tempDir, "config/mod.yaml");
    fs.mkdirSync(path.dirname(yamlPath), { recursive: true });
    fs.writeFileSync(yamlPath, "# YAML comment\nsetting: true\n", "utf-8");

    const propPath = path.join(tempDir, "config/mod.properties");
    fs.writeFileSync(propPath, "# Prop comment\nsetting=true\n", "utf-8");

    const iniPath = path.join(tempDir, "config/mod.ini");
    fs.writeFileSync(iniPath, "; INI comment\n[sec]\nsetting = true\n", "utf-8");

    const textPath = path.join(tempDir, "config/mod.conf");
    fs.writeFileSync(textPath, "# Text comment\nsetting: true\n", "utf-8");

    const patches: ConfigPatch[] = [
      {
        id: "patch-yaml",
        revision: 1,
        path: "config/mod.yaml",
        adapter: "yaml",
        mode: "enforce",
        missingFile: "defer",
        operations: [{ op: "set", path: ["setting"], value: false }],
      },
      {
        id: "patch-prop",
        revision: 1,
        path: "config/mod.properties",
        adapter: "properties",
        mode: "enforce",
        missingFile: "defer",
        operations: [{ op: "set", path: ["setting"], value: false }],
      },
      {
        id: "patch-ini",
        revision: 1,
        path: "config/mod.ini",
        adapter: "ini",
        mode: "enforce",
        missingFile: "defer",
        operations: [{ op: "set", path: ["sec", "setting"], value: false }],
      },
      {
        id: "patch-text",
        revision: 1,
        path: "config/mod.conf",
        adapter: "text",
        mode: "enforce",
        missingFile: "defer",
        operations: [
          {
            op: "replaceLiteral",
            search: "setting: true",
            replacement: "setting: false",
            expectedMatches: 1,
          },
        ],
      },
    ];

    const prevState: InstallationState = {
      pack: "Lampas 2",
      version: "2.0.0",
      installedAt: new Date().toISOString(),
      files: {},
    };

    const res = await reconcileConfigPatches({ gameDir: tempDir, patches, prevState });
    expect(res.appliedCount).toBe(4);

    expect(fs.readFileSync(yamlPath, "utf-8")).toContain("setting: false");
    expect(fs.readFileSync(propPath, "utf-8")).toContain("setting=false");
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("setting = false");
    expect(fs.readFileSync(textPath, "utf-8")).toContain("setting: false");
  });
});
