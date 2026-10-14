import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-removal-test-"));
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

const {
  planGameFilesRemoval,
  removeGameFiles,
  listPreexistingEntries,
  GameFilesRemovalError,
} = await import("../src/game-files-removal");
const {
  ConfigManager,
  PortalPolicy,
  getStorePackageCacheDir,
  getStoreRedirectedPath,
  resolveStoreGameDir,
  toExternalPath,
} = await import("../src/config");

let caseDir: string;
let caseSeq = 0;

beforeEach(() => {
  caseDir = path.join(testRoot, `case-${++caseSeq}`);
  fs.mkdirSync(caseDir, { recursive: true });
});

afterAll(() => {
  PortalPolicy.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

function write(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A game folder as the launcher leaves it after a sync and a game session. */
function makeInstall(dir: string, packFiles: string[] = []): void {
  write(
    path.join(dir, ".lampas", "installation.json"),
    JSON.stringify({
      pack: "Lampas 2",
      version: "1.0.0",
      installedAt: "2026-10-01T00:00:00.000Z",
      files: Object.fromEntries(
        packFiles.map((f) => [f, { sha256: "0", size: 1, policy: "managed" }]),
      ),
    }),
  );
  write(path.join(dir, "mods", "sodium.jar"));
  write(path.join(dir, "versions", "26.2", "26.2.jar"), "x".repeat(2048));
  write(path.join(dir, "screenshots", "shot.png"));
  write(path.join(dir, "options.txt"));
}

describe("planGameFilesRemoval", () => {
  test("removes everything in the launcher's default folder, then the folder", async () => {
    const gameDir = path.join(caseDir, ".minecraft-lampas");
    makeInstall(gameDir);
    write(path.join(gameDir, "journeymap", "data.dat"));

    const plan = await planGameFilesRemoval(gameDir, [gameDir]);
    expect(plan.isDefaultFolder).toBe(true);
    expect(plan.leftoverEntries).toEqual([]);
    expect(plan.entries.sort()).toEqual(
      [
        ".lampas",
        "journeymap",
        "mods",
        "options.txt",
        "screenshots",
        "versions",
      ].sort(),
    );
    expect(plan.totalBytes).toBeGreaterThanOrEqual(2048);

    const result = await removeGameFiles(plan);
    expect(result.failed).toEqual([]);
    expect(result.folderRemoved).toBe(true);
    expect(fs.existsSync(gameDir)).toBe(false);
  });

  test("in a folder the user chose, removes only launcher, pack and Minecraft entries", async () => {
    const gameDir = path.join(caseDir, "Documents");
    makeInstall(gameDir, ["kubejs/scripts/main.js", "../outside/evil.txt"]);
    write(path.join(gameDir, "kubejs", "scripts", "main.js"));
    write(path.join(gameDir, "Homework.docx"));
    write(path.join(gameDir, "Photos", "cat.jpg"));

    const plan = await planGameFilesRemoval(gameDir, [
      path.join(caseDir, ".minecraft-lampas"),
    ]);
    expect(plan.isDefaultFolder).toBe(false);
    expect(plan.entries).toContain("kubejs");
    expect(plan.entries).not.toContain("..");
    expect(plan.leftoverEntries.sort()).toEqual(["Homework.docx", "Photos"]);

    const result = await removeGameFiles(plan);
    expect(result.failed).toEqual([]);
    expect(result.folderRemoved).toBe(false);
    expect(fs.readdirSync(gameDir).sort()).toEqual(["Homework.docx", "Photos"]);
    expect(fs.existsSync(path.join(gameDir, "Photos", "cat.jpg"))).toBe(true);
  });

  test("never removes what a chosen folder held before setup, across repeated removals", async () => {
    const gameDir = path.join(caseDir, "Pictures");
    write(path.join(gameDir, "Screenshots", "desktop.png"));
    write(path.join(gameDir, "logs", "camera.log"));
    // First-run setup lists the folder's contents; the config keeps the list.
    const preexisting = await listPreexistingEntries(gameDir);
    const defaults = [path.join(caseDir, ".minecraft-lampas")];

    // Remove, play again (sync recreates the install), remove again.
    for (let cycle = 0; cycle < 2; cycle++) {
      makeInstall(gameDir);
      const plan = await planGameFilesRemoval(gameDir, defaults, preexisting);
      expect(plan.leftoverEntries.sort()).toEqual(["Screenshots", "logs"]);
      expect(plan.entries).toContain("mods");
      await removeGameFiles(plan);
      expect(
        fs.existsSync(path.join(gameDir, "Screenshots", "desktop.png")),
      ).toBe(true);
      expect(fs.existsSync(path.join(gameDir, "logs", "camera.log"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(gameDir, "mods"))).toBe(false);
    }
  });

  test("lists nothing for an empty folder or an existing install", async () => {
    const empty = path.join(caseDir, "empty");
    fs.mkdirSync(empty);
    expect(await listPreexistingEntries(empty)).toEqual([]);
    expect(await listPreexistingEntries(path.join(caseDir, "missing"))).toEqual(
      [],
    );

    const existing = path.join(caseDir, "existing");
    makeInstall(existing);
    expect(await listPreexistingEntries(existing)).toEqual([]);
  });

  test("removes .lampas last and keeps it after a failure, so removal can be retried", async () => {
    const gameDir = path.join(caseDir, ".minecraft-lampas");
    makeInstall(gameDir);

    const plan = await planGameFilesRemoval(gameDir, [gameDir]);
    expect(plan.entries[plan.entries.length - 1]).toBe(".lampas");

    // An entry name the filesystem rejects stands in for a locked file.
    const result = await removeGameFiles({
      ...plan,
      entries: ["mods", "bad\0name", ".lampas"],
    });
    expect(result.failed.map((f) => f.entry)).toEqual(["bad\0name"]);
    expect(result.folderRemoved).toBe(false);
    expect(fs.existsSync(path.join(gameDir, "mods"))).toBe(false);
    expect(fs.existsSync(path.join(gameDir, ".lampas"))).toBe(true);

    // The retry is accepted and finishes the job.
    const retry = await planGameFilesRemoval(gameDir, [gameDir]);
    const done = await removeGameFiles(retry);
    expect(done.failed).toEqual([]);
    expect(fs.existsSync(gameDir)).toBe(false);
  });

  test("removes a linked entry without touching what it points at", async () => {
    const gameDir = path.join(caseDir, ".minecraft-lampas");
    makeInstall(gameDir);
    const outside = path.join(caseDir, "elsewhere");
    write(path.join(outside, "keep.txt"));
    // A junction needs no elevation on Windows; elsewhere it is a dir symlink.
    fs.symlinkSync(outside, path.join(gameDir, "resourcepacks"), "junction");

    const plan = await planGameFilesRemoval(gameDir, [gameDir]);
    const result = await removeGameFiles(plan);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(path.join(gameDir, "resourcepacks"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });

  test("refuses a folder without a Lampas installation", async () => {
    const gameDir = path.join(caseDir, "Downloads");
    write(path.join(gameDir, "mods", "a.jar"));
    await expect(planGameFilesRemoval(gameDir, [gameDir])).rejects.toThrow(
      GameFilesRemovalError,
    );
    expect(fs.existsSync(path.join(gameDir, "mods", "a.jar"))).toBe(true);
  });

  test("refuses a game folder that is itself a link", async () => {
    const real = path.join(caseDir, "real");
    makeInstall(real);
    const link = path.join(caseDir, "link");
    fs.symlinkSync(real, link, "junction");
    await expect(planGameFilesRemoval(link, [link])).rejects.toThrow(
      GameFilesRemovalError,
    );
  });

  test("refuses the home folder and drive roots", async () => {
    await expect(
      planGameFilesRemoval(os.homedir(), [os.homedir()]),
    ).rejects.toThrow(GameFilesRemovalError);
    const root = path.parse(caseDir).root;
    await expect(planGameFilesRemoval(root, [root])).rejects.toThrow(
      GameFilesRemovalError,
    );
  });

  test("refuses a missing folder", async () => {
    const gameDir = path.join(caseDir, "gone");
    await expect(planGameFilesRemoval(gameDir, [gameDir])).rejects.toThrow(
      GameFilesRemovalError,
    );
  });
});

describe("getStorePackageCacheDir", () => {
  const original = process.env.LOCALAPPDATA;
  const pfn = "59450PUPProgGuild.LampasLauncher_bdagfy06snw12";
  const execPath =
    "C:\\Program Files\\WindowsApps\\59450PUPProgGuild.LampasLauncher_1.5.4.0_x64__bdagfy06snw12\\app\\Lampas Launcher.exe";

  test("points Store installs at the package's LocalCache folder", () => {
    process.env.LOCALAPPDATA = caseDir;
    fs.mkdirSync(path.join(caseDir, "Packages", pfn), { recursive: true });
    try {
      expect(getStorePackageCacheDir(execPath, true)).toBe(
        path.join(caseDir, "Packages", pfn, "LocalCache"),
      );
    } finally {
      process.env.LOCALAPPDATA = original;
    }
  });

  test("returns null outside the Store or when the package folder is missing", () => {
    process.env.LOCALAPPDATA = caseDir;
    try {
      expect(getStorePackageCacheDir(execPath, false)).toBeNull();
      expect(getStorePackageCacheDir(execPath, true)).toBeNull();
      expect(
        getStorePackageCacheDir("C:\\Apps\\Lampas Launcher.exe", true),
      ).toBeNull();
    } finally {
      process.env.LOCALAPPDATA = original;
    }
  });
});

describe("getStoreRedirectedPath", () => {
  const original = {
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  const restore = () => {
    process.env.APPDATA = original.APPDATA;
    process.env.LOCALAPPDATA = original.LOCALAPPDATA;
  };

  test("maps %APPDATA% and %LOCALAPPDATA% folders into LocalCache", () => {
    const cache = path.join(caseDir, "Local", "Packages", "pkg", "LocalCache");
    process.env.APPDATA = path.join(caseDir, "Roaming");
    process.env.LOCALAPPDATA = path.join(caseDir, "Local");
    try {
      expect(
        getStoreRedirectedPath(
          path.join(caseDir, "Roaming", ".minecraft-lampas"),
          cache,
        ),
      ).toBe(path.join(cache, "Roaming", ".minecraft-lampas"));
      expect(
        getStoreRedirectedPath(
          path.join(caseDir, "Local", "Games", "x"),
          cache,
        ),
      ).toBe(path.join(cache, "Local", "Games", "x"));
      // A name that starts with ".." is still inside %APPDATA%.
      expect(
        getStoreRedirectedPath(
          path.join(caseDir, "Roaming", "..lampas"),
          cache,
        ),
      ).toBe(path.join(cache, "Roaming", "..lampas"));
    } finally {
      restore();
    }
  });

  test("leaves the package's own folder, other folders and non-Store builds alone", () => {
    const cache = path.join(caseDir, "Local", "Packages", "pkg", "LocalCache");
    process.env.APPDATA = path.join(caseDir, "Roaming");
    process.env.LOCALAPPDATA = path.join(caseDir, "Local");
    try {
      expect(
        getStoreRedirectedPath(path.join(cache, ".minecraft-lampas"), cache),
      ).toBeNull();
      expect(getStoreRedirectedPath(path.dirname(cache), cache)).toBeNull();
      expect(
        getStoreRedirectedPath(path.join(caseDir, "Games", "lampas"), cache),
      ).toBeNull();
      expect(getStoreRedirectedPath(process.env.APPDATA, cache)).toBeNull();
      expect(
        getStoreRedirectedPath(
          path.join(caseDir, "Roaming", ".minecraft-lampas"),
          null,
        ),
      ).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("ConfigManager on a Store install", () => {
  const pfn = "59450PUPProgGuild.LampasLauncher_bdagfy06snw12";
  const storeExecPath =
    "C:\\Program Files\\WindowsApps\\59450PUPProgGuild.LampasLauncher_1.5.4.0_x64__bdagfy06snw12\\app\\Lampas Launcher.exe";

  /** Runs `body` as a Store build whose %APPDATA% and %LOCALAPPDATA% sit in caseDir. */
  function asStoreInstall(
    body: (paths: { configured: string; redirected: string }) => void,
  ): void {
    const saved = {
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      execPath: process.execPath,
      windowsStore: (process as { windowsStore?: boolean }).windowsStore,
    };
    const roaming = path.join(caseDir, "Roaming");
    const local = path.join(caseDir, "Local");
    fs.mkdirSync(path.join(local, "Packages", pfn), { recursive: true });
    process.env.APPDATA = roaming;
    process.env.LOCALAPPDATA = local;
    Object.defineProperty(process, "execPath", {
      value: storeExecPath,
      configurable: true,
      writable: true,
    });
    (process as { windowsStore?: boolean }).windowsStore = true;
    try {
      PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
      body({
        configured: path.join(roaming, ".minecraft-lampas"),
        redirected: path.join(
          local,
          "Packages",
          pfn,
          "LocalCache",
          "Roaming",
          ".minecraft-lampas",
        ),
      });
    } finally {
      process.env.APPDATA = saved.APPDATA;
      process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
      Object.defineProperty(process, "execPath", {
        value: saved.execPath,
        configurable: true,
        writable: true,
      });
      (process as { windowsStore?: boolean }).windowsStore = saved.windowsStore;
      ConfigManager.resetForTesting();
    }
  }

  test("switches to and saves the redirected copy of an %APPDATA% game folder that holds the install", () => {
    asStoreInstall(({ configured, redirected }) => {
      makeInstall(redirected);
      ConfigManager.resetForTesting();
      ConfigManager.set({ gameDir: configured, gameDirConfigured: true });
      ConfigManager.resetForTesting();

      expect(ConfigManager.get().gameDir).toBe(redirected);
      expect(resolveStoreGameDir(configured)).toBe(redirected);
      const saved = JSON.parse(
        fs.readFileSync(path.join(userDataDir, "config.json"), "utf-8"),
      );
      expect(saved.gameDir).toBe(redirected);
    });
  });

  test("keeps the configured folder when the redirected copy holds no install", () => {
    asStoreInstall(({ configured, redirected }) => {
      fs.mkdirSync(path.join(redirected, "logs"), { recursive: true });
      ConfigManager.resetForTesting();
      ConfigManager.set({ gameDir: configured, gameDirConfigured: true });
      ConfigManager.resetForTesting();

      expect(ConfigManager.get().gameDir).toBe(configured);
      expect(resolveStoreGameDir(configured)).toBe(configured);
    });
  });

  test("gives other programs the private copy's path when Windows redirected a file", () => {
    asStoreInstall(({ configured, redirected }) => {
      const log = path.join(configured, "logs", "launcher.log");
      const redirectedLog = path.join(redirected, "logs", "launcher.log");
      expect(toExternalPath(log)).toBe(log);

      write(redirectedLog);
      expect(toExternalPath(log)).toBe(redirectedLog);
    });
  });
});

describe("ConfigManager.resetToDefaults", () => {
  test("restores defaults so first-run setup shows again", () => {
    PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
    ConfigManager.resetForTesting();
    ConfigManager.set({
      gameDir: path.join(caseDir, "custom"),
      gameDirConfigured: true,
      allocatedRamGb: 8,
    });

    ConfigManager.resetToDefaults();

    const config = ConfigManager.get();
    expect(config.gameDirConfigured).toBe(false);
    expect(config.allocatedRamGb).toBe(8);
    expect(config.gameDir).not.toBe(path.join(caseDir, "custom"));
  });
});
