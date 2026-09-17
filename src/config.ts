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

import { normalizePortalUrl, isExactLoopbackHost, portalFetch, PortalRedirectPolicyError, PortalPolicyError } from "./portal-policy";
export { normalizePortalUrl, validateWebUrl, isApprovedRemoteHost, isExactLoopbackHost, portalFetch, PortalRedirectPolicyError, PortalPolicyError } from "./portal-policy";

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
  private static sessionGeneration: number = 1;

  static getSessionGeneration(): number {
    return this.sessionGeneration;
  }

  static incrementSessionGeneration(): number {
    return ++this.sessionGeneration;
  }

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
        this.incrementSessionGeneration();
        // Durable disk cleanup: scrub unencrypted legacy credentials from disk
        if (fs.existsSync(this.configPath)) {
          const scrubbed = { ...loaded };
          delete (scrubbed as any).token;
          delete (scrubbed as any).refreshToken;
          delete (scrubbed as any).minecraftAccessToken;
          delete (scrubbed as any).sessionPortalUrl;
          writeAtomicFileSync(this.configPath, JSON.stringify(scrubbed, null, 2), "utf-8");
        }
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

    // Security invariant: sessionPortalUrl cannot be forged or modified via generic set()
    const sanitizedConfig = { ...newConfig };
    delete (sanitizedConfig as any).sessionPortalUrl;

    const updated = { ...current, ...sanitizedConfig };

    if (sanitizedConfig.portalUrl !== undefined) {
      const normalizedPortal = normalizePortalUrl(sanitizedConfig.portalUrl);
      updated.portalUrl = normalizedPortal;

      // Phase 1 Security: Portal origin changes must invalidate existing credentials based on trusted prior state
      if (current.sessionPortalUrl && normalizedPortal !== current.sessionPortalUrl) {
        updated.token = undefined;
        updated.refreshToken = undefined;
        updated.minecraftAccessToken = undefined;
        updated.sessionPortalUrl = undefined;
        this.incrementSessionGeneration();
      }
    }

    // Ensure sessionPortalUrl remains unset if there are no tokens
    if (!updated.token && !updated.refreshToken && !updated.minecraftAccessToken) {
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

    return this.persistAndEmit(current, updated);
  }

  /**
   * Main-only operation to establish newly authenticated credentials with an explicit issuing origin.
   */
  static establishSession(
    issuingOrigin: string,
    credentials: { token?: string; refreshToken?: string; minecraftAccessToken?: string },
    extraSettings?: Partial<LauncherConfig>
  ): LauncherConfig {
    this.initPath();
    const current = this.get();
    const canonicalOrigin = normalizePortalUrl(issuingOrigin);

    const updated: LauncherConfig = {
      ...current,
      ...extraSettings,
      portalUrl: canonicalOrigin,
      sessionPortalUrl: canonicalOrigin,
      token: credentials.token,
      refreshToken: credentials.refreshToken,
      minecraftAccessToken: credentials.minecraftAccessToken,
    };

    this.incrementSessionGeneration();

    for (const key of Object.keys(updated) as Array<keyof LauncherConfig>) {
      if (updated[key] === undefined) {
        delete updated[key];
      }
    }

    return this.persistAndEmit(current, updated);
  }

  /**
   * Main-only operation to clear the active authenticated session.
   */
  static clearSession(): LauncherConfig {
    this.initPath();
    const current = this.get();
    const updated: LauncherConfig = {
      ...current,
      token: undefined,
      refreshToken: undefined,
      minecraftAccessToken: undefined,
      sessionPortalUrl: undefined,
    };

    this.incrementSessionGeneration();

    for (const key of Object.keys(updated) as Array<keyof LauncherConfig>) {
      if (updated[key] === undefined) {
        delete updated[key];
      }
    }

    return this.persistAndEmit(current, updated);
  }

  private static persistAndEmit(current: LauncherConfig, updated: LauncherConfig): LauncherConfig {
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
    this.sessionGeneration = 1;
  }
}
