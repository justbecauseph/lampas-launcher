import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-gamedir-test-"));
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openExternal: async () => undefined, openPath: async () => "" },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
}));

const { ConfigManager, getDefaultGameDir, getUserDataDir } = await import("../src/config");
const { GameDirectoryManager } = await import("../src/game-directory");
const { GameRunner } = await import("../src/game-runner");

beforeEach(() => {
  process.env.LAMPAS_DEFAULT_GAME_DIR = path.join(testRoot, "default-lampas-game");
  ConfigManager.resetForTesting();
  GameDirectoryManager.resetForTesting();
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterAll(() => {
  delete process.env.LAMPAS_DEFAULT_GAME_DIR;
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("GameDirectoryManager & Installation Relocation", () => {
  test("fresh installation requires initial directory confirmation", () => {
    ConfigManager.resetForTesting();
    const status = GameDirectoryManager.getStatus();
    expect(status.isConfigured).toBe(false);
    expect(GameDirectoryManager.needsInitialSetup()).toBe(true);
    expect(status.gameDir).toBe(path.resolve(path.join(testRoot, "default-lampas-game")));
  });

  test("legacy config with non-empty gameDir is automatically treated as configured", () => {
    ConfigManager.resetForTesting();
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        portalUrl: "https://dev.lampas.town",
        gameDir: path.join(testRoot, "legacy-game"),
      })
    );

    const status = GameDirectoryManager.getStatus();
    expect(status.isConfigured).toBe(true);
    expect(GameDirectoryManager.needsInitialSetup()).toBe(false);
    expect(status.gameDir).toBe(path.join(testRoot, "legacy-game"));
  });

  test("existing disk installation with .lampas/installation.json is treated as configured", () => {
    ConfigManager.resetForTesting();
    const defaultDir = getDefaultGameDir();
    const stateFile = path.join(defaultDir, ".lampas", "installation.json");

    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ pack: "Lampas 2", version: "2.0.0" }));

      const status = GameDirectoryManager.getStatus();
      expect(status.isConfigured).toBe(true);
      expect(GameDirectoryManager.needsInitialSetup()).toBe(false);
      expect(status.hasInstallation).toBe(true);
    } finally {
      if (fs.existsSync(path.join(defaultDir, ".lampas"))) {
        try {
          fs.rmSync(path.join(defaultDir, ".lampas"), { recursive: true, force: true });
        } catch {}
      }
    }
  });

  test("accepting default path configures and persists gameDir", async () => {
    ConfigManager.resetForTesting();
    const defaultPath = GameDirectoryManager.getDefaultPath();
    const updated = await GameDirectoryManager.configureInitial(defaultPath);

    expect(updated.gameDirConfigured).toBe(true);
    expect(updated.gameDir).toBe(path.resolve(defaultPath));
    expect(GameDirectoryManager.needsInitialSetup()).toBe(false);
    expect(ConfigManager.get().gameDirConfigured).toBe(true);
  });

  test("custom first-run path configures and persists gameDir", async () => {
    ConfigManager.resetForTesting();
    const customDir = path.join(testRoot, "custom-minecraft-folder");
    const updated = await GameDirectoryManager.configureInitial(customDir);

    expect(updated.gameDirConfigured).toBe(true);
    expect(updated.gameDir).toBe(path.resolve(customDir));
    expect(fs.existsSync(customDir)).toBe(true);
    expect(GameDirectoryManager.needsInitialSetup()).toBe(false);
  });

  test("configureInitial is rejected when game directory is already configured", async () => {
    ConfigManager.set({ gameDirConfigured: true });
    await expect(GameDirectoryManager.configureInitial(path.join(testRoot, "another-dir"))).rejects.toThrow(
      "Game directory is already configured; use Move Installation."
    );
  });

  test("validates target paths and rejects invalid, root, identical, or nested paths", () => {
    const current = path.join(testRoot, "installed-here");

    // Empty / whitespace
    expect(GameDirectoryManager.validateTarget("", current).valid).toBe(false);
    expect(GameDirectoryManager.validateTarget("   ", current).valid).toBe(false);

    // Root paths
    expect(GameDirectoryManager.validateTarget(path.parse(process.cwd()).root, current).valid).toBe(false);
    if (process.platform === "win32") {
      expect(GameDirectoryManager.validateTarget("C:\\", current).valid).toBe(false);
      expect(GameDirectoryManager.validateTarget("C:", current).valid).toBe(false);
    } else {
      expect(GameDirectoryManager.validateTarget("/", current).valid).toBe(false);
    }

    // Same path
    expect(GameDirectoryManager.validateTarget(current, current).valid).toBe(false);

    // Target inside current
    const insideTarget = path.join(current, "subfolder");
    expect(GameDirectoryManager.validateTarget(insideTarget, current).valid).toBe(false);

    // Current inside target
    const parentTarget = path.dirname(current);
    expect(GameDirectoryManager.validateTarget(parentTarget, current).valid).toBe(false);

    // Valid sibling path
    const validSibling = path.join(testRoot, "new-sibling-dir");
    expect(GameDirectoryManager.validateTarget(validSibling, current).valid).toBe(true);
  });

  test("rejects move to an existing non-empty directory", async () => {
    const sourceDir = path.join(testRoot, "source-nonempty-test");
    const targetDir = path.join(testRoot, "target-nonempty-test");

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "options.txt"), "sound:1.0");

    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "unrelated.txt"), "some existing data");

    ConfigManager.set({ gameDir: sourceDir, gameDirConfigured: true });

    await expect(GameDirectoryManager.moveInstallation(targetDir)).rejects.toThrow(
      "already exists and is not empty"
    );
    expect(ConfigManager.get().gameDir).toBe(path.resolve(sourceDir));
    expect(fs.existsSync(path.join(sourceDir, "options.txt"))).toBe(true);
  });

  test("rejects move while Minecraft is running", async () => {
    const sourceDir = path.join(testRoot, "source-running-test");
    const targetDir = path.join(testRoot, "target-running-test");
    fs.mkdirSync(sourceDir, { recursive: true });

    ConfigManager.set({ gameDir: sourceDir, gameDirConfigured: true });

    // Mock isGameRunning
    const origIsRunning = GameRunner.isGameRunning;
    (GameRunner as any).isGameRunning = () => true;

    try {
      await expect(GameDirectoryManager.moveInstallation(targetDir)).rejects.toThrow(
        "while Minecraft is running"
      );
    } finally {
      (GameRunner as any).isGameRunning = origIsRunning;
    }
  });

  test("moves entire directory tree and preserves worlds, mods, options, and metadata", async () => {
    const sourceDir = path.join(testRoot, "game-full-source");
    const targetDir = path.join(testRoot, "game-full-target");

    // Populate source tree
    fs.mkdirSync(path.join(sourceDir, ".lampas", "cache", "sha256"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, ".lampas", "installation.json"),
      JSON.stringify({ pack: "Lampas 2", version: "2.0.0", files: {} })
    );
    fs.writeFileSync(path.join(sourceDir, ".lampas", "cache", "sha256", "abc123hash"), "cached data");

    fs.mkdirSync(path.join(sourceDir, "saves", "My World 1"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "saves", "My World 1", "level.dat"), "world-data");

    fs.mkdirSync(path.join(sourceDir, "screenshots"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "screenshots", "2026-08-24.png"), "image-bytes");

    fs.mkdirSync(path.join(sourceDir, "resourcepacks"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "resourcepacks", "custom-pack.zip"), "zip-bytes");

    fs.mkdirSync(path.join(sourceDir, "mods"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "mods", "fabric-api.jar"), "mod-bytes");
    fs.writeFileSync(path.join(sourceDir, "mods", "my-local-mod.jar"), "custom-mod-bytes");

    fs.writeFileSync(path.join(sourceDir, "options.txt"), "fov:90\ngamma:1.0\n");
    fs.writeFileSync(path.join(sourceDir, "servers.dat"), "server-list-data");

    ConfigManager.set({ gameDir: sourceDir, gameDirConfigured: true });

    const progressPhases: string[] = [];
    const result = await GameDirectoryManager.moveInstallation(targetDir, (p) => {
      progressPhases.push(p.phase);
    });

    expect(result.success).toBe(true);
    expect(result.gameDir).toBe(path.resolve(targetDir));
    expect(ConfigManager.get().gameDir).toBe(path.resolve(targetDir));

    // Target has all files
    expect(fs.existsSync(path.join(targetDir, ".lampas", "installation.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, ".lampas", "cache", "sha256", "abc123hash"))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, "saves", "My World 1", "level.dat"), "utf-8")).toBe("world-data");
    expect(fs.readFileSync(path.join(targetDir, "screenshots", "2026-08-24.png"), "utf-8")).toBe("image-bytes");
    expect(fs.readFileSync(path.join(targetDir, "resourcepacks", "custom-pack.zip"), "utf-8")).toBe("zip-bytes");
    expect(fs.readFileSync(path.join(targetDir, "mods", "my-local-mod.jar"), "utf-8")).toBe("custom-mod-bytes");
    expect(fs.readFileSync(path.join(targetDir, "options.txt"), "utf-8")).toBe("fov:90\ngamma:1.0\n");
    expect(fs.readFileSync(path.join(targetDir, "servers.dat"), "utf-8")).toBe("server-list-data");

    // Old source removed
    expect(fs.existsSync(sourceDir)).toBe(false);

    // Journal removed
    expect(fs.existsSync(path.join(userDataDir, "directory-move.json"))).toBe(false);
  });

  test("falls back to copy + verify + staging rename when fs.rename throws EXDEV", async () => {
    const sourceDir = path.join(testRoot, "exdev-source");
    const targetDir = path.join(testRoot, "exdev-target");

    fs.mkdirSync(path.join(sourceDir, "mods"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "options.txt"), "sound:0.8");
    fs.writeFileSync(path.join(sourceDir, "mods", "test.jar"), "test-mod-contents");

    ConfigManager.set({ gameDir: sourceDir, gameDirConfigured: true });

    // Mock rename to simulate EXDEV cross-device move
    GameDirectoryManager._renameFn = (src: string, dst: string) => {
      if (src === path.resolve(sourceDir) && dst === path.resolve(targetDir)) {
        const err: any = new Error("EXDEV: cross-device link not permitted");
        err.code = "EXDEV";
        throw err;
      }
      return fs.renameSync(src, dst);
    };

    try {
      const phases: string[] = [];
      const result = await GameDirectoryManager.moveInstallation(targetDir, (p) => {
        phases.push(p.phase);
      });

      expect(result.success).toBe(true);
      expect(phases).toContain("moving");
      expect(phases).toContain("verifying");
      expect(phases).toContain("cleaning");
      expect(phases).toContain("complete");

      expect(fs.existsSync(path.join(targetDir, "options.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(targetDir, "mods", "test.jar"), "utf-8")).toBe("test-mod-contents");
      expect(fs.existsSync(sourceDir)).toBe(false);
      expect(ConfigManager.get().gameDir).toBe(path.resolve(targetDir));
    } finally {
      GameDirectoryManager.resetForTesting();
    }
  });

  test("failed verification leaves source untouched and cleans up staging", async () => {
    const sourceDir = path.join(testRoot, "verify-fail-source");
    const targetDir = path.join(testRoot, "verify-fail-target");

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "options.txt"), "important-config-never-lose");

    ConfigManager.set({ gameDir: sourceDir, gameDirConfigured: true });

    // Force copy fallback
    GameDirectoryManager._renameFn = (src: string, dst: string) => {
      if (src === path.resolve(sourceDir)) {
        const err: any = new Error("EXDEV");
        err.code = "EXDEV";
        throw err;
      }
      return fs.renameSync(src, dst);
    };

    // Corrupt copied file to simulate disk corruption / verification failure
    GameDirectoryManager._copyFn = (src: string, dst: string) => {
      fs.writeFileSync(dst, "corrupted-content");
    };

    try {
      await expect(GameDirectoryManager.moveInstallation(targetDir)).rejects.toThrow("Verification failed");

      // Source must be completely intact
      expect(fs.existsSync(path.join(sourceDir, "options.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(sourceDir, "options.txt"), "utf-8")).toBe("important-config-never-lose");

      // Target must not exist
      expect(fs.existsSync(targetDir)).toBe(false);

      // Config remains pointing to source
      expect(ConfigManager.get().gameDir).toBe(path.resolve(sourceDir));
    } finally {
      GameDirectoryManager.resetForTesting();
    }
  });

  test("detects same-size file content corruption via SHA-256 verification and aborts move", async () => {
    const sourceDir = path.join(testRoot, "sha-corrupt-source");
    const targetDir = path.join(testRoot, "sha-corrupt-target");

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "options.txt"), "ABCD"); // 4 bytes

    ConfigManager.set({ gameDir: sourceDir, gameDirConfigured: true });

    // Force copy fallback
    GameDirectoryManager._renameFn = (src: string, dst: string) => {
      if (src === path.resolve(sourceDir)) {
        const err: any = new Error("EXDEV");
        err.code = "EXDEV";
        throw err;
      }
      return fs.renameSync(src, dst);
    };

    // Corrupt copied file with EXACT SAME LENGTH but DIFFERENT CONTENT ("WXYZ" instead of "ABCD")
    GameDirectoryManager._copyFn = (src: string, dst: string) => {
      fs.writeFileSync(dst, "WXYZ"); // exactly 4 bytes
    };

    try {
      await expect(GameDirectoryManager.moveInstallation(targetDir)).rejects.toThrow("content SHA-256 mismatch");

      // Source is untouched
      expect(fs.readFileSync(path.join(sourceDir, "options.txt"), "utf-8")).toBe("ABCD");
      expect(fs.existsSync(targetDir)).toBe(false);
      expect(ConfigManager.get().gameDir).toBe(path.resolve(sourceDir));
    } finally {
      GameDirectoryManager.resetForTesting();
    }
  });

  test("moving into an existing empty directory succeeds cleanly without rename failure", async () => {
    const sourceDir = path.join(testRoot, "source-empty-target-test");
    const targetDir = path.join(testRoot, "target-empty-dir");

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "options.txt"), "sound:1.0");

    // Empty directory returned by file chooser
    fs.mkdirSync(targetDir, { recursive: true });
    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.readdirSync(targetDir).length).toBe(0);

    ConfigManager.set({ gameDir: sourceDir, gameDirConfigured: true });

    const result = await GameDirectoryManager.moveInstallation(targetDir);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "options.txt"))).toBe(true);
    expect(fs.existsSync(sourceDir)).toBe(false);
    expect(ConfigManager.get().gameDir).toBe(path.resolve(targetDir));
  });

  test("startup recovery detects same-filesystem rename crash before config update and finalizes config", async () => {
    const oldSource = path.join(testRoot, "direct-rename-crashed-source");
    const newTarget = path.join(testRoot, "direct-rename-crashed-target");

    // Source was already renamed to target on disk
    fs.mkdirSync(newTarget, { recursive: true });
    fs.writeFileSync(path.join(newTarget, "options.txt"), "renamed-options");

    const journalPath = path.join(userDataDir, "directory-move.json");
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        source: oldSource,
        target: newTarget,
        staging: path.join(testRoot, ".lampas-moving-rename"),
        phase: "renaming",
      })
    );

    ConfigManager.set({ gameDir: oldSource, gameDirConfigured: true });

    await GameDirectoryManager.recoverInterruptedMove();

    // Config must be updated to newTarget
    expect(ConfigManager.get().gameDir).toBe(path.resolve(newTarget));
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  test("startup recovery cleans up abandoned staging directory from interrupted copy", async () => {
    const stagingDir = path.join(testRoot, ".lampas-moving-test123");
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "half-copied.txt"), "partial");

    const journalPath = path.join(userDataDir, "directory-move.json");
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        source: path.join(testRoot, "original-source"),
        target: path.join(testRoot, "intended-target"),
        staging: stagingDir,
        phase: "copying",
      })
    );

    await GameDirectoryManager.recoverInterruptedMove();

    // Staging was cleaned up
    expect(fs.existsSync(stagingDir)).toBe(false);
    // Journal was cleaned up
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  test("startup recovery finishes source deletion if move was interrupted during cleaning phase", async () => {
    const oldSource = path.join(testRoot, "leftover-source");
    const newTarget = path.join(testRoot, "finished-target");

    fs.mkdirSync(oldSource, { recursive: true });
    fs.writeFileSync(path.join(oldSource, "old.txt"), "old");

    fs.mkdirSync(newTarget, { recursive: true });
    fs.writeFileSync(path.join(newTarget, "options.txt"), "new-options");

    const journalPath = path.join(userDataDir, "directory-move.json");
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        source: oldSource,
        target: newTarget,
        staging: path.join(testRoot, ".lampas-moving-old"),
        phase: "cleaning",
      })
    );

    await GameDirectoryManager.recoverInterruptedMove();

    // Old source is cleaned
    expect(fs.existsSync(oldSource)).toBe(false);
    // New target remains intact
    expect(fs.existsSync(path.join(newTarget, "options.txt"))).toBe(true);
    // Journal removed
    expect(fs.existsSync(journalPath)).toBe(false);
  });
});
