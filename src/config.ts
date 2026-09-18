import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { app } from "electron";
import { LauncherLogger } from "./logger";
import { writeAtomicFileSync } from "./file-transfer";
import { SessionManager } from "./session-manager";
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

import { normalizePortalUrl, isExactLoopbackHost, portalFetch, PortalRedirectPolicyError, PortalPolicyError, PortalPolicy, type DevelopmentPortalPolicy } from "./portal-policy";
export { normalizePortalUrl, validateWebUrl, isApprovedRemoteHost, isExactLoopbackHost, portalFetch, PortalRedirectPolicyError, PortalPolicyError, PortalPolicy, type DevelopmentPortalPolicy } from "./portal-policy";

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

  static getConfigPath(): string {
    this.initPath();
    return this.configPath;
  }

  static getSessionGeneration(): number {
    return SessionManager.getSessionEpoch();
  }

  static incrementSessionGeneration(): number {
    return SessionManager.advanceSessionEpoch();
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

  static {
    SessionManager.addSessionListener((creds) => {
      if (ConfigManager.cachedConfig) {
        if (creds) {
          ConfigManager.cachedConfig.token = creds.token;
          ConfigManager.cachedConfig.refreshToken = creds.refreshToken;
          ConfigManager.cachedConfig.minecraftAccessToken = creds.minecraftAccessToken;
          ConfigManager.cachedConfig.sessionPortalUrl = creds.portalUrl;
        } else {
          delete ConfigManager.cachedConfig.token;
          delete ConfigManager.cachedConfig.refreshToken;
          delete ConfigManager.cachedConfig.minecraftAccessToken;
          delete ConfigManager.cachedConfig.sessionPortalUrl;
        }
      }
    });
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
        delete (loaded as any).token;
        delete (loaded as any).refreshToken;
        delete (loaded as any).minecraftAccessToken;
        delete (loaded as any).sessionPortalUrl;

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

    // Phase 3 Security: Main-only Session Authority & Credential Separation
    // Initialize SessionManager with config path and active portal
    SessionManager.initialize(this.configPath, loaded.portalUrl);

    // Populate in-memory credentials from SessionManager (secrets never live in config.json on disk)
    const creds = SessionManager.getCredentials();
    if (creds && creds.token) {
      loaded.token = creds.token;
      loaded.refreshToken = creds.refreshToken;
      loaded.minecraftAccessToken = creds.minecraftAccessToken;
      loaded.sessionPortalUrl = creds.portalUrl;
    }

    if (!loaded.gameDir) {
      loaded.gameDir = defaultGameDir;
    }

    loaded.noSync = Boolean(loaded.noSync);
    this.cachedConfig = loaded;
    return this.cachedConfig;
  }

  static set(newConfig: Partial<LauncherConfig>): LauncherConfig {
    this.initPath();
    const current = { ...this.get() };

    // Security invariant: sessionPortalUrl cannot be forged or modified via generic set()
    const attemptedSessionPortalForgery = "sessionPortalUrl" in newConfig;
    const sanitizedConfig = { ...newConfig };
    delete (sanitizedConfig as any).sessionPortalUrl;
    delete (sanitizedConfig as any).token;
    delete (sanitizedConfig as any).refreshToken;
    delete (sanitizedConfig as any).minecraftAccessToken;

    const updated = { ...current, ...sanitizedConfig };

    // Phase 3 SEC-03/SEC-08: Credential mutation is removed from generic ConfigManager.set().
    // Preserves token-free renderer DTOs and origin isolation. Sessions must be managed
    // exclusively via SessionManager (or ConfigManager.establishSession / clearSession).
    updated.token = current.token;
    updated.refreshToken = current.refreshToken;
    updated.minecraftAccessToken = current.minecraftAccessToken;
    updated.sessionPortalUrl = current.sessionPortalUrl;

    if (sanitizedConfig.portalUrl !== undefined) {
      const priorCanonical = normalizePortalUrl(current.portalUrl);
      const nextCanonical = normalizePortalUrl(sanitizedConfig.portalUrl);
      updated.portalUrl = nextCanonical;

      // Phase 1 Security: Advance authentication generation on any actual active portal origin change,
      // independently of whether an active session was already established.
      const originChanged = priorCanonical !== nextCanonical;
      const sessionMismatch = Boolean(current.sessionPortalUrl && nextCanonical !== current.sessionPortalUrl);

      if (originChanged || sessionMismatch) {
        SessionManager.onPortalUrlChanged(nextCanonical);
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
    credentials: {
      token?: string;
      refreshToken?: string;
      minecraftAccessToken?: string;
      portalAccountId?: string;
      portalUsername?: string;
    },
    extraSettings?: Partial<LauncherConfig>
  ): LauncherConfig {
    this.initPath();
    const current = { ...this.get() };

    if (credentials.token) {
      const tokenHash = crypto.createHash("sha256").update(credentials.token).digest("hex").slice(0, 10);
      const portalAccountId = credentials.portalAccountId || `config-account-${tokenHash}`;
      const portalUsername = credentials.portalUsername || `ConfigUser-${tokenHash.slice(0, 4)}`;
      SessionManager.establishSession(issuingOrigin, {
        token: credentials.token,
        refreshToken: credentials.refreshToken,
        minecraftAccessToken: credentials.minecraftAccessToken,
        portalAccountId,
        portalUsername,
      });
    }

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
    const current = { ...this.get() };
    SessionManager.clearSession();

    const updated: LauncherConfig = {
      ...current,
      token: undefined,
      refreshToken: undefined,
      minecraftAccessToken: undefined,
      sessionPortalUrl: undefined,
    };

    for (const key of Object.keys(updated) as Array<keyof LauncherConfig>) {
      if (updated[key] === undefined) {
        delete updated[key];
      }
    }

    return this.persistAndEmit(current, updated);
  }

  private static persistAndEmit(current: LauncherConfig, updated: LauncherConfig): LauncherConfig {
    // Phase 3 Security: Settings persistence must NEVER serialize tokens or secret fields to disk
    const toPersist = { ...updated };
    delete (toPersist as any).token;
    delete (toPersist as any).refreshToken;
    delete (toPersist as any).minecraftAccessToken;
    delete (toPersist as any).sessionPortalUrl;

    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writeAtomicFileSync(this.configPath, JSON.stringify(toPersist, null, 2), "utf-8");

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
    SessionManager.resetForTesting();
  }
}
