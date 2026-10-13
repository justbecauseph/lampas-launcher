import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { ConfigManager } from "./config";
import { normalizePortalUrl } from "./portal-policy";
import { LauncherAuth } from "./auth";
import { MinecraftBootstrap } from "./minecraft-bootstrap";
import { JavaRuntimeManager } from "./java-runtime";
import {
  isValidServerAddress,
  verifyRequiredResourcePacks,
} from "./resource-packs";
import { validateRuntimeDefinition } from "./runtime-definition";
import { ProcessLogFramer } from "./game-log-stream";
import {
  classifyJavaArgs,
  parseJavaArgs,
  InstallationStateError,
} from "./ipc-boundary";
import type { GameLogEntry, ReleaseDescriptor, UserProfile } from "./types";
import { assertSyncSafetyAdmission } from "./sync-safety";
import {
  validateInstallationState,
  validateReleaseDescriptor,
  MAX_SUPPORTED_PROTOCOL,
} from "./metadata-policy";
import { checkPhysicalAncestrySync } from "./path-policy";
import { TRANSFER_LIMITS } from "./transfer-limits";
import { maximizeGameWindow, MAXIMIZE_EXIT } from "./window-maximizer";

function readInstalledMetadata(gameDir: string, filePath: string): unknown {
  checkPhysicalAncestrySync(gameDir, filePath, {
    disallowSymlinks: true,
    expectedCategory: "RESERVED_INTERNAL",
  });
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > TRANSFER_LIMITS.jsonBytes)
      throw new Error("Installed metadata is not a bounded regular file");
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (!count) break;
      total += count;
    }
    if (total > stat.size)
      throw new Error("Installed metadata changed during reading");
    return JSON.parse(bytes.subarray(0, total).toString("utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function generateOfflineUuid(username: string): string {
  const md5 = createHash("md5").update(`OfflinePlayer:${username}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // Version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // Variant RFC 4122
  return md5.toString("hex");
}

export class GameRunner {
  private static runningProcess: ChildProcess | null = null;
  private static exitPromise: Promise<number | null> | null = null;
  private static isStarting = false;

  static isGameRunning(): boolean {
    return this.isStarting || this.runningProcess !== null;
  }

  static async launchGame(
    user: UserProfile | null,
    onLog: (entry: GameLogEntry) => void,
    onExit: (code: number | null) => void,
    releaseOverride?: ReleaseDescriptor,
  ): Promise<boolean> {
    if (this.isGameRunning()) {
      throw new Error("Minecraft is already running!");
    }

    this.isStarting = true;

    const log = (level: GameLogEntry["level"], message: string) => {
      onLog({
        timestamp: new Date().toLocaleTimeString(),
        level,
        message,
      });
    };

    try {
      const config = ConfigManager.get();
      let activeUser: UserProfile;

      if (
        user &&
        user.minecraftUuid &&
        user.minecraftUuid !== "00000000-0000-0000-0000-000000000000"
      ) {
        // Consolidated authentication: use main-verified user identity
        activeUser = user;
      } else {
        if (!config.token && !config.refreshToken) {
          throw new Error(
            "Authentication required: Please log in with your Lampas Portal account before playing.",
          );
        }
        log("INFO", "Refreshing authentication tokens via Lampas Portal...");
        const refreshed = await LauncherAuth.refreshSession(config.portalUrl);
        if (!refreshed.valid || !refreshed.user) {
          throw new Error(
            "Session expired or invalid: Please log in with your Lampas Portal account.",
          );
        }
        activeUser = refreshed.user;
      }

      const activeConfig = ConfigManager.get();
      const username = activeUser.minecraftUsername || activeUser.name;
      const uuid = activeUser.minecraftUuid;
      if (
        !username ||
        !uuid ||
        uuid === "00000000-0000-0000-0000-000000000000"
      ) {
        throw new Error(
          "Authentication error: No bound Minecraft account found in your profile. Please link your Minecraft account on the portal dashboard.",
        );
      }

      const gameDir = activeConfig.gameDir;
      try {
        assertSyncSafetyAdmission({
          origin: normalizePortalUrl(activeConfig.portalUrl),
          channel: (activeConfig.selectedChannel || "stable") as
            "stable" | "beta" | "dev",
          gameDir,
        });
      } catch {
        throw new InstallationStateError(
          "Launch blocked by an unresolved synchronization failure. Run Repair before playing.",
        );
      }
      const ramGb = activeConfig.allocatedRamGb || 4;
      const rawUuid = uuid.replace(/-/g, "");
      const mcToken =
        activeUser.minecraftAccessToken || activeConfig.minecraftAccessToken;
      const isRealMsa = !!(
        mcToken &&
        mcToken.startsWith("ey") &&
        mcToken.length > 50
      );
      const token = isRealMsa ? mcToken : "0";
      const userType = isRealMsa ? "msa" : "legacy";

      // Resolve active release descriptor for launch configuration
      let release: ReleaseDescriptor | null = releaseOverride || null;
      if (!release) {
        const stateReleasePath = path.join(gameDir, ".lampas", "release.json");
        if (!fs.existsSync(stateReleasePath)) {
          throw new InstallationStateError(
            "No installed Lampas release found. Please synchronize or repair your modpack installation first.",
          );
        }
        try {
          const cached: any = readInstalledMetadata(gameDir, stateReleasePath);
          const { syncGeneration, ...remoteDescriptor } = cached;
          validateReleaseDescriptor(remoteDescriptor);
          if (
            syncGeneration !== undefined &&
            (typeof syncGeneration !== "string" ||
              syncGeneration.length > 128 ||
              !syncGeneration.trim())
          )
            throw new Error("Invalid release generation");
          if (
            remoteDescriptor.protocol > MAX_SUPPORTED_PROTOCOL ||
            remoteDescriptor.status === "REVOKED"
          )
            throw new Error("Installed release is ineligible for launch");
          release = cached;
        } catch {
          throw new InstallationStateError(
            "Release descriptor is corrupted. Please synchronize or repair your modpack installation first.",
          );
        }
      }

      if (
        !release ||
        typeof release !== "object" ||
        Object.keys(release).length === 0
      ) {
        throw new InstallationStateError(
          "No installed Lampas release found. Please synchronize or repair your modpack installation first.",
        );
      }
      if (!release.version || typeof release.version !== "string") {
        throw new InstallationStateError(
          "Release descriptor metadata is missing mandatory 'version' field. Please synchronize or repair.",
        );
      }

      // Mandatory installed-state evidence validation
      if (!releaseOverride) {
        const stateFilePath = path.join(
          gameDir,
          ".lampas",
          "installation.json",
        );
        if (!fs.existsSync(stateFilePath)) {
          throw new InstallationStateError(
            "Missing installation state metadata: No installed modpack found. Please synchronize or repair your modpack installation first.",
          );
        }
        let installedState: any;
        try {
          installedState = readInstalledMetadata(gameDir, stateFilePath);
        } catch {
          throw new InstallationStateError(
            "Installation state metadata is corrupted. Please synchronize or repair your modpack installation first.",
          );
        }
        if (
          !installedState ||
          typeof installedState !== "object" ||
          Object.keys(installedState).length === 0
        ) {
          throw new InstallationStateError(
            "Installation state metadata is empty. Please synchronize or repair your modpack installation first.",
          );
        }
        if (
          !installedState.version ||
          typeof installedState.version !== "string"
        ) {
          throw new InstallationStateError(
            "Installation state metadata is missing mandatory 'version' field. Please synchronize or repair.",
          );
        }
        if (
          installedState.version &&
          release.version &&
          installedState.version !== release.version
        ) {
          throw new InstallationStateError(
            `Incompatible installation state detected: installed version '${installedState.version}' does not match release descriptor '${release.version}'. Please synchronize or repair.`,
          );
        }
        if (
          installedState.syncGeneration &&
          release.syncGeneration &&
          installedState.syncGeneration !== release.syncGeneration
        ) {
          throw new InstallationStateError(
            `Incompatible installation generation detected: installed generation '${installedState.syncGeneration}' does not match release descriptor '${release.syncGeneration}'. Please synchronize or repair.`,
          );
        }
        try {
          validateInstallationState(installedState, gameDir);
          if (installedState.pack !== release.pack)
            throw new Error("Installed pack identity mismatch");
        } catch {
          throw new InstallationStateError(
            "Installation state metadata is invalid. Please synchronize or repair.",
          );
        }
      }

      const runtime = validateRuntimeDefinition(release);

      // Verify required resource packs before bootstrapping
      if (
        release?.launch?.requiredResourcePacks &&
        release.launch.requiredResourcePacks.length > 0
      ) {
        log(
          "INFO",
          `Verifying ${release.launch.requiredResourcePacks.length} required Lampas resource pack(s)...`,
        );
        try {
          await verifyRequiredResourcePacks(
            gameDir,
            release.launch.requiredResourcePacks,
          );
          log("INFO", "Required resource pack(s) verified.");
        } catch (err: any) {
          log(
            "ERROR",
            `Failed to verify required Lampas resource pack: ${err.message}`,
          );
          throw new Error(
            "Unable to prepare required Lampas resource pack. Run Repair and try again.",
          );
        }
      }

      log(
        "INFO",
        `Preparing Standalone Minecraft + Fabric Environment (Java 25)...`,
      );
      log("INFO", `Game Directory: ${gameDir}`);
      log(
        "INFO",
        `Authentication: ${isRealMsa ? "Microsoft Services" : "Lampas Protocol"}`,
      );

      // 1. Ensure OpenJDK 25 Runtime
      const javaExe = await JavaRuntimeManager.ensureJava25(gameDir, (msg) =>
        log("INFO", msg),
      );

      // 2. Bootstrap Mojang & Fabric Libraries & Assets
      const { classpath, mainClass, assetIndex } =
        await MinecraftBootstrap.prepareGameEnvironment(
          gameDir,
          runtime,
          (msg) => log("INFO", msg),
        );

      // 3. Build JVM and Game Classpath
      const cpSeparator = process.platform === "win32" ? ";" : ":";
      const classpathString = classpath.join(cpSeparator);

      const customJavaArgs = parseJavaArgs(activeConfig.javaArgs || "");
      const autoConnectServer =
        release?.launch?.autoConnect && release.launch.server
          ? release.launch.server.trim()
          : undefined;
      if (autoConnectServer && !isValidServerAddress(autoConnectServer)) {
        log(
          "ERROR",
          `Invalid auto-connect server address configured: '${autoConnectServer}'`,
        );
        throw new Error(
          `Malformed auto-connect server address: '${autoConnectServer}'`,
        );
      }

      const jvmArgs = buildLaunchArguments({
        gameDir,
        ramGb,
        runtime,
        assetIndex,
        username,
        uuid: rawUuid,
        token,
        userType,
        customJavaArgs,
        mainClass,
        classpathString,
        autoConnectServer,
      });

      log("INFO", `Starting Minecraft client via ${mainClass}...`);

      const proc = spawn(javaExe, jvmArgs, {
        cwd: gameDir,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.runningProcess = proc;

      // Set up exit promise to await actual process termination
      this.exitPromise = new Promise<number | null>((resolve) => {
        let resolved = false;
        const settleExit = (code: number | null) => {
          if (!resolved) {
            resolved = true;
            resolve(code);
          }
        };
        proc.once?.("exit", settleExit);
        proc.once?.("close", settleExit);
      });

      // Wait for asynchronous spawn or initial spawn error
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanupSpawnListeners = () => {
          proc.removeListener?.("spawn", onSpawn);
          proc.removeListener?.("error", onSpawnError);
        };

        const onSpawn = () => {
          if (!settled) {
            settled = true;
            cleanupSpawnListeners();
            resolve();
          }
        };

        const onSpawnError = (err: any) => {
          if (!settled) {
            settled = true;
            cleanupSpawnListeners();
            this.runningProcess = null;
            this.exitPromise = null;
            reject(err);
          }
        };

        proc.once?.("spawn", onSpawn);
        proc.once?.("error", onSpawnError);

        // Fallback for mocks and synchronous child processes
        setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanupSpawnListeners();
            resolve();
          }
        }, 10);
      });

      const stdoutFramer = new ProcessLogFramer("INFO", onLog);
      const stderrFramer = new ProcessLogFramer("WARN", onLog);

      stdoutFramer.attach(proc.stdout);
      stderrFramer.attach(proc.stderr);

      let exitReported = false;
      const maximizer = maximizeGameWindow(proc.pid, (code) => {
        if (exitReported) return;
        if (code === MAXIMIZE_EXIT.maximized) {
          log("INFO", "Maximized Minecraft window.");
        } else if (
          code !== MAXIMIZE_EXIT.processGone &&
          code !== MAXIMIZE_EXIT.notMaximizable
        ) {
          log("WARN", `Could not maximize Minecraft window (code ${code}).`);
        }
      });

      const handleExit = (code: number | null) => {
        if (exitReported) return;
        exitReported = true;
        if (maximizer && maximizer.exitCode === null) {
          try {
            maximizer.kill();
          } catch {}
        }
        stdoutFramer.flush();
        stderrFramer.flush();
        this.runningProcess = null;
        this.exitPromise = null;
        log(
          code === 0 ? "INFO" : "ERROR",
          `Minecraft exited with code ${code}`,
        );
        onExit(code);
      };

      proc.once?.("exit", handleExit);
      proc.once?.("close", handleExit);

      // Runtime post-spawn errors: log but DO NOT clear runningProcess!
      // The child OS process has not exited unless 'exit' or 'close' fires.
      proc.on?.("error", (err: any) => {
        log("ERROR", `Minecraft process runtime error: ${err?.message || err}`);
      });

      return true;
    } catch (err: any) {
      log("ERROR", `Failed to launch Minecraft JVM: ${err.message}`);
      throw err;
    } finally {
      this.isStarting = false;
    }
  }

  static async killGame(timeoutMs = 5000): Promise<void> {
    const proc = this.runningProcess;
    if (!proc || proc.killed) {
      return;
    }

    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may already have terminated
    }

    if (!this.exitPromise) {
      return;
    }

    // Wait bounded time for SIGTERM exit
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.min(timeoutMs, 2500));
    });

    const result = await Promise.race([this.exitPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    // Escalate to SIGKILL if process did not exit within timeout window
    if (
      result === "timeout" &&
      this.runningProcess &&
      !this.runningProcess.killed
    ) {
      try {
        this.runningProcess.kill("SIGKILL");
      } catch {}
      const finalTimeout = new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(1000, timeoutMs - 2500));
      });
      await Promise.race([this.exitPromise, finalTimeout]);
    }
  }

  static resetForTesting(): void {
    this.runningProcess = null;
    this.exitPromise = null;
    this.isStarting = false;
  }
}

export function buildLaunchArguments(options: {
  gameDir: string;
  ramGb: number;
  runtime: any;
  assetIndex: string;
  username: string;
  uuid: string;
  token: string;
  userType: string;
  customJavaArgs: string[];
  mainClass: string;
  classpathString: string;
  autoConnectServer?: string;
}): string[] {
  const classification = classifyJavaArgs(options.customJavaArgs);
  if (classification.hasLaunchTargetOverride) {
    throw new InstallationStateError(
      `Process argument sink rejected launch target override: custom Java arguments contain an unauthorized launch target override: ${classification.launchTargetViolations.join(", ")}`,
    );
  }

  const rawUuid = options.uuid.replace(/-/g, "");
  const jvmArgs = [
    `-Xmx${options.ramGb}G`,
    `-Xms${Math.min(2, options.ramGb)}G`,
    "-XX:+UseZGC",
    "-XX:+ParallelRefProcEnabled",
    "-XX:MaxGCPauseMillis=200",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+DisableExplicitGC",
    "-XX:+AlwaysPreTouch",
    "-Dfabric.disableTelemetry=true",
    `-Djava.library.path=${path.join(options.gameDir, "natives")}`,
    `-Dminecraft.applet.TargetDirectory=${options.gameDir}`,
    ...options.customJavaArgs,
    "-cp",
    options.classpathString,
    options.mainClass,
    "--username",
    options.username,
    "--version",
    options.runtime.minecraft,
    "--gameDir",
    options.gameDir,
    "--assetsDir",
    path.join(options.gameDir, "assets"),
    "--assetIndex",
    options.assetIndex,
    "--uuid",
    rawUuid,
    "--accessToken",
    options.token,
    "--userType",
    options.userType,
    "--versionType",
    "release",
    "--userProperties",
    "{}",
  ];

  if (options.autoConnectServer) {
    jvmArgs.push("--quickPlayMultiplayer", options.autoConnectServer);
  }

  return jvmArgs;
}

export { parseJavaArgs, classifyJavaArgs } from "./ipc-boundary";
