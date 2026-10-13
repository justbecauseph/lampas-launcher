import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigManager } from "./config";
import { LauncherLogger } from "./logger";
import { OperationCoordinator } from "./operations";
import type { CustomClientMod, CustomShaderPack } from "./types";

import {
  checkPhysicalAncestrySync,
  resolveAndContainPath,
} from "./path-policy";

interface ImportKind {
  extension: ".jar" | ".zip";
  /** Plural noun used in user-facing errors, e.g. "client mods". */
  plural: string;
  /** Singular noun used in user-facing errors, e.g. "client mod". */
  singular: string;
  /** Capitalized noun for "file not found" errors. */
  label: string;
  backupPrefix: string;
  logTag: string;
}

const MOD_IMPORT: ImportKind = {
  extension: ".jar",
  plural: "client mods",
  singular: "client mod",
  label: "Mod",
  backupPrefix: ".mod-backup",
  logTag: "Client Mods",
};

const SHADER_IMPORT: ImportKind = {
  extension: ".zip",
  plural: "shader packs",
  singular: "shader pack",
  label: "Shader pack",
  backupPrefix: ".shader-backup",
  logTag: "Shader Packs",
};

function assertImportableFile(sourcePath: string, kind: ImportKind): void {
  if (
    !path.isAbsolute(sourcePath) ||
    path.extname(sourcePath).toLowerCase() !== kind.extension
  ) {
    throw new Error(
      `Only local ${kind.extension} files can be added as ${kind.plural}.`,
    );
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`${kind.label} file not found: ${sourcePath}`);
  }
  if (fs.lstatSync(sourcePath).isSymbolicLink()) {
    throw new Error(`Cannot import symbolic link as ${kind.singular}.`);
  }

  // Check intermediate parents for symlink or junction
  let current = path.dirname(path.resolve(sourcePath));
  const root = path.parse(current).root;
  while (current && current !== root) {
    if (fs.existsSync(current)) {
      const lstat = fs.lstatSync(current);
      if (lstat.isSymbolicLink()) {
        throw new Error(
          `Cannot import from symbolic link or junction path: ${sourcePath}`,
        );
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Copies an approved local file into place through an exclusive, randomly
 * named staging file. An existing destination is backed up first and
 * restored if promotion fails.
 */
function promoteImport(
  sourcePath: string,
  dir: string,
  destination: string,
  filename: string,
  kind: ImportKind,
): void {
  // Safe exclusive staging with unpredictable random temporary name
  const tempPath = path.join(
    dir,
    `.importing-${Date.now()}-${Math.random().toString(16).slice(2)}${kind.extension}`,
  );

  let backupPath: string | null = null;
  try {
    fs.copyFileSync(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    const tempStat = fs.lstatSync(tempPath);
    if (tempStat.isSymbolicLink()) {
      throw new Error("Temporary import staging resolved to a symbolic link.");
    }

    // If destination exists, create a recoverable backup before promotion
    if (fs.existsSync(destination)) {
      backupPath = path.join(
        dir,
        `${kind.backupPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.bak`,
      );
      fs.renameSync(destination, backupPath);
    }

    try {
      fs.renameSync(tempPath, destination);
    } catch (renameErr) {
      // Promotion failed: rollback original file from backup!
      if (backupPath && fs.existsSync(backupPath)) {
        const activeBackup = backupPath;
        try {
          fs.renameSync(activeBackup, destination);
          backupPath = null;
        } catch (rollbackErr: any) {
          LauncherLogger.error(
            `[${kind.logTag}] Critical: automatic rollback failed for '${filename}'. Original preserved at '${activeBackup}': ${rollbackErr.message}`,
          );
          throw new Error(
            `Failed to replace ${kind.singular} '${filename}' and automatic rollback failed. The original is preserved at '${path.basename(activeBackup)}'.`,
          );
        }
      }
      throw renameErr;
    }

    // Promotion succeeded: remove the backup cleanly
    if (backupPath && fs.existsSync(backupPath)) {
      try {
        fs.unlinkSync(backupPath);
        backupPath = null;
      } catch {}
    }
  } catch (importErr: any) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
    throw importErr;
  }
}

function modPath(gameDir: string, filename: string, enabled: boolean): string {
  if (
    filename !== path.basename(filename) ||
    path.extname(filename).toLowerCase() !== ".jar"
  ) {
    throw new Error("Invalid local mod filename.");
  }
  const relPath = path.join(
    "mods",
    enabled ? filename : `${filename}.disabled`,
  );
  return resolveAndContainPath(gameDir, relPath);
}

function shaderPackPath(gameDir: string, filename: string): string {
  if (
    filename !== path.basename(filename) ||
    path.extname(filename).toLowerCase() !== ".zip"
  ) {
    throw new Error("Invalid shader pack filename.");
  }
  return resolveAndContainPath(gameDir, path.join("shaderpacks", filename));
}

/** A ZIP local file header starts with "PK". */
function assertZipArchive(sourcePath: string): void {
  const fd = fs.openSync(sourcePath, "r");
  try {
    const header = Buffer.alloc(4);
    const read = fs.readSync(fd, header, 0, 4, 0);
    if (read < 4 || header.readUInt32LE(0) !== 0x04034b50) {
      throw new Error(
        `${path.basename(sourcePath)} is not a valid shader pack (.zip) archive.`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Local shader packs (Iris/OptiFine .zip files) the player adds themselves.
 * They live in shaderpacks/ and are never touched by pack synchronization,
 * which only removes files it installed.
 */
export class ShaderPackManager {
  static list(): CustomShaderPack[] {
    return ConfigManager.get().customShaderPacks || [];
  }

  static add(sourcePaths: string[]): CustomShaderPack[] {
    OperationCoordinator.assertCanMutate(
      "Cannot modify shader packs while an operation or Minecraft is running.",
    );
    const config = ConfigManager.get();
    const shaderDir = resolveAndContainPath(config.gameDir, "shaderpacks");
    if (!fs.existsSync(shaderDir)) {
      fs.mkdirSync(shaderDir, { recursive: true });
    }
    checkPhysicalAncestrySync(config.gameDir, shaderDir, {
      enforceOwnership: true,
      disallowSymlinks: true,
    });

    const packs = [...(config.customShaderPacks || [])];

    for (const sourcePath of sourcePaths) {
      assertImportableFile(sourcePath, SHADER_IMPORT);
      assertZipArchive(sourcePath);
      const filename = path.basename(sourcePath);
      const existing = packs.find(
        (pack) => pack.filename.toLowerCase() === filename.toLowerCase(),
      );
      const destination = shaderPackPath(config.gameDir, filename);
      checkPhysicalAncestrySync(config.gameDir, destination, {
        enforceOwnership: true,
        disallowSymlinks: true,
      });

      if (fs.existsSync(destination)) {
        const destStat = fs.lstatSync(destination);
        if (!destStat.isFile() || destStat.isSymbolicLink()) {
          throw new Error(
            `Cannot overwrite symbolic link or special file at destination shader pack: ${filename}`,
          );
        }
        if (
          !existing &&
          path.resolve(sourcePath) !== path.resolve(destination)
        ) {
          throw new Error(
            `${filename} already exists in the shaderpacks folder and is not a launcher-managed local shader pack.`,
          );
        }
      }

      promoteImport(
        sourcePath,
        shaderDir,
        destination,
        filename,
        SHADER_IMPORT,
      );

      const size = fs.statSync(destination).size;
      if (existing) {
        existing.addedAt = new Date().toISOString();
        existing.size = size;
        LauncherLogger.info(
          `[Shader Packs] Replaced shader pack: ${filename} (${(size / 1024).toFixed(1)} KB)`,
        );
      } else {
        packs.push({ filename, addedAt: new Date().toISOString(), size });
        LauncherLogger.info(
          `[Shader Packs] Added shader pack: ${filename} (${(size / 1024).toFixed(1)} KB)`,
        );
      }
    }

    ConfigManager.set({ customShaderPacks: packs });
    return packs;
  }

  static remove(filename: string): CustomShaderPack[] {
    OperationCoordinator.assertCanMutate(
      "Cannot modify shader packs while an operation or Minecraft is running.",
    );
    const config = ConfigManager.get();
    const packs = [...(config.customShaderPacks || [])];
    if (!packs.some((pack) => pack.filename === filename)) {
      throw new Error(`Unknown local shader pack: ${filename}`);
    }
    const target = shaderPackPath(config.gameDir, filename);
    checkPhysicalAncestrySync(config.gameDir, target, {
      enforceOwnership: true,
      disallowSymlinks: true,
    });
    fs.rmSync(target, { force: true });
    LauncherLogger.info(`[Shader Packs] Removed shader pack: ${filename}`);
    const updated = packs.filter((pack) => pack.filename !== filename);
    ConfigManager.set({ customShaderPacks: updated });
    return updated;
  }
}

export class ClientModManager {
  static list(): CustomClientMod[] {
    return ConfigManager.get().customClientMods || [];
  }

  static add(sourcePaths: string[]): CustomClientMod[] {
    OperationCoordinator.assertCanMutate(
      "Cannot modify client mods while an operation or Minecraft is running.",
    );
    const config = ConfigManager.get();
    const modsDir = resolveAndContainPath(config.gameDir, "mods");
    if (!fs.existsSync(modsDir)) {
      fs.mkdirSync(modsDir, { recursive: true });
    }
    checkPhysicalAncestrySync(config.gameDir, modsDir, {
      enforceOwnership: true,
      disallowSymlinks: true,
    });

    const mods = [...(config.customClientMods || [])];

    for (const sourcePath of sourcePaths) {
      assertImportableFile(sourcePath, MOD_IMPORT);
      const filename = path.basename(sourcePath);
      const existing = mods.find(
        (mod) => mod.filename.toLowerCase() === filename.toLowerCase(),
      );
      const destination = modPath(config.gameDir, filename, true);
      checkPhysicalAncestrySync(config.gameDir, destination, {
        enforceOwnership: true,
        disallowSymlinks: true,
      });

      if (fs.existsSync(destination)) {
        const destStat = fs.lstatSync(destination);
        if (
          destStat.isSymbolicLink() ||
          destStat.isFIFO() ||
          destStat.isSocket() ||
          destStat.isCharacterDevice() ||
          destStat.isBlockDevice()
        ) {
          throw new Error(
            `Cannot overwrite symbolic link or special file at destination mod: ${filename}`,
          );
        }
        if (
          !existing &&
          path.resolve(sourcePath) !== path.resolve(destination)
        ) {
          throw new Error(
            `${filename} already exists in the mods folder and is not a launcher-managed local mod.`,
          );
        }
      }

      promoteImport(sourcePath, modsDir, destination, filename, MOD_IMPORT);

      if (existing) {
        const disabledPath = modPath(config.gameDir, filename, false);
        if (fs.existsSync(disabledPath)) {
          fs.rmSync(disabledPath, { force: true });
        }
        existing.enabled = true;
        existing.addedAt = new Date().toISOString();
        existing.size = fs.statSync(destination).size;
        LauncherLogger.info(
          `[Client Mods] Replaced custom mod: ${filename} (${(existing.size / 1024).toFixed(1)} KB)`,
        );
      } else {
        const size = fs.statSync(destination).size;
        mods.push({
          filename,
          enabled: true,
          addedAt: new Date().toISOString(),
          size,
        });
        LauncherLogger.info(
          `[Client Mods] Added custom mod: ${filename} (${(size / 1024).toFixed(1)} KB)`,
        );
      }
    }

    ConfigManager.set({ customClientMods: mods });
    return mods;
  }

  static setEnabled(filename: string, enabled: boolean): CustomClientMod[] {
    OperationCoordinator.assertCanMutate(
      "Cannot modify client mods while an operation or Minecraft is running.",
    );
    const config = ConfigManager.get();
    const mods = [...(config.customClientMods || [])];
    const mod = mods.find((entry) => entry.filename === filename);
    if (!mod) throw new Error(`Unknown local mod: ${filename}`);
    if (mod.enabled === enabled) return mods;

    const source = modPath(config.gameDir, filename, mod.enabled);
    const destination = modPath(config.gameDir, filename, enabled);
    checkPhysicalAncestrySync(config.gameDir, source, {
      enforceOwnership: true,
      disallowSymlinks: true,
    });
    checkPhysicalAncestrySync(config.gameDir, destination, {
      enforceOwnership: true,
      disallowSymlinks: true,
    });
    if (!fs.existsSync(source))
      throw new Error(`${filename} is missing from the mods folder.`);
    if (fs.existsSync(destination))
      throw new Error(`Cannot toggle ${filename}: destination already exists.`);
    fs.renameSync(source, destination);
    mod.enabled = enabled;
    LauncherLogger.info(
      `[Client Mods] ${enabled ? "Enabled" : "Disabled"} custom mod: ${filename}`,
    );
    ConfigManager.set({ customClientMods: mods });
    return mods;
  }

  static remove(filename: string): CustomClientMod[] {
    OperationCoordinator.assertCanMutate(
      "Cannot modify client mods while an operation or Minecraft is running.",
    );
    const config = ConfigManager.get();
    const mods = [...(config.customClientMods || [])];
    const mod = mods.find((entry) => entry.filename === filename);
    if (!mod) throw new Error(`Unknown local mod: ${filename}`);
    const target = modPath(config.gameDir, filename, mod.enabled);
    checkPhysicalAncestrySync(config.gameDir, target, {
      enforceOwnership: true,
      disallowSymlinks: true,
    });
    fs.rmSync(target, { force: true });
    LauncherLogger.info(`[Client Mods] Removed custom mod: ${filename}`);
    const updated = mods.filter((entry) => entry.filename !== filename);
    ConfigManager.set({ customClientMods: updated });
    return updated;
  }

  static setOfficialEnabled(modId: string, enabled: boolean): string[] {
    OperationCoordinator.assertCanMutate(
      "Cannot modify client mods while an operation or Minecraft is running.",
    );
    const disabled = new Set(ConfigManager.get().disabledClientMods || []);
    if (enabled) disabled.delete(modId);
    else disabled.add(modId);
    LauncherLogger.info(
      `[Client Mods] ${enabled ? "Enabled" : "Disabled"} official mod: ${modId}`,
    );
    const updated = Array.from(disabled).sort();
    ConfigManager.set({ disabledClientMods: updated });
    return updated;
  }
}
