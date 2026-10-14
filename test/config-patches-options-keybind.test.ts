import {
  afterAll,
  afterEach,
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
import type { ConfigPatch, InstallationState } from "../src/types";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-options-keybind-test-"),
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
const { reconcileConfigPatches } =
  await import("../src/config-patches/reconciler");
const { isOptionsKeybindPatch, validateManifestMetadata } =
  await import("../src/path-policy");

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

const SNAPPY_KEY = "key_key.snappy_tappy.toggle";
const FIGURA_KEY = "key_figura.config.action_wheel_button";

function keybindPatch(overrides: Partial<ConfigPatch> = {}): ConfigPatch {
  return {
    id: "unbind-snappy-tappy",
    revision: 3,
    path: "options.txt",
    adapter: "properties",
    mode: "once",
    missingFile: "defer",
    operations: [
      {
        op: "set",
        path: [SNAPPY_KEY],
        value: "key.keyboard.unknown",
      },
    ],
    ...overrides,
  };
}

function emptyState(
  appliedConfigPatches?: InstallationState["appliedConfigPatches"],
): InstallationState {
  return {
    pack: "Lampas 2",
    version: "2.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    files: {},
    appliedConfigPatches,
  };
}

describe("isOptionsKeybindPatch", () => {
  test("accepts a set of a key_ entry to a key.keyboard value on options.txt", () => {
    expect(isOptionsKeybindPatch(keybindPatch())).toBe(true);
  });

  test("accepts a key.mouse value", () => {
    expect(
      isOptionsKeybindPatch(
        keybindPatch({
          operations: [
            { op: "set", path: [FIGURA_KEY], value: "key.mouse.middle" },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("rejects a non-key option", () => {
    expect(
      isOptionsKeybindPatch(
        keybindPatch({
          operations: [
            { op: "set", path: ["guiScale"], value: "key.keyboard.unknown" },
          ],
        }),
      ),
    ).toBe(false);
  });

  test("rejects a key_ entry whose value is not a key binding", () => {
    for (const value of ["2", "true"]) {
      expect(
        isOptionsKeybindPatch(
          keybindPatch({
            operations: [{ op: "set", path: [SNAPPY_KEY], value }],
          }),
        ),
      ).toBe(false);
    }
  });

  test("rejects a remove op", () => {
    expect(
      isOptionsKeybindPatch(
        keybindPatch({
          operations: [{ op: "remove", path: [SNAPPY_KEY] }],
        }),
      ),
    ).toBe(false);
  });

  test("rejects missingFile create", () => {
    expect(isOptionsKeybindPatch(keybindPatch({ missingFile: "create" }))).toBe(
      false,
    );
  });

  test("rejects the json adapter", () => {
    expect(isOptionsKeybindPatch(keybindPatch({ adapter: "json" }))).toBe(
      false,
    );
  });

  test("rejects another protected path", () => {
    expect(isOptionsKeybindPatch(keybindPatch({ path: "servers.dat" }))).toBe(
      false,
    );
  });

  test("rejects a multi-element path", () => {
    expect(
      isOptionsKeybindPatch(
        keybindPatch({
          operations: [
            {
              op: "set",
              path: [SNAPPY_KEY, "extra"],
              value: "key.keyboard.unknown",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  test("rejects an empty operations list", () => {
    expect(isOptionsKeybindPatch(keybindPatch({ operations: [] }))).toBe(false);
  });
});

describe("reconcileConfigPatches on options.txt keybinds", () => {
  let gameDir: string;
  let optionsPath: string;

  beforeEach(() => {
    gameDir = fs.mkdtempSync(path.join(testRoot, "game-"));
    optionsPath = path.join(gameDir, "options.txt");
  });

  afterEach(() => {
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  test("rebinds only the targeted key and keeps the ':' separator", async () => {
    const source =
      "guiScale:2\n" +
      `${SNAPPY_KEY}:key.keyboard.grave.accent\n` +
      `${FIGURA_KEY}:key.keyboard.grave.accent\n` +
      "fov:0.0\n";
    fs.writeFileSync(optionsPath, source, "utf-8");

    const res = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });

    expect(res.appliedCount).toBe(1);
    expect(res.deferredCount).toBe(0);
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
      "guiScale:2\n" +
        `${SNAPPY_KEY}:key.keyboard.unknown\n` +
        `${FIGURA_KEY}:key.keyboard.grave.accent\n` +
        "fov:0.0\n",
    );
    expect(res.appliedState["unbind-snappy-tappy"]).toEqual({
      revision: 3,
      appliedAt: expect.any(String),
    });
  });

  test("once mode does not rewrite options.txt again after the user rebinds the key", async () => {
    fs.writeFileSync(
      optionsPath,
      `${SNAPPY_KEY}:key.keyboard.grave.accent\n`,
      "utf-8",
    );

    const first = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });
    expect(first.appliedCount).toBe(1);

    const userRebound = `${SNAPPY_KEY}:key.keyboard.f6\n`;
    fs.writeFileSync(optionsPath, userRebound, "utf-8");

    const second = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(first.appliedState),
    });

    expect(second.appliedCount).toBe(0);
    expect(second.unchangedCount).toBe(1);
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(userRebound);
  });

  test("defers when options.txt is missing and creates nothing", async () => {
    const res = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });

    expect(res.deferredCount).toBe(1);
    expect(res.appliedCount).toBe(0);
    expect(fs.existsSync(optionsPath)).toBe(false);
    expect(res.appliedState["unbind-snappy-tappy"]).toBeUndefined();
  });

  test("defers without writing when the key line is absent", async () => {
    const source = "guiScale:2\nfov:0.0\n";
    fs.writeFileSync(optionsPath, source, "utf-8");

    const res = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });

    expect(res.deferredCount).toBe(1);
    expect(res.appliedCount).toBe(0);
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(source);
    expect(res.appliedState["unbind-snappy-tappy"]).toBeUndefined();
  });

  test("rejects a non-keybind op on options.txt as an unsafe target", async () => {
    const source = "guiScale:2\n";
    fs.writeFileSync(optionsPath, source, "utf-8");

    await expect(
      reconcileConfigPatches({
        gameDir,
        patches: [
          keybindPatch({
            operations: [{ op: "set", path: ["guiScale"], value: "3" }],
          }),
        ],
        prevState: emptyState(),
      }),
    ).rejects.toThrow(/unsafe target path 'options.txt'/);

    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(source);
  });

  test("rejects a keybind-shaped patch on servers.dat as an unsafe target", async () => {
    const serversPath = path.join(gameDir, "servers.dat");
    const source = `${SNAPPY_KEY}:key.keyboard.grave.accent\n`;
    fs.writeFileSync(serversPath, source, "utf-8");

    await expect(
      reconcileConfigPatches({
        gameDir,
        patches: [keybindPatch({ path: "servers.dat" })],
        prevState: emptyState(),
      }),
    ).rejects.toThrow(/unsafe target path 'servers.dat'/);

    expect(fs.readFileSync(serversPath, "utf-8")).toBe(source);
  });
});

describe("validateManifestMetadata config patches on options.txt", () => {
  test("accepts a keybind-shaped patch on options.txt", () => {
    expect(() =>
      validateManifestMetadata({ files: [], configPatches: [keybindPatch()] }),
    ).not.toThrow();
  });

  test("still rejects a non-keybind patch on options.txt", () => {
    expect(() =>
      validateManifestMetadata({
        files: [],
        configPatches: [
          keybindPatch({
            operations: [{ op: "set", path: ["guiScale"], value: "2" }],
          }),
        ],
      }),
    ).toThrow(/targets protected namespace/);
  });
});

describe("keybind patch shape: mode and exact path", () => {
  test("rejects an enforce-mode keybind patch, which would revert rebinds every sync", () => {
    expect(isOptionsKeybindPatch(keybindPatch({ mode: "enforce" }))).toBe(
      false,
    );
  });

  test("rejects a keybind patch whose path is not exactly lowercase options.txt", () => {
    for (const target of ["OPTIONS.TXT", "Options.txt", "options.TXT"]) {
      expect(isOptionsKeybindPatch(keybindPatch({ path: target }))).toBe(false);
    }
  });

  test("reconcile throws for an enforce-mode keybind patch on options.txt", async () => {
    const gameDir = fs.mkdtempSync(path.join(testRoot, "game-"));
    const optionsPath = path.join(gameDir, "options.txt");
    const source = `${SNAPPY_KEY}:key.keyboard.grave.accent\n`;
    fs.writeFileSync(optionsPath, source, "utf-8");
    await expect(
      reconcileConfigPatches({
        gameDir,
        patches: [keybindPatch({ mode: "enforce" })],
        prevState: emptyState(),
      }),
    ).rejects.toThrow(/unsafe target path 'options.txt'/);
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(source);
  });

  test("reconcile treats OPTIONS.TXT as an unsafe target, not as the keybind exception", async () => {
    const gameDir = fs.mkdtempSync(path.join(testRoot, "game-"));
    fs.writeFileSync(
      path.join(gameDir, "OPTIONS.TXT"),
      `${SNAPPY_KEY}:key.keyboard.grave.accent\n`,
      "utf-8",
    );
    await expect(
      reconcileConfigPatches({
        gameDir,
        patches: [keybindPatch({ path: "OPTIONS.TXT" })],
        prevState: emptyState(),
      }),
    ).rejects.toThrow(/unsafe target path 'OPTIONS.TXT'/);
  });
});

describe("keybind rewrite: line endings and matching", () => {
  let gameDir: string;
  let optionsPath: string;

  beforeEach(() => {
    gameDir = fs.mkdtempSync(path.join(testRoot, "game-"));
    optionsPath = path.join(gameDir, "options.txt");
  });

  test("regression: a \r\r\n line is rewritten in place, not appended, and does not fail", async () => {
    fs.writeFileSync(
      optionsPath,
      `${SNAPPY_KEY}:key.keyboard.grave.accent\r\r\nfov:0.0\r\r\n`,
      "utf-8",
    );
    const res = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });
    expect(res.appliedCount).toBe(1);
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
      `${SNAPPY_KEY}:key.keyboard.unknown\r\r\nfov:0.0\r\r\n`,
    );
  });

  test("CRLF file stays CRLF after the rewrite", async () => {
    fs.writeFileSync(
      optionsPath,
      `guiScale:2\r\n${SNAPPY_KEY}:key.keyboard.grave.accent\r\nfov:0.0\r\n`,
      "utf-8",
    );
    await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
      `guiScale:2\r\n${SNAPPY_KEY}:key.keyboard.unknown\r\nfov:0.0\r\n`,
    );
  });

  test("mixed endings: only the rewritten line changes, and it keeps its own terminator", async () => {
    fs.writeFileSync(
      optionsPath,
      `guiScale:2\n${SNAPPY_KEY}:key.keyboard.grave.accent\r\nfov:0.0\n`,
      "utf-8",
    );
    await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
      `guiScale:2\n${SNAPPY_KEY}:key.keyboard.unknown\r\nfov:0.0\n`,
    );
  });

  test("rewrites the value of every matching line, keeps each EOL, and never appends", async () => {
    fs.writeFileSync(
      optionsPath,
      `${SNAPPY_KEY}:key.keyboard.grave.accent\r\nfov:0.0\n${SNAPPY_KEY}:key.keyboard.f6\n`,
      "utf-8",
    );
    const res = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });
    expect(res.appliedCount).toBe(1);
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
      `${SNAPPY_KEY}:key.keyboard.unknown\r\nfov:0.0\n${SNAPPY_KEY}:key.keyboard.unknown\n`,
    );
  });

  test("a lone CR inside a key line's value does not match, so the key counts as missing and the patch defers", async () => {
    const source = "key_a:x\rkey_b:y\n";
    fs.writeFileSync(optionsPath, source, "utf-8");
    const res = await reconcileConfigPatches({
      gameDir,
      patches: [
        keybindPatch({
          operations: [
            { op: "set", path: ["key_a"], value: "key.keyboard.unknown" },
          ],
        }),
      ],
      prevState: emptyState(),
    });
    expect(res.deferredCount).toBe(1);
    expect(res.appliedState["unbind-snappy-tappy"]).toBeUndefined();
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(source);
  });

  test("keeps a file without a trailing newline without one", async () => {
    fs.writeFileSync(
      optionsPath,
      `guiScale:2\n${SNAPPY_KEY}:key.keyboard.grave.accent`,
      "utf-8",
    );
    await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
      `guiScale:2\n${SNAPPY_KEY}:key.keyboard.unknown`,
    );
  });

  test("matches a key line with leading whitespace and a space after the colon", async () => {
    fs.writeFileSync(
      optionsPath,
      `  ${SNAPPY_KEY}: key.keyboard.grave.accent\n`,
      "utf-8",
    );
    const res = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });
    expect(res.appliedCount).toBe(1);
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(
      `  ${SNAPPY_KEY}: key.keyboard.unknown\n`,
    );
  });
});

describe("keybind rewrite: unreadable options.txt defers instead of failing", () => {
  let gameDir: string;
  let optionsPath: string;

  beforeEach(() => {
    gameDir = fs.mkdtempSync(path.join(testRoot, "game-"));
    optionsPath = path.join(gameDir, "options.txt");
  });

  test("EISDIR: options.txt is a directory, so the patch defers with a WARN", async () => {
    fs.mkdirSync(optionsPath);
    const warnSpy = spyOn(LauncherLogger, "warn");
    try {
      const res = await reconcileConfigPatches({
        gameDir,
        patches: [keybindPatch()],
        prevState: emptyState(),
      });
      expect(res.deferredCount).toBe(1);
      expect(res.appliedCount).toBe(0);
      expect(res.appliedState["unbind-snappy-tappy"]).toBeUndefined();
      expect(fs.statSync(optionsPath).isDirectory()).toBe(true);
      expect(
        warnSpy.mock.calls.some(([msg]) =>
          String(msg).includes("could not be safely read"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("null bytes in options.txt defer without writing and without once-state", async () => {
    const source = `${SNAPPY_KEY}:key.keyboard.grave.accent\0\n`;
    fs.writeFileSync(optionsPath, source, "utf-8");
    const res = await reconcileConfigPatches({
      gameDir,
      patches: [keybindPatch()],
      prevState: emptyState(),
    });
    expect(res.deferredCount).toBe(1);
    expect(res.appliedState["unbind-snappy-tappy"]).toBeUndefined();
    expect(fs.readFileSync(optionsPath, "utf-8")).toBe(source);
  });

  test("a non-keybind patch on a directory named options.txt still fails", async () => {
    fs.mkdirSync(optionsPath);
    await expect(
      reconcileConfigPatches({
        gameDir,
        patches: [
          keybindPatch({
            operations: [{ op: "set", path: ["guiScale"], value: "2" }],
          }),
        ],
        prevState: emptyState(),
      }),
    ).rejects.toThrow(/unsafe target path/);
  });
});

// Symlink creation needs a privilege on some Windows setups. Symlink tests are
// skipped there rather than reported as passing without running.
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
const readOnlyEnforced = !(
  typeof process.getuid === "function" && process.getuid() === 0
);

describe("keybind patch: symlinked and unreadable options.txt defer", () => {
  let gameDir: string;
  let optionsPath: string;

  beforeEach(() => {
    gameDir = fs.mkdtempSync(path.join(testRoot, "game-"));
    optionsPath = path.join(gameDir, "options.txt");
  });

  (SYMLINKS_SUPPORTED ? test : test.skip)(
    "a symlinked options.txt defers with a WARN, does not throw, and leaves the target alone",
    async () => {
      const outside = path.join(testRoot, `outside-${Date.now()}.txt`);
      const outsideSource = `${SNAPPY_KEY}:key.keyboard.grave.accent\n`;
      fs.writeFileSync(outside, outsideSource, "utf-8");
      fs.symlinkSync(outside, optionsPath);
      const warnSpy = spyOn(LauncherLogger, "warn");
      try {
        const res = await reconcileConfigPatches({
          gameDir,
          patches: [keybindPatch()],
          prevState: emptyState(),
        });
        expect(res.deferredCount).toBe(1);
        expect(res.appliedState["unbind-snappy-tappy"]).toBeUndefined();
        expect(fs.readFileSync(outside, "utf-8")).toBe(outsideSource);
        expect(fs.lstatSync(optionsPath).isSymbolicLink()).toBe(true);
        expect(
          warnSpy.mock.calls.some(([msg]) =>
            String(msg).includes("physical containment check"),
          ),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  (SYMLINKS_SUPPORTED ? test : test.skip)(
    "a dangling symlink options.txt defers and is not replaced",
    async () => {
      fs.symlinkSync(path.join(testRoot, "missing-target.txt"), optionsPath);
      const res = await reconcileConfigPatches({
        gameDir,
        patches: [keybindPatch()],
        prevState: emptyState(),
      });
      expect(res.deferredCount).toBe(1);
      expect(fs.lstatSync(optionsPath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(testRoot, "missing-target.txt"))).toBe(
        false,
      );
    },
  );

  (SYMLINKS_SUPPORTED ? test : test.skip)(
    "a non-keybind patch still throws on a symlinked target",
    async () => {
      const configDir = path.join(gameDir, "config");
      fs.mkdirSync(configDir);
      const outside = path.join(testRoot, `chat-${Date.now()}.json`);
      fs.writeFileSync(outside, '{"volume":1}', "utf-8");
      fs.symlinkSync(outside, path.join(configDir, "chat.json"));
      await expect(
        reconcileConfigPatches({
          gameDir,
          patches: [
            {
              id: "chat-volume",
              revision: 1,
              path: "config/chat.json",
              adapter: "json",
              mode: "enforce",
              missingFile: "defer",
              operations: [{ op: "set", path: ["volume"], value: 2 }],
            },
          ],
          prevState: emptyState(),
        }),
      ).rejects.toThrow(/Prohibited symbolic link/);
      expect(fs.readFileSync(outside, "utf-8")).toBe('{"volume":1}');
    },
  );

  test("bytes that are not valid UTF-8 defer with a WARN and the file stays byte-identical", async () => {
    const source = Buffer.concat([
      Buffer.from("guiScale:2\nname:caf", "utf-8"),
      Buffer.from([0xe9]),
      Buffer.from(`\n${SNAPPY_KEY}:key.keyboard.grave.accent\n`, "utf-8"),
    ]);
    fs.writeFileSync(optionsPath, source);
    const warnSpy = spyOn(LauncherLogger, "warn");
    try {
      const res = await reconcileConfigPatches({
        gameDir,
        patches: [keybindPatch()],
        prevState: emptyState(),
      });
      expect(res.deferredCount).toBe(1);
      expect(res.appliedState["unbind-snappy-tappy"]).toBeUndefined();
      expect(fs.readFileSync(optionsPath).equals(source)).toBe(true);
      expect(
        warnSpy.mock.calls.some(([msg]) =>
          String(msg).includes("could not be safely read"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  (readOnlyEnforced ? test : test.skip)(
    "a read-only options.txt defers with a WARN, is not rewritten, and keeps its mode",
    async () => {
      const source = `${SNAPPY_KEY}:key.keyboard.grave.accent\n`;
      fs.writeFileSync(optionsPath, source, "utf-8");
      fs.chmodSync(optionsPath, 0o444);
      const modeBefore = fs.statSync(optionsPath).mode & 0o777;
      const warnSpy = spyOn(LauncherLogger, "warn");
      try {
        const res = await reconcileConfigPatches({
          gameDir,
          patches: [keybindPatch()],
          prevState: emptyState(),
        });
        expect(res.deferredCount).toBe(1);
        expect(res.appliedState["unbind-snappy-tappy"]).toBeUndefined();
        expect(fs.statSync(optionsPath).mode & 0o777).toBe(modeBefore);
        expect(fs.readFileSync(optionsPath, "utf-8")).toBe(source);
        expect(
          warnSpy.mock.calls.some(([msg]) =>
            String(msg).includes("not writable"),
          ),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
        fs.chmodSync(optionsPath, 0o644);
      }
    },
  );
});
