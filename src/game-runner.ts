import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { ConfigManager, resolveStoreGameDir } from "./config";
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
  AuthRequiredError,
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
import {
  classifyGameSession,
  clearGameSession,
  newGameSessionId,
  readGameSession,
  sessionMarkerArg,
  systemProcessProbe,
  writeGameSession,
} from "./game-session";
import type { GameSessionVerdict, ProcessProbe } from "./game-session";

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

// Allowance for a clock that runs slightly ahead of Microsoft's.
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * Why `token` can't launch the game, or null when it can. A usable token is
 * a Minecraft access token from a Microsoft sign-in: a JWT whose payload
 * decodes and whose `exp`, when present, has not passed. The launcher can't
 * verify the signature; the Lampas Portal obtains the token from Microsoft.
 */
export function minecraftTokenProblem(
  token: string | undefined,
  now: number = Date.now(),
): "missing" | "expired" | null {
  if (typeof token !== "string" || !token.startsWith("ey")) return "missing";
  const parts = token.split(".");
  if (parts.length !== 3 || token.length <= 50) return "missing";
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return "missing";
  }
  if (!payload || typeof payload !== "object") return "missing";
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp === "number" && exp * 1000 < now - TOKEN_EXPIRY_SKEW_MS) {
    return "expired";
  }
  return null;
}

/** What the player must do before the game can launch. */
export const LAUNCH_SIGN_IN_MESSAGES = {
  login:
    "Authentication required: log in with your Lampas Portal account before playing.",
  session:
    "Your session has expired. Log in with your Lampas Portal account again.",
  link: "No bound Minecraft account found in your profile. Link one on the Lampas Portal.",
  minecraft:
    "Minecraft sign-in required: link the Microsoft account that owns Minecraft on the Lampas Portal, then log in again.",
  expired:
    "Your Minecraft session has expired. Log out, log in again, and try once more.",
} as const;

export type LaunchSignInReason = keyof typeof LAUNCH_SIGN_IN_MESSAGES;

/**
 * The identity Minecraft launches with, or why there is none: no linked
 * Minecraft account, or no usable Minecraft token from a Microsoft sign-in.
 * There is no offline-mode fallback.
 */
export function resolveLaunchIdentity(
  user: UserProfile,
  storedToken: string | undefined,
  now: number = Date.now(),
):
  | { ok: true; username: string; uuid: string; token: string }
  | { ok: false; reason: LaunchSignInReason } {
  const username = user.minecraftUsername || user.name;
  const uuid = user.minecraftUuid;
  if (!username || !uuid || uuid === "00000000-0000-0000-0000-000000000000") {
    return { ok: false, reason: "link" };
  }
  const token = user.minecraftAccessToken || storedToken;
  const problem = minecraftTokenProblem(token, now);
  if (problem === "expired") return { ok: false, reason: "expired" };
  if (problem || !token) return { ok: false, reason: "minecraft" };
  return { ok: true, username, uuid, token };
}

export class GameRunner {
  private static runningProcess: ChildProcess | null = null;
  private static exitPromise: Promise<number | null> | null = null;
  private static isStarting = false;
  // A game started by an earlier launcher session that this one picked up.
  private static adopted: {
    pid: number;
    sessionId: string;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  private static releasedForShutdown = false;
  private static adoptionPending = false;
  static _processProbe: ProcessProbe = systemProcessProbe;
  static _adoptedPollMs = 2000;
  static _adoptionRetryMs = 5000;
  static _adoptionAttempts = 3;

  static isGameRunning(): boolean {
    return (
      this.isStarting ||
      this.adoptionPending ||
      this.runningProcess !== null ||
      this.adopted !== null
    );
  }

  static getAdoptedPid(): number | null {
    return this.adopted ? this.adopted.pid : null;
  }

  /**
   * Picks up a Minecraft process that a previous launcher session left
   * running. The recorded PID is only trusted when its current command line
   * carries the session marker baked into the JVM arguments at launch.
   */
  static async adoptRunningGame(
    onExit: (code: number | null) => void,
  ): Promise<{ pid: number } | null> {
    if (this.isGameRunning()) return null;
    const record = readGameSession();
    if (!record) return null;

    // While the recorded PID is alive but not yet verified, report the game
    // as running so a second launch or a pack mutation cannot start against
    // files the unverified process may still hold.
    this.adoptionPending = true;
    try {
      for (let attempt = 1; ; attempt++) {
        let verdict: GameSessionVerdict = "unknown";
        try {
          verdict = await classifyGameSession(record, this._processProbe);
        } catch {
          // Never surface the error: probe failures can carry the command line.
          verdict = "unknown";
        }
        if (verdict === "dead" || verdict === "mismatch") {
          try {
            clearGameSession(record.sessionId);
          } catch {}
          return null;
        }
        if (verdict === "adoptable") break;
        // "unknown": the process is alive but its command line could not be
        // read (slow or failed PowerShell query). Retry a few times, then give
        // up for this start but keep the record for the next one.
        if (attempt >= this._adoptionAttempts) return null;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this._adoptionRetryMs),
        );
      }
    } finally {
      this.adoptionPending = false;
    }
    if (this.isGameRunning()) return null;

    const pid = record.pid;
    let reported = false;
    const timer = setInterval(() => {
      let alive = true;
      try {
        alive = this._processProbe.isAlive(pid);
      } catch {
        alive = false;
      }
      if (alive || reported) return;
      reported = true;
      clearInterval(timer);
      this.adopted = null;
      try {
        clearGameSession(record.sessionId);
      } catch {}
      onExit(null);
    }, this._adoptedPollMs);
    timer.unref?.();
    this.adopted = { pid, sessionId: record.sessionId, timer };
    return { pid };
  }

  static isAdoptionPending(): boolean {
    return this.adoptionPending;
  }

  static async launchGame(
    user: UserProfile | null,
    onLog: (entry: GameLogEntry) => void,
    onExit: (code: number | null) => void,
    releaseOverride?: ReleaseDescriptor,
  ): Promise<boolean> {
    if (this.adoptionPending) {
      throw new Error(
        "Still checking whether Minecraft is running from a previous launcher session. Try again in a moment.",
      );
    }
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
          throw new AuthRequiredError(LAUNCH_SIGN_IN_MESSAGES.login);
        }
        log("INFO", "Refreshing authentication tokens via Lampas Portal...");
        const refreshed = await LauncherAuth.refreshSession(config.portalUrl);
        if (!refreshed.valid || !refreshed.user) {
          throw new AuthRequiredError(LAUNCH_SIGN_IN_MESSAGES.session);
        }
        activeUser = refreshed.user;
      }

      const activeConfig = ConfigManager.get();
      const identity = resolveLaunchIdentity(
        activeUser,
        activeConfig.minecraftAccessToken,
      );
      if (!identity.ok) {
        throw new AuthRequiredError(LAUNCH_SIGN_IN_MESSAGES[identity.reason]);
      }
      const { username, uuid, token } = identity;

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
      const ramGb = activeConfig.allocatedRamGb || 8;
      const rawUuid = uuid.replace(/-/g, "");
      const userType = "msa";

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
      // A Store install that created this folder during the session wrote it
      // to the package's private copy. The game runs outside the package and
      // needs that copy's real path.
      const launchDir = resolveStoreGameDir(gameDir);
      if (launchDir !== gameDir)
        log("INFO", `Game files are in the Store package's copy: ${launchDir}`);
      log("INFO", "Authentication: Microsoft account");

      // 1. Ensure OpenJDK 25 Runtime
      const javaExe = await JavaRuntimeManager.ensureJava25(launchDir, (msg) =>
        log("INFO", msg),
      );

      // 2. Bootstrap Mojang & Fabric Libraries & Assets
      const { classpath, mainClass, assetIndex } =
        await MinecraftBootstrap.prepareGameEnvironment(
          launchDir,
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

      const sessionId = newGameSessionId();
      const jvmArgs = buildLaunchArguments({
        gameDir: launchDir,
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
        sessionId,
      });

      log("INFO", `Starting Minecraft client via ${mainClass}...`);

      // Detached so the game outlives the launcher; on Windows a non-detached
      // child is placed in a job object that closes with its parent. Verified
      // on a side-loaded Store (MSIX) install on 2026-10-14: the game survives
      // the launcher quitting and is adopted again on the next start.
      const proc = spawn(javaExe, jvmArgs, {
        cwd: launchDir,
        detached: true,
        windowsHide: true,
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

      if (
        typeof proc.pid === "number" &&
        Number.isSafeInteger(proc.pid) &&
        proc.pid > 0
      ) {
        try {
          writeGameSession({
            version: 1,
            pid: proc.pid,
            sessionId,
            startedAt: new Date().toISOString(),
            gameDir,
          });
        } catch (err: any) {
          log(
            "WARN",
            `Could not record the running game for later reattachment: ${err?.message || err}`,
          );
        }
      }

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
        if (!this.releasedForShutdown) {
          try {
            clearGameSession(sessionId);
          } catch {}
        }
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
    const adopted = this.adopted;
    if (adopted) {
      await this.killAdoptedGame(adopted.pid, timeoutMs);
      return;
    }

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

  // Exit reporting for an adopted game is left to the adoption poll timer.
  private static async killAdoptedGame(
    pid: number,
    timeoutMs: number,
  ): Promise<void> {
    const probe = this._processProbe;
    const waitForExit = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      for (;;) {
        let alive = true;
        try {
          alive = probe.isAlive(pid);
        } catch {
          alive = false;
        }
        if (!alive) return true;
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    };

    try {
      probe.terminate(pid, "SIGTERM");
    } catch {
      // Process may already have terminated
    }
    if (await waitForExit(Math.min(timeoutMs, 2500))) return;

    try {
      probe.terminate(pid, "SIGKILL");
    } catch {}
    await waitForExit(Math.max(1000, timeoutMs - 2500));
  }

  /**
   * Detaches the launcher from a running game as it shuts down. The session
   * file is deliberately left in place: the game keeps running and the next
   * launcher start adopts it.
   */
  static releaseForShutdown(): void {
    this.releasedForShutdown = true;
    const proc = this.runningProcess;
    if (proc) {
      try {
        proc.unref();
      } catch {}
      try {
        proc.stdout?.destroy();
      } catch {}
      try {
        proc.stderr?.destroy();
      } catch {}
    }
    if (this.adopted) {
      clearInterval(this.adopted.timer);
      this.adopted = null;
    }
  }

  static resetForTesting(): void {
    this.runningProcess = null;
    this.exitPromise = null;
    this.isStarting = false;
    if (this.adopted) clearInterval(this.adopted.timer);
    this.adopted = null;
    this.releasedForShutdown = false;
    this.adoptionPending = false;
    this._processProbe = systemProcessProbe;
    this._adoptedPollMs = 2000;
    this._adoptionRetryMs = 5000;
    this._adoptionAttempts = 3;
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
  userType: "msa";
  customJavaArgs: string[];
  mainClass: string;
  classpathString: string;
  autoConnectServer?: string;
  sessionId?: string;
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
    // Generational ZGC (the only ZGC mode on Java 25). G1-only tuning such as
    // MaxGCPauseMillis or ParallelRefProcEnabled has no effect here.
    "-XX:+UseZGC",
    "-XX:+DisableExplicitGC",
    "-XX:+AlwaysPreTouch",
    "-Dfabric.disableTelemetry=true",
    `-Djava.library.path=${path.join(options.gameDir, "natives")}`,
    `-Dminecraft.applet.TargetDirectory=${options.gameDir}`,
    ...(options.sessionId ? [sessionMarkerArg(options.sessionId)] : []),
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
