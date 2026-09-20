import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { ConfigManager } from "./config";
import {
  downloadVerified,
  fetchJsonWithRetry,
  hashFile,
} from "./file-transfer";
import { runBoundedPool } from "./async-pool";
import { TRANSFER_LIMITS, TransferLimitError } from "./transfer-limits";
import {
  assertSubordinateRoot,
  canonicalizeRelativePath,
  checkPhysicalAncestry,
  normalizePathKey,
  resolveAndContainPath,
  validateDigestString,
} from "./path-policy";

const MAX_JAVA_MANIFEST_ENTRIES = 100_000;
const MAX_JAVA_MANIFEST_PATH_BYTES = 4096;
// These caps describe one managed repair operation. They are checked while
// validating the complete upstream manifest, before the runtime directory is
// created or any destination is opened. A 2 GiB file cap keeps one transfer
// bounded; the 4 GiB aggregate cap covers the largest supported Java image.
const MAX_JAVA_RUNTIME_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_JAVA_RUNTIME_OPERATION_BYTES = 4 * 1024 * 1024 * 1024;

export interface ValidatedJavaRuntimeManifestEntry {
  relativePath: string;
  type: "file" | "directory";
  executable: boolean;
  downloads?: {
    raw: {
      url: string;
      sha1: string;
      size: number;
    };
  };
}

/**
 * Validates the complete Mojang runtime manifest before the managed runtime
 * directory is created or any file is downloaded. Every file has a bound
 * digest and size, and path collisions are rejected after canonicalization.
 */
export function validateJavaRuntimeManifest(
  manifest: unknown,
): ValidatedJavaRuntimeManifestEntry[] {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Java runtime manifest must be an object.");
  }
  const files = (manifest as Record<string, unknown>).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Java runtime manifest is missing a files object.");
  }

  const rawEntries = Object.entries(files as Record<string, unknown>);
  if (
    rawEntries.length === 0 ||
    rawEntries.length > MAX_JAVA_MANIFEST_ENTRIES
  ) {
    throw new Error(
      `Java runtime manifest has an invalid file count (${rawEntries.length}).`,
    );
  }

  const entries: ValidatedJavaRuntimeManifestEntry[] = [];
  const byPath = new Map<string, ValidatedJavaRuntimeManifestEntry>();
  let expectedRuntimeBytes = 0;
  for (const [rawPath, rawInfo] of rawEntries) {
    if (Buffer.byteLength(rawPath, "utf8") > MAX_JAVA_MANIFEST_PATH_BYTES) {
      throw new Error(
        `Java runtime manifest path exceeds ${MAX_JAVA_MANIFEST_PATH_BYTES} bytes.`,
      );
    }
    const relativePath = canonicalizeRelativePath(rawPath);
    const key = normalizePathKey(relativePath);
    if (byPath.has(key)) {
      throw new Error(
        `Java runtime manifest contains duplicate path '${relativePath}'.`,
      );
    }
    if (!rawInfo || typeof rawInfo !== "object" || Array.isArray(rawInfo)) {
      throw new Error(
        `Java runtime manifest entry '${relativePath}' is malformed.`,
      );
    }
    const info = rawInfo as Record<string, any>;
    if (info.type !== "file" && info.type !== "directory") {
      throw new Error(
        `Java runtime manifest entry '${relativePath}' has an invalid type.`,
      );
    }

    if (info.type === "directory") {
      const entry: ValidatedJavaRuntimeManifestEntry = {
        relativePath,
        type: "directory",
        executable: false,
      };
      entries.push(entry);
      byPath.set(key, entry);
      continue;
    }

    const raw = info.downloads?.raw;
    if (!raw || typeof raw !== "object") {
      throw new Error(
        `Java runtime file '${relativePath}' is missing its raw download metadata.`,
      );
    }
    if (typeof raw.url !== "string" || !raw.url.trim()) {
      throw new Error(
        `Java runtime file '${relativePath}' is missing its download URL.`,
      );
    }
    try {
      const parsedUrl = new URL(raw.url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("URL must use HTTP or HTTPS.");
      }
    } catch (error: any) {
      throw new Error(
        `Java runtime file '${relativePath}' has an invalid download URL: ${error.message}`,
      );
    }
    const sha1 = validateDigestString(raw.sha1, "sha1");
    if (!Number.isSafeInteger(raw.size) || raw.size < 0) {
      throw new Error(
        `Java runtime file '${relativePath}' has an invalid expected size.`,
      );
    }
    if (raw.size > MAX_JAVA_RUNTIME_FILE_BYTES) {
      throw new TransferLimitError(
        "Java runtime file",
        MAX_JAVA_RUNTIME_FILE_BYTES,
        raw.size,
      );
    }
    expectedRuntimeBytes += raw.size;
    if (expectedRuntimeBytes > MAX_JAVA_RUNTIME_OPERATION_BYTES) {
      throw new TransferLimitError(
        "Java runtime operation",
        MAX_JAVA_RUNTIME_OPERATION_BYTES,
        expectedRuntimeBytes,
      );
    }
    const entry: ValidatedJavaRuntimeManifestEntry = {
      relativePath,
      type: "file",
      executable: info.executable === true,
      downloads: { raw: { url: raw.url.trim(), sha1, size: raw.size } },
    };
    entries.push(entry);
    byPath.set(key, entry);
  }

  // A file cannot also be an ancestor of another manifest destination. A
  // directory ancestor is expected and may be omitted from the manifest.
  for (const entry of entries) {
    const segments = entry.relativePath.split("/");
    let ancestor = "";
    for (let i = 0; i < segments.length - 1; i++) {
      ancestor = ancestor ? `${ancestor}/${segments[i]}` : segments[i];
      const parent = byPath.get(normalizePathKey(ancestor));
      if (parent?.type === "file") {
        throw new Error(
          `Java runtime manifest file '${parent.relativePath}' collides with descendant '${entry.relativePath}'.`,
        );
      }
    }
  }

  return entries;
}

async function fetchVerifiedJavaRuntimeManifest(
  manifestReference: unknown,
  runtimeRoot: string,
): Promise<unknown> {
  if (!manifestReference || typeof manifestReference !== "object") {
    throw new Error("Java runtime metadata is missing its manifest reference.");
  }
  const reference = manifestReference as Record<string, unknown>;
  if (typeof reference.url !== "string" || !reference.url.trim()) {
    throw new Error("Java runtime manifest reference is missing a URL.");
  }
  let manifestUrl: URL;
  try {
    manifestUrl = new URL(reference.url);
  } catch {
    throw new Error("Java runtime manifest reference has an invalid URL.");
  }
  if (manifestUrl.protocol !== "https:") {
    throw new Error("Java runtime manifest reference must use HTTPS.");
  }
  const expectedSha1 = validateDigestString(reference.sha1 as string, "sha1");
  if (!Number.isSafeInteger(reference.size) || (reference.size as number) < 0) {
    throw new Error(
      "Java runtime manifest reference has an invalid expected size.",
    );
  }
  if ((reference.size as number) > TRANSFER_LIMITS.jsonBytes) {
    throw new TransferLimitError(
      "Java runtime manifest",
      TRANSFER_LIMITS.jsonBytes,
      reference.size as number,
    );
  }

  await fs.promises.mkdir(runtimeRoot, { recursive: true });
  await checkPhysicalAncestry(path.dirname(runtimeRoot), runtimeRoot, {
    disallowSymlinks: true,
  });
  const stagingDir = path.join(
    runtimeRoot,
    `.manifest-staging.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
  );
  await checkPhysicalAncestry(runtimeRoot, stagingDir, {
    disallowSymlinks: true,
  });
  let ownsStagingDir = false;
  try {
    await fs.promises.mkdir(stagingDir);
    ownsStagingDir = true;
    await checkPhysicalAncestry(runtimeRoot, stagingDir, {
      disallowSymlinks: true,
    });
    const stagedManifest = path.join(stagingDir, "manifest.json");
    await downloadVerified(manifestUrl.href, stagedManifest, {
      algorithm: "sha1",
      expectedHash: expectedSha1,
      expectedSize: reference.size as number,
      maxBytes: TRANSFER_LIMITS.jsonBytes,
      transport: "public-metadata",
      headers: { "User-Agent": "Lampas-Launcher/1.0" },
      timeoutMs: 60_000,
    });
    const stat = await fs.promises.stat(stagedManifest);
    if (stat.size > TRANSFER_LIMITS.jsonBytes) {
      throw new TransferLimitError(
        "Java runtime manifest",
        TRANSFER_LIMITS.jsonBytes,
        stat.size,
      );
    }
    return JSON.parse(await fs.promises.readFile(stagedManifest, "utf-8"));
  } finally {
    if (ownsStagingDir) {
      await fs.promises
        .rm(stagingDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
}

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
          },
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
    verificationMode: "fast" | "full" = "fast",
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
      process.platform === "win32" ? "javaw.exe" : "java",
    );
    if (fs.existsSync(localRuntimeJava)) {
      if (verificationMode === "fast") {
        const ver = await this.checkJavaVersion(localRuntimeJava);
        if (ver && ver >= 25) {
          onLog(`[Java] Found local Java ${ver}: ${localRuntimeJava}`);
          return localRuntimeJava;
        }
      } else {
        // A managed executable is untrusted until the runtime manifest has
        // repaired and re-hashed it. Do not execute it during full repair.
        onLog(
          `[Java] Preparing full verification of managed Java: ${localRuntimeJava}`,
        );
      }
    }

    // 3. Search common system locations for Java 25 / OpenJDK 25 unless repairing a managed runtime.
    const searchPaths: string[] = [];

    if (process.env.JAVA_HOME) {
      searchPaths.push(
        path.join(
          process.env.JAVA_HOME,
          "bin",
          process.platform === "win32" ? "javaw.exe" : "java",
        ),
      );
    }

    if (process.platform === "win32") {
      searchPaths.push(
        path.join(
          process.env.LOCALAPPDATA || "",
          "Programs",
          "Eclipse Adoptium",
          "jdk-25",
          "bin",
          "javaw.exe",
        ),
        "C:\\Program Files\\Microsoft\\jdk-25\\bin\\javaw.exe",
        "C:\\Program Files\\Eclipse Adoptium\\jdk-25\\bin\\javaw.exe",
        "C:\\Program Files\\Java\\jdk-25\\bin\\javaw.exe",
      );
    } else {
      searchPaths.push(
        "/usr/lib/jvm/java-25-openjdk/bin/java",
        "/usr/lib/jvm/java-25/bin/java",
        "/opt/jdk-25/bin/java",
      );
    }

    for (const p of verificationMode === "full" &&
    fs.existsSync(localRuntimeJava)
      ? []
      : searchPaths) {
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
    onLog(
      `[Java] Java 25 not detected. Provisioning official OpenJDK 25 (java-runtime-epsilon)...`,
    );
    const runtimeDest = path.join(gameDir, "runtime", "java-runtime-epsilon");
    assertSubordinateRoot(gameDir, path.join(gameDir, "runtime"));
    assertSubordinateRoot(gameDir, runtimeDest);

    try {
      const platformKey =
        process.platform === "win32"
          ? "windows-x64"
          : process.platform === "darwin"
            ? "mac-os"
            : "linux";
      const allRuntimes: any = await fetchJsonWithRetry(
        "https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json",
      );
      const epsilonEntries = allRuntimes[platformKey]?.["java-runtime-epsilon"];

      if (!epsilonEntries || epsilonEntries.length === 0) {
        throw new Error(
          `Java 25 (java-runtime-epsilon) not available for platform ${platformKey}`,
        );
      }

      const manifestReference = epsilonEntries[0].manifest;
      const manifest: any = await fetchVerifiedJavaRuntimeManifest(
        manifestReference,
        path.join(gameDir, "runtime"),
      );
      const entries = validateJavaRuntimeManifest(manifest);

      // Resolve and inspect every destination before creating the runtime
      // directory. This prevents a malformed entry discovered late in the
      // manifest from leaving a partially provisioned managed tree.
      for (const entry of entries) {
        const targetPath = resolveAndContainPath(
          runtimeDest,
          entry.relativePath,
        );
        await checkPhysicalAncestry(runtimeDest, targetPath, {
          disallowSymlinks: true,
        });
      }
      await fs.promises.mkdir(runtimeDest, { recursive: true });
      await checkPhysicalAncestry(runtimeDest, runtimeDest, {
        disallowSymlinks: true,
      });

      let completed = 0;
      const total = entries.length;
      const concurrency = 6;

      await runBoundedPool(
        entries,
        async (entry, _index, signal) => {
          const targetPath = resolveAndContainPath(
            runtimeDest,
            entry.relativePath,
          );
          await checkPhysicalAncestry(runtimeDest, targetPath, {
            disallowSymlinks: true,
          });

          if (entry.type === "directory") {
            await fs.promises.mkdir(targetPath, { recursive: true });
            await checkPhysicalAncestry(runtimeDest, targetPath, {
              disallowSymlinks: true,
            });
          } else {
            const raw = entry.downloads!.raw;
            await fs.promises.mkdir(path.dirname(targetPath), {
              recursive: true,
            });
            await checkPhysicalAncestry(runtimeDest, targetPath, {
              disallowSymlinks: true,
            });

            let isValid = false;
            if (fs.existsSync(targetPath)) {
              try {
                const stat = await fs.promises.lstat(targetPath);
                if (
                  stat.isFile() &&
                  stat.nlink === 1 &&
                  stat.size === raw.size
                ) {
                  isValid = (await hashFile(targetPath, "sha1")) === raw.sha1;
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
                maxBytes: MAX_JAVA_RUNTIME_FILE_BYTES,
                headers: { "User-Agent": "Lampas-Launcher/1.0" },
                timeoutMs: 60_000,
                signal,
              });
            }

            await checkPhysicalAncestry(runtimeDest, targetPath, {
              disallowSymlinks: true,
            });
            if (entry.executable) {
              try {
                await fs.promises.chmod(targetPath, 0o755);
              } catch {}
            }
          }

          completed++;
          if (completed % 100 === 0 || completed === total) {
            onLog(
              `[Java] Downloading OpenJDK 25: ${completed}/${total} files...`,
            );
          }
          return entry.relativePath;
        },
        { concurrency },
      );

      const executableCandidates =
        process.platform === "win32"
          ? ["bin/java.exe", "bin/javaw.exe"]
          : ["bin/java"];
      const executableEntry = executableCandidates
        .map((candidate) =>
          entries.find(
            (entry) =>
              entry.relativePath.toLowerCase() === candidate.toLowerCase(),
          ),
        )
        .find((entry): entry is ValidatedJavaRuntimeManifestEntry =>
          Boolean(entry),
        );
      if (!executableEntry?.downloads) {
        throw new Error(
          "Java runtime manifest does not contain a hashed managed executable.",
        );
      }

      const executablePath = resolveAndContainPath(
        runtimeDest,
        executableEntry.relativePath,
      );
      await checkPhysicalAncestry(runtimeDest, executablePath, {
        disallowSymlinks: true,
      });
      const executableStat = await fs.promises.lstat(executablePath);
      if (
        !executableStat.isFile() ||
        executableStat.nlink !== 1 ||
        executableStat.size !== executableEntry.downloads.raw.size
      ) {
        throw new Error(
          `Provisioned Java executable '${executablePath}' failed regular-file verification.`,
        );
      }
      const executableHash = await hashFile(executablePath, "sha1");
      if (executableHash !== executableEntry.downloads.raw.sha1) {
        throw new Error(
          `Provisioned Java executable '${executablePath}' failed SHA-1 verification.`,
        );
      }

      // Validate the provisioned executable only after its exact manifest bytes
      // have been checked. The configured/system Java paths above remain an
      // explicit trusted user choice.
      this.clearProbeCache();
      const provisionedVer = await this.checkJavaVersion(localRuntimeJava);
      if (!provisionedVer || provisionedVer < 25) {
        throw new Error(
          `Provisioned Java at '${localRuntimeJava}' failed verification (detected: ${provisionedVer ?? "none"}).`,
        );
      }

      onLog(
        `[Java] OpenJDK 25 successfully installed and verified (${provisionedVer}) in: ${runtimeDest}`,
      );
      return localRuntimeJava;
    } catch (err: any) {
      onLog(`[Java Error] Automatic Java 25 download failed: ${err.message}`);
      throw new Error(
        `Minecraft 26.2 requires OpenJDK 25. Please install Java 25 or configure its path in settings.`,
      );
    }
  }
}
