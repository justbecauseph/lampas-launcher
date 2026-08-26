import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigManager } from "./config";
import { LauncherLogger } from "./logger";
import type { CustomClientMod } from "./types";

function assertJar(sourcePath: string): void {
  if (!path.isAbsolute(sourcePath) || path.extname(sourcePath).toLowerCase() !== ".jar") {
    throw new Error("Only local .jar files can be added as client mods.");
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Mod file not found: ${sourcePath}`);
  }
}

function modPath(gameDir: string, filename: string, enabled: boolean): string {
  if (filename !== path.basename(filename) || path.extname(filename).toLowerCase() !== ".jar") {
    throw new Error("Invalid local mod filename.");
  }
  return path.join(gameDir, "mods", enabled ? filename : `${filename}.disabled`);
}

export class ClientModManager {
  static list(): CustomClientMod[] {
    return ConfigManager.get().customClientMods || [];
  }

  static add(sourcePaths: string[]): CustomClientMod[] {
    const config = ConfigManager.get();
    const modsDir = path.join(config.gameDir, "mods");
    fs.mkdirSync(modsDir, { recursive: true });
    const mods = [...(config.customClientMods || [])];

    for (const sourcePath of sourcePaths) {
      assertJar(sourcePath);
      const filename = path.basename(sourcePath);
      const existing = mods.find((mod) => mod.filename.toLowerCase() === filename.toLowerCase());
      const destination = modPath(config.gameDir, filename, true);
      if (fs.existsSync(destination) && !existing && path.resolve(sourcePath) !== path.resolve(destination)) {
        throw new Error(`${filename} already exists in the mods folder and is not a launcher-managed local mod.`);
      }

      const tempPath = `${destination}.importing`;
      fs.copyFileSync(sourcePath, tempPath);
      fs.rmSync(destination, { force: true });
      fs.renameSync(tempPath, destination);
      if (existing) {
        fs.rmSync(modPath(config.gameDir, filename, false), { force: true });
        existing.enabled = true;
        existing.addedAt = new Date().toISOString();
        existing.size = fs.statSync(destination).size;
        LauncherLogger.info(`[Client Mods] Replaced custom mod: ${filename} (${(existing.size / 1024).toFixed(1)} KB)`);
      } else {
        const size = fs.statSync(destination).size;
        mods.push({ filename, enabled: true, addedAt: new Date().toISOString(), size });
        LauncherLogger.info(`[Client Mods] Added custom mod: ${filename} (${(size / 1024).toFixed(1)} KB)`);
      }
    }

    ConfigManager.set({ customClientMods: mods });
    return mods;
  }

  static setEnabled(filename: string, enabled: boolean): CustomClientMod[] {
    const config = ConfigManager.get();
    const mods = [...(config.customClientMods || [])];
    const mod = mods.find((entry) => entry.filename === filename);
    if (!mod) throw new Error(`Unknown local mod: ${filename}`);
    if (mod.enabled === enabled) return mods;

    const source = modPath(config.gameDir, filename, mod.enabled);
    const destination = modPath(config.gameDir, filename, enabled);
    if (!fs.existsSync(source)) throw new Error(`${filename} is missing from the mods folder.`);
    if (fs.existsSync(destination)) throw new Error(`Cannot toggle ${filename}: destination already exists.`);
    fs.renameSync(source, destination);
    mod.enabled = enabled;
    LauncherLogger.info(`[Client Mods] ${enabled ? "Enabled" : "Disabled"} custom mod: ${filename}`);
    ConfigManager.set({ customClientMods: mods });
    return mods;
  }

  static remove(filename: string): CustomClientMod[] {
    const config = ConfigManager.get();
    const mods = [...(config.customClientMods || [])];
    const mod = mods.find((entry) => entry.filename === filename);
    if (!mod) throw new Error(`Unknown local mod: ${filename}`);
    fs.rmSync(modPath(config.gameDir, filename, mod.enabled), { force: true });
    LauncherLogger.info(`[Client Mods] Removed custom mod: ${filename}`);
    const updated = mods.filter((entry) => entry.filename !== filename);
    ConfigManager.set({ customClientMods: updated });
    return updated;
  }

  static setOfficialEnabled(modId: string, enabled: boolean): string[] {
    const disabled = new Set(ConfigManager.get().disabledClientMods || []);
    if (enabled) disabled.delete(modId);
    else disabled.add(modId);
    LauncherLogger.info(`[Client Mods] ${enabled ? "Enabled" : "Disabled"} official mod: ${modId}`);
    const updated = Array.from(disabled).sort();
    ConfigManager.set({ disabledClientMods: updated });
    return updated;
  }
}
