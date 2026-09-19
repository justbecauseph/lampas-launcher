import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { ConfigManager } from "./config";
import { downloadVerified, fetchJsonWithRetry, hashFile } from "./file-transfer";
import { checkPhysicalAncestry, resolveAndContainPath, validateDigestString } from "./path-policy";

export class JavaRuntimeManager {
  private static probeCache = new Map<string, number | null>();

  static clearProbeCache(): void {
    this.probeCache.clear();
  }

  /**
   * Asynchronously probes a Java executable for its major specification version.
   * Shell-free execution with argument arrays, bounded buffer, timeout, and Windows javaw detection.
   */
  static async checkJavaVersion(javaPath: string): Promise<number | null> {
    const trimmed = javaPath.trim();
    if (!trimmed) return null;

    if (this.probeCache.has(trimmed)) {
      return this.probeCache.get(trimmed)!;
    }

    const isBareCommand =
      trimmed === "java" ||
      trimmed === "javaw" ||
      trimmed === "java.exe" ||
      trimmed === "javaw.exe";

    // For file paths, check existence on disk
    if (!isBareCommand && !fs.existsSync(trimmed)) {
      this.probeCache.set(trimmed, null);
      return null;
    }

    // Windows javaw probing: javaw.exe suppresses console output.
    // If probing javaw.exe, check for a sibling java.exe in the same directory.
    let probeExecutable = trimmed;
    if (process.platform === "win32") {
      const lower = trimmed.toLowerCase();
      if (lower.endsWith("javaw.exe")) {
        const siblingJava = path.join(path.dirname(trimmed), "java.exe");
        if (fs.existsSync(siblingJava)) {
          probeExecutable = siblingJava;
        }
      } else if (lower === "javaw") {
        probeExecutable = "java";
      }
    }

    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          probeExecutable,
          ["-version"],
          {
            timeout: 4000,
            maxBuffer: 64 * 1024,
            shell: false,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const combined = `${stdout || ""}\n${stderr || ""}`;
            if (combined.trim().length > 0) {
              resolve(combined);
            } else if (error) {
              reject(error);
            } else {
              resolve("");
            }
          }
        );
      });

      const match =
        output.match(/version "(?:1\.)?(\d+)/i) ||
        output.match(/build (\d+)/i) ||
        output.match(/openjdk (\d+)/i);
      const ver = match ? parseInt(match[1], 10) : null;
      this.probeCache.set(trimmed, ver);
      return ver;
    } catch {
      this.probeCache.set(trimmed, null);
      return null;
    }
  }

  static async ensureJava25(
    gameDir: string,
    onLog: (msg: string) => void,
    verificationMode: "fast" | "full" = "fast"
  ): Promise<string> {
    const config = ConfigManager.get();

    // 1. Check user configured Java path
    if (config.javaPath) {
      const ver = await this.checkJavaVersion(config.javaPath);
      if (ver && ver >= 25) {
        onLog(`[Java] Using configured Java ${ver}: ${config.javaPath}`);
        return config.javaPath;
      }
    }

    // 2. Check local gameDir runtime
    const localRuntimeJava = path.join(
      gameDir,
      "runtime",
      "java-runtime-epsilon",
      "bin",
      process.platform === "win32" ? "javaw.exe" : "java"
    );
    if (fs.existsSync(localRuntimeJava)) {
      const ver = await this.checkJavaVersion(localRuntimeJava);
      if (ver && ver >= 25) {
        if (verificationMode === "fast") {
          onLog(`[Java] Found local Java ${ver}: ${localRuntimeJava}`);
          return localRuntimeJava;
        }
        onLog(`[Java] Fully verifying local Java ${ver}: ${localRuntimeJava}`);
      }
    }

    // 3. Search common system locations for Java 25 / OpenJDK 25 unless repairing a managed runtime.
    const searchPaths: string[] = [];

    if (process.env.JAVA_HOME) {
      searchPaths.push(
        path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "javaw.exe" : "java")
      );
    }

    if (process.platform === "win32") {
      searchPaths.push(
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Eclipse Adoptium", "jdk-25", "bin", "javaw.exe"),
        "C:\\Program Files\\Microsoft\\jdk-25\\bin\\javaw.exe",
        "C:\\Program Files\\Eclipse Adoptium\\jdk-25\\bin\\javaw.exe",
        "C:\\Program Files\\Java\\jdk-25\\bin\\javaw.exe"
      );
    } else {
      searchPaths.push(
        "/usr/lib/jvm/java-25-openjdk/bin/java",
        "/usr/lib/jvm/java-25/bin/java",
        "/opt/jdk-25/bin/java"
      );
    }

    for (const p of verificationMode === "full" && fs.existsSync(localRuntimeJava) ? [] : searchPaths) {
      const ver = await this.checkJavaVersion(p);
      if (ver && ver >= 25) {
        onLog(`[Java] Located system Java ${ver}: ${p}`);
        return p;
      }
    }

    // 4. Check PATH 'java'
    const systemJavaVer =
      verificationMode === "full" && fs.existsSync(localRuntimeJava)
        ? null
        : await this.checkJavaVersion("java");
    if (systemJavaVer && systemJavaVer >= 25) {
      onLog(`[Java] Using PATH Java ${systemJavaVer}`);
      return "java";
    }

    // 5. If not found on machine, download and provision OpenJDK 25 from Mojang runtime CDN
    onLog(`[Java] Java 25 not detected. Provisioning official OpenJDK 25 (java-runtime-epsilon)...`);
    const runtimeDest = path.join(gameDir, "runtime", "java-runtime-epsilon");
    await fs.promises.mkdir(runtimeDest, { recursive: true });

    try {
      const platformKey =
        process.platform === "win32"
          ? "windows-x64"
          : process.platform === "darwin"
          ? "mac-os"
          : "linux";
      const allRuntimes: any = await fetchJsonWithRetry(
        "https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json"
      );
      const epsilonEntries = allRuntimes[platformKey]?.["java-runtime-epsilon"];

      if (!epsilonEntries || epsilonEntries.length === 0) {
        throw new Error(`Java 25 (java-runtime-epsilon) not available for platform ${platformKey}`);
      }

      const manifestUrl = epsilonEntries[0].manifest.url;
      const manifest: any = await fetchJsonWithRetry(manifestUrl);
      const files: Record<string, any> = manifest.files || {};

      let completed = 0;
      const total = Object.keys(files).length;
      const entries = Object.entries(files);
      let nextFile = 0;
      const concurrency = 6;

      async function worker() {
        while (nextFile < entries.length) {
          const item = entries[nextFile++];
          if (!item) break;
          const [relPath, fileInfo] = item;
          const targetPath = resolveAndContainPath(runtimeDest, relPath);
          await checkPhysicalAncestry(runtimeDest, targetPath);

          if (fileInfo.type === "directory") {
            await fs.promises.mkdir(targetPath, { recursive: true });
            completed++;
            continue;
          }

          if (fileInfo.type === "file" && fileInfo.downloads?.raw) {
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

            const raw = fileInfo.downloads.raw;
            if (raw.sha1) {
              validateDigestString(raw.sha1, "sha1");
            }
            let isValid = false;
            if (fs.existsSync(targetPath)) {
              try {
                const stat = await fs.promises.stat(targetPath);
                const sizeOk = raw.size === undefined || stat.size === raw.size;
                if (sizeOk) {
                  const actualSha1 = await hashFile(targetPath, "sha1");
                  isValid = !raw.sha1 || actualSha1 === raw.sha1;
                }
              } catch {
                isValid = false;
              }
            }

            if (!isValid) {
              await downloadVerified(raw.url, targetPath, {
                algorithm: "sha1",
                expectedHash: raw.sha1,
                expectedSize: raw.size,
                headers: { "User-Agent": "Lampas-Launcher/1.0" },
                timeoutMs: 60_000,
              });
            }

            if (fileInfo.executable) {
              try {
                await fs.promises.chmod(targetPath, 0o755);
              } catch {}
            }
          }

          completed++;
          if (completed % 100 === 0 || completed === total) {
            onLog(`[Java] Downloading OpenJDK 25: ${completed}/${total} files...`);
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(concurrency, entries.length) }, () => worker())
      );

      // Validate the provisioned executable before announcing success
      const provisionedVer = await this.checkJavaVersion(localRuntimeJava);
      if (!provisionedVer || provisionedVer < 25) {
        throw new Error(
          `Provisioned Java at '${localRuntimeJava}' failed verification (detected: ${provisionedVer ?? "none"}).`
        );
      }

      onLog(`[Java] OpenJDK 25 successfully installed and verified (${provisionedVer}) in: ${runtimeDest}`);
      return localRuntimeJava;
    } catch (err: any) {
      onLog(`[Java Error] Automatic Java 25 download failed: ${err.message}`);
      throw new Error(
        `Minecraft 26.2 requires OpenJDK 25. Please install Java 25 or configure its path in settings.`
      );
    }
  }
}
