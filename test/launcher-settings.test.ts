import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-launcher-test-"),
);
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

const { ConfigManager, PortalPolicy } = await import("../src/config");
const { CredentialStore } = await import("../src/credential-store");
const { ClientModManager, ShaderPackManager } =
  await import("../src/client-mods");
const { parseJavaArgs } = await import("../src/game-runner");
const { LauncherLogger } = await import("../src/logger");

beforeEach(() => {
  PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
  // Keep credentials in this file's user-data folder, so a session another
  // test file saved is never restored into these configs.
  CredentialStore.resetForTesting();
  ConfigManager.resetForTesting();
  ConfigManager.set({
    gameDir: path.join(testRoot, "game"),
    customClientMods: [],
    customShaderPacks: [],
    disabledClientMods: [],
  });
});

// The import check only reads the ZIP local-file-header signature (PK).
function writeZip(target: string): void {
  fs.writeFileSync(
    target,
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)]),
  );
}

afterAll(() => {
  PortalPolicy.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("launcher settings", () => {
  test("parses quoted Java arguments without corrupting Windows paths", () => {
    expect(
      parseJavaArgs(
        '-Dlabel="Lampas client" -Dpath=C:\\Games\\Lampas -XX:+UseStringDeduplication',
      ),
    ).toEqual([
      "-Dlabel=Lampas client",
      "-Dpath=C:\\Games\\Lampas",
      "-XX:+UseStringDeduplication",
    ]);
    expect(() => parseJavaArgs('-Dlabel="unfinished')).toThrow(
      "unclosed quote",
    );
  });

  test("tracks, disables, and removes an imported local mod", () => {
    const source = path.join(testRoot, "example-client.jar");
    fs.writeFileSync(source, "test mod");

    ClientModManager.add([source]);
    const enabledPath = path.join(
      testRoot,
      "game",
      "mods",
      "example-client.jar",
    );
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

  test("imports and removes a local shader pack in shaderpacks/", () => {
    const source = path.join(testRoot, "Complementary.zip");
    writeZip(source);

    ShaderPackManager.add([source]);
    const installed = path.join(
      testRoot,
      "game",
      "shaderpacks",
      "Complementary.zip",
    );
    expect(fs.existsSync(installed)).toBe(true);
    expect(ConfigManager.get().customShaderPacks?.[0]?.filename).toBe(
      "Complementary.zip",
    );

    // Re-importing the same pack replaces it instead of failing.
    ShaderPackManager.add([source]);
    expect(ConfigManager.get().customShaderPacks).toHaveLength(1);
    expect(
      fs
        .readdirSync(path.dirname(installed))
        .filter((f) => f.startsWith(".importing-") || f.endsWith(".bak")),
    ).toEqual([]);

    ShaderPackManager.remove("Complementary.zip");
    expect(fs.existsSync(installed)).toBe(false);
    expect(ConfigManager.get().customShaderPacks).toEqual([]);
  });

  test("rejects shader packs that are not ZIP archives or would overwrite pack files", () => {
    const fake = path.join(testRoot, "not-really.zip");
    fs.writeFileSync(fake, "plain text");
    expect(() => ShaderPackManager.add([fake])).toThrow(
      "not a valid shader pack",
    );

    const jar = path.join(testRoot, "wrong-type.jar");
    writeZip(jar);
    expect(() => ShaderPackManager.add([jar])).toThrow(
      "Only local .zip files can be added as shader packs.",
    );

    const shaderDir = path.join(testRoot, "game", "shaderpacks");
    fs.mkdirSync(shaderDir, { recursive: true });
    writeZip(path.join(shaderDir, "PackManaged.zip"));
    const source = path.join(testRoot, "PackManaged.zip");
    writeZip(source);
    expect(() => ShaderPackManager.add([source])).toThrow(
      "not a launcher-managed local shader pack",
    );
    expect(() => ShaderPackManager.remove("../PackManaged.zip")).toThrow(
      "Unknown local shader pack",
    );
  });

  test("rejects path traversal in local mod operations", () => {
    ConfigManager.set({
      customClientMods: [
        {
          filename: "../example-client.jar",
          enabled: true,
          addedAt: new Date().toISOString(),
          size: 1,
        },
      ],
    });
    expect(() => ClientModManager.remove("../example-client.jar")).toThrow(
      "Invalid local mod filename",
    );
    ConfigManager.set({ customClientMods: [] });
  });

  test("normalizes portal URLs and upgrades HTTP to HTTPS for remote portals", () => {
    const { normalizePortalUrl } = require("../src/config");
    expect(normalizePortalUrl("http://dev.lampas.town")).toBe(
      "https://dev.lampas.town",
    );
    expect(normalizePortalUrl("dev.lampas.town")).toBe(
      "https://dev.lampas.town",
    );
    expect(normalizePortalUrl("http://dev.lampas.town/")).toBe(
      "https://dev.lampas.town",
    );
    expect(normalizePortalUrl("https://dev.lampas.town")).toBe(
      "https://dev.lampas.town",
    );
    expect(normalizePortalUrl("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(normalizePortalUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
  });

  test("resolves default gameDir when unconfigured", () => {
    const { getDefaultGameDir } = require("../src/config");
    process.env.LAMPAS_DEFAULT_GAME_DIR = path.join(
      testRoot,
      "default-env-game",
    );
    ConfigManager.resetForTesting();
    expect(getDefaultGameDir()).toBe(path.join(testRoot, "default-env-game"));
    delete process.env.LAMPAS_DEFAULT_GAME_DIR;
  });

  test("generic config update sanitization preserves gameDir and gameDirConfigured", () => {
    ConfigManager.set({
      gameDir: path.join(testRoot, "initial-dir"),
      gameDirConfigured: true,
    });
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

  test("external avatars and mod icons are on by default", () => {
    ConfigManager.resetForTesting();
    expect(ConfigManager.get().externalImages).toBe(true);
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

describe("config.json shape validation on load", () => {
  const addedAt = "2025-01-02T03:04:05.000Z";
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(LauncherLogger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** Writes `raw` as the whole config.json, then loads it fresh. */
  function loadFromDisk(raw: unknown) {
    const configPath = ConfigManager.getConfigPath();
    fs.writeFileSync(
      configPath,
      typeof raw === "string" ? raw : JSON.stringify(raw),
    );
    ConfigManager.resetForTesting();
    return ConfigManager.get();
  }

  function ignoredSettingsWarnings(): string[] {
    return warnSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((message: string) =>
        message.startsWith("[Config] Ignored invalid settings:"),
      );
  }

  test("drops a local mod with a non-string filename and keeps valid siblings", () => {
    const config = loadFromDisk({
      customClientMods: [
        { filename: 123, enabled: true, addedAt, size: 5 },
        { filename: "good.jar", enabled: true, addedAt, size: 10 },
        { filename: "../escape.jar", enabled: true, addedAt, size: 1 },
        { filename: "readme.txt", enabled: true, addedAt, size: 1 },
        "not-an-object",
        null,
        { filename: "Other.JAR", enabled: 0, addedAt: 7, size: -3 },
      ],
    });

    expect(config.customClientMods).toEqual([
      { filename: "good.jar", enabled: true, addedAt, size: 10 },
      { filename: "Other.JAR", enabled: false, addedAt: "", size: 0 },
    ]);
  });

  test("drops shader packs that are malformed or not .zip files", () => {
    const config = loadFromDisk({
      customShaderPacks: [
        { filename: ["Pack.zip"], addedAt, size: 5 },
        { filename: "Pack.zip", addedAt, size: 20 },
        { filename: "nested/Pack.zip", addedAt, size: 20 },
        { filename: "Pack.jar", addedAt, size: 20 },
        { filename: "Loose.zip", addedAt: null, size: "big" },
      ],
    });

    expect(config.customShaderPacks).toEqual([
      { filename: "Pack.zip", addedAt, size: 20 },
      { filename: "Loose.zip", addedAt: "", size: 0 },
    ]);
  });

  test("replaces non-array mod lists with empty lists and keeps only string items", () => {
    const notArrays = loadFromDisk({
      disabledClientMods: "foo",
      customClientMods: { filename: "a.jar" },
      customShaderPacks: 7,
    });
    expect(notArrays.disabledClientMods).toEqual([]);
    expect(notArrays.customClientMods).toEqual([]);
    expect(notArrays.customShaderPacks).toEqual([]);

    const mixed = loadFromDisk({
      disabledClientMods: ["a.jar", 5, null, "b.jar", { x: 1 }],
    });
    expect(mixed.disabledClientMods).toEqual(["a.jar", "b.jar"]);
  });

  test("falls back to the default 8 GB when allocatedRamGb is not an integer from 2 to 64", () => {
    for (const bad of [1, 65, 0, -4, 8.5, "lots", null, true, [8]]) {
      expect(loadFromDisk({ allocatedRamGb: bad }).allocatedRamGb).toBe(8);
    }
    expect(loadFromDisk({ allocatedRamGb: 2 }).allocatedRamGb).toBe(2);
    expect(loadFromDisk({ allocatedRamGb: 64 }).allocatedRamGb).toBe(64);
  });

  test("falls back to the stable channel when selectedChannel is not stable, beta, or dev", () => {
    expect(loadFromDisk({ selectedChannel: "nightly" }).selectedChannel).toBe(
      "stable",
    );
    expect(loadFromDisk({ selectedChannel: 3 }).selectedChannel).toBe("stable");
    expect(loadFromDisk({ selectedChannel: "beta" }).selectedChannel).toBe(
      "beta",
    );
    expect(loadFromDisk({ selectedChannel: "dev" }).selectedChannel).toBe(
      "dev",
    );
  });

  test("ignores wrongly typed scalar settings so the defaults apply", () => {
    const defaultGameDir = path.join(testRoot, "default-for-bad-types");
    process.env.LAMPAS_DEFAULT_GAME_DIR = defaultGameDir;
    try {
      const config = loadFromDisk({
        portalUrl: "",
        gameDir: 42,
        javaArgs: 42,
        javaPath: { path: "java" },
        noSync: "yes",
        externalImages: "no",
      });
      expect(config.portalUrl).toBe("https://dev.lampas.town");
      expect(config.gameDir).toBe(defaultGameDir);
      expect(config.javaArgs).toBe("");
      expect(config.javaPath).toBeUndefined();
      expect(config.noSync).toBe(false);
      expect(config.externalImages).toBe(true);
    } finally {
      delete process.env.LAMPAS_DEFAULT_GAME_DIR;
    }
  });

  test("does not carry unknown keys onto the loaded config", () => {
    // Raw JSON, because an object literal's __proto__ would not serialize.
    const config = loadFromDisk(
      '{"allocatedRamGb":6,"somethingElse":"x","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;

    expect(config.allocatedRamGb).toBe(6);
    expect("somethingElse" in config).toBe(false);
    expect(Object.hasOwn(config, "__proto__")).toBe(false);
    expect(config.polluted).toBeUndefined();
  });

  test("a non-object config.json loads as the defaults", () => {
    for (const raw of ["[1, 2]", '"text"', "null", "42"]) {
      const config = loadFromDisk(raw);
      expect(config.selectedChannel).toBe("stable");
      expect(config.allocatedRamGb).toBe(8);
      expect(config.customClientMods).toEqual([]);
    }
  });

  test("a non-boolean gameDirConfigured is treated as missing by the legacy migration", () => {
    const defaultGameDir = path.join(testRoot, "no-install-here");
    process.env.LAMPAS_DEFAULT_GAME_DIR = defaultGameDir;
    try {
      // A chosen game folder marks an old config as configured.
      expect(
        loadFromDisk({
          gameDirConfigured: "yes",
          gameDir: path.join(testRoot, "chosen"),
        }).gameDirConfigured,
      ).toBe(true);
      // No chosen folder and no installation: not configured.
      expect(loadFromDisk({ gameDirConfigured: "yes" }).gameDirConfigured).toBe(
        false,
      );
      // A real boolean is kept as written.
      expect(
        loadFromDisk({ gameDirConfigured: false, gameDir: "C:\\chosen" })
          .gameDirConfigured,
      ).toBe(false);
    } finally {
      delete process.env.LAMPAS_DEFAULT_GAME_DIR;
    }
  });

  test("a valid config.json loads unchanged without a warning", () => {
    const valid = {
      portalUrl: "https://dev.lampas.town",
      selectedChannel: "beta",
      allocatedRamGb: 12,
      gameDir: path.join(testRoot, "valid-game"),
      gameDirConfigured: true,
      gameDirPreexistingEntries: ["saves", "options.txt"],
      javaPath: "C:\\Java\\bin\\javaw.exe",
      javaArgs: "-XX:+UseG1GC",
      disabledClientMods: ["a.jar", "b.jar"],
      customClientMods: [
        { filename: "mine.jar", enabled: false, addedAt, size: 1234 },
      ],
      customShaderPacks: [{ filename: "Shaders.zip", addedAt, size: 99 }],
      noSync: true,
      externalImages: false,
    };

    expect(loadFromDisk(valid)).toEqual(valid);
    expect(ignoredSettingsWarnings()).toEqual([]);
  });

  test("logs one warning naming the ignored keys and never their values", () => {
    loadFromDisk({
      allocatedRamGb: "secret-looking-value",
      selectedChannel: "nightly-value",
      mysteryKey: "mystery-value",
      customClientMods: [{ filename: 123 }],
      javaArgs: "-Xmx1G",
    });

    const warnings = ignoredSettingsWarnings();
    expect(warnings).toHaveLength(1);
    for (const name of [
      "allocatedRamGb",
      "selectedChannel",
      "mysteryKey",
      "customClientMods",
    ]) {
      expect(warnings[0]).toContain(name);
    }
    expect(warnings[0]).not.toContain("javaArgs");
    for (const value of [
      "secret-looking-value",
      "nightly-value",
      "mystery-value",
    ]) {
      expect(warnings[0]).not.toContain(value);
    }
  });
});
