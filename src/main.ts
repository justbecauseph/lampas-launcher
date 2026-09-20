import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ConfigManager,
  validateWebUrl,
  PortalPolicy,
  getUserDataDir,
} from "./config";
import { SessionManager } from "./session-manager";
import { LauncherAuth } from "./auth";
import { LauncherSync } from "./sync";
import { GameRunner, parseJavaArgs } from "./game-runner";
import { ClientModManager } from "./client-mods";
import { LauncherLogger } from "./logger";
import { GameDirectoryManager } from "./game-directory";
import { ServerStatusClient } from "./server-status";
import {
  OperationCoordinator,
  safeSend as safeSendToWindow,
} from "./operations";
import { BoundedLogBatchTransport } from "./game-log-stream";
import { CosmeticImageBroker, createModIconResolver } from "./cosmetic-images";
import {
  classifyJavaArgs,
  IpcBoundary,
  IpcSchemas,
  IpcSecurityError,
  IpcValidationError,
  UserCancelledError,
  ModPolicyError,
  registerSecureHandler,
  registerSecureListener,
  validateModPaths,
} from "./ipc-boundary";
import type {
  DirectoryMoveProgress,
  SyncProgress,
  UserProfile,
  LauncherConfig,
  RendererUserProfile,
  RendererSettingsDto,
  KnownLocationId,
  UpdateSettingsDto,
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
    externalImages: Boolean(config.externalImages),
  };
}

const cosmeticImageBroker = new CosmeticImageBroker({
  isEnabled: () => Boolean(ConfigManager.get().externalImages),
  getUser: () => SessionManager.getCurrentUser(),
  resolveModIcon: createModIconResolver(() => LauncherSync.getModCatalog()),
});
SessionManager.addSessionListener((credentials) => {
  if (!credentials) cosmeticImageBroker.clear();
});

function toRendererUserProfile(
  user?: UserProfile,
): RendererUserProfile | undefined {
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
  const iconPath = path.join(__dirname, "../assets/lampas.png");
  const appIcon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : undefined;

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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  IpcBoundary.setMainWindow(mainWindow);

  // Navigation, redirect, window open, webview, and permission lockdown
  mainWindow.webContents.setWindowOpenHandler?.(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      try {
        const validUrl = validateWebUrl(url);
        shell.openExternal(validUrl);
      } catch (err: any) {
        LauncherLogger.warn(
          `[Window Open] Rejected URL: ${err?.message || err}`,
        );
      }
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    LauncherLogger.warn(
      `[Navigation] Blocked attempt to navigate window to: ${url}`,
    );
  });

  mainWindow.webContents.on("will-redirect", (event, url) => {
    event.preventDefault();
    LauncherLogger.warn(
      `[Redirect] Blocked attempt to redirect window to: ${url}`,
    );
  });

  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    LauncherLogger.warn("[Security] Denied attempt to attach webview");
  });

  mainWindow.webContents.session?.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      LauncherLogger.warn(
        `[Permissions] Denied permission request: ${permission}`,
      );
      callback(false);
    },
  );

  mainWindow.webContents.session?.setPermissionCheckHandler?.(
    (_webContents, permission, requestingOrigin) => {
      LauncherLogger.warn(
        `[Permissions] Denied permission check: ${permission} from ${requestingOrigin}`,
      );
      return false;
    },
  );

  mainWindow.webContents.session?.webRequest?.onHeadersReceived?.(
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      const csp =
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none';";
      responseHeaders["Content-Security-Policy"] = [csp];
      responseHeaders["X-Content-Type-Options"] = ["nosniff"];
      responseHeaders["X-Frame-Options"] = ["DENY"];
      callback({ responseHeaders });
    },
  );

  mainWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      LauncherLogger.info(
        `[Renderer Console] (level ${level}) ${message} (${sourceId}:${line})`,
      );
    },
  );

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    LauncherLogger.error(
      `[Renderer Crash] Render process gone: ${JSON.stringify(details)}`,
    );
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    IpcBoundary.setMainWindow(null);
  });

  // Packaged vs development renderer loading (installed AFTER all security protections)
  const isPackaged = IpcBoundary.isPackagedProduction();
  const prodPath = path.join(__dirname, "renderer/index.html");

  if (isPackaged) {
    if (!fs.existsSync(prodPath)) {
      LauncherLogger.error(
        `[Fatal Startup] Packaged renderer not found at: ${prodPath}`,
      );
      throw new Error(`Packaged renderer not found at: ${prodPath}`);
    }
    mainWindow.loadFile(prodPath);
  } else {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      try {
        const parsed = new URL(devServerUrl);
        if (
          (parsed.hostname === "localhost" ||
            parsed.hostname === "127.0.0.1") &&
          (parsed.protocol === "http:" || parsed.protocol === "https:")
        ) {
          mainWindow.loadURL(devServerUrl);
        } else {
          throw new Error(
            `Refusing to load untrusted VITE_DEV_SERVER_URL: ${devServerUrl}`,
          );
        }
      } catch (err: any) {
        LauncherLogger.error(`[Startup Error] ${err.message}`);
        throw err;
      }
    } else if (fs.existsSync(prodPath)) {
      mainWindow.loadFile(prodPath);
    } else {
      const devFallback = path.join(__dirname, "../ui/index.html");
      if (!fs.existsSync(devFallback)) {
        throw new Error(`Renderer index.html not found at: ${devFallback}`);
      }
      mainWindow.loadFile(devFallback);
    }
  }
}

app.whenReady().then(async () => {
  LauncherLogger.init();
  LauncherLogger.info(
    `Lampas Launcher initialized (App: ${app.getName()} ${app.getVersion()})`,
  );

  // Establish main-owned startup policy for document trust
  IpcBoundary.initializeStartupPolicy({
    isPackaged: Boolean(app.isPackaged),
    appPath:
      typeof app.getAppPath === "function"
        ? app.getAppPath()
        : path.resolve(__dirname, ".."),
    devEndpoint: !app.isPackaged
      ? process.env.VITE_DEV_SERVER_URL || "http://localhost:5173"
      : null,
  });

  if (!app.isPackaged) {
    PortalPolicy.configureDevelopmentPolicy({
      allowLoopback: true,
      allowedRemoteHosts: process.env.LAMPAS_ALLOWED_PORTAL_HOSTS
        ? process.env.LAMPAS_ALLOWED_PORTAL_HOSTS.split(",")
            .map((h) => h.trim())
            .filter(Boolean)
        : undefined,
    });
  }

  try {
    await GameDirectoryManager.recoverInterruptedMove();
  } catch (err: any) {
    LauncherLogger.error(
      `Failed to process move journal recovery: ${err.message}`,
    );
    OperationCoordinator.blockMutations(err.message);
  }

  createWindow();

  logTransport = new BoundedLogBatchTransport(() => mainWindow);
  registerSecureListener("game:logAck", IpcSchemas.logAck, (event, data) => {
    const targetId = mainWindow?.webContents?.id;
    if (targetId === undefined || event.sender.id !== targetId) {
      LauncherLogger.warn(
        `[LogTransport] Ignored ACK from unauthorized sender ${event.sender.id} (expected ${targetId})`,
      );
      return;
    }
    logTransport?.onRendererAck(data.batchId, event.sender.id);
  });

  // IPC Handlers: Window Controls
  registerSecureHandler("window:minimize", IpcSchemas.noArgs, () =>
    mainWindow?.minimize(),
  );
  registerSecureHandler("window:maximize", IpcSchemas.noArgs, () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  registerSecureHandler(
    "window:isMaximized",
    IpcSchemas.noArgs,
    () => mainWindow?.isMaximized() ?? false,
  );
  registerSecureHandler("window:close", IpcSchemas.noArgs, () =>
    mainWindow?.close(),
  );

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
      return (
        childLower === parentLower ||
        childLower.startsWith(parentLower + path.sep)
      );
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
  type KnownLocationId =
    "gameDir" | "modsDir" | "logsDir" | "launcherLog" | "minecraftLog";
  const knownLocationIds: KnownLocationId[] = [
    "gameDir",
    "modsDir",
    "logsDir",
    "launcherLog",
    "minecraftLog",
  ];

  function resolveAndValidateKnownLocation(locationId: string): string {
    if (typeof locationId !== "string" || !locationId.trim()) {
      throw new IpcValidationError(
        "Location identifier must be a non-empty string.",
      );
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
          throw new IpcValidationError(
            `Game directory ancestor does not exist: ${targetPath}`,
          );
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
        const rawUserData = path.resolve(getUserDataDir());
        if (!fs.existsSync(rawUserData)) {
          fs.mkdirSync(rawUserData, { recursive: true });
        }
        canonicalAuthorizedRoot = fs.realpathSync(rawUserData);

        const rawLogsDir = path.resolve(LauncherLogger.getLogsDir());
        if (!fs.existsSync(rawLogsDir)) {
          throw new IpcValidationError("Launcher log file does not exist yet.");
        }
        const canonicalLogsDir = fs.realpathSync(rawLogsDir);
        if (!isPathWithinOrEqual(canonicalLogsDir, canonicalAuthorizedRoot)) {
          throw new IpcValidationError(
            `Refusing to authorize logs directory escaping userData: '${canonicalLogsDir}' is outside root '${canonicalAuthorizedRoot}'`,
          );
        }

        targetPath = path.resolve(LauncherLogger.getLogPath());
        expectedType = "file";
        missingErrorMessage = "Launcher log file does not exist yet.";
        break;
      }
      case "minecraftLog": {
        const rawGameDir = path.resolve(config.gameDir);
        if (!fs.existsSync(rawGameDir)) {
          throw new IpcValidationError(
            "Minecraft log (latest.log) not found. Launch Minecraft first to create it.",
          );
        }
        canonicalAuthorizedRoot = fs.realpathSync(rawGameDir);
        targetPath = path.resolve(
          canonicalAuthorizedRoot,
          "logs",
          "latest.log",
        );
        expectedType = "file";
        missingErrorMessage =
          "Minecraft log (latest.log) not found. Launch Minecraft first to create it.";
        break;
      }
      default:
        throw new IpcValidationError(
          `Unknown location '${locationId}'. Permitted locations: gameDir, modsDir, logsDir, launcherLog, minecraftLog`,
        );
    }

    // Pre-creation: validate physical ancestry against authorized canonical root
    const existingAncestor = findExistingAncestor(targetPath);
    if (!fs.existsSync(existingAncestor)) {
      throw new IpcValidationError(
        `No existing ancestor for path: ${targetPath}`,
      );
    }
    const canonicalAncestor = fs.realpathSync(existingAncestor);
    if (
      id !== "gameDir" &&
      !isPathWithinOrEqual(canonicalAncestor, canonicalAuthorizedRoot)
    ) {
      throw new IpcValidationError(
        `Refusing to create or open path with escaping ancestor: '${canonicalAncestor}' is outside root '${canonicalAuthorizedRoot}'`,
      );
    }

    if (createIfMissing && !fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    if (!fs.existsSync(targetPath)) {
      throw new IpcValidationError(
        missingErrorMessage || `Target location does not exist: ${targetPath}`,
      );
    }

    // Post-creation: canonicalize target path and reject escaping symlinks/junctions
    const canonicalTarget = fs.realpathSync(targetPath);
    if (
      id !== "gameDir" &&
      !isPathWithinOrEqual(canonicalTarget, canonicalAuthorizedRoot)
    ) {
      throw new IpcValidationError(
        `Refusing to open path escaping authorized root: '${canonicalTarget}' is outside root '${canonicalAuthorizedRoot}'`,
      );
    }

    const stat = fs.statSync(canonicalTarget);
    if (expectedType === "dir" && !stat.isDirectory()) {
      throw new IpcValidationError(
        `Expected directory at '${canonicalTarget}', but found non-directory.`,
      );
    }
    if (expectedType === "file" && !stat.isFile()) {
      throw new IpcValidationError(
        `Expected file at '${canonicalTarget}', but found non-file.`,
      );
    }

    return canonicalTarget;
  }

  // IPC Handlers: Utils
  registerSecureHandler("utils:getAppVersion", IpcSchemas.noArgs, () =>
    app.getVersion(),
  );
  registerSecureHandler(
    "utils:openPath",
    IpcSchemas.openPath,
    async (_, targetPath) => {
      // 1. If web URL (http/https), validate and open externally. Never fall back to local opening.
      const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(targetPath);
      const hasUriScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(targetPath);
      if (hasUriScheme && !isWindowsDrive) {
        const validUrl = validateWebUrl(targetPath);
        await shell.openExternal(validUrl);
        return validUrl;
      }

      // 2. Local path handling: strictly constrain to approved known launcher locations with type validation
      if (knownLocationIds.includes(targetPath as KnownLocationId)) {
        const resolved = resolveAndValidateKnownLocation(targetPath);
        await shell.openPath(resolved);
        return resolved;
      }

      // Check if path resolves identically to one of the authorized known locations
      for (const id of knownLocationIds) {
        try {
          const resolved = resolveAndValidateKnownLocation(id);
          const resolvedTrimmed = fs.existsSync(targetPath)
            ? fs.realpathSync(targetPath)
            : path.resolve(targetPath);
          if (resolvedTrimmed === resolved) {
            await shell.openPath(resolved);
            return resolved;
          }
        } catch {}
      }

      throw new IpcValidationError(
        `Refusing to open unapproved path '${targetPath}'. Only validated web URLs and known launcher locations may be opened.`,
      );
    },
  );
  registerSecureHandler(
    "utils:openSourcePage",
    IpcSchemas.openSourcePage,
    async (_, url) => {
      await shell.openExternal(url);
      return url;
    },
  );
  registerSecureHandler(
    "utils:openKnownLocation",
    IpcSchemas.openKnownLocation,
    async (_, location) => {
      const targetPath = resolveAndValidateKnownLocation(location);
      await shell.openPath(targetPath);
      return targetPath;
    },
  );
  registerSecureHandler("utils:getLogPath", IpcSchemas.noArgs, () =>
    LauncherLogger.getLogPath(),
  );
  registerSecureHandler("utils:openLogsDir", IpcSchemas.noArgs, async () => {
    const logsDir = resolveAndValidateKnownLocation("logsDir");
    await shell.openPath(logsDir);
    return logsDir;
  });
  registerSecureHandler("utils:openLogFile", IpcSchemas.noArgs, async () => {
    const logPath = resolveAndValidateKnownLocation("launcherLog");
    await shell.openPath(logPath);
    return logPath;
  });
  registerSecureHandler("utils:getMinecraftLogPath", IpcSchemas.noArgs, () => {
    const config = ConfigManager.get();
    return path.join(config.gameDir, "logs", "latest.log");
  });
  registerSecureHandler(
    "utils:openMinecraftLog",
    IpcSchemas.noArgs,
    async () => {
      const latestLog = resolveAndValidateKnownLocation("minecraftLog");
      await shell.openPath(latestLog);
      return latestLog;
    },
  );

  // IPC Handlers: Config
  registerSecureHandler("config:get", IpcSchemas.noArgs, () =>
    toRendererSettingsDto(ConfigManager.get()),
  );
  registerSecureHandler(
    "config:set",
    IpcSchemas.configSet,
    async (event, newConfig) => {
      OperationCoordinator.assertCanMutate("update configuration");

      // Privileged setting: javaPath
      if (
        newConfig.javaPath !== undefined &&
        newConfig.javaPath !== ConfigManager.get().javaPath &&
        newConfig.javaPath.trim() !== ""
      ) {
        const hasApproval = IpcBoundary.consumeApproval(
          "config:javaPath",
          newConfig.javaPath,
        );
        if (!hasApproval) {
          const confirmed = await IpcBoundary.confirmPrivilegedOperation(
            event,
            {
              title: "Confirm Custom Java Executable",
              message: "Set custom Java executable?",
              detail: `Custom Java binary path:\n${newConfig.javaPath}`,
              confirmButtonText: "Confirm",
            },
          );
          if (!confirmed) {
            throw new UserCancelledError(
              "Custom Java executable update cancelled by user.",
            );
          }
        }
      }

      // Privileged setting: privileged javaArgs
      if (
        newConfig.javaArgs !== undefined &&
        newConfig.javaArgs.trim() !== ""
      ) {
        const parsedArgs = parseJavaArgs(newConfig.javaArgs);
        const classification = classifyJavaArgs(parsedArgs);
        if (classification.hasLaunchTargetOverride) {
          throw new IpcValidationError(
            "Custom Java arguments cannot override launch target or main class.",
          );
        }
        if (classification.isPrivileged) {
          const hasApproval = IpcBoundary.consumeApproval(
            "config:privilegedJavaArgs",
            newConfig.javaArgs,
          );
          if (!hasApproval) {
            const confirmed = await IpcBoundary.confirmPrivilegedOperation(
              event,
              {
                title: "Security Warning: Privileged Java Arguments",
                message:
                  "The specified Java arguments contain privileged or sensitive flags that can execute arbitrary code.",
                detail: `Detected flags:\n${classification.privilegedReasons.join("\n")}\n\nFull arguments:\n${newConfig.javaArgs}\n\nDo you want to allow these arguments?`,
                confirmButtonText: "Allow",
              },
            );
            if (!confirmed) {
              throw new UserCancelledError(
                "Privileged Java arguments rejected by user.",
              );
            }
          }
        }
      }

      // Recheck operation coordination after asynchronous approval
      OperationCoordinator.assertCanMutate("update configuration");
      const updatedConfig = ConfigManager.set(newConfig);
      if (!updatedConfig.externalImages) cosmeticImageBroker.clear();
      return toRendererSettingsDto(updatedConfig);
    },
  );

  // Cosmetic images are brokered through main. The renderer never supplies a
  // user identity or remote URL, and disabled external images return before
  // any network request.
  registerSecureHandler("cosmetics:getAvatar", IpcSchemas.noArgs, () =>
    cosmeticImageBroker.getAvatar(),
  );
  registerSecureHandler(
    "cosmetics:getModIcon",
    IpcSchemas.cosmeticModId,
    (_event, id) => cosmeticImageBroker.getModIcon(id),
  );

  // IPC Handlers: Game Directory
  registerSecureHandler("gameDir:getStatus", IpcSchemas.noArgs, () =>
    GameDirectoryManager.getStatus(),
  );
  registerSecureHandler(
    "gameDir:browse",
    IpcSchemas.gameDirBrowse,
    async (event, defaultPath) => {
      if (!dialog?.showOpenDialog) {
        throw new IpcSecurityError(
          "Native dialog service unavailable; browse action denied fail-closed.",
        );
      }
      const snapshot = IpcBoundary.createApprovalSnapshot(event);
      const result = await dialog.showOpenDialog(snapshot.window, {
        title: "Select Minecraft Installation Directory",
        defaultPath: defaultPath || ConfigManager.get().gameDir,
        properties: ["openDirectory", "createDirectory"],
      });
      IpcBoundary.validateApprovalSnapshot(snapshot);
      if (!result.canceled && result.filePaths.length > 0) {
        for (const p of result.filePaths) {
          IpcBoundary.grantApproval("gameDir:target", p, {
            generation: snapshot.generation,
          });
        }
      }
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
  );
  registerSecureHandler(
    "gameDir:validate",
    IpcSchemas.gameDirValidate,
    (_, targetPath, currentPath) =>
      GameDirectoryManager.validateTarget(targetPath, currentPath),
  );
  registerSecureHandler(
    "gameDir:configure",
    IpcSchemas.gameDirTarget,
    async (event, targetPath) => {
      OperationCoordinator.assertCanMutate("configure game directory");
      const hasApproval = IpcBoundary.consumeApproval(
        "gameDir:target",
        targetPath,
      );
      if (!hasApproval) {
        const confirmed = await IpcBoundary.confirmPrivilegedOperation(event, {
          title: "Confirm Minecraft Installation Directory",
          message: "Configure Minecraft installation directory?",
          detail: `The application will configure its installation at:\n${targetPath}`,
          confirmButtonText: "Configure",
        });
        if (!confirmed) {
          throw new UserCancelledError("Configuration cancelled by user.");
        }
      }
      OperationCoordinator.assertCanMutate("configure game directory");
      const updated = await GameDirectoryManager.configureInitial(targetPath);
      return toRendererSettingsDto(updated);
    },
  );
  registerSecureHandler(
    "gameDir:move",
    IpcSchemas.gameDirTarget,
    async (event, targetPath) => {
      OperationCoordinator.assertCanMutate("move game directory");
      const hasApproval = IpcBoundary.consumeApproval(
        "gameDir:target",
        targetPath,
      );
      if (!hasApproval) {
        const confirmed = await IpcBoundary.confirmPrivilegedOperation(event, {
          title: "Confirm Installation Move",
          message: "Move Minecraft installation directory?",
          detail: `The existing installation and data will be moved to:\n${targetPath}`,
          confirmButtonText: "Move",
        });
        if (!confirmed) {
          throw new UserCancelledError("Move cancelled by user.");
        }
      }
      OperationCoordinator.assertCanMutate("move game directory");
      const op = OperationCoordinator.acquire(
        "move",
        `Move installation to ${targetPath}`,
      );
      const throttledProgress =
        op.createThrottledProgress<DirectoryMoveProgress>(
          (progress) => safeSend("gameDir:moveProgress", progress),
          100,
          (p) => p.phase === "complete",
        );
      try {
        LauncherLogger.info(`Moving game installation to: ${targetPath}`);
        return await GameDirectoryManager.moveInstallation(
          targetPath,
          (progress) => {
            throttledProgress(progress);
          },
        );
      } finally {
        op.release();
      }
    },
  );

  // IPC Handlers: Auth
  registerSecureHandler("auth:login", IpcSchemas.noArgs, async () => {
    const res = await LauncherAuth.loginWithPortal();
    return { user: toRendererUserProfile(res.user)! };
  });
  registerSecureHandler("auth:logout", IpcSchemas.noArgs, () => {
    const result = LauncherAuth.logout();
    cosmeticImageBroker.clear();
    return result;
  });
  registerSecureHandler("auth:verify", IpcSchemas.noArgs, async () => {
    const res = await LauncherAuth.verifySession();
    return { valid: res.valid, user: toRendererUserProfile(res.user) };
  });
  registerSecureHandler("auth:refresh", IpcSchemas.noArgs, async () => {
    const res = await LauncherAuth.refreshSession();
    return { valid: res.valid, user: toRendererUserProfile(res.user) };
  });
  registerSecureHandler("auth:getStorageStatus", IpcSchemas.noArgs, () =>
    SessionManager.getStorageStatus(),
  );

  // IPC Handlers: Server presence. Portal credentials stay in the main process.
  registerSecureHandler("server:getStatus", IpcSchemas.noArgs, () =>
    ServerStatusClient.getStatus(),
  );

  // IPC Handlers: Sync & Repair
  registerSecureHandler("sync:start", IpcSchemas.noArgs, async () => {
    const op = OperationCoordinator.acquire("sync", "Modpack synchronization");
    const log = (level: "INFO" | "ERROR", message: string) => {
      const sanitized = LauncherLogger.sanitize(message);
      LauncherLogger.log(level, sanitized);
      logTransport?.push({
        timestamp: new Date().toLocaleTimeString(),
        level,
        message: sanitized,
      });
    };
    const throttledProgress = op.createThrottledProgress<SyncProgress>(
      (progress) => safeSend("sync:progress", progress),
      100,
      (p) =>
        p.status === "complete" || p.status === "error" || p.percent === 100,
    );
    try {
      log(
        "INFO",
        "[Sync] Starting modpack integrity verification and synchronization...",
      );
      return await LauncherSync.syncClient((progress) => {
        if (progress.message) {
          log(
            progress.status === "error" ? "ERROR" : "INFO",
            `[Sync] ${progress.message}`,
          );
        }
        throttledProgress(progress);
      });
    } catch (error) {
      log(
        "ERROR",
        `[Sync] Verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      logTransport?.flushSession();
      op.release();
    }
  });
  registerSecureHandler("sync:repair", IpcSchemas.noArgs, async () => {
    const op = OperationCoordinator.acquire(
      "repair",
      "Full installation repair",
    );
    const throttledProgress = op.createThrottledProgress<SyncProgress>(
      (progress) => safeSend("sync:progress", progress),
      100,
      (p) =>
        p.status === "complete" || p.status === "error" || p.percent === 100,
    );
    try {
      LauncherLogger.info("Starting full installation repair...");
      return await LauncherSync.repairInstallation(
        (progress) => throttledProgress(progress),
        (log) => {
          LauncherLogger.log(log.level, log.message);
          logTransport?.push(log);
        },
      );
    } finally {
      op.release();
    }
  });
  registerSecureHandler("sync:getModCatalog", IpcSchemas.noArgs, () =>
    LauncherSync.getModCatalog(),
  );
  registerSecureHandler("sync:getInstalledRuntime", IpcSchemas.noArgs, () => {
    const config = ConfigManager.get();
    const releasePath = path.join(config.gameDir, ".lampas", "release.json");
    const statePath = path.join(config.gameDir, ".lampas", "installation.json");
    if (fs.existsSync(releasePath) && fs.existsSync(statePath)) {
      try {
        const release = JSON.parse(fs.readFileSync(releasePath, "utf-8"));
        const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        if (
          !state ||
          typeof state !== "object" ||
          !state.version ||
          typeof state.version !== "string"
        ) {
          return null;
        }
        if (
          !release ||
          typeof release !== "object" ||
          !release.version ||
          typeof release.version !== "string"
        ) {
          return null;
        }
        if (state.version !== release.version) {
          return null;
        }
        if (
          state.syncGeneration &&
          release.syncGeneration &&
          state.syncGeneration !== release.syncGeneration
        ) {
          return null;
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

  // IPC Handlers: Mods
  registerSecureHandler(
    "mods:browseAndAdd",
    IpcSchemas.noArgs,
    async (event) => {
      OperationCoordinator.assertCanMutate("add client mods");
      if (!dialog?.showOpenDialog) {
        throw new IpcSecurityError(
          "Native dialog service unavailable; file selection denied fail-closed.",
        );
      }
      const snapshot = IpcBoundary.createApprovalSnapshot(event);
      const result = await dialog.showOpenDialog(snapshot.window, {
        title: "Add local client mods",
        filters: [{ name: "Minecraft mods", extensions: ["jar"] }],
        properties: ["openFile", "multiSelections"],
      });
      IpcBoundary.validateApprovalSnapshot(snapshot);
      OperationCoordinator.assertCanMutate("add client mods");
      if (
        result.canceled ||
        !result.filePaths ||
        result.filePaths.length === 0
      ) {
        return ClientModManager.list();
      }
      validateModPaths(result.filePaths);
      for (const p of result.filePaths) {
        IpcBoundary.grantApproval("mod:import", p, {
          generation: snapshot.generation,
        });
      }
      for (const p of result.filePaths) {
        if (!IpcBoundary.consumeApproval("mod:import", p)) {
          throw new IpcSecurityError(
            "Mod import approval was invalidated or expired.",
          );
        }
      }
      return ClientModManager.add(result.filePaths);
    },
  );
  registerSecureHandler(
    "mods:addPaths",
    IpcSchemas.modPaths,
    async (event, paths) => {
      OperationCoordinator.assertCanMutate("add client mods");
      validateModPaths(paths);
      const unapproved: string[] = [];
      for (const p of paths) {
        if (!IpcBoundary.consumeApproval("mod:import", p)) {
          unapproved.push(p);
        }
      }
      if (unapproved.length > 0) {
        const confirmed = await IpcBoundary.confirmPrivilegedOperation(event, {
          title: "Confirm Mod Import",
          message: "Import local client mod(s)?",
          detail: `Are you sure you want to import the following mod file(s)?\n${unapproved.join("\n")}`,
          confirmButtonText: "Import",
        });
        if (!confirmed) {
          throw new UserCancelledError("Mod import cancelled by user.");
        }
        OperationCoordinator.assertCanMutate("add client mods");
      }
      return ClientModManager.add(paths);
    },
  );
  registerSecureHandler(
    "mods:setOfficialEnabled",
    IpcSchemas.officialModToggle,
    async (_, id, enabled) => {
      OperationCoordinator.assertCanMutate("toggle official mod");
      if (!enabled) {
        const catalog = await LauncherSync.getModCatalog();
        const mod = catalog.find((m) => m.id === id && m.source === "official");
        if (!mod) {
          throw new ModPolicyError(
            `Cannot disable unknown official mod: '${id}'`,
          );
        }
        if (mod.canDisable !== true) {
          throw new ModPolicyError(
            `Official mod '${id}' is required and cannot be disabled.`,
          );
        }
      }
      return ClientModManager.setOfficialEnabled(id, enabled);
    },
  );
  registerSecureHandler(
    "mods:setCustomEnabled",
    IpcSchemas.customModToggle,
    (_, filename, enabled) => {
      OperationCoordinator.assertCanMutate("toggle custom mod");
      return ClientModManager.setEnabled(filename, enabled);
    },
  );
  registerSecureHandler(
    "mods:removeCustom",
    IpcSchemas.customModFilename,
    (_, filename) => {
      OperationCoordinator.assertCanMutate("remove custom mod");
      return ClientModManager.remove(filename);
    },
  );

  // IPC Handlers: Game
  registerSecureHandler("game:launch", IpcSchemas.noArgs, async () => {
    const op = OperationCoordinator.acquire("launch", "Launch Minecraft");
    try {
      const refreshed = await LauncherAuth.refreshSession();
      if (!refreshed.valid || !refreshed.user) {
        throw new IpcValidationError(
          "Authentication required: Please log in with your Lampas Portal account before playing.",
        );
      }
      const user = refreshed.user;
      LauncherLogger.info("Initiating authenticated game launch");
      return await GameRunner.launchGame(
        user,
        (log) => {
          logTransport?.push(log);
        },
        (code) => {
          logTransport?.flushSession();
          LauncherLogger.info(`Minecraft process exited with code ${code}`);
          safeSend("game:exit", code);
        },
        undefined,
      );
    } finally {
      op.release();
    }
  });
  registerSecureHandler("game:kill", IpcSchemas.noArgs, async () => {
    LauncherLogger.warn("Game kill request received from user.");
    await GameRunner.killGame();
  });
  registerSecureHandler("game:isRunning", IpcSchemas.noArgs, () =>
    GameRunner.isGameRunning(),
  );

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
          "Boolean(window.lampas && window.lampas.utils && typeof window.lampas.utils.getAppVersion === 'function')",
        );
        if (!hasBridge) {
          throw new Error(
            "window.lampas or window.lampas.utils.getAppVersion is undefined in renderer context",
          );
        }
        LauncherLogger.info(
          "[Smoke Test] Renderer & preload verification round-trip passed",
        );
        const smokeJava = process.argv
          .find((argument) => argument.startsWith("--smoke-java="))
          ?.slice("--smoke-java=".length);
        if (smokeJava) {
          if (!path.isAbsolute(smokeJava))
            throw new Error("Smoke Java path must be absolute");
          const { JavaRuntimeManager } = await import("./java-runtime");
          if (
            ((await JavaRuntimeManager.checkJavaVersion(smokeJava)) || 0) < 25
          )
            throw new Error("Packaged Java 25 subprocess probe failed");
          LauncherLogger.info(
            "[Smoke Test] Java 25 subprocess verification passed",
          );
        }

        // Real Electron adversarial boundary checks
        const adversarialCheck = await mainWindow.webContents
          .executeJavaScript(`
          (async () => {
            // 1. Node integration disabled
            if (typeof require !== 'undefined' || typeof process !== 'undefined' || typeof Buffer !== 'undefined') {
              return { passed: false, reason: "Node integration leaked into renderer" };
            }
            // 2. Raw IPC not leaked on global
            if (typeof window.ipcRenderer !== 'undefined' || typeof window.electron !== 'undefined') {
              return { passed: false, reason: "Raw Electron IPC leaked into renderer" };
            }
            // 3. Unknown settings field rejected
            let rejectedSchema = false;
            try {
              await window.lampas.config.set({ maliciousField: "attack" });
            } catch (err) {
              if (err && err.message && err.message.includes("Unknown or unauthorized settings field")) {
                rejectedSchema = true;
              }
            }
            if (!rejectedSchema) {
              return { passed: false, reason: "Adversarial schema config:set did not reject malicious field" };
            }
            // 4. Arbitrary local path open rejected
            let rejectedPath = false;
            try {
              await window.lampas.utils.openPath("C:\\\\\\\\Windows\\\\\\\\System32\\\\\\\\cmd.exe");
            } catch (err) {
              if (err && err.message && (err.message.includes("Refusing to open unapproved path") || err.message.includes("unapproved path") || err.message.includes("Security violation") || err.message.includes("Invalid path"))) {
                rejectedPath = true;
              }
            }
            if (!rejectedPath) {
              return { passed: false, reason: "Adversarial openPath did not reject arbitrary local path" };
            }
            // 5. Native permission query rejected
            try {
              const perm = await navigator.permissions.query({ name: 'geolocation' });
              if (perm.state !== 'denied') {
                return { passed: false, reason: "Expected permission state to be 'denied', got " + perm.state };
              }
            } catch (permErr) {
              return { passed: false, reason: "Permission query threw exception instead of returning denied: " + (permErr && permErr.message) };
            }

            // 6. Auth storage status verification
            const storageStatus = await window.lampas.auth.getStorageStatus();
            if (!storageStatus || typeof storageStatus.sessionOnly !== 'boolean' || !storageStatus.backend) {
              return { passed: false, reason: "getStorageStatus did not return valid AuthStorageStatusDto: " + JSON.stringify(storageStatus) };
            }
            let rejectedSource = false;
            try { await window.lampas.utils.openSourcePage('file:///lampas-security-sentinel'); }
            catch { rejectedSource = true; }
            if (!rejectedSource) return { passed: false, reason: 'Local source link was accepted' };
            const originalPortal = (await window.lampas.config.get()).portalUrl;
            let rejectedPortal = false;
            try { await window.lampas.config.set({ portalUrl: 'https://unapproved.example.invalid' }); }
            catch { rejectedPortal = true; }
            if (!rejectedPortal || (await window.lampas.config.get()).portalUrl !== originalPortal) {
              return { passed: false, reason: 'Renderer changed the credential destination' };
            }
            return { passed: true };
          })()
        `);

        if (!adversarialCheck || !adversarialCheck.passed) {
          throw new Error(
            `Adversarial boundary check failed: ${adversarialCheck?.reason || "unknown"}`,
          );
        }
        const approvedDocument = mainWindow.webContents.getURL();
        const foreignWindow = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        try {
          await foreignWindow.loadURL(approvedDocument);
          const denied = await foreignWindow.webContents
            .executeJavaScript(`(async () => {
            if (!window.lampas) return false;
            try { await window.lampas.config.get(); return false; } catch { return true; }
          })()`);
          if (!denied)
            throw new Error("A foreign Electron window invoked privileged IPC");
        } finally {
          foreignWindow.destroy();
        }
        await mainWindow.webContents.executeJavaScript(
          "location.href = 'https://unapproved.example.invalid/security-smoke'",
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (mainWindow.webContents.getURL() !== approvedDocument)
          throw new Error(
            "Packaged application navigated away from its approved document",
          );
        LauncherLogger.info(
          "[Smoke Test] Real Electron adversarial boundary checks passed",
        );
        console.log(
          "[Smoke Test] Real Electron adversarial boundary checks passed",
        );
      } catch (smokeErr: any) {
        console.error(
          `[Smoke Test] Verification failed: ${smokeErr?.message || smokeErr}`,
        );
        LauncherLogger.error(
          `[Smoke Test] Verification failed: ${smokeErr?.message || smokeErr}`,
        );
        process.exitCode = 1;
      } finally {
        LauncherLogger.info(
          "[Smoke Test] All handlers registered; initiating graceful shutdown",
        );
        setTimeout(() => {
          app.quit();
        }, 100);
      }
    };
    setTimeout(runSmokeCheck, 400);
  }

  app.on("child-process-gone", (_event, details) => {
    LauncherLogger.error(
      `[Process Crash] ${details.type} process gone (${details.reason}, exitCode: ${details.exitCode})`,
    );
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
  LauncherAuth.cancelLogin();
  try {
    await Promise.race([
      Promise.all([
        LauncherLogger.close(),
        logTransport
          ? Promise.resolve(logTransport.close())
          : Promise.resolve(),
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
