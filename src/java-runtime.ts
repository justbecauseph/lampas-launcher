import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { ConfigManager } from "./config";
import { downloadVerified, fetchJsonWithRetry, hashFile } from "./file-transfer";

export class JavaRuntimeManager {
  private static checkJavaVersion(javaPath: string): number | null {
    try {
      if (!fs.existsSync(javaPath)) return null;
      const output = execSync(`"${javaPath}" -version 2>&1`, { encoding: "utf-8", timeout: 4000 });
      const match = output.match(/version "(?:1\.)?(\d+)/i) || output.match(/build (\d+)/i);
      if (match) {
        return parseInt(match[1], 10);
      }
    } catch {
      return null;
    }
    return null;
  }

  static async ensureJava25(
    gameDir: string,
    onLog: (msg: string) => void,
    verificationMode: "fast" | "full" = "fast"
  ): Promise<string> {
    const config = ConfigManager.get();

    // 1. Check user configured Java path
    if (config.javaPath) {
      const ver = this.checkJavaVersion(config.javaPath);
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
      const ver = this.checkJavaVersion(localRuntimeJava);
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
      const ver = this.checkJavaVersion(p);
      if (ver && ver >= 25) {
        onLog(`[Java] Located system Java ${ver}: ${p}`);
        return p;
      }
    }

    // 4. Check PATH 'java'
    const systemJavaVer = verificationMode === "full" && fs.existsSync(localRuntimeJava) ? null : this.checkJavaVersion("java");
    if (systemJavaVer && systemJavaVer >= 25) {
      onLog(`[Java] Using PATH Java ${systemJavaVer}`);
      return "java";
    }

    // 5. If not found on machine, download and provision OpenJDK 25 from Mojang runtime CDN
    onLog(`[Java] Java 25 not detected. Provisioning official OpenJDK 25 (java-runtime-epsilon)...`);
    const runtimeDest = path.join(gameDir, "runtime", "java-runtime-epsilon");
    fs.mkdirSync(runtimeDest, { recursive: true });

    try {
      const platformKey = process.platform === "win32" ? "windows-x64" : process.platform === "darwin" ? "mac-os" : "linux";
      const allRuntimes: any = await fetchJsonWithRetry("https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json");
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
      async function worker() {
        while (nextFile < entries.length) {
          const [relPath, fileInfo] = entries[nextFile++];
          const targetPath = path.join(runtimeDest, relPath);
          if (fileInfo.type === "directory") {
            fs.mkdirSync(targetPath, { recursive: true });
            completed++;
            continue;
          }

          if (fileInfo.type === "file" && fileInfo.downloads?.raw) {
            if (!fs.existsSync(path.dirname(targetPath))) {
              fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            }

            const raw = fileInfo.downloads.raw;
            const isValid = fs.existsSync(targetPath) &&
              (!raw.size || fs.statSync(targetPath).size === raw.size) &&
              (!raw.sha1 || await hashFile(targetPath, "sha1") === raw.sha1);
            if (!isValid) {
              await fs.promises.rm(targetPath, { force: true });
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
                fs.chmodSync(targetPath, 0o755);
              } catch {}
            }
          }

          completed++;
          if (completed % 100 === 0 || completed === total) {
            onLog(`[Java] Downloading OpenJDK 25: ${completed}/${total} files...`);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(8, entries.length) }, () => worker()));

      onLog(`[Java] OpenJDK 25 successfully installed in: ${runtimeDest}`);
      return localRuntimeJava;
    } catch (err: any) {
      onLog(`[Java Error] Automatic Java 25 download failed: ${err.message}`);
      throw new Error(`Minecraft 26.2 requires OpenJDK 25. Please install Java 25 or configure its path in settings.`);
    }
  }
}
