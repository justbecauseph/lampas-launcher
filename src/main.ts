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
import type { UserProfile } from "./types";

let mainWindow: BrowserWindow | null = null;
type LauncherOperation = "sync" | "repair" | "move" | "launch" | null;
let currentOperation: LauncherOperation = null;

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

  mainWindow.loadFile(path.join(__dirname, "../ui/index.html"));

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

  // IPC Handlers: Config
  ipcMain.handle("config:get", () => ConfigManager.get());
  ipcMain.handle("config:set", (_, newConfig) => {
    const safeConfig = { ...newConfig };
    delete safeConfig.gameDir; // Generic config updates cannot directly overwrite gameDir
    delete safeConfig.gameDirConfigured; // Generic config updates cannot manipulate directory onboarding state
    if (typeof safeConfig?.javaArgs === "string") parseJavaArgs(safeConfig.javaArgs);
    return ConfigManager.set(safeConfig);
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
  ipcMain.handle("gameDir:configure", (_, targetPath: string) =>
    GameDirectoryManager.configureInitial(targetPath));
  ipcMain.handle("gameDir:move", async (_, targetPath: string) => {
    if (GameRunner.isGameRunning()) {
      throw new Error("Cannot move installation while Minecraft is running.");
    }
    if (currentOperation !== null) {
      throw new Error(`Another operation (${currentOperation}) is currently in progress.`);
    }
    currentOperation = "move";
    try {
      LauncherLogger.info(`Moving game installation to: ${targetPath}`);
      return await GameDirectoryManager.moveInstallation(targetPath, (progress) => {
        mainWindow?.webContents.send("gameDir:moveProgress", progress);
      });
    } finally {
      currentOperation = null;
    }
  });

  // IPC Handlers: Auth
  ipcMain.handle("auth:login", (_, portalUrl) => LauncherAuth.loginWithPortal(portalUrl));
  ipcMain.handle("auth:logout", () => LauncherAuth.logout());
  ipcMain.handle("auth:verify", (_, portalUrl) => LauncherAuth.verifySession(portalUrl));
  ipcMain.handle("auth:refresh", (_, portalUrl) => LauncherAuth.refreshSession(portalUrl));

  // IPC Handlers: Server presence. Portal credentials stay in the main process.
  ipcMain.handle("server:getStatus", () => ServerStatusClient.getStatus());

  // IPC Handlers: Sync & Repair
  ipcMain.handle("sync:start", async () => {
    if (GameRunner.isGameRunning()) {
      throw new Error("Cannot synchronize while Minecraft is running.");
    }
    if (currentOperation !== null) {
      throw new Error(`Another operation (${currentOperation}) is currently in progress.`);
    }
    currentOperation = "sync";
    try {
      LauncherLogger.info("Starting modpack synchronization...");
      return await LauncherSync.syncClient((progress) => {
        if (progress.message) {
          LauncherLogger.info(`[Sync] ${progress.message}`);
        }
        mainWindow?.webContents.send("sync:progress", progress);
      });
    } finally {
      currentOperation = null;
    }
  });
  ipcMain.handle("sync:repair", async () => {
    if (GameRunner.isGameRunning()) {
      throw new Error("Cannot repair while Minecraft is running.");
    }
    if (currentOperation !== null) {
      throw new Error(`Another operation (${currentOperation}) is currently in progress.`);
    }
    currentOperation = "repair";
    try {
      LauncherLogger.info("Starting full installation repair...");
      return await LauncherSync.repairInstallation(
        (progress) => mainWindow?.webContents.send("sync:progress", progress),
        (log) => {
          LauncherLogger.log(log.level, log.message);
          mainWindow?.webContents.send("game:log", log);
        }
      );
    } finally {
      currentOperation = null;
    }
  });
  ipcMain.handle("sync:getModCatalog", () => LauncherSync.getModCatalog());

  ipcMain.handle("mods:browseAndAdd", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Add local client mods",
      filters: [{ name: "Minecraft mods", extensions: ["jar"] }],
      properties: ["openFile", "multiSelections"],
    });
    return result.canceled ? ClientModManager.list() : ClientModManager.add(result.filePaths);
  });
  ipcMain.handle("mods:addPaths", (_, paths: string[]) => ClientModManager.add(paths));
  ipcMain.handle("mods:setOfficialEnabled", (_, id: string, enabled: boolean) =>
    ClientModManager.setOfficialEnabled(id, enabled));
  ipcMain.handle("mods:setCustomEnabled", (_, filename: string, enabled: boolean) =>
    ClientModManager.setEnabled(filename, enabled));
  ipcMain.handle("mods:removeCustom", (_, filename: string) => ClientModManager.remove(filename));

  // IPC Handlers: Game
  ipcMain.handle("game:launch", async (_, user: UserProfile | null, releaseOverride?: any) => {
    if (GameRunner.isGameRunning()) {
      throw new Error("Minecraft is already running.");
    }
    if (currentOperation !== null) {
      throw new Error(`Cannot launch Minecraft while ${currentOperation} is in progress.`);
    }
    currentOperation = "launch";
    try {
      LauncherLogger.info(`Initiating game launch for player: ${user?.minecraftUsername || user?.name || "Unknown"}`);
      return await GameRunner.launchGame(
        user,
        (log) => {
          // Stream live game output to UI console only (Minecraft Log4j logs stay in logs/latest.log)
          mainWindow?.webContents.send("game:log", log);
        },
        (code) => {
          LauncherLogger.info(`Minecraft process exited with code ${code}`);
          mainWindow?.webContents.send("game:exit", code);
        },
        releaseOverride
      );
    } finally {
      currentOperation = null;
    }
  });
  ipcMain.handle("game:kill", () => {
    LauncherLogger.warn("Game kill request received from user.");
    GameRunner.killGame();
  });
  ipcMain.handle("game:isRunning", () => GameRunner.isGameRunning());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
