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

export interface FabricLoaderDefinition {
  type: "fabric";
  version: string;
}

export interface ReleaseDescriptor {
  schemaVersion: number;
  pack: string;
  version: string;
  minecraft: string;
  loader: FabricLoaderDefinition;
  minimumLauncherVersion: string;
  protocol: number;
  gitCommit?: string;
  created: string;
  clientManifest: string;
  serverManifest: string;
  totalMods?: number;
  totalFiles?: number;
  launch?: ReleaseLaunchConfig;
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
