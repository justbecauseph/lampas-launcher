import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  SyncProgress,
  SyncResult,
  GameLogEntry,
  DirectoryStatus,
  DirectoryValidationResult,
  DirectoryMoveProgress,
  DirectoryMoveResult,
  ServerStatus,
  RendererUserProfile,
  RendererSettingsDto,
  ModCatalogEntry,
  InstalledRuntimeInfo,
  UpdateSettingsDto,
  KnownLocationId,
  AuthStorageStatusDto,
  ClearCredentialsResult,
  CosmeticImageResult,
  LampasApi,
} from "./types";

const api: LampasApi = {
  auth: {
    login: (): Promise<{ user: RendererUserProfile }> =>
      ipcRenderer.invoke("auth:login"),
    logout: (): Promise<ClearCredentialsResult> =>
      ipcRenderer.invoke("auth:logout"),
    verify: (): Promise<{ valid: boolean; user?: RendererUserProfile }> =>
      ipcRenderer.invoke("auth:verify"),
    refresh: (): Promise<{ valid: boolean; user?: RendererUserProfile }> =>
      ipcRenderer.invoke("auth:refresh"),
    getStorageStatus: (): Promise<AuthStorageStatusDto> =>
      ipcRenderer.invoke("auth:getStorageStatus"),
  },
  cosmetics: {
    getAvatar: (): Promise<CosmeticImageResult | null> =>
      ipcRenderer.invoke("cosmetics:getAvatar"),
    getModIcon: (id: string): Promise<CosmeticImageResult | null> =>
      ipcRenderer.invoke("cosmetics:getModIcon", id),
  },
  server: {
    getStatus: (): Promise<ServerStatus> =>
      ipcRenderer.invoke("server:getStatus"),
  },
  sync: {
    start: (): Promise<SyncResult> => ipcRenderer.invoke("sync:start"),
    repair: (): Promise<SyncResult> => ipcRenderer.invoke("sync:repair"),
    getModCatalog: (): Promise<ModCatalogEntry[]> =>
      ipcRenderer.invoke("sync:getModCatalog"),
    getInstalledRuntime: (): Promise<InstalledRuntimeInfo | null> =>
      ipcRenderer.invoke("sync:getInstalledRuntime"),
    onProgress: (callback: (progress: SyncProgress) => void) => {
      const handler = (_: any, data: SyncProgress) => callback(data);
      ipcRenderer.on("sync:progress", handler);
      return () => ipcRenderer.removeListener("sync:progress", handler);
    },
  },
  mods: {
    browseAndAdd: () => ipcRenderer.invoke("mods:browseAndAdd"),
    addDropped: (files: File[]) =>
      ipcRenderer.invoke(
        "mods:addPaths",
        files.map((file) => webUtils.getPathForFile(file)),
      ),
    setOfficialEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("mods:setOfficialEnabled", id, enabled),
    setCustomEnabled: (filename: string, enabled: boolean) =>
      ipcRenderer.invoke("mods:setCustomEnabled", filename, enabled),
    removeCustom: (filename: string) =>
      ipcRenderer.invoke("mods:removeCustom", filename),
  },
  shaders: {
    browseAndAdd: () => ipcRenderer.invoke("shaders:browseAndAdd"),
    addDropped: (files: File[]) =>
      ipcRenderer.invoke(
        "shaders:addPaths",
        files.map((file) => webUtils.getPathForFile(file)),
      ),
    remove: (filename: string) =>
      ipcRenderer.invoke("shaders:remove", filename),
  },
  game: {
    launch: (): Promise<boolean> => ipcRenderer.invoke("game:launch"),
    kill: (): Promise<void> => ipcRenderer.invoke("game:kill"),
    isRunning: (): Promise<boolean> => ipcRenderer.invoke("game:isRunning"),
    onLog: (callback: (entry: GameLogEntry) => void) => {
      const handler = (_: any, data: GameLogEntry) => callback(data);
      ipcRenderer.on("game:log", handler);
      return () => ipcRenderer.removeListener("game:log", handler);
    },
    onLogBatch: (
      callback: (batch: {
        batchId: number;
        entries: GameLogEntry[];
        dropped: number;
        bytes?: number;
      }) => void,
    ) => {
      const handler = (
        _: any,
        data: {
          batchId: number;
          entries: GameLogEntry[];
          dropped: number;
          bytes?: number;
        },
      ) => {
        callback(data);
        ipcRenderer.send("game:logAck", { batchId: data.batchId });
      };
      ipcRenderer.on("game:logBatch", handler);
      return () => ipcRenderer.removeListener("game:logBatch", handler);
    },
    onExit: (callback: (code: number | null) => void) => {
      const handler = (_: any, code: number | null) => callback(code);
      ipcRenderer.on("game:exit", handler);
      return () => ipcRenderer.removeListener("game:exit", handler);
    },
  },
  gameDirectory: {
    getStatus: (): Promise<DirectoryStatus> =>
      ipcRenderer.invoke("gameDir:getStatus"),
    browse: (
      defaultPath?: string,
    ): Promise<{ canceled: boolean; filePaths: string[] }> =>
      ipcRenderer.invoke("gameDir:browse", defaultPath),
    validate: (
      targetPath: string,
      currentPath?: string,
    ): Promise<DirectoryValidationResult> =>
      ipcRenderer.invoke("gameDir:validate", targetPath, currentPath),
    configure: (targetPath: string): Promise<RendererSettingsDto> =>
      ipcRenderer.invoke("gameDir:configure", targetPath),
    move: (targetPath: string): Promise<DirectoryMoveResult> =>
      ipcRenderer.invoke("gameDir:move", targetPath),
    onMoveProgress: (callback: (progress: DirectoryMoveProgress) => void) => {
      const handler = (_: any, data: DirectoryMoveProgress) => callback(data);
      ipcRenderer.on("gameDir:moveProgress", handler);
      return () => ipcRenderer.removeListener("gameDir:moveProgress", handler);
    },
  },
  config: {
    get: (): Promise<RendererSettingsDto> => ipcRenderer.invoke("config:get"),
    set: (newConfig: UpdateSettingsDto): Promise<RendererSettingsDto> =>
      ipcRenderer.invoke("config:set", newConfig),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke("window:isMaximized"),
    close: () => ipcRenderer.invoke("window:close"),
  },
  utils: {
    getAppVersion: (): Promise<string> =>
      ipcRenderer.invoke("utils:getAppVersion"),
    openPath: (targetPath: string): Promise<string> =>
      ipcRenderer.invoke("utils:openPath", targetPath),
    openSourcePage: (url: string): Promise<string> =>
      ipcRenderer.invoke("utils:openSourcePage", url),
    openKnownLocation: (location: KnownLocationId): Promise<string> =>
      ipcRenderer.invoke("utils:openKnownLocation", location),
    getLogPath: (): Promise<string> => ipcRenderer.invoke("utils:getLogPath"),
    openLogsDir: (): Promise<string> => ipcRenderer.invoke("utils:openLogsDir"),
    openLogFile: (): Promise<string> => ipcRenderer.invoke("utils:openLogFile"),
    getMinecraftLogPath: (): Promise<string> =>
      ipcRenderer.invoke("utils:getMinecraftLogPath"),
    openMinecraftLog: (): Promise<string> =>
      ipcRenderer.invoke("utils:openMinecraftLog"),
  },
};

contextBridge.exposeInMainWorld("lampas", api);
