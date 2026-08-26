import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  LauncherConfig,
  SyncProgress,
  GameLogEntry,
  UserProfile,
  DirectoryStatus,
  DirectoryValidationResult,
  DirectoryMoveProgress,
  DirectoryMoveResult,
  ServerStatus,
} from "./types";

contextBridge.exposeInMainWorld("lampas", {
  auth: {
    login: (portalUrl?: string): Promise<{ token: string; user: UserProfile }> =>
      ipcRenderer.invoke("auth:login", portalUrl),
    logout: (): Promise<void> => ipcRenderer.invoke("auth:logout"),
    verify: (portalUrl?: string): Promise<{ valid: boolean; user?: UserProfile }> =>
      ipcRenderer.invoke("auth:verify", portalUrl),
    refresh: (portalUrl?: string): Promise<{ valid: boolean; user?: UserProfile; token?: string }> =>
      ipcRenderer.invoke("auth:refresh", portalUrl),
  },
  server: {
    getStatus: (): Promise<ServerStatus> => ipcRenderer.invoke("server:getStatus"),
  },
  sync: {
    start: (): Promise<{ success: boolean; version: string; packName: string }> =>
      ipcRenderer.invoke("sync:start"),
    repair: (): Promise<{ success: boolean; message: string; version: string; packName: string }> =>
      ipcRenderer.invoke("sync:repair"),
    getModCatalog: (): Promise<any[]> => ipcRenderer.invoke("sync:getModCatalog"),
    onProgress: (callback: (progress: SyncProgress) => void) => {
      const handler = (_: any, data: SyncProgress) => callback(data);
      ipcRenderer.on("sync:progress", handler);
      return () => ipcRenderer.removeListener("sync:progress", handler);
    },
  },
  mods: {
    browseAndAdd: () => ipcRenderer.invoke("mods:browseAndAdd"),
    addDropped: (files: File[]) => ipcRenderer.invoke("mods:addPaths", files.map((file) => webUtils.getPathForFile(file))),
    setOfficialEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("mods:setOfficialEnabled", id, enabled),
    setCustomEnabled: (filename: string, enabled: boolean) => ipcRenderer.invoke("mods:setCustomEnabled", filename, enabled),
    removeCustom: (filename: string) => ipcRenderer.invoke("mods:removeCustom", filename),
  },
  game: {
    launch: (user: UserProfile | null, releaseOverride?: any): Promise<boolean> =>
      ipcRenderer.invoke("game:launch", user, releaseOverride),
    kill: (): Promise<void> => ipcRenderer.invoke("game:kill"),
    isRunning: (): Promise<boolean> => ipcRenderer.invoke("game:isRunning"),
    onLog: (callback: (entry: GameLogEntry) => void) => {
      const handler = (_: any, data: GameLogEntry) => callback(data);
      ipcRenderer.on("game:log", handler);
      return () => ipcRenderer.removeListener("game:log", handler);
    },
    onExit: (callback: (code: number | null) => void) => {
      const handler = (_: any, code: number | null) => callback(code);
      ipcRenderer.on("game:exit", handler);
      return () => ipcRenderer.removeListener("game:exit", handler);
    },
  },
  gameDirectory: {
    getStatus: (): Promise<DirectoryStatus> => ipcRenderer.invoke("gameDir:getStatus"),
    browse: (defaultPath?: string): Promise<{ canceled: boolean; filePaths: string[] }> =>
      ipcRenderer.invoke("gameDir:browse", defaultPath),
    validate: (targetPath: string, currentPath?: string): Promise<DirectoryValidationResult> =>
      ipcRenderer.invoke("gameDir:validate", targetPath, currentPath),
    configure: (targetPath: string): Promise<LauncherConfig> =>
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
    get: (): Promise<LauncherConfig> => ipcRenderer.invoke("config:get"),
    set: (newConfig: Partial<LauncherConfig>): Promise<LauncherConfig> =>
      ipcRenderer.invoke("config:set", newConfig),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
    close: () => ipcRenderer.invoke("window:close"),
  },
  utils: {
    openPath: (targetPath: string): Promise<string> => ipcRenderer.invoke("utils:openPath", targetPath),
    getLogPath: (): Promise<string> => ipcRenderer.invoke("utils:getLogPath"),
    openLogsDir: (): Promise<string> => ipcRenderer.invoke("utils:openLogsDir"),
    openLogFile: (): Promise<string> => ipcRenderer.invoke("utils:openLogFile"),
  },
});
