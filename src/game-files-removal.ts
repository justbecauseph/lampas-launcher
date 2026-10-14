/**
 * Removal of the game folder's contents from Settings.
 *
 * Invariants:
 * 1. Main-only: the folder comes from the launcher config, never from the renderer.
 * 2. The folder must be a real directory (not a link or a drive root) that holds a
 *    `.lampas` directory, so a folder the launcher never installed into is refused.
 * 3. The launcher's default folder is emptied and removed. In a folder the user
 *    picked, only entries the launcher, the pack or Minecraft create are removed;
 *    anything else is left in place and counted.
 * 4. Entries that were already in a folder when it was first set up (kept in the
 *    launcher config as gameDirPreexistingEntries) are never removed, even when
 *    their names match, e.g. a Pictures folder's own Screenshots.
 * 5. Links and junctions are removed as links; their targets are never touched.
 * 6. Locked or undeletable entries are reported, not treated as success, and
 *    `.lampas` goes last so a failed removal can be retried.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCanonicalDiskPath } from "./path-policy";

/** Top-level entries the launcher creates in the game folder. */
const LAUNCHER_ENTRIES = [
  ".lampas",
  "runtime",
  "versions",
  "libraries",
  "assets",
  "natives",
];

/** Top-level entries Minecraft, Fabric and common client mods create. */
const MINECRAFT_ENTRIES = [
  ".fabric",
  "config",
  "crash-reports",
  "debug",
  "downloads",
  "logs",
  "mods",
  "resourcepacks",
  "saves",
  "screenshots",
  "shaderpacks",
  "command_history.txt",
  "hotbar.nbt",
  "options.txt",
  "optionsof.txt",
  "optionsshaders.txt",
  "realms_persistence.json",
  "servers.dat",
  "servers.dat_old",
  "usercache.json",
  "usernamecache.json",
];

/**
 * Lists what a folder already holds when the user picks it at first-run
 * setup. The caller keeps the list in the launcher config (outside the game
 * folder, so removal can't delete it) and passes it to planGameFilesRemoval.
 * Empty for an empty or missing folder, or one with a Lampas installation.
 */
export async function listPreexistingEntries(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(path.resolve(dir));
  } catch {
    return [];
  }
  if (names.some((n) => entryKey(n) === ".lampas")) return [];
  return names;
}

export interface GameFilesRemovalPlan {
  gameDir: string;
  /** True when the folder is the launcher's own default, which is removed whole. */
  isDefaultFolder: boolean;
  /** Top-level entry names that will be removed. */
  entries: string[];
  /** Top-level entries left in place because the launcher didn't create them. */
  leftoverEntries: string[];
  /** Bytes in the entries to remove, not following links. */
  totalBytes: number;
}

export interface GameFilesRemovalResult {
  removedEntries: string[];
  failed: Array<{ entry: string; message: string }>;
  leftoverEntries: string[];
  folderRemoved: boolean;
}

export class GameFilesRemovalError extends Error {
  readonly isMainOwnedError = true;
  constructor(message: string) {
    super(message);
    this.name = "GameFilesRemovalError";
  }
}

function comparablePath(p: string): string {
  const canonical = getCanonicalDiskPath(path.resolve(p));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function entryKey(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

/** Top-level names of the files the pack installed, from installation.json. */
function packManagedEntries(gameDir: string): string[] {
  const statePath = path.join(gameDir, ".lampas", "installation.json");
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const files = state && typeof state.files === "object" ? state.files : {};
    const names = new Set<string>();
    for (const rel of Object.keys(files)) {
      const first = rel.split(/[\\/]/)[0];
      // Ignore anything that could escape the folder.
      if (first && first !== "." && first !== ".." && !path.isAbsolute(rel)) {
        names.add(first);
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

async function sizeOf(target: string): Promise<number> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  let names: string[];
  try {
    names = await fs.promises.readdir(target);
  } catch {
    return 0;
  }
  for (const name of names) {
    total += await sizeOf(path.join(target, name));
  }
  return total;
}

/**
 * Checks that the game folder can be removed and lists what removal deletes.
 * Throws GameFilesRemovalError with a user-facing reason otherwise.
 */
export async function planGameFilesRemoval(
  gameDir: string,
  /** Folders the launcher chose itself (current and earlier defaults). */
  defaultGameDirs: string[],
  /** Entries the folder held before setup; never removed. */
  preexistingEntries: string[] = [],
): Promise<GameFilesRemovalPlan> {
  if (!gameDir || typeof gameDir !== "string") {
    throw new GameFilesRemovalError("No game folder is configured.");
  }
  const resolved = path.resolve(gameDir);
  if (path.parse(resolved).root.toLowerCase() === resolved.toLowerCase()) {
    throw new GameFilesRemovalError(
      "The game folder is a drive root, so it won't be removed.",
    );
  }
  if (comparablePath(resolved) === comparablePath(os.homedir())) {
    throw new GameFilesRemovalError(
      "The game folder is your home folder, so it won't be removed.",
    );
  }

  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.lstat(resolved);
  } catch {
    throw new GameFilesRemovalError("There are no game files to remove.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new GameFilesRemovalError(
      "The game folder is a link or not a folder, so it won't be removed.",
    );
  }

  const markerStat = await fs.promises
    .lstat(path.join(resolved, ".lampas"))
    .catch(() => null);
  if (!markerStat || !markerStat.isDirectory()) {
    throw new GameFilesRemovalError(
      "This folder doesn't contain a Lampas installation, so nothing was removed.",
    );
  }

  const isDefaultFolder = defaultGameDirs.some(
    (dir) => comparablePath(dir) === comparablePath(resolved),
  );

  const known = new Set(
    [
      ...LAUNCHER_ENTRIES,
      ...MINECRAFT_ENTRIES,
      ...packManagedEntries(resolved),
    ].map(entryKey),
  );

  const preexisting = new Set(preexistingEntries.map(entryKey));
  const names = await fs.promises.readdir(resolved);
  const entries: string[] = [];
  const leftoverEntries: string[] = [];
  for (const name of names) {
    const key = entryKey(name);
    if (preexisting.has(key)) leftoverEntries.push(name);
    else if (isDefaultFolder || known.has(key)) entries.push(name);
    else leftoverEntries.push(name);
  }
  // `.lampas` marks the folder as a Lampas install; remove it last.
  entries.sort(
    (a, b) =>
      Number(entryKey(a) === ".lampas") - Number(entryKey(b) === ".lampas"),
  );

  let totalBytes = 0;
  for (const name of entries) {
    totalBytes += await sizeOf(path.join(resolved, name));
  }

  return {
    gameDir: resolved,
    isDefaultFolder,
    entries,
    leftoverEntries,
    totalBytes,
  };
}

/**
 * Removes the entries in a plan. The default folder itself is removed once it
 * is empty; a folder the user picked is kept.
 */
export async function removeGameFiles(
  plan: GameFilesRemovalPlan,
): Promise<GameFilesRemovalResult> {
  const removedEntries: string[] = [];
  const failed: Array<{ entry: string; message: string }> = [];

  for (const name of plan.entries) {
    // Keep the marker if anything failed, so the user can retry the removal.
    if (entryKey(name) === ".lampas" && failed.length > 0) continue;
    const target = path.join(plan.gameDir, name);
    try {
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink()) {
        // Remove the link itself; never descend into what it points at.
        await removeLink(target);
      } else {
        await fs.promises.rm(target, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        });
      }
      removedEntries.push(name);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        removedEntries.push(name);
        continue;
      }
      failed.push({ entry: name, message: err?.message || String(err) });
    }
  }

  let folderRemoved = false;
  if (plan.isDefaultFolder && failed.length === 0) {
    try {
      await fs.promises.rmdir(plan.gameDir);
      folderRemoved = true;
    } catch {
      // Something appeared in the meantime; leave the folder.
    }
  }

  return {
    removedEntries,
    failed,
    leftoverEntries: plan.leftoverEntries,
    folderRemoved,
  };
}

async function removeLink(target: string): Promise<void> {
  try {
    await fs.promises.unlink(target);
  } catch (err: any) {
    // Directory symlinks and junctions on Windows are removed with rmdir,
    // which deletes the link without touching the target's contents.
    if (err?.code === "EPERM" || err?.code === "EISDIR") {
      await fs.promises.rmdir(target);
      return;
    }
    throw err;
  }
}
