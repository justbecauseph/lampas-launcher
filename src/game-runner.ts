import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { ConfigManager } from "./config";
import { LauncherAuth } from "./auth";
import { MinecraftBootstrap } from "./minecraft-bootstrap";
import { JavaRuntimeManager } from "./java-runtime";
import { isValidServerAddress, verifyRequiredResourcePacks } from "./resource-packs";
import { validateRuntimeDefinition } from "./runtime-definition";
import type { GameLogEntry, ReleaseDescriptor, UserProfile } from "./types";

function generateOfflineUuid(username: string): string {
  const md5 = createHash("md5").update(`OfflinePlayer:${username}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // Version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // Variant RFC 4122
  return md5.toString("hex");
}

export class GameRunner {
  private static runningProcess: ChildProcess | null = null;
  private static isStarting = false;

  static isGameRunning(): boolean {
    return this.isStarting || this.runningProcess !== null;
  }

  static async launchGame(
    user: UserProfile | null,
    onLog: (entry: GameLogEntry) => void,
    onExit: (code: number | null) => void,
    releaseOverride?: ReleaseDescriptor
  ): Promise<boolean> {
    if (this.isGameRunning()) {
      throw new Error("Minecraft is already running!");
    }

    this.isStarting = true;

    const log = (level: "INFO" | "WARN" | "ERROR", message: string) => {
      onLog({
        timestamp: new Date().toLocaleTimeString(),
        level,
        message,
      });
    };

    try {
      const config = ConfigManager.get();
      if (!user || (!config.token && !config.refreshToken)) {
        throw new Error("Authentication required: Please log in with your Lampas Portal account before playing.");
      }

      log("INFO", "Refreshing authentication tokens via Lampas Portal...");
      const refreshed = await LauncherAuth.refreshSession(config.portalUrl);
      if (!refreshed.valid || !refreshed.user) {
        throw new Error("Session expired or invalid: Please log in with your Lampas Portal account.");
      }

      const activeUser = refreshed.user;
      const activeConfig = ConfigManager.get();
      const username = activeUser.minecraftUsername || activeUser.name;
      const uuid = activeUser.minecraftUuid;
      if (!username || !uuid || uuid === "00000000-0000-0000-0000-000000000000") {
        throw new Error("Authentication error: No bound Minecraft account found in your profile. Please link your Minecraft account on the portal dashboard.");
      }

      const gameDir = activeConfig.gameDir;
      const ramGb = activeConfig.allocatedRamGb || 4;
      const rawUuid = uuid.replace(/-/g, "");
      const mcToken = activeUser.minecraftAccessToken || activeConfig.minecraftAccessToken;
      const isRealMsa = !!(mcToken && mcToken.startsWith("ey") && mcToken.length > 50);
      const token = isRealMsa ? mcToken : "0";
      const userType = isRealMsa ? "msa" : "legacy";

      // Resolve active release descriptor for launch configuration
      let release: ReleaseDescriptor | null = releaseOverride || null;
      if (!release) {
        const stateReleasePath = path.join(gameDir, ".lampas", "release.json");
        if (fs.existsSync(stateReleasePath)) {
          try {
            release = JSON.parse(fs.readFileSync(stateReleasePath, "utf-8"));
          } catch {}
        }
      }

      if (!release) {
        throw new Error(
          "No installed Lampas release found. Please synchronize or repair your modpack installation first."
        );
      }

    const runtime = validateRuntimeDefinition(release);

    // Verify required resource packs before bootstrapping
    if (release?.launch?.requiredResourcePacks && release.launch.requiredResourcePacks.length > 0) {
      log("INFO", `Verifying ${release.launch.requiredResourcePacks.length} required Lampas resource pack(s)...`);
      try {
        await verifyRequiredResourcePacks(gameDir, release.launch.requiredResourcePacks);
        log("INFO", "Required resource pack(s) verified.");
      } catch (err: any) {
        log("ERROR", `Failed to verify required Lampas resource pack: ${err.message}`);
        throw new Error("Unable to prepare required Lampas resource pack. Run Repair and try again.");
      }
    }

    log("INFO", `Preparing Standalone Minecraft + Fabric Environment (Java 25)...`);
    log("INFO", `Game Directory: ${gameDir}`);
    log("INFO", `Player: ${username} (UUID: ${rawUuid}, Auth: ${isRealMsa ? "Microsoft Services" : "Lampas Protocol"})`);

    // 1. Ensure OpenJDK 25 Runtime
    const javaExe = await JavaRuntimeManager.ensureJava25(gameDir, (msg) => log("INFO", msg));

    // 2. Bootstrap Mojang & Fabric Libraries & Assets
    const { classpath, mainClass, assetIndex } = await MinecraftBootstrap.prepareGameEnvironment(
      gameDir,
      runtime,
      (msg) => log("INFO", msg)
    );

    // 3. Build JVM and Game Classpath
    const cpSeparator = process.platform === "win32" ? ";" : ":";
    const classpathString = classpath.join(cpSeparator);

    const customJavaArgs = parseJavaArgs(activeConfig.javaArgs || "");
    const jvmArgs = [
      `-Xmx${ramGb}G`,
      `-Xms${Math.min(2, ramGb)}G`,
      "-XX:+UseZGC",
      "-XX:+ParallelRefProcEnabled",
      "-XX:MaxGCPauseMillis=200",
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:+DisableExplicitGC",
      "-XX:+AlwaysPreTouch",
      "-Dfabric.disableTelemetry=true",
      `-Djava.library.path=${path.join(gameDir, "natives")}`,
      `-Dminecraft.applet.TargetDirectory=${gameDir}`,
      ...customJavaArgs,
      "-cp",
      classpathString,
      mainClass,
      "--username",
      username,
      "--version",
      runtime.minecraft,
      "--gameDir",
      gameDir,
      "--assetsDir",
      path.join(gameDir, "assets"),
      "--assetIndex",
      assetIndex,
      "--uuid",
      rawUuid,
      "--accessToken",
      token,
      "--userType",
      userType,
      "--versionType",
      "release",
      "--userProperties",
      "{}",
    ];

    // Quick Play: Direct server connection
    if (release?.launch?.autoConnect && release.launch.server) {
      const serverAddr = release.launch.server.trim();
      if (!isValidServerAddress(serverAddr)) {
        log("ERROR", `Invalid auto-connect server address configured: '${serverAddr}'`);
        throw new Error(`Malformed auto-connect server address: '${serverAddr}'`);
      }
      log("INFO", `Direct connect enabled: automatically connecting to ${serverAddr}...`);
      jvmArgs.push("--quickPlayMultiplayer", serverAddr);
    }

    log("INFO", `Starting Minecraft client via ${mainClass}...`);

    const proc = spawn(javaExe, jvmArgs, {
      cwd: gameDir,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

      this.runningProcess = proc;

      // Wait for asynchronous spawn or error
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanupSpawnListeners = () => {
          proc.removeListener?.("spawn", onSpawn);
          proc.removeListener?.("error", onError);
        };

        const onSpawn = () => {
          if (!settled) {
            settled = true;
            cleanupSpawnListeners();
            resolve();
          }
        };

        const onError = (err: any) => {
          if (!settled) {
            settled = true;
            cleanupSpawnListeners();
            this.runningProcess = null;
            reject(err);
          }
        };

        proc.once?.("spawn", onSpawn);
        proc.once?.("error", onError);

        // Fallback for mocks and synchronous child processes
        setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanupSpawnListeners();
            resolve();
          }
        }, 10);
      });

      proc.stdout?.on("data", (data) => {
        const text = data.toString().trim();
        if (text) {
          log("INFO", text);
        }
      });

      proc.stderr?.on("data", (data) => {
        const text = data.toString().trim();
        if (text) {
          const level = text.includes("ERROR") || text.includes("Exception") ? "ERROR" : "WARN";
          log(level, text);
        }
      });

      let exitReported = false;
      const handleExit = (code: number | null) => {
        if (exitReported) return;
        exitReported = true;
        this.runningProcess = null;
        log(code === 0 ? "INFO" : "ERROR", `Minecraft exited with code ${code}`);
        onExit(code);
      };

      proc.once?.("exit", handleExit);
      proc.once?.("close", handleExit);
      proc.on?.("error", (err: any) => {
        log("ERROR", `Minecraft process error: ${err?.message || err}`);
        handleExit(-1);
      });

      return true;
    } catch (err: any) {
      log("ERROR", `Failed to launch Minecraft JVM: ${err.message}`);
      throw err;
    } finally {
      this.isStarting = false;
    }
  }

  static killGame(): void {
    if (this.runningProcess && !this.runningProcess.killed) {
      this.runningProcess.kill("SIGTERM");
    }
  }

  static resetForTesting(): void {
    this.runningProcess = null;
    this.isStarting = false;
  }
}

export function parseJavaArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const input = value.trim();
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      const next = input[index + 1];
      if (next === "\\" || next === '"' || next === "'" || /\s/.test(next || "")) escaped = true;
      else current += char;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Custom Java arguments contain an unclosed quote.");
  if (current) args.push(current);
  return args;
}
