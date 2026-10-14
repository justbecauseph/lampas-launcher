import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-options-defaults-test-"),
);
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
const { ConfigManager, PortalPolicy } = await import("../src/config");
const { LauncherSync } = await import("../src/sync");
const { validateManifestMetadata } = await import("../src/path-policy");
const { placeSeedFileIfAbsent } = await import("../src/seed-file");

const previousRetryBaseMs = process.env.LAMPAS_TRANSFER_RETRY_BASE_MS;

// The pack's default options.txt: keybind defaults plus a version line.
const PACK_DEFAULT_OPTIONS = Buffer.from(
  "version:4189\nkey_key.snappy_tappy.toggle:key.keyboard.unknown\nkey_figura.config.action_wheel_button:key.keyboard.grave.accent\n",
  "utf-8",
);
// A player's options.txt, which must never be overwritten.
const PLAYER_OPTIONS = Buffer.from(
  "version:4189\nguiScale:3\nkey_key.snappy_tappy.toggle:key.keyboard.f6\nfov:0.5\n",
  "utf-8",
);
const DIGEST_PLACEHOLDER = "a".repeat(64);

let gameDir: string;
let optionsPath: string;
let versionCounter = 0;

beforeAll(() => {
  process.env.LAMPAS_TRANSFER_RETRY_BASE_MS = "1";
  fs.mkdirSync(userDataDir, { recursive: true });
});

beforeEach(() => {
  gameDir = fs.mkdtempSync(path.join(testRoot, "game-"));
  optionsPath = path.join(gameDir, "options.txt");
  PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
  ConfigManager.resetForTesting();
  ConfigManager.set({
    portalUrl: "http://localhost:3000",
    selectedChannel: "stable",
    gameDir,
    customClientMods: [],
    disabledClientMods: [],
  });
  ConfigManager.establishSession("http://localhost:3000", {
    token: "mock-token",
  });
});

afterAll(() => {
  if (previousRetryBaseMs === undefined)
    delete process.env.LAMPAS_TRANSFER_RETRY_BASE_MS;
  else process.env.LAMPAS_TRANSFER_RETRY_BASE_MS = previousRetryBaseMs;
  PortalPolicy.resetForTesting();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

interface ServedFile {
  path: string;
  policy: string;
  content: Buffer;
}

// Serves one release whose client manifest lists `files` and `configPatches`,
// plus the blobs for `files`.
function serveRelease(
  files: ServedFile[],
  configPatches: unknown[] = [],
  overrides: {
    release?: Record<string, unknown>;
    manifest?: Record<string, unknown>;
  } = {},
) {
  versionCounter++;
  const version = `4.0.${versionCounter}`;
  const blobs = new Map<string, Buffer>();
  const entries = files.map((file) => {
    const digest = sha256(file.content);
    const url = `/api/v1/blobs/${digest}`;
    blobs.set(url, file.content);
    return {
      path: file.path,
      hashes: { sha256: digest },
      size: file.content.length,
      download: { url, provider: "lampas" },
      policy: file.policy,
    };
  });
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/channels/stable") {
        return Response.json({
          channel: "stable",
          version,
          release: `/api/v1/releases/${version}`,
        });
      }
      if (url.pathname === `/api/v1/releases/${version}`) {
        return Response.json({
          schemaVersion: 1,
          pack: "Lampas 2",
          version,
          protocol: 3,
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          minimumLauncherVersion: "1.0.0",
          created: "2026-01-01T00:00:00Z",
          clientManifest: `/api/v1/releases/${version}/client-manifest`,
          serverManifest: `/api/v1/releases/${version}/server-manifest`,
          ...overrides.release,
        });
      }
      if (url.pathname === `/api/v1/releases/${version}/client-manifest`) {
        return Response.json({
          schemaVersion: 2,
          pack: "Lampas 2",
          version,
          target: "client",
          protocol: 3,
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          files: entries,
          mods: [],
          ...(configPatches.length > 0 ? { configPatches } : {}),
          ...overrides.manifest,
        });
      }
      const blob = blobs.get(url.pathname);
      if (blob) return new Response(blob);
      return new Response("Not Found", { status: 404 });
    },
  });
  ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, {
    token: "mock-token",
  });
  return server;
}

const OPTIONS_PRESERVE = (): ServedFile => ({
  path: "options.txt",
  policy: "PRESERVE",
  content: PACK_DEFAULT_OPTIONS,
});

describe("validateManifestMetadata default options.txt", () => {
  const entry = (filePath: string, policy: string) => ({
    path: filePath,
    hashes: { sha256: DIGEST_PLACEHOLDER },
    size: 1,
    policy,
  });

  test("accepts options.txt with policy PRESERVE", () => {
    expect(() =>
      validateManifestMetadata({
        files: [entry("options.txt", "PRESERVE")],
      }),
    ).not.toThrow();
  });

  test("rejects options.txt with policy MANAGED", () => {
    expect(() =>
      validateManifestMetadata({
        files: [entry("options.txt", "MANAGED")],
      }),
    ).toThrow(/protected or reserved namespace/);
  });

  test("accepts servers.dat with policy PRESERVE", () => {
    expect(() =>
      validateManifestMetadata({
        files: [entry("servers.dat", "PRESERVE")],
      }),
    ).not.toThrow();
  });

  test("rejects servers.dat with policy MANAGED", () => {
    expect(() =>
      validateManifestMetadata({
        files: [entry("servers.dat", "MANAGED")],
      }),
    ).toThrow(/protected or reserved namespace/);
  });

  test("rejects Servers.dat with policy PRESERVE", () => {
    expect(() =>
      validateManifestMetadata({
        files: [entry("Servers.dat", "PRESERVE")],
      }),
    ).toThrow(/protected or reserved namespace/);
  });
});

describe("sync places the pack's default options.txt", () => {
  test("places options.txt with exact bytes when the player has none", async () => {
    const server = serveRelease([OPTIONS_PRESERVE()]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(optionsPath).equals(PACK_DEFAULT_OPTIONS)).toBe(
        true,
      );
    } finally {
      server.stop(true);
    }
  });

  test("leaves an existing options.txt byte-identical", async () => {
    fs.writeFileSync(optionsPath, PLAYER_OPTIONS);
    const server = serveRelease([OPTIONS_PRESERVE()]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(optionsPath).equals(PLAYER_OPTIONS)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("does not record options.txt in installation state, and a later sync keeps the player's file", async () => {
    const managed: ServedFile = {
      path: "config/pack-settings.json",
      policy: "MANAGED",
      content: Buffer.from('{"enabled":true}\n', "utf-8"),
    };
    const server = serveRelease([OPTIONS_PRESERVE(), managed]);
    try {
      const first = await LauncherSync.syncClient(() => {});
      expect(first.success).toBe(true);

      const state = JSON.parse(
        fs.readFileSync(
          path.join(gameDir, ".lampas", "installation.json"),
          "utf-8",
        ),
      );
      expect(state.files["options.txt"]).toBeUndefined();
      expect(state.files["config/pack-settings.json"]).toBeDefined();

      // The player edits options.txt. The next sync must neither reject the
      // state nor overwrite the file.
      fs.writeFileSync(optionsPath, PLAYER_OPTIONS);
      const second = await LauncherSync.syncClient(() => {});
      expect(second.success).toBe(true);
      expect(fs.readFileSync(optionsPath).equals(PLAYER_OPTIONS)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a manifest that ships options.txt with policy MANAGED", async () => {
    const server = serveRelease([
      { path: "options.txt", policy: "MANAGED", content: PACK_DEFAULT_OPTIONS },
    ]);
    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /protected namespace/,
      );
      expect(fs.existsSync(optionsPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("sync applies keybind config patches to options.txt", () => {
  const keybindPatch = (value: string) => ({
    id: "unbind-snappy-tappy",
    revision: 1,
    path: "options.txt",
    adapter: "properties",
    mode: "once",
    missingFile: "defer",
    operations: [{ op: "set", path: ["key_key.snappy_tappy.toggle"], value }],
  });

  test("rebinds an existing keybind line and keeps every other line byte-identical", async () => {
    const before =
      "guiScale:2\nkey_key.snappy_tappy.toggle:key.keyboard.grave.accent\nfov:0.0\n";
    fs.writeFileSync(optionsPath, before, "utf-8");
    const server = serveRelease([], [keybindPatch("key.keyboard.unknown")]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
        "guiScale:2\nkey_key.snappy_tappy.toggle:key.keyboard.unknown\nfov:0.0\n",
      );
    } finally {
      server.stop(true);
    }
  });

  test("defers and creates nothing when options.txt is missing", async () => {
    const server = serveRelease([], [keybindPatch("key.keyboard.unknown")]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.existsSync(optionsPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("defers without writing when the keybind line is absent", async () => {
    const before = "guiScale:2\nfov:0.0\n";
    fs.writeFileSync(optionsPath, before, "utf-8");
    const server = serveRelease([], [keybindPatch("key.keyboard.unknown")]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(optionsPath, "utf-8")).toBe(before);
    } finally {
      server.stop(true);
    }
  });
});

// A pack ships a PRESERVE default options.txt together with a once keybind
// patch on it. Fresh installs get the default. Existing players keep their file,
// and the patch rewrites the keybind line.
const XAERO_DEFAULT = Buffer.from(
  "version:4189\nguiScale:2\nkey_gui.xaero_open_map:key.keyboard.comma\nfov:0.0\n",
  "utf-8",
);
const XAERO_PLAYER_FILE =
  "guiScale:3\nkey_gui.xaero_open_map:key.keyboard.m\nfov:0.5\n";

function manifestEntry(filePath: string, policy: string) {
  return {
    path: filePath,
    hashes: { sha256: DIGEST_PLACEHOLDER },
    size: 1,
    policy,
  };
}

function xaeroPatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "xaero-open-map",
    revision: 1,
    path: "options.txt",
    adapter: "properties",
    mode: "once",
    missingFile: "defer",
    operations: [
      {
        op: "set",
        path: ["key_gui.xaero_open_map"],
        value: "key.keyboard.comma",
      },
    ],
    ...overrides,
  };
}

function jsonPatch(targetPath: string) {
  return {
    id: "chat-volume",
    revision: 1,
    path: targetPath,
    adapter: "json",
    mode: "enforce",
    missingFile: "defer",
    operations: [{ op: "set", path: ["volume"], value: 1 }],
  };
}

describe("validateManifestMetadata: default options.txt with keybind patches", () => {
  test("accepts a PRESERVE options.txt shipped with a keybind patch on it", () => {
    expect(() =>
      validateManifestMetadata({
        files: [manifestEntry("options.txt", "PRESERVE")],
        configPatches: [xaeroPatch()],
      }),
    ).not.toThrow();
  });

  test("rejects a MANAGED config file that a patch also targets", () => {
    expect(() =>
      validateManifestMetadata({
        files: [manifestEntry("config/chat.json", "MANAGED")],
        configPatches: [jsonPatch("config/chat.json")],
      }),
    ).toThrow(/managed both as a whole file and by config patch/);
  });

  test("rejects a PRESERVE config file that a patch also targets", () => {
    expect(() =>
      validateManifestMetadata({
        files: [manifestEntry("config/chat.json", "PRESERVE")],
        configPatches: [jsonPatch("config/chat.json")],
      }),
    ).toThrow(/managed both as a whole file and by config patch/);
  });

  test("rejects a MANAGED options.txt shipped with a keybind patch", () => {
    expect(() =>
      validateManifestMetadata({
        files: [manifestEntry("options.txt", "MANAGED")],
        configPatches: [xaeroPatch()],
      }),
    ).toThrow(/protected or reserved namespace/);
  });

  test("rejects a PRESERVE options.txt shipped with a non-keybind patch", () => {
    expect(() =>
      validateManifestMetadata({
        files: [manifestEntry("options.txt", "PRESERVE")],
        configPatches: [
          xaeroPatch({
            operations: [{ op: "set", path: ["guiScale"], value: "2" }],
          }),
        ],
      }),
    ).toThrow(/targets protected namespace/);
  });
});

describe("sync with a default options.txt and a keybind patch on it", () => {
  test("fresh install: the default already holds the patched value, so the patch is already satisfied and the file stays byte-identical", async () => {
    const infoSpy = spyOn(LauncherLogger, "info");
    const server = serveRelease(
      [{ path: "options.txt", policy: "PRESERVE", content: XAERO_DEFAULT }],
      [xaeroPatch()],
    );
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(optionsPath).equals(XAERO_DEFAULT)).toBe(true);

      const state = JSON.parse(
        fs.readFileSync(
          path.join(gameDir, ".lampas", "installation.json"),
          "utf-8",
        ),
      );
      expect(state.appliedConfigPatches["xaero-open-map"]).toMatchObject({
        revision: 1,
      });
      expect(state.files["options.txt"]).toBeUndefined();

      // The default is placed before the patch runs.
      const messages = infoSpy.mock.calls.map(([msg]) => String(msg));
      const placed = messages.findIndex((msg) =>
        msg.includes("[Placed] options.txt"),
      );
      const satisfied = messages.findIndex(
        (msg) =>
          msg.includes("xaero-open-map") && msg.includes("already satisfied"),
      );
      expect(placed).toBeGreaterThanOrEqual(0);
      expect(satisfied).toBeGreaterThan(placed);
    } finally {
      infoSpy.mockRestore();
      server.stop(true);
    }
  });

  test("existing player file: the default is not placed and the patch rewrites only the keybind line", async () => {
    fs.writeFileSync(optionsPath, XAERO_PLAYER_FILE, "utf-8");
    const infoSpy = spyOn(LauncherLogger, "info");
    const server = serveRelease(
      [{ path: "options.txt", policy: "PRESERVE", content: XAERO_DEFAULT }],
      [xaeroPatch()],
    );
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
        "guiScale:3\nkey_gui.xaero_open_map:key.keyboard.comma\nfov:0.5\n",
      );

      const messages = infoSpy.mock.calls.map(([msg]) => String(msg));
      expect(messages.some((msg) => msg.includes("[Placed] options.txt"))).toBe(
        false,
      );
      // An existing PRESERVE file is skipped before download, so nothing is queued.
      expect(messages.some((msg) => msg.includes("0 to download"))).toBe(true);

      const state = JSON.parse(
        fs.readFileSync(
          path.join(gameDir, ".lampas", "installation.json"),
          "utf-8",
        ),
      );
      expect(state.appliedConfigPatches["xaero-open-map"]).toMatchObject({
        revision: 1,
      });
    } finally {
      infoSpy.mockRestore();
      server.stop(true);
    }
  });
});

describe("validateManifestMetadata: options.txt must be exactly lowercase", () => {
  test("rejects OPTIONS.TXT and Options.txt with PRESERVE", () => {
    for (const target of ["OPTIONS.TXT", "Options.txt"]) {
      expect(() =>
        validateManifestMetadata({
          files: [manifestEntry(target, "PRESERVE")],
        }),
      ).toThrow(/protected or reserved namespace/);
    }
  });

  test("rejects a keybind patch on OPTIONS.TXT", () => {
    expect(() =>
      validateManifestMetadata({
        files: [],
        configPatches: [xaeroPatch({ path: "OPTIONS.TXT" })],
      }),
    ).toThrow(/targets protected namespace/);
  });

  test("rejects an enforce-mode keybind patch, even beside a PRESERVE options.txt", () => {
    expect(() =>
      validateManifestMetadata({
        files: [manifestEntry("options.txt", "PRESERVE")],
        configPatches: [xaeroPatch({ mode: "enforce" })],
      }),
    ).toThrow(/targets protected namespace/);
  });
});

describe("seed placement never overwrites a player file", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(testRoot, "seed-"));
  });

  test("places a missing file and leaves no temp file behind", async () => {
    const source = path.join(scratch, "source.txt");
    const destination = path.join(scratch, "options.txt");
    fs.writeFileSync(source, PACK_DEFAULT_OPTIONS);
    expect(await placeSeedFileIfAbsent(source, destination)).toBe("placed");
    expect(fs.readFileSync(destination).equals(PACK_DEFAULT_OPTIONS)).toBe(
      true,
    );
    expect(fs.readdirSync(scratch).sort()).toEqual([
      "options.txt",
      "source.txt",
    ]);
  });

  test("keeps an existing file and leaves no temp file behind", async () => {
    const source = path.join(scratch, "source.txt");
    const destination = path.join(scratch, "options.txt");
    fs.writeFileSync(source, PACK_DEFAULT_OPTIONS);
    fs.writeFileSync(destination, PLAYER_OPTIONS);
    expect(await placeSeedFileIfAbsent(source, destination)).toBe("kept");
    expect(fs.readFileSync(destination).equals(PLAYER_OPTIONS)).toBe(true);
    expect(fs.readdirSync(scratch).sort()).toEqual([
      "options.txt",
      "source.txt",
    ]);
  });

  test("sync keeps a player options.txt that appears after the existence check", async () => {
    const infoSpy = spyOn(LauncherLogger, "info");
    const realLink = fs.promises.link;
    // Simulate the player's file appearing just before the placement step.
    const linkSpy = spyOn(fs.promises, "link").mockImplementation(
      async (existingPath, newPath) => {
        fs.writeFileSync(String(newPath), PLAYER_OPTIONS);
        return realLink(existingPath, newPath);
      },
    );
    const server = serveRelease([OPTIONS_PRESERVE()]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(optionsPath).equals(PLAYER_OPTIONS)).toBe(true);
      expect(
        infoSpy.mock.calls.some(([msg]) =>
          String(msg).includes("[Kept] options.txt"),
        ),
      ).toBe(true);
    } finally {
      linkSpy.mockRestore();
      infoSpy.mockRestore();
      server.stop(true);
    }
  });
});

describe("version and protocol gates run before schema validation", () => {
  const markerPath = () => path.join(gameDir, ".lampas", "sync-safety.json");

  test("a future minimumLauncherVersion with a protected-path entry reports update-required and persists no safety block", async () => {
    const server = serveRelease(
      [
        {
          path: "options.txt",
          policy: "MANAGED",
          content: Buffer.from("server-list", "utf-8"),
        },
      ],
      [],
      { release: { minimumLauncherVersion: "99.0.0" } },
    );
    try {
      const error = await LauncherSync.syncClient(() => {}).catch((e) => e);
      expect(error.message).toMatch(/Launcher update required/);
      expect(error.message).not.toMatch(/protected/);
      expect(fs.existsSync(markerPath())).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("an unsupported protocol with a protected-path entry reports update-required and persists no safety block", async () => {
    const server = serveRelease(
      [
        {
          path: "options.txt",
          policy: "MANAGED",
          content: Buffer.from("server-list", "utf-8"),
        },
      ],
      [],
      { manifest: { protocol: 4 } },
    );
    try {
      const error = await LauncherSync.syncClient(() => {}).catch((e) => e);
      expect(error.message).toMatch(/Unsupported modpack protocol/);
      expect(error.message).not.toMatch(/protected/);
      expect(fs.existsSync(markerPath())).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("the Mods tab catalog rejects a newer release with the update-required message", async () => {
    LauncherSync.invalidateModCatalog();
    const server = serveRelease([], [], {
      release: { minimumLauncherVersion: "99.0.0" },
    });
    try {
      await expect(LauncherSync.getModCatalog()).rejects.toThrow(
        /Launcher update required/,
      );
    } finally {
      LauncherSync.invalidateModCatalog();
      server.stop(true);
    }
  });

  test("a persisted SCHEMA safety block clears after a later successful sync", async () => {
    const failing = serveRelease([
      {
        path: "options.txt",
        policy: "MANAGED",
        content: Buffer.from("server-list", "utf-8"),
      },
    ]);
    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /protected namespace/,
      );
    } finally {
      failing.stop(true);
    }
    expect(JSON.parse(fs.readFileSync(markerPath(), "utf-8")).reason).toBe(
      "SCHEMA",
    );

    const succeeding = serveRelease([OPTIONS_PRESERVE()]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
    } finally {
      succeeding.stop(true);
    }
    expect(fs.existsSync(markerPath())).toBe(false);
  });
});

describe("sync with an unreadable options.txt", () => {
  test("a directory named options.txt defers the keybind patch and does not fail the sync", async () => {
    fs.mkdirSync(optionsPath);
    const server = serveRelease([], [xaeroPatch()]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.statSync(optionsPath).isDirectory()).toBe(true);
      const state = JSON.parse(
        fs.readFileSync(
          path.join(gameDir, ".lampas", "installation.json"),
          "utf-8",
        ),
      );
      expect(state.appliedConfigPatches?.["xaero-open-map"]).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});

// servers.dat is binary NBT. The bytes include NUL and high-bit values, so any
// text conversion would change them.
const SERVERS_DEFAULT = Buffer.from(
  "0a0000090007736572766572730000ff00fe0d0a00",
  "hex",
);
const PLAYER_SERVERS = Buffer.from(
  "0a0000090007736572766572730000ff00aa1100",
  "hex",
);

function serversSeed(): ServedFile {
  return { path: "servers.dat", policy: "PRESERVE", content: SERVERS_DEFAULT };
}

function serversPatch() {
  return {
    id: "servers-patch",
    revision: 1,
    path: "servers.dat",
    adapter: "json",
    mode: "enforce",
    missingFile: "defer",
    operations: [{ op: "set", path: ["name"], value: "Lampas" }],
  };
}

describe("validateManifestMetadata: servers.dat seed and patches", () => {
  test("rejects a config patch on servers.dat, even beside a PRESERVE servers.dat", () => {
    expect(() =>
      validateManifestMetadata({
        files: [manifestEntry("servers.dat", "PRESERVE")],
        configPatches: [serversPatch()],
      }),
    ).toThrow(/targets protected namespace/);
  });

  test("rejects a keybind-shaped patch on servers.dat, because the keybind exception is options.txt only", () => {
    expect(() =>
      validateManifestMetadata({
        files: [],
        configPatches: [xaeroPatch({ path: "servers.dat" })],
      }),
    ).toThrow(/targets protected namespace/);
  });
});

describe("sync places the pack's default servers.dat", () => {
  const serversPathFor = () => path.join(gameDir, "servers.dat");

  test("places servers.dat with exact bytes when the player has none", async () => {
    const server = serveRelease([serversSeed()]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(serversPathFor()).equals(SERVERS_DEFAULT)).toBe(
        true,
      );
    } finally {
      server.stop(true);
    }
  });

  test("leaves an existing servers.dat byte-identical", async () => {
    fs.writeFileSync(serversPathFor(), PLAYER_SERVERS);
    const server = serveRelease([serversSeed()]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(serversPathFor()).equals(PLAYER_SERVERS)).toBe(
        true,
      );
    } finally {
      server.stop(true);
    }
  });

  test("does not record servers.dat in installation state, and a later sync keeps the player's file", async () => {
    const managed: ServedFile = {
      path: "config/pack-settings.json",
      policy: "MANAGED",
      content: Buffer.from('{"enabled":true}\n', "utf-8"),
    };
    const server = serveRelease([serversSeed(), managed]);
    try {
      const first = await LauncherSync.syncClient(() => {});
      expect(first.success).toBe(true);

      const state = JSON.parse(
        fs.readFileSync(
          path.join(gameDir, ".lampas", "installation.json"),
          "utf-8",
        ),
      );
      expect(state.files["servers.dat"]).toBeUndefined();
      expect(state.files["config/pack-settings.json"]).toBeDefined();

      fs.writeFileSync(serversPathFor(), PLAYER_SERVERS);
      const second = await LauncherSync.syncClient(() => {});
      expect(second.success).toBe(true);
      expect(fs.readFileSync(serversPathFor()).equals(PLAYER_SERVERS)).toBe(
        true,
      );
    } finally {
      server.stop(true);
    }
  });

  test("sync keeps a player servers.dat that appears after the existence check", async () => {
    const infoSpy = spyOn(LauncherLogger, "info");
    const realLink = fs.promises.link;
    // Simulate the player's file appearing just before the placement step.
    const linkSpy = spyOn(fs.promises, "link").mockImplementation(
      async (existingPath, newPath) => {
        fs.writeFileSync(String(newPath), PLAYER_SERVERS);
        return realLink(existingPath, newPath);
      },
    );
    const server = serveRelease([serversSeed()]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.readFileSync(serversPathFor()).equals(PLAYER_SERVERS)).toBe(
        true,
      );
      expect(
        infoSpy.mock.calls.some(([msg]) =>
          String(msg).includes("[Kept] servers.dat"),
        ),
      ).toBe(true);
    } finally {
      linkSpy.mockRestore();
      infoSpy.mockRestore();
      server.stop(true);
    }
  });

  test("rejects a manifest that ships servers.dat with policy MANAGED", async () => {
    const server = serveRelease([
      { path: "servers.dat", policy: "MANAGED", content: SERVERS_DEFAULT },
    ]);
    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /protected namespace/,
      );
      expect(fs.existsSync(serversPathFor())).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a manifest that ships Servers.dat with policy PRESERVE", async () => {
    const server = serveRelease([
      { path: "Servers.dat", policy: "PRESERVE", content: SERVERS_DEFAULT },
    ]);
    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /protected namespace/,
      );
      const names = fs.existsSync(gameDir) ? fs.readdirSync(gameDir) : [];
      expect(names.some((name) => name.toLowerCase() === "servers.dat")).toBe(
        false,
      );
    } finally {
      server.stop(true);
    }
  });

  test("rejects a config patch on servers.dat and creates nothing", async () => {
    const server = serveRelease([serversSeed()], [serversPatch()]);
    try {
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /protected namespace/,
      );
      expect(fs.existsSync(serversPathFor())).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

function symlinksSupported(): boolean {
  const probeDir = fs.mkdtempSync(path.join(testRoot, "symlink-probe-"));
  try {
    fs.writeFileSync(path.join(probeDir, "target.txt"), "");
    fs.symlinkSync(
      path.join(probeDir, "target.txt"),
      path.join(probeDir, "link.txt"),
    );
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}
const SYMLINKS_SUPPORTED = symlinksSupported();

describe("seed placement: link failures fall back to an exclusive copy", () => {
  let scratch: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(testRoot, "seed-link-"));
    source = path.join(scratch, "source.txt");
    destination = path.join(scratch, "options.txt");
    fs.writeFileSync(source, PACK_DEFAULT_OPTIONS);
  });

  for (const code of ["EISDIR", "EINVAL", "EPERM", "EXDEV"]) {
    test(`link failing with ${code} places the seed by an exclusive copy with exact bytes`, async () => {
      const linkSpy = spyOn(fs.promises, "link").mockImplementation(
        async () => {
          throw Object.assign(new Error(`simulated ${code}`), { code });
        },
      );
      try {
        expect(await placeSeedFileIfAbsent(source, destination)).toBe("placed");
        expect(fs.readFileSync(destination).equals(PACK_DEFAULT_OPTIONS)).toBe(
          true,
        );
        expect(fs.readdirSync(scratch).sort()).toEqual([
          "options.txt",
          "source.txt",
        ]);
      } finally {
        linkSpy.mockRestore();
      }
    });
  }

  test("link failing with EEXIST keeps the existing entry", async () => {
    const linkSpy = spyOn(fs.promises, "link").mockImplementation(async () => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });
    fs.writeFileSync(destination, PLAYER_OPTIONS);
    try {
      expect(await placeSeedFileIfAbsent(source, destination)).toBe("kept");
      expect(fs.readFileSync(destination).equals(PLAYER_OPTIONS)).toBe(true);
    } finally {
      linkSpy.mockRestore();
    }
  });

  test("a failed exclusive copy removes its partial destination and the temp file", async () => {
    const realCopy = fs.promises.copyFile;
    const linkSpy = spyOn(fs.promises, "link").mockImplementation(async () => {
      throw Object.assign(new Error("no hard links"), { code: "EPERM" });
    });
    const copySpy = spyOn(fs.promises, "copyFile").mockImplementation(
      async (from, to, mode) => {
        if (String(to) === destination) {
          fs.writeFileSync(destination, "partial");
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        return realCopy(from, to, mode);
      },
    );
    try {
      await expect(placeSeedFileIfAbsent(source, destination)).rejects.toThrow(
        /disk full/,
      );
      expect(fs.readdirSync(scratch).sort()).toEqual(["source.txt"]);
    } finally {
      copySpy.mockRestore();
      linkSpy.mockRestore();
    }
  });
});

describe("seed placement: existing entries are kept, never followed", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(testRoot, "seed-entry-"));
  });

  test("a directory at the destination is kept", async () => {
    const source = path.join(scratch, "source.txt");
    const destination = path.join(scratch, "servers.dat");
    fs.writeFileSync(source, SERVERS_DEFAULT);
    fs.mkdirSync(destination);
    expect(await placeSeedFileIfAbsent(source, destination)).toBe("kept");
    expect(fs.statSync(destination).isDirectory()).toBe(true);
  });

  (SYMLINKS_SUPPORTED ? test : test.skip)(
    "a dangling symlink at the destination is kept and not replaced",
    async () => {
      const source = path.join(scratch, "source.txt");
      const destination = path.join(scratch, "options.txt");
      const missingTarget = path.join(scratch, "missing.txt");
      fs.writeFileSync(source, PACK_DEFAULT_OPTIONS);
      fs.symlinkSync(missingTarget, destination);
      expect(await placeSeedFileIfAbsent(source, destination)).toBe("kept");
      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(missingTarget)).toBe(false);
    },
  );
});

describe("sync keeps an existing symlink or directory at a seed path", () => {
  (SYMLINKS_SUPPORTED ? test : test.skip)(
    "a symlinked options.txt is kept, and its target is untouched",
    async () => {
      const outside = path.join(testRoot, `seed-target-${Date.now()}.txt`);
      fs.writeFileSync(outside, PLAYER_OPTIONS);
      fs.symlinkSync(outside, optionsPath);
      const server = serveRelease([OPTIONS_PRESERVE()]);
      try {
        const result = await LauncherSync.syncClient(() => {});
        expect(result.success).toBe(true);
        expect(fs.lstatSync(optionsPath).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(outside).equals(PLAYER_OPTIONS)).toBe(true);
      } finally {
        server.stop(true);
      }
    },
  );

  (SYMLINKS_SUPPORTED ? test : test.skip)(
    "a dangling symlink options.txt is kept and not replaced",
    async () => {
      const missing = path.join(testRoot, `missing-seed-${Date.now()}.txt`);
      fs.symlinkSync(missing, optionsPath);
      const infoSpy = spyOn(LauncherLogger, "info");
      const server = serveRelease([OPTIONS_PRESERVE()]);
      try {
        const result = await LauncherSync.syncClient(() => {});
        expect(result.success).toBe(true);
        expect(fs.lstatSync(optionsPath).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(missing)).toBe(false);
        // The seed is not fetched at all when an entry exists.
        expect(
          infoSpy.mock.calls.some(([msg]) =>
            String(msg).includes("0 to download"),
          ),
        ).toBe(true);
      } finally {
        infoSpy.mockRestore();
        server.stop(true);
      }
    },
  );

  test("a directory named servers.dat is kept", async () => {
    const serversPath = path.join(gameDir, "servers.dat");
    fs.mkdirSync(serversPath);
    const server = serveRelease([
      { path: "servers.dat", policy: "PRESERVE", content: SERVERS_DEFAULT },
    ]);
    try {
      const result = await LauncherSync.syncClient(() => {});
      expect(result.success).toBe(true);
      expect(fs.statSync(serversPath).isDirectory()).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
