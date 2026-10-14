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
  // Store (MSIX) builds default to the package's own storage, which Windows
  // deletes on uninstall. Users who want the files kept choose another
  // location during setup.
  const packageCache = getStorePackageCacheDir();
  if (packageCache) {
    return path.join(packageCache, ".minecraft-lampas");
  }
  return getLegacyDefaultGameDir();
}

/** The %APPDATA% default every build used before Store builds got their own. */
export function getLegacyDefaultGameDir(): string {
  return path.join(
    process.env.APPDATA || process.env.HOME || process.cwd(),
    ".minecraft-lampas",
  );
}

/**
 * For a Store (MSIX) install, the package's LocalCache folder, written to
 * directly rather than through the %APPDATA% redirection, so the path the
 * launcher shows is where the files really are. Null for other builds or
 * when the package folder can't be found.
 */
export function getStorePackageCacheDir(
  execPath: string = process.execPath,
  isStore: boolean = Boolean(
    (process as { windowsStore?: boolean }).windowsStore,
  ),
): string | null {
  if (!isStore || !process.env.LOCALAPPDATA) return null;
  // Installed under ...\WindowsApps\<Name>_<Version>_<Arch>_<ResourceId>_<PublisherId>\
  const segments = execPath.split(/[\\/]/);
  const appsIndex = segments.findIndex(
    (s) => s.toLowerCase() === "windowsapps",
  );
  const fullName = appsIndex >= 0 ? segments[appsIndex + 1] : undefined;
  const parts = fullName?.split("_");
  if (!parts || parts.length !== 5 || !parts[0] || !parts[4]) return null;
  const packageRoot = path.join(
    process.env.LOCALAPPDATA,
    "Packages",
    `${parts[0]}_${parts[4]}`,
  );
  return fs.existsSync(packageRoot)
    ? path.join(packageRoot, "LocalCache")
    : null;
}

export function getUserDataDir(): string {
  return app
    ? app.getPath("userData")
    : path.join(process.env.APPDATA || process.cwd(), ".lampas-launcher");
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
  customShaderPacks: [],
  noSync: false,
  externalImages: true,
};

import {
  normalizePortalUrl,
  isExactLoopbackHost,
  portalFetch,
  PortalRedirectPolicyError,
  PortalPolicyError,
  PortalPolicy,
  type DevelopmentPortalPolicy,
} from "./portal-policy";
export {
  normalizePortalUrl,
  validateWebUrl,
  isApprovedRemoteHost,
  isExactLoopbackHost,
  portalFetch,
  PortalRedirectPolicyError,
  PortalPolicyError,
  PortalPolicy,
  type DevelopmentPortalPolicy,
} from "./portal-policy";

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
  if (
    key === "token" ||
    key === "refreshToken" ||
    key === "minecraftAccessToken"
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value.length > 80
      ? `"${value.slice(0, 77)}..."`
      : JSON.stringify(value);
  }
  if (typeof value === "object") {
    const serialized = JSON.stringify(value);
    return serialized.length > 80
      ? `${serialized.slice(0, 77)}...`
      : serialized;
  }
  return String(value);
}

const CHANNELS: ReadonlyArray<LauncherConfig["selectedChannel"]> = [
  "stable",
  "beta",
  "dev",
];

/** Credential keys. SessionManager owns them; config.json never supplies them. */
const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "token",
  "refreshToken",
  "minecraftAccessToken",
  "sessionPortalUrl",
]);

/** Every LauncherConfig key that may be read from config.json. */
type PersistedConfigKey = Exclude<
  keyof LauncherConfig,
  "token" | "refreshToken" | "minecraftAccessToken" | "sessionPortalUrl"
>;

const KNOWN_CONFIG_KEY_LIST = [
  "portalUrl",
  "selectedChannel",
  "allocatedRamGb",
  "gameDir",
  "gameDirConfigured",
  "gameDirPreexistingEntries",
  "javaPath",
  "javaArgs",
  "disabledClientMods",
  "customClientMods",
  "customShaderPacks",
  "noSync",
  "externalImages",
] as const satisfies readonly PersistedConfigKey[];

// Compile-time check: a key added to LauncherConfig must also be listed above,
// otherwise sanitizeLoadedConfig would silently drop it on load.
type MissingKnownConfigKey = Exclude<
  PersistedConfigKey,
  (typeof KNOWN_CONFIG_KEY_LIST)[number]
>;
const knownConfigKeysAreExhaustive: [MissingKnownConfigKey] extends [never]
  ? true
  : never = true;
void knownConfigKeysAreExhaustive;

const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set(KNOWN_CONFIG_KEY_LIST);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a managed-file entry ({ filename, addedAt, size, ... }) whose filename
 * is a bare name with the given extension. Returns null for anything else.
 */
function readManagedFileEntry(
  value: unknown,
  extension: string,
): { filename: string; addedAt: string; size: number } | null {
  if (!isPlainObject(value)) return null;
  const { filename, addedAt, size } = value;
  if (
    typeof filename !== "string" ||
    filename !== path.basename(filename) ||
    path.extname(filename).toLowerCase() !== extension
  ) {
    return null;
  }
  return {
    filename,
    addedAt: typeof addedAt === "string" ? addedAt : "",
    size:
      typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : 0,
  };
}

/**
 * Reduces the parsed contents of config.json to the settings the launcher
 * understands, with the right types. Invalid values are left out so the
 * defaults apply, and malformed list entries are dropped one by one.
 * Credentials never come from this file (SessionManager owns them), so the
 * secret keys are not copied. `dropped` names the keys that were ignored,
 * never their values.
 */
function sanitizeLoadedConfig(parsed: unknown): {
  config: Partial<LauncherConfig>;
  dropped: string[];
} {
  const config: Partial<LauncherConfig> = {};
  const dropped = new Set<string>();

  if (!isPlainObject(parsed)) {
    dropped.add("(root)");
    return { config, dropped: [...dropped] };
  }

  for (const key of Object.keys(parsed)) {
    if (!KNOWN_CONFIG_KEYS.has(key) && !SECRET_CONFIG_KEYS.has(key)) {
      // Key names come from a hand-editable file; keep the log line printable.
      dropped.add(key.replace(/[^\x20-\x7e]/g, "?").slice(0, 64));
    }
  }

  const has = (key: string): boolean => Object.hasOwn(parsed, key);

  if (has("portalUrl")) {
    const v = parsed.portalUrl;
    if (typeof v === "string" && v.length > 0) config.portalUrl = v;
    else dropped.add("portalUrl");
  }
  if (has("selectedChannel")) {
    const v = parsed.selectedChannel;
    if (CHANNELS.includes(v as LauncherConfig["selectedChannel"])) {
      config.selectedChannel = v as LauncherConfig["selectedChannel"];
    } else dropped.add("selectedChannel");
  }
  if (has("allocatedRamGb")) {
    const v = parsed.allocatedRamGb;
    if (typeof v === "number" && Number.isInteger(v) && v >= 2 && v <= 64) {
      config.allocatedRamGb = v;
    } else dropped.add("allocatedRamGb");
  }
  for (const key of ["gameDir", "javaPath", "javaArgs"] as const) {
    if (!has(key)) continue;
    const v = parsed[key];
    if (typeof v === "string") config[key] = v;
    else dropped.add(key);
  }
  for (const key of [
    "gameDirConfigured",
    "noSync",
    "externalImages",
  ] as const) {
    if (!has(key)) continue;
    const v = parsed[key];
    if (typeof v === "boolean") config[key] = v;
    else dropped.add(key);
  }

  if (has("disabledClientMods")) {
    const v = parsed.disabledClientMods;
    if (Array.isArray(v)) {
      config.disabledClientMods = v.filter(
        (item): item is string => typeof item === "string",
      );
      if (config.disabledClientMods.length !== v.length) {
        dropped.add("disabledClientMods");
      }
    } else {
      config.disabledClientMods = [];
      dropped.add("disabledClientMods");
    }
  }

  if (has("customClientMods")) {
    const v = parsed.customClientMods;
    const mods: NonNullable<LauncherConfig["customClientMods"]> = [];
    if (Array.isArray(v)) {
      for (const item of v) {
        const entry = readManagedFileEntry(item, ".jar");
        if (entry) {
          mods.push({
            ...entry,
            enabled: Boolean((item as Record<string, unknown>).enabled),
          });
        }
      }
    }
    config.customClientMods = mods;
    if (!Array.isArray(v) || mods.length !== v.length) {
      dropped.add("customClientMods");
    }
  }

  if (has("customShaderPacks")) {
    const v = parsed.customShaderPacks;
    const packs: NonNullable<LauncherConfig["customShaderPacks"]> = [];
    if (Array.isArray(v)) {
      for (const item of v) {
        const entry = readManagedFileEntry(item, ".zip");
        if (entry) packs.push(entry);
      }
    }
    config.customShaderPacks = packs;
    if (!Array.isArray(v) || packs.length !== v.length) {
      dropped.add("customShaderPacks");
    }
  }

  if (has("gameDirPreexistingEntries")) {
    const v = parsed.gameDirPreexistingEntries;
    if (Array.isArray(v)) {
      const entries = v.filter(
        (item): item is string => typeof item === "string",
      );
      config.gameDirPreexistingEntries = entries;
      if (entries.length !== v.length) dropped.add("gameDirPreexistingEntries");
    } else dropped.add("gameDirPreexistingEntries");
  }

  return { config, dropped: [...dropped] };
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
          ConfigManager.cachedConfig.minecraftAccessToken =
            creds.minecraftAccessToken;
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
        const { config: parsed, dropped } = sanitizeLoadedConfig(
          JSON.parse(data),
        );
        if (dropped.length > 0) {
          LauncherLogger.warn(
            `[Config] Ignored invalid settings: ${dropped.join(", ")}`,
          );
        }
        // Secrets are never read from config.json; sanitizeLoadedConfig skips them.
        loaded = { ...DEFAULT_CONFIG, ...parsed };

        // Legacy migration: automatically regard existing configuration or existing installation as configured
        if (parsed.gameDirConfigured === undefined) {
          const resolvedDir =
            typeof parsed.gameDir === "string" &&
            parsed.gameDir.trim().length > 0
              ? parsed.gameDir
              : defaultGameDir;
          const hasInstallation = fs.existsSync(
            path.join(resolvedDir, ".lampas", "installation.json"),
          );

          if (
            (typeof parsed.gameDir === "string" &&
              parsed.gameDir.trim().length > 0) ||
            hasInstallation
          ) {
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
      const hasInstallation = fs.existsSync(
        path.join(defaultGameDir, ".lampas", "installation.json"),
      );
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
    loaded.externalImages = Boolean(loaded.externalImages);
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
      const sessionMismatch = Boolean(
        current.sessionPortalUrl && nextCanonical !== current.sessionPortalUrl,
      );

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
    if (
      !updated.token &&
      !updated.refreshToken &&
      !updated.minecraftAccessToken
    ) {
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
    extraSettings?: Partial<LauncherConfig>,
  ): LauncherConfig {
    this.initPath();
    const current = { ...this.get() };

    if (credentials.token) {
      const tokenHash = crypto
        .createHash("sha256")
        .update(credentials.token)
        .digest("hex")
        .slice(0, 10);
      const portalAccountId =
        credentials.portalAccountId || `config-account-${tokenHash}`;
      const portalUsername =
        credentials.portalUsername || `ConfigUser-${tokenHash.slice(0, 4)}`;
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

  private static persistAndEmit(
    current: LauncherConfig,
    updated: LauncherConfig,
  ): LauncherConfig {
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
    writeAtomicFileSync(
      this.configPath,
      JSON.stringify(toPersist, null, 2),
      "utf-8",
    );

    // Only after persistence succeeds, log all changed configuration properties
    const allKeys = new Set([
      ...Object.keys(current),
      ...Object.keys(updated),
    ]) as Set<keyof LauncherConfig>;

    for (const key of allKeys) {
      if (!valuesEqual(current[key], updated[key])) {
        LauncherLogger.info(`[Config] ${key} changed`);
        if (key === "noSync") {
          LauncherLogger.info(
            `[Settings] No-sync mode ${updated.noSync ? "enabled" : "disabled"}`,
          );
        }
      }
    }

    this.cachedConfig = updated;
    return this.cachedConfig;
  }

  /**
   * Main-only: restores default settings, which brings back first-run setup.
   * Callers must clear the session first; this refuses while one is active.
   */
  static resetToDefaults(): void {
    this.initPath();
    const current = this.get();
    if (current.token) {
      throw new Error("Sign out before resetting launcher settings.");
    }
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writeAtomicFileSync(
      this.configPath,
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      "utf-8",
    );
    LauncherLogger.info("[Config] Settings reset to defaults");
    this.incrementSessionGeneration();
    // Re-derive on next read so the default game folder and portal apply.
    this.cachedConfig = null;
  }

  static resetForTesting(): void {
    this.cachedConfig = null;
    this.configPath = "";
    SessionManager.resetForTesting();
  }
}
