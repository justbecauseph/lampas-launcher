export interface UserProfile {
  id: string;
  name: string;
  discordId?: string;
  discordTag?: string;
  minecraftUuid?: string;
  minecraftUsername?: string;
  minecraftAccessToken?: string;
  isAdmin: boolean;
  isTech: boolean;
  roles: string[];
  allowedChannels: string[];
}

export interface OnlineMinecraftPlayer {
  uuid: string;
  username: string;
}

export type MinecraftServerState =
  | "starting"
  | "online"
  | "stopping"
  | "offline"
  | "unknown";

export type PresenceFreshness = "live" | "stale" | "unavailable";

export interface ServerStatus {
  server: {
    state: MinecraftServerState;
    managementConnected: boolean;
  };
  players: {
    online: number | null;
    list: OnlineMinecraftPlayer[];
  };
  presence: {
    freshness: PresenceFreshness;
    updatedAt: string | null;
  };
}

export interface LauncherConfig {
  portalUrl: string;
  selectedChannel: "stable" | "beta" | "dev";
  allocatedRamGb: number;
  gameDir: string;
  gameDirConfigured?: boolean;
  javaPath?: string;
  javaArgs?: string;
  disabledClientMods?: string[];
  customClientMods?: CustomClientMod[];
  noSync?: boolean;
  token?: string;
  refreshToken?: string;
  minecraftAccessToken?: string;
}

export interface DirectoryStatus {
  gameDir: string;
  isConfigured: boolean;
  defaultGameDir: string;
  exists: boolean;
  hasInstallation: boolean;
}

export interface DirectoryValidationResult {
  valid: boolean;
  reason?: string;
}

export interface DirectoryMoveProgress {
  phase: "preparing" | "moving" | "verifying" | "cleaning" | "complete";
  filesCompleted: number;
  totalFiles: number;
  bytesCompleted: number;
  totalBytes: number;
  currentFile?: string;
  percent: number;
}

export interface DirectoryMoveResult {
  success: boolean;
  gameDir: string;
  previousGameDir: string;
  error?: string;
}

export interface CustomClientMod {
  filename: string;
  enabled: boolean;
  addedAt: string;
  size: number;
}

export interface SyncProgress {
  status: "idle" | "checking" | "downloading" | "verifying" | "staging" | "repairing" | "complete" | "error";
  message: string;
  currentFile?: string;
  filesCompleted: number;
  totalFiles: number;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
}

export interface GameLogEntry {
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR" | "CHAT";
  message: string;
}

export interface RequiredResourcePack {
  id: string;
  filename: string;
  path: string;
  sha256: string;
  sha1?: string;
}

export interface ReleaseLaunchConfig {
  autoConnect?: boolean;
  server?: string;
  requiredResourcePacks?: RequiredResourcePack[];
}

export interface MinecraftRuntimeDefinition {
  minecraft: string;
  loader: {
    type: "fabric";
    version: string;
  };
}

export interface ReleaseDescriptor extends MinecraftRuntimeDefinition {
  schemaVersion: number;
  pack: string;
  version: string;
  minimumLauncherVersion: string;
  protocol: number;
  gitCommit?: string;
  created: string;
  clientManifest: string;
  serverManifest: string;
  totalMods?: number;
  totalFiles?: number;
  launch?: ReleaseLaunchConfig;
  syncGeneration?: string;
}

export type ConfigPatchMode = "enforce" | "once";

export type MissingFilePolicy = "defer" | "create";

export type ConfigOperation =
  | {
      op: "set";
      path: Array<string | number>;
      value: any;
    }
  | {
      op: "remove";
      path: Array<string | number>;
    }
  | {
      op: "replaceLiteral";
      search: string;
      replacement: string;
      expectedMatches: number;
    };

export interface ConfigPatch {
  id: string;
  revision: number;
  path: string;
  adapter: string;
  mode: ConfigPatchMode;
  missingFile: MissingFilePolicy;
  operations: ConfigOperation[];
}

export interface AppliedConfigPatchState {
  revision: number;
  appliedAt: string;
}

export interface InstallationState {
  pack: string;
  version: string;
  installedAt: string;
  syncGeneration?: string;
  releaseVersion?: string;
  managedResourcePacks?: string[];
  appliedConfigPatches?: Record<string, AppliedConfigPatchState>;
  files: Record<
    string,
    {
      sha256: string;
      size: number;
      policy: string;
      mtimeMs?: number;
      verifiedAt?: string;
    }
  >;
  [key: string]: unknown;
}

export interface RendererUserProfile {
  id: string;
  name: string;
  discordId?: string;
  discordTag?: string;
  minecraftUuid?: string;
  minecraftUsername?: string;
  isAdmin: boolean;
  isTech: boolean;
  roles: string[];
  allowedChannels: string[];
}

export interface RendererSettingsDto {
  portalUrl: string;
  selectedChannel: "stable" | "beta" | "dev";
  allocatedRamGb: number;
  gameDir: string;
  gameDirConfigured?: boolean;
  javaPath?: string;
  javaArgs?: string;
  disabledClientMods?: string[];
  customClientMods?: CustomClientMod[];
  noSync?: boolean;
}

export interface ModCatalogEntry {
  id: string;
  name?: string;
  filename?: string;
  description?: string;
  side: "client" | "server" | "both";
  categories?: string[];
  source: "official" | "custom";
  enabled: boolean;
  canDisable: boolean;
  size?: number;
  iconUrl?: string;
  sourceUrl?: string;
}

export interface InstalledRuntimeInfo {
  minecraft: string;
  loader: {
    type: string;
    version: string;
  };
  launch?: ReleaseLaunchConfig;
}

export interface SyncResult {
  success: boolean;
  version: string;
  packName: string;
  message?: string;
  release?: ReleaseDescriptor;
  runtime?: InstalledRuntimeInfo;
}

export interface LampasApi {
  auth: {
    login: (portalUrl?: string) => Promise<{ user: RendererUserProfile }>;
    logout: () => Promise<void>;
    verify: (portalUrl?: string) => Promise<{ valid: boolean; user?: RendererUserProfile }>;
    refresh: (portalUrl?: string) => Promise<{ valid: boolean; user?: RendererUserProfile }>;
  };
  server: {
    getStatus: () => Promise<ServerStatus>;
  };
  sync: {
    start: () => Promise<SyncResult>;
    repair: () => Promise<SyncResult>;
    getModCatalog: () => Promise<ModCatalogEntry[]>;
    getInstalledRuntime: () => Promise<InstalledRuntimeInfo | null>;
    onProgress: (callback: (progress: SyncProgress) => void) => () => void;
  };
  mods: {
    browseAndAdd: () => Promise<{ success: boolean; filesAdded?: string[]; error?: string }>;
    addDropped: (files: File[]) => Promise<{ success: boolean; filesAdded?: string[]; error?: string }>;
    setOfficialEnabled: (id: string, enabled: boolean) => Promise<void>;
    setCustomEnabled: (filename: string, enabled: boolean) => Promise<void>;
    removeCustom: (filename: string) => Promise<void>;
  };
  game: {
    launch: (user: RendererUserProfile | null, releaseOverride?: any) => Promise<boolean>;
    kill: () => Promise<void>;
    isRunning: () => Promise<boolean>;
    onLog: (callback: (entry: GameLogEntry) => void) => () => void;
    onLogBatch: (callback: (batch: { batchId: number; entries: GameLogEntry[]; dropped: number; bytes?: number }) => void) => () => void;
    onExit: (callback: (code: number | null) => void) => () => void;
  };
  gameDirectory: {
    getStatus: () => Promise<DirectoryStatus>;
    browse: (defaultPath?: string) => Promise<{ canceled: boolean; filePaths: string[] }>;
    validate: (targetPath: string, currentPath?: string) => Promise<DirectoryValidationResult>;
    configure: (targetPath: string) => Promise<RendererSettingsDto>;
    move: (targetPath: string) => Promise<DirectoryMoveResult>;
    onMoveProgress: (callback: (progress: DirectoryMoveProgress) => void) => () => void;
  };
  config: {
    get: () => Promise<RendererSettingsDto>;
    set: (newConfig: Partial<RendererSettingsDto>) => Promise<RendererSettingsDto>;
  };
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    close: () => Promise<void>;
  };
  utils: {
    getAppVersion: () => Promise<string>;
    openPath: (targetPath: string) => Promise<string>;
    getLogPath: () => Promise<string>;
    openLogsDir: () => Promise<string>;
    openLogFile: () => Promise<string>;
    getMinecraftLogPath: () => Promise<string>;
    openMinecraftLog: () => Promise<string>;
  };
}

