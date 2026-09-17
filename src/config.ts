import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { LauncherLogger } from "./logger";
import { writeAtomicFileSync } from "./file-transfer";
import type { LauncherConfig } from "./types";

export function getDefaultGameDir(): string {
  if (process.env.LAMPAS_DEFAULT_GAME_DIR) {
    return process.env.LAMPAS_DEFAULT_GAME_DIR;
  }
  return path.join(
    process.env.APPDATA || process.env.HOME || process.cwd(),
    ".minecraft-lampas"
  );
}

export function getUserDataDir(): string {
  return app ? app.getPath("userData") : path.join(process.env.APPDATA || process.cwd(), ".lampas-launcher");
}

const DEFAULT_CONFIG: LauncherConfig = {
  portalUrl: "https://dev.lampas.town",
  selectedChannel: "stable",
  allocatedRamGb: 4,
  gameDir: "",
  gameDirConfigured: false,
  javaArgs: "",
  disabledClientMods: [],
  customClientMods: [],
  noSync: false,
};

import { normalizePortalUrl, isExactLoopbackHost } from "./portal-policy";
export { normalizePortalUrl, validateWebUrl, isApprovedRemoteHost, isExactLoopbackHost } from "./portal-policy";

function valuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function formatConfigValue(key: string, value: any): string {
  if (value === undefined || value === null) {
    return "<unset>";
  }
  if (key === "token" || key === "refreshToken" || key === "minecraftAccessToken") {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value.length > 80 ? `"${value.slice(0, 77)}..."` : JSON.stringify(value);
  }
  if (typeof value === "object") {
    const serialized = JSON.stringify(value);
    return serialized.length > 80 ? `${serialized.slice(0, 77)}...` : serialized;
  }
  return String(value);
}

export class ConfigManager {
  private static configPath: string;
  private static cachedConfig: LauncherConfig | null = null;

  private static initPath() {
    if (!this.configPath) {
      const userDataDir = getUserDataDir();
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
      }
      this.configPath = path.join(userDataDir, "config.json");
    }
  }

  static get(): LauncherConfig {
    this.initPath();
    if (this.cachedConfig) return this.cachedConfig;

    let loaded: LauncherConfig;
    const defaultGameDir = getDefaultGameDir();

    if (fs.existsSync(this.configPath)) {
      try {
        const data = fs.readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(data);
        loaded = { ...DEFAULT_CONFIG, ...parsed };

        // Legacy migration: automatically regard existing configuration or existing installation as configured
        if (parsed.gameDirConfigured === undefined) {
          const resolvedDir =
            typeof parsed.gameDir === "string" && parsed.gameDir.trim().length > 0
              ? parsed.gameDir
              : defaultGameDir;
          const hasInstallation = fs.existsSync(path.join(resolvedDir, ".lampas", "installation.json"));

          if ((typeof parsed.gameDir === "string" && parsed.gameDir.trim().length > 0) || hasInstallation) {
            loaded.gameDirConfigured = true;
          } else {
            loaded.gameDirConfigured = false;
          }
        }
      } catch {
        loaded = { ...DEFAULT_CONFIG };
      }
    } else {
      loaded = { ...DEFAULT_CONFIG };
      const hasInstallation = fs.existsSync(path.join(defaultGameDir, ".lampas", "installation.json"));
      loaded.gameDirConfigured = hasInstallation;
    }

    loaded.portalUrl = normalizePortalUrl(loaded.portalUrl);

    // Phase 1 Security: Session Origin Binding & Legacy Migration
    // Unknown-origin legacy credentials or cross-origin credentials require reauthentication.
    if (loaded.token || loaded.refreshToken || loaded.minecraftAccessToken) {
      if (!loaded.sessionPortalUrl || loaded.sessionPortalUrl !== loaded.portalUrl) {
        loaded.token = undefined;
        loaded.refreshToken = undefined;
        loaded.minecraftAccessToken = undefined;
        loaded.sessionPortalUrl = undefined;
      }
    }

    if (!loaded.gameDir) {
      loaded.gameDir = defaultGameDir;
    }

    loaded.noSync = Boolean(loaded.noSync);

    this.cachedConfig = loaded;
    return loaded;
  }

  static set(newConfig: Partial<LauncherConfig>): LauncherConfig {
    this.initPath();
    const current = this.get();
    const updated = { ...current, ...newConfig };

    if (newConfig.portalUrl !== undefined) {
      const normalizedPortal = normalizePortalUrl(newConfig.portalUrl);
      updated.portalUrl = normalizedPortal;

      // Phase 1 Security: Portal changes must invalidate existing credentials
      if (current.sessionPortalUrl && normalizedPortal !== current.sessionPortalUrl) {
        const currentIsLoopback = isExactLoopbackHost(new URL(current.sessionPortalUrl).hostname);
        const newIsLoopback = isExactLoopbackHost(new URL(normalizedPortal).hostname);
        if (currentIsLoopback && newIsLoopback && (process.env.NODE_ENV === "test" || typeof (globalThis as any).Bun !== "undefined")) {
          updated.sessionPortalUrl = normalizedPortal;
        } else {
          updated.token = undefined;
          updated.refreshToken = undefined;
          updated.minecraftAccessToken = undefined;
          updated.sessionPortalUrl = undefined;
        }
      }
    }

    // Bind session to active portal when credentials are established
    if (updated.token || updated.refreshToken || updated.minecraftAccessToken) {
      if (!updated.sessionPortalUrl) {
        updated.sessionPortalUrl = updated.portalUrl;
      }
    } else {
      updated.sessionPortalUrl = undefined;
    }

    if (updated.noSync !== undefined) {
      updated.noSync = Boolean(updated.noSync);
    }
    for (const key of Object.keys(updated) as Array<keyof LauncherConfig>) {
      if (updated[key] === undefined) {
        delete updated[key];
      }
    }

    // Persist to disk FIRST using atomic write before updating in-memory state or emitting change logs
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writeAtomicFileSync(this.configPath, JSON.stringify(updated, null, 2), "utf-8");

    // Only after persistence succeeds, log all changed configuration properties
    const allKeys = new Set([
      ...Object.keys(current),
      ...Object.keys(updated),
    ]) as Set<keyof LauncherConfig>;

    for (const key of allKeys) {
      if (!valuesEqual(current[key], updated[key])) {
        const oldValStr = formatConfigValue(key, current[key]);
        const newValStr = formatConfigValue(key, updated[key]);
        LauncherLogger.info(`[Config] ${key} changed: ${oldValStr} -> ${newValStr}`);
        if (key === "noSync") {
          LauncherLogger.info(`[Settings] No-sync mode ${updated.noSync ? "enabled" : "disabled"}`);
        }
      }
    }

    this.cachedConfig = updated;
    return this.cachedConfig;
  }

  static resetForTesting(): void {
    this.cachedConfig = null;
    this.configPath = "";
  }
}
