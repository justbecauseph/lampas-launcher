import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigManager, validateWebUrl, PortalPolicy, getUserDataDir } from "./config";
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
    width: 1180,
    height: 800,
    minWidth: 1100,
    minHeight: 600,
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hidden" : undefined,
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

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    LauncherLogger.info(`[Renderer Console] (level ${level}) ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    LauncherLogger.error(`[Renderer Crash] Render process gone: ${JSON.stringify(details)}`);
  });

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

  if (!app.isPackaged) {
    PortalPolicy.configureDevelopmentPolicy({
      allowLoopback: true,
      allowedRemoteHosts: process.env.LAMPAS_ALLOWED_PORTAL_HOSTS
        ? process.env.LAMPAS_ALLOWED_PORTAL_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
        : undefined,
    });
  }

  try {
    await GameDirectoryManager.recoverInterruptedMove();
  } catch (err: any) {
    LauncherLogger.error(`Failed to process move journal recovery: ${err.message}`);
    OperationCoordinator.blockMutations(err.message);
  }

  createWindow();

  logTransport = new BoundedLogBatchTransport(() => mainWindow);
  ipcMain.on("game:logAck", (event, data?: { batchId?: number }) => {
    const targetId = mainWindow?.webContents?.id;
    if (targetId === undefined || event.sender.id !== targetId) {
      LauncherLogger.warn(`[LogTransport] Ignored ACK from unauthorized sender ${event.sender.id} (expected ${targetId})`);
      return;
    }
    if (typeof data?.batchId !== "number") {
      LauncherLogger.warn(`[LogTransport] Ignored malformed ACK with invalid batchId: ${data?.batchId}`);
      return;
    }
    logTransport?.onRendererAck(data.batchId, event.sender.id);
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

  // Helpers: physical ancestry and path containment
  function isPathWithinOrEqual(childPath: string, parentPath: string): boolean {
    const normChild = path.normalize(path.resolve(childPath));
    const normParent = path.normalize(path.resolve(parentPath));
    const rel = path.relative(normParent, normChild);
    if (rel === "" || rel === ".") return true;
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    if (process.platform === "win32") {
      const parentLower = normParent.toLowerCase().replace(/[\\/]+$/, "");
      const childLower = normChild.toLowerCase();
      return childLower === parentLower || childLower.startsWith(parentLower + path.sep);
    }
    return true;
  }

  function findExistingAncestor(p: string): string {
    let current = path.resolve(p);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return current;
  }

  // Helper: validate known location identifiers, expected types, physical ancestry, and canonical roots
  type KnownLocationId = "gameDir" | "modsDir" | "logsDir" | "launcherLog" | "minecraftLog";
  const knownLocationIds: KnownLocationId[] = ["gameDir", "modsDir", "logsDir", "launcherLog", "minecraftLog"];

  function resolveAndValidateKnownLocation(locationId: string): string {
    if (typeof locationId !== "string" || !locationId.trim()) {
      throw new Error("Location identifier must be a non-empty string.");
    }
    const id = locationId.trim() as KnownLocationId;
    const config = ConfigManager.get();

    let targetPath: string;
    let expectedType: "dir" | "file";
    let createIfMissing = false;
    let missingErrorMessage: string | undefined;
    let canonicalAuthorizedRoot: string;

    switch (id) {
      case "gameDir": {
        targetPath = path.resolve(config.gameDir);
        expectedType = "dir";
        createIfMissing = true;
        const nearestAncestor = findExistingAncestor(targetPath);
        if (!fs.existsSync(nearestAncestor)) {
          throw new Error(`Game directory ancestor does not exist: ${targetPath}`);
        }
        canonicalAuthorizedRoot = fs.realpathSync(nearestAncestor);
        break;
      }
      case "modsDir": {
        const rawGameDir = path.resolve(config.gameDir);
        if (!fs.existsSync(rawGameDir)) {
          fs.mkdirSync(rawGameDir, { recursive: true });
        }
        canonicalAuthorizedRoot = fs.realpathSync(rawGameDir);
        targetPath = path.resolve(canonicalAuthorizedRoot, "mods");
        expectedType = "dir";
        createIfMissing = true;
        break;
      }
      case "logsDir": {
        const rawUserData = path.resolve(getUserDataDir());
        if (!fs.existsSync(rawUserData)) {
          fs.mkdirSync(rawUserData, { recursive: true });
        }
        canonicalAuthorizedRoot = fs.realpathSync(rawUserData);
        targetPath = path.resolve(LauncherLogger.getLogsDir());
        expectedType = "dir";
        createIfMissing = true;
        break;
      }
      case "launcherLog": {
        const rawLogsDir = path.resolve(LauncherLogger.getLogsDir());
        if (!fs.existsSync(rawLogsDir)) {
          throw new Error("Launcher log file does not exist yet.");
        }
        canonicalAuthorizedRoot = fs.realpathSync(rawLogsDir);
        targetPath = path.resolve(LauncherLogger.getLogPath());
        expectedType = "file";
        missingErrorMessage = "Launcher log file does not exist yet.";
        break;
      }
      case "minecraftLog": {
        const rawGameDir = path.resolve(config.gameDir);
        if (!fs.existsSync(rawGameDir)) {
          throw new Error("Minecraft log (latest.log) not found. Launch Minecraft first to create it.");
        }
        canonicalAuthorizedRoot = fs.realpathSync(rawGameDir);
        targetPath = path.resolve(canonicalAuthorizedRoot, "logs", "latest.log");
        expectedType = "file";
        missingErrorMessage = "Minecraft log (latest.log) not found. Launch Minecraft first to create it.";
        break;
      }
      default:
        throw new Error(`Unknown location '${locationId}'. Permitted locations: gameDir, modsDir, logsDir, launcherLog, minecraftLog`);
    }

    // Pre-creation: validate physical ancestry against authorized canonical root
    const existingAncestor = findExistingAncestor(targetPath);
    if (!fs.existsSync(existingAncestor)) {
      throw new Error(`No existing ancestor for path: ${targetPath}`);
    }
    const canonicalAncestor = fs.realpathSync(existingAncestor);
    if (id !== "gameDir" && !isPathWithinOrEqual(canonicalAncestor, canonicalAuthorizedRoot)) {
      throw new Error(`Refusing to create or open path with escaping ancestor: '${canonicalAncestor}' is outside root '${canonicalAuthorizedRoot}'`);
    }

    if (createIfMissing && !fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    if (!fs.existsSync(targetPath)) {
      throw new Error(missingErrorMessage || `Target location does not exist: ${targetPath}`);
    }

    // Post-creation: canonicalize target path and reject escaping symlinks/junctions
    const canonicalTarget = fs.realpathSync(targetPath);
    if (id !== "gameDir" && !isPathWithinOrEqual(canonicalTarget, canonicalAuthorizedRoot)) {
      throw new Error(`Refusing to open path escaping authorized root: '${canonicalTarget}' is outside root '${canonicalAuthorizedRoot}'`);
    }

    const stat = fs.statSync(canonicalTarget);
    if (expectedType === "dir" && !stat.isDirectory()) {
      throw new Error(`Expected directory at '${canonicalTarget}', but found non-directory.`);
    }
    if (expectedType === "file" && !stat.isFile()) {
      throw new Error(`Expected file at '${canonicalTarget}', but found non-file.`);
    }

    return canonicalTarget;
  }

  // IPC Handlers: Utils
  ipcMain.handle("utils:getAppVersion", () => app.getVersion());
  ipcMain.handle("utils:openPath", async (_, targetPath: string) => {
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      throw new Error("Target path must be a non-empty string.");
    }
    const trimmed = targetPath.trim();

    // 1. If web URL (http/https), validate and open externally. Never fall back to local opening.
    const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(trimmed);
    const hasUriScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
    if (hasUriScheme && !isWindowsDrive) {
      const validUrl = validateWebUrl(trimmed);
      await shell.openExternal(validUrl);
      return validUrl;
    }

    // 2. Local path handling: strictly constrain to approved known launcher locations with type validation
    if (knownLocationIds.includes(trimmed as KnownLocationId)) {
      const resolved = resolveAndValidateKnownLocation(trimmed);
      await shell.openPath(resolved);
      return resolved;
    }

    // Check if path resolves identically to one of the authorized known locations
    for (const id of knownLocationIds) {
      try {
        const resolved = resolveAndValidateKnownLocation(id);
        const resolvedTrimmed = fs.existsSync(trimmed) ? fs.realpathSync(trimmed) : path.resolve(trimmed);
        if (resolvedTrimmed === resolved) {
          await shell.openPath(resolved);
          return resolved;
        }
      } catch {}
    }

    throw new Error(`Refusing to open unapproved path '${targetPath}'. Only validated web URLs and known launcher locations may be opened.`);
  });
  ipcMain.handle("utils:openSourcePage", async (_, url: string) => {
    const validatedUrl = validateWebUrl(url);
    await shell.openExternal(validatedUrl);
    return validatedUrl;
  });
  ipcMain.handle("utils:openKnownLocation", async (_, location: string) => {
    const targetPath = resolveAndValidateKnownLocation(location);
    await shell.openPath(targetPath);
    return targetPath;
  });
  ipcMain.handle("utils:getLogPath", () => LauncherLogger.getLogPath());
  ipcMain.handle("utils:openLogsDir", async () => {
    const logsDir = resolveAndValidateKnownLocation("logsDir");
    await shell.openPath(logsDir);
    return logsDir;
  });
  ipcMain.handle("utils:openLogFile", async () => {
    const logPath = resolveAndValidateKnownLocation("launcherLog");
    await shell.openPath(logPath);
    return logPath;
  });
  ipcMain.handle("utils:getMinecraftLogPath", () => {
    const config = ConfigManager.get();
    return path.join(config.gameDir, "logs", "latest.log");
  });
  ipcMain.handle("utils:openMinecraftLog", async () => {
    const latestLog = resolveAndValidateKnownLocation("minecraftLog");
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
    delete (safeConfig as any).sessionPortalUrl; // Renderer cannot forge session-binding ownership
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
  ipcMain.handle("auth:login", async () => {
    const res = await LauncherAuth.loginWithPortal();
    return { user: toRendererUserProfile(res.user)! };
  });
  ipcMain.handle("auth:logout", () => LauncherAuth.logout());
  ipcMain.handle("auth:verify", async () => {
    const res = await LauncherAuth.verifySession();
    return { valid: res.valid, user: toRendererUserProfile(res.user) };
  });
  ipcMain.handle("auth:refresh", async () => {
    const res = await LauncherAuth.refreshSession();
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
  ipcMain.handle("game:kill", async () => {
    LauncherLogger.warn("Game kill request received from user.");
    await GameRunner.killGame();
  });
  ipcMain.handle("game:isRunning", () => GameRunner.isGameRunning());

  if (process.argv.includes("--smoke-test")) {
    const runSmokeCheck = async () => {
      try {
        if (!mainWindow) throw new Error("Main window was not created");
        if (mainWindow.webContents.isLoading()) {
          await new Promise<void>((resolve) => {
            mainWindow?.webContents.once("did-finish-load", () => resolve());
          });
        }
        const hasBridge = await mainWindow.webContents.executeJavaScript(
          "Boolean(window.lampas && window.lampas.utils && typeof window.lampas.utils.getAppVersion === 'function')"
        );
        if (!hasBridge) {
          throw new Error("window.lampas or window.lampas.utils.getAppVersion is undefined in renderer context");
        }
        LauncherLogger.info("[Smoke Test] Renderer & preload verification round-trip passed");
      } catch (smokeErr: any) {
        LauncherLogger.error(`[Smoke Test] Verification failed: ${smokeErr?.message || smokeErr}`);
        process.exitCode = 1;
      } finally {
        LauncherLogger.info("[Smoke Test] All handlers registered; initiating graceful shutdown");
        setTimeout(() => {
          app.quit();
        }, 100);
      }
    };
    setTimeout(runSmokeCheck, 400);
  }

  app.on("child-process-gone", (_event, details) => {
    LauncherLogger.error(`[Process Crash] ${details.type} process gone (${details.reason}, exitCode: ${details.exitCode})`);
    if (details.type === "GPU" && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.invalidate();
    }
  });
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
