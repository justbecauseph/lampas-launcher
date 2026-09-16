import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigManager } from "./config";
import { LauncherAuth } from "./auth";
import { LauncherSync } from "./sync";
import { GameRunner, parseJavaArgs } from "./game-runner";
import { ClientModManager } from "./client-mods";
import { LauncherLogger } from "./logger";
import { GameDirectoryManager } from "./game-directory";
import { ServerStatusClient } from "./server-status";
import { OperationCoordinator, safeSend as safeSendToWindow } from "./operations";
import { BoundedLogBatchTransport } from "./game-log-stream";
import type {
  DirectoryMoveProgress,
  SyncProgress,
  UserProfile,
  LauncherConfig,
  RendererUserProfile,
  RendererSettingsDto,
} from "./types";

let mainWindow: BrowserWindow | null = null;
let logTransport: BoundedLogBatchTransport | null = null;

function safeSend(channel: string, ...args: any[]): void {
  safeSendToWindow(mainWindow, channel, ...args);
}

function toRendererSettingsDto(config: LauncherConfig): RendererSettingsDto {
  return {
    portalUrl: config.portalUrl,
    selectedChannel: config.selectedChannel,
    allocatedRamGb: config.allocatedRamGb,
    gameDir: config.gameDir,
    gameDirConfigured: config.gameDirConfigured,
    javaPath: config.javaPath,
    javaArgs: config.javaArgs,
    disabledClientMods: config.disabledClientMods,
    customClientMods: config.customClientMods,
    noSync: config.noSync,
  };
}

function toRendererUserProfile(user?: UserProfile): RendererUserProfile | undefined {
  if (!user) return undefined;
  return {
    id: user.id,
    name: user.name,
    discordId: user.discordId,
    discordTag: user.discordTag,
    minecraftUuid: user.minecraftUuid,
    minecraftUsername: user.minecraftUsername,
    isAdmin: user.isAdmin,
    isTech: user.isTech,
    roles: user.roles,
    allowedChannels: user.allowedChannels,
  };
}

function createWindow() {
  const iconPath = path.join(__dirname, "../ui/assets/lampas.png");
  const appIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0b0f0e",
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    const prodPath = path.join(__dirname, "renderer/index.html");
    if (fs.existsSync(prodPath)) {
      mainWindow.loadFile(prodPath);
    } else {
      mainWindow.loadFile(path.join(__dirname, "../ui/index.html"));
    }
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  LauncherLogger.init();
  LauncherLogger.info(`Lampas Launcher initialized (App: ${app.getName()} ${app.getVersion()})`);

  try {
    await GameDirectoryManager.recoverInterruptedMove();
  } catch (err: any) {
    LauncherLogger.error(`Failed to process move journal recovery: ${err.message}`);
  }

  createWindow();

  logTransport = new BoundedLogBatchTransport(() => mainWindow);
  ipcMain.on("game:logAck", (_, data?: { batchId?: number }) => {
    logTransport?.onRendererAck(data?.batchId);
  });

  // IPC Handlers: Window Controls
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("window:close", () => mainWindow?.close());

  // IPC Handlers: Utils
  ipcMain.handle("utils:getAppVersion", () => app.getVersion());
  ipcMain.handle("utils:openPath", async (_, targetPath: string) => {
    if (targetPath) {
      if (/^https?:\/\//i.test(targetPath)) await shell.openExternal(targetPath);
      else await shell.openPath(targetPath);
    }
  });
  ipcMain.handle("utils:getLogPath", () => LauncherLogger.getLogPath());
  ipcMain.handle("utils:openLogsDir", async () => {
    const logsDir = LauncherLogger.getLogsDir();
    await shell.openPath(logsDir);
    return logsDir;
  });
  ipcMain.handle("utils:openLogFile", async () => {
    const logPath = LauncherLogger.getLogPath();
    await shell.openPath(logPath);
    return logPath;
  });
  ipcMain.handle("utils:getMinecraftLogPath", () => {
    const config = ConfigManager.get();
    return path.join(config.gameDir, "logs", "latest.log");
  });
  ipcMain.handle("utils:openMinecraftLog", async () => {
    const config = ConfigManager.get();
    const latestLog = path.join(config.gameDir, "logs", "latest.log");
    if (!fs.existsSync(latestLog)) {
      throw new Error("Minecraft log (latest.log) not found. Launch Minecraft first to create it.");
    }
    await shell.openPath(latestLog);
    return latestLog;
  });

  // IPC Handlers: Config
  ipcMain.handle("config:get", () => toRendererSettingsDto(ConfigManager.get()));
  ipcMain.handle("config:set", (_, newConfig) => {
    OperationCoordinator.assertCanMutate("update configuration");
    const safeConfig = { ...newConfig };
    delete (safeConfig as any).gameDir; // Generic config updates cannot directly overwrite gameDir
    delete (safeConfig as any).gameDirConfigured; // Generic config updates cannot manipulate directory onboarding state
    delete (safeConfig as any).token;
    delete (safeConfig as any).refreshToken;
    delete (safeConfig as any).minecraftAccessToken;
    if (typeof safeConfig?.javaArgs === "string") parseJavaArgs(safeConfig.javaArgs);
    return toRendererSettingsDto(ConfigManager.set(safeConfig));
  });

  // IPC Handlers: Game Directory
  ipcMain.handle("gameDir:getStatus", () => GameDirectoryManager.getStatus());
  ipcMain.handle("gameDir:browse", async (_, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Select Minecraft Installation Directory",
      defaultPath: defaultPath || ConfigManager.get().gameDir,
      properties: ["openDirectory", "createDirectory"],
    });
    return { canceled: result.canceled, filePaths: result.filePaths };
  });
  ipcMain.handle("gameDir:validate", (_, targetPath: string, currentPath?: string) =>
    GameDirectoryManager.validateTarget(targetPath, currentPath));
  ipcMain.handle("gameDir:configure", async (_, targetPath: string) => {
    OperationCoordinator.assertCanMutate("configure game directory");
    const updated = await GameDirectoryManager.configureInitial(targetPath);
    return toRendererSettingsDto(updated);
  });
  ipcMain.handle("gameDir:move", async (_, targetPath: string) => {
    const op = OperationCoordinator.acquire("move", `Move installation to ${targetPath}`);
    const throttledProgress = op.createThrottledProgress<DirectoryMoveProgress>(
      (progress) => safeSend("gameDir:moveProgress", progress),
      100,
      (p) => p.phase === "complete"
    );
    try {
      LauncherLogger.info(`Moving game installation to: ${targetPath}`);
      return await GameDirectoryManager.moveInstallation(targetPath, (progress) => {
        throttledProgress(progress);
      });
    } finally {
      op.release();
    }
  });

  // IPC Handlers: Auth
  ipcMain.handle("auth:login", async (_, portalUrl) => {
    const res = await LauncherAuth.loginWithPortal(portalUrl);
    return { user: toRendererUserProfile(res.user)! };
  });
  ipcMain.handle("auth:logout", () => LauncherAuth.logout());
  ipcMain.handle("auth:verify", async (_, portalUrl) => {
    const res = await LauncherAuth.verifySession(portalUrl);
    return { valid: res.valid, user: toRendererUserProfile(res.user) };
  });
  ipcMain.handle("auth:refresh", async (_, portalUrl) => {
    const res = await LauncherAuth.refreshSession(portalUrl);
    return { valid: res.valid, user: toRendererUserProfile(res.user) };
  });

  // IPC Handlers: Server presence. Portal credentials stay in the main process.
  ipcMain.handle("server:getStatus", () => ServerStatusClient.getStatus());

  // IPC Handlers: Sync & Repair
  ipcMain.handle("sync:start", async () => {
    const op = OperationCoordinator.acquire("sync", "Modpack synchronization");
    const throttledProgress = op.createThrottledProgress<SyncProgress>(
      (progress) => safeSend("sync:progress", progress),
      100,
      (p) => p.status === "complete" || p.status === "error" || p.percent === 100
    );
    try {
      LauncherLogger.info("Starting modpack synchronization...");
      return await LauncherSync.syncClient((progress) => {
        if (progress.message) {
          LauncherLogger.info(`[Sync] ${progress.message}`);
        }
        throttledProgress(progress);
      });
    } finally {
      op.release();
    }
  });
  ipcMain.handle("sync:repair", async () => {
    const op = OperationCoordinator.acquire("repair", "Full installation repair");
    const throttledProgress = op.createThrottledProgress<SyncProgress>(
      (progress) => safeSend("sync:progress", progress),
      100,
      (p) => p.status === "complete" || p.status === "error" || p.percent === 100
    );
    try {
      LauncherLogger.info("Starting full installation repair...");
      return await LauncherSync.repairInstallation(
        (progress) => throttledProgress(progress),
        (log) => {
          LauncherLogger.log(log.level, log.message);
          logTransport?.push(log);
        }
      );
    } finally {
      op.release();
    }
  });
  ipcMain.handle("sync:getModCatalog", () => LauncherSync.getModCatalog());
  ipcMain.handle("sync:getInstalledRuntime", () => {
    const config = ConfigManager.get();
    const releasePath = path.join(config.gameDir, ".lampas", "release.json");
    if (fs.existsSync(releasePath)) {
      try {
        const release = JSON.parse(fs.readFileSync(releasePath, "utf-8"));
        const statePath = path.join(config.gameDir, ".lampas", "installation.json");
        if (fs.existsSync(statePath)) {
          const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
          if (state.version && release.version && state.version !== release.version) {
            return null;
          }
          if (
            state.syncGeneration &&
            release.syncGeneration &&
            state.syncGeneration !== release.syncGeneration
          ) {
            return null;
          }
        }
        if (release?.minecraft && release?.loader?.version) {
          return {
            minecraft: release.minecraft,
            loader: {
              type: release.loader.type || "fabric",
              version: release.loader.version,
            },
            launch: release.launch,
          };
        }
      } catch {}
    }
    return null;
  });

  ipcMain.handle("mods:browseAndAdd", async () => {
    OperationCoordinator.assertCanMutate("add client mods");
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Add local client mods",
      filters: [{ name: "Minecraft mods", extensions: ["jar"] }],
      properties: ["openFile", "multiSelections"],
    });
    return result.canceled ? ClientModManager.list() : ClientModManager.add(result.filePaths);
  });
  ipcMain.handle("mods:addPaths", (_, paths: string[]) => {
    OperationCoordinator.assertCanMutate("add client mods");
    return ClientModManager.add(paths);
  });
  ipcMain.handle("mods:setOfficialEnabled", (_, id: string, enabled: boolean) => {
    OperationCoordinator.assertCanMutate("toggle official mod");
    return ClientModManager.setOfficialEnabled(id, enabled);
  });
  ipcMain.handle("mods:setCustomEnabled", (_, filename: string, enabled: boolean) => {
    OperationCoordinator.assertCanMutate("toggle custom mod");
    return ClientModManager.setEnabled(filename, enabled);
  });
  ipcMain.handle("mods:removeCustom", (_, filename: string) => {
    OperationCoordinator.assertCanMutate("remove custom mod");
    return ClientModManager.remove(filename);
  });

  // IPC Handlers: Game
  ipcMain.handle("game:launch", async (_, user: UserProfile | null, releaseOverride?: any) => {
    const op = OperationCoordinator.acquire("launch", `Launch Minecraft for ${user?.minecraftUsername || user?.name || "Unknown"}`);
    try {
      LauncherLogger.info(`Initiating game launch for player: ${user?.minecraftUsername || user?.name || "Unknown"}`);
      return await GameRunner.launchGame(
        user,
        (log) => {
          // Stream live game output to bounded IPC batch transport
          logTransport?.push(log);
        },
        (code) => {
          logTransport?.flushSession();
          LauncherLogger.info(`Minecraft process exited with code ${code}`);
          safeSend("game:exit", code);
        },
        releaseOverride
      );
    } finally {
      op.release();
    }
  });
  ipcMain.handle("game:kill", () => {
    LauncherLogger.warn("Game kill request received from user.");
    GameRunner.killGame();
  });
  ipcMain.handle("game:isRunning", () => GameRunner.isGameRunning());

  if (process.argv.includes("--smoke-test")) {
    LauncherLogger.info("[Smoke Test] All handlers registered; initiating graceful shutdown");
    setTimeout(() => {
      app.quit();
    }, 200);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let isQuitting = false;
app.on("before-quit", async (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  try {
    await Promise.race([
      Promise.all([
        LauncherLogger.close(),
        logTransport ? Promise.resolve(logTransport.close()) : Promise.resolve(),
      ]),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (err: any) {
    process.stderr.write(`[Shutdown Error] ${err?.message || err}\n`);
  } finally {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }
    app.quit();
  }
});
