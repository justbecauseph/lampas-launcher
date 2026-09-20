import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Unzip, UnzipInflate } from "fflate";
import {
  copyAtomic,
  downloadVerified,
  hashFile,
  writeAtomicFile,
} from "./file-transfer";
import { runBoundedPool } from "./async-pool";
import { TRANSFER_LIMITS, TransferLimitError } from "./transfer-limits";
import {
  assertSubordinateRoot,
  checkPhysicalAncestrySync,
  PathContainmentError,
  resolveAndContainPath,
  validateDigestString,
} from "./path-policy";
import {
  FabricMetaResolver,
  type FabricMetaResolverOptions,
  parseMavenCoordinate,
  mavenToPath,
  type ParsedMavenCoordinate,
} from "./fabric-meta";
import { validateRuntimeDefinition } from "./runtime-definition";
import type { MinecraftRuntimeDefinition } from "./types";
import versionMeta262 from "./version-meta-26.2.json";

export { parseMavenCoordinate, mavenToPath, type ParsedMavenCoordinate };

export interface MavenCoordinate {
  name: string;
  url?: string;
  sha1?: string;
  rules?: Array<{ action: "allow" | "disallow"; os?: { name: string } }>;
  downloads?: {
    artifact?: {
      sha1: string;
      size: number;
      url: string;
      path?: string;
    };
    classifiers?: Record<
      string,
      { sha1: string; size: number; url: string; path?: string }
    >;
  };
}

function isLibraryAllowed(lib: MavenCoordinate): boolean {
  if (!lib.rules || lib.rules.length === 0) return true;

  const currentOs =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "osx"
        : "linux";
  let allowed = false;

  for (const rule of lib.rules) {
    if (rule.action === "allow") {
      if (!rule.os || rule.os.name === currentOs) {
        allowed = true;
      }
    } else if (rule.action === "disallow") {
      if (rule.os && rule.os.name === currentOs) {
        allowed = false;
      }
    }
  }

  return allowed;
}

export interface PrepareGameEnvironmentOptions {
  fabricMetaOptions?: FabricMetaResolverOptions;
}

const MAX_NATIVE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_NATIVE_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_NATIVE_ENTRY_COUNT = 4096;
const MAX_NATIVE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_EXPANDED_BYTES = 128 * 1024 * 1024;
// fflate may inflate a complete compressed input chunk before invoking
// ondata. Keep each feed small enough that a worst-case deflate ratio (about
// 1032:1) stays near 1 MiB of transient output, while the per-entry and
// aggregate output caps below remain authoritative.
const MAX_NATIVE_COMPRESSED_FEED_BYTES = 1024;
const MAX_ASSET_OBJECT_COUNT = 100_000;
const MAX_ASSET_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ASSET_OPERATION_BYTES = 32 * 1024 * 1024 * 1024;

interface NativeExtractionBudget {
  archiveBytes: number;
  entryCount: number;
  declaredExpandedBytes: number;
  expandedBytes: number;
}

interface NativeReceipt {
  version: string;
  platform: string;
  arch: string;
  files: string[];
  fileHashes: Record<string, string>;
}

function nativeOutputName(
  entryName: string,
): { name: string; key: string } | null {
  const normalized = entryName.replace(/\\/g, "/");
  const name = path.posix.basename(normalized);
  const lower = name.toLowerCase();
  if (
    !name ||
    (!lower.endsWith(".dll") &&
      !lower.endsWith(".so") &&
      !lower.endsWith(".dylib") &&
      !lower.endsWith(".jnilib"))
  ) {
    return null;
  }
  return { name, key: lower };
}

async function extractNativeArchiveBounded(
  archivePath: string,
  budget: NativeExtractionBudget,
): Promise<Map<string, { name: string; bytes: Uint8Array }>> {
  const archiveStat = await fs.promises.lstat(archivePath);
  if (!archiveStat.isFile()) {
    throw new Error(
      `Native archive '${path.basename(archivePath)}' is not a regular file.`,
    );
  }
  if (archiveStat.nlink > 1) {
    throw new Error(
      `Native archive '${path.basename(archivePath)}' is not an exclusively owned file.`,
    );
  }
  if (archiveStat.size > MAX_NATIVE_ARCHIVE_BYTES) {
    throw new Error(
      `Native archive '${path.basename(archivePath)}' exceeds the ${MAX_NATIVE_ARCHIVE_BYTES} byte archive limit.`,
    );
  }
  budget.archiveBytes += archiveStat.size;
  if (budget.archiveBytes > MAX_NATIVE_ARCHIVE_TOTAL_BYTES) {
    throw new Error(
      `Native archive operation exceeds the ${MAX_NATIVE_ARCHIVE_TOTAL_BYTES} byte archive budget.`,
    );
  }

  const outputs = new Map<string, { name: string; bytes: Uint8Array }>();
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  let streamError: Error | null = null;
  let foundEntries = false;

  unzipper.onfile = (file) => {
    if (streamError) {
      file.terminate();
      return;
    }

    foundEntries = true;
    budget.entryCount++;
    if (budget.entryCount > MAX_NATIVE_ENTRY_COUNT) {
      streamError = new Error(
        `Native archive exceeds the ${MAX_NATIVE_ENTRY_COUNT} entry limit.`,
      );
      file.terminate();
      return;
    }

    const native = nativeOutputName(file.name);
    if (native && outputs.has(native.key)) {
      streamError = new Error(
        `Native archive contains duplicate output basename '${native.name}'.`,
      );
      file.terminate();
      return;
    }

    const declaredSize = file.originalSize;
    if (declaredSize !== undefined) {
      if (
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 0 ||
        declaredSize > MAX_NATIVE_ENTRY_BYTES
      ) {
        streamError = new Error(
          `Native archive entry '${file.name}' exceeds the ${MAX_NATIVE_ENTRY_BYTES} byte entry limit.`,
        );
        file.terminate();
        return;
      }
      budget.declaredExpandedBytes += declaredSize;
      if (budget.declaredExpandedBytes > MAX_NATIVE_EXPANDED_BYTES) {
        streamError = new Error(
          `Native archive operation exceeds the ${MAX_NATIVE_EXPANDED_BYTES} byte expansion budget.`,
        );
        file.terminate();
        return;
      }
    }

    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (err, data, final) => {
      if (err) {
        streamError = new Error(
          `Failed to decompress native archive entry '${file.name}': ${err.message}`,
        );
        file.terminate();
        return;
      }

      entryBytes += data.byteLength;
      budget.expandedBytes += data.byteLength;
      if (
        entryBytes > MAX_NATIVE_ENTRY_BYTES ||
        budget.expandedBytes > MAX_NATIVE_EXPANDED_BYTES
      ) {
        streamError = new Error(
          `Native archive expansion exceeds configured limits at entry '${file.name}'.`,
        );
        file.terminate();
        return;
      }
      if (native && data.byteLength > 0) {
        chunks.push(new Uint8Array(data));
      }
      if (final && native) {
        outputs.set(native.key, {
          name: native.name,
          bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        });
      }
    };

    file.start();
  };

  const input = fs.createReadStream(archivePath, {
    highWaterMark: MAX_NATIVE_COMPRESSED_FEED_BYTES,
  });
  try {
    for await (const chunk of input) {
      if (streamError) throw streamError;
      // Keep this split even when the stream honours highWaterMark: custom
      // Readable implementations and future refactors may yield larger
      // chunks, and fflate's pre-callback allocation is input-chunk sized.
      const bytes = new Uint8Array(chunk as Buffer);
      for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += MAX_NATIVE_COMPRESSED_FEED_BYTES
      ) {
        const end = Math.min(
          offset + MAX_NATIVE_COMPRESSED_FEED_BYTES,
          bytes.byteLength,
        );
        unzipper.push(bytes.subarray(offset, end));
        if (streamError) throw streamError;
      }
    }
    unzipper.push(new Uint8Array(), true);
    if (streamError) throw streamError;
    if (!foundEntries) {
      throw new Error(
        `Failed to decompress native archive '${path.basename(archivePath)}': no valid ZIP entries.`,
      );
    }
  } catch (err: any) {
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    input.destroy();
  }

  return outputs;
}

function readNativeReceipt(
  receiptPath: string,
  minecraftVersion: string,
): NativeReceipt | null {
  try {
    const stat = fs.lstatSync(receiptPath);
    if (
      !stat.isFile() ||
      stat.nlink > 1 ||
      stat.size > TRANSFER_LIMITS.jsonBytes
    )
      return null;
    const raw = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as Record<
      string,
      unknown
    >;
    if (
      raw.version !== minecraftVersion ||
      raw.platform !== process.platform ||
      raw.arch !== process.arch ||
      !Array.isArray(raw.files) ||
      !raw.fileHashes ||
      typeof raw.fileHashes !== "object"
    ) {
      return null;
    }

    const files: string[] = [];
    const fileHashes: Record<string, string> = {};
    const seen = new Set<string>();
    for (const value of raw.files) {
      if (typeof value !== "string") return null;
      const native = nativeOutputName(value);
      if (!native || native.name !== value || seen.has(native.key)) return null;
      const hash = (raw.fileHashes as Record<string, unknown>)[value];
      if (typeof hash !== "string") return null;
      fileHashes[value] = validateDigestString(hash, "sha256");
      seen.add(native.key);
      files.push(value);
    }
    return {
      version: minecraftVersion,
      platform: process.platform,
      arch: process.arch,
      files,
      fileHashes,
    };
  } catch {
    return null;
  }
}

function nativeReceiptFilesPresent(
  nativesDir: string,
  receipt: NativeReceipt,
): boolean {
  try {
    for (const filename of receipt.files) {
      const target = resolveAndContainPath(nativesDir, filename);
      checkPhysicalAncestrySync(nativesDir, target, { disallowSymlinks: true });
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.nlink > 1) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyNativeReceipt(
  nativesDir: string,
  receipt: NativeReceipt,
): Promise<boolean> {
  for (const filename of receipt.files) {
    const target = resolveAndContainPath(nativesDir, filename);
    checkPhysicalAncestrySync(nativesDir, target, { disallowSymlinks: true });
    try {
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile() || stat.nlink > 1) return false;
      const actual = await hashFile(target, "sha256");
      if (actual !== receipt.fileHashes[filename]) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function removeOwnedStaleNatives(
  nativesDir: string,
  previousReceipt: NativeReceipt | null,
  currentFiles: Set<string>,
): Promise<void> {
  if (!previousReceipt) return;
  const currentKeys = new Set(
    Array.from(currentFiles)
      .map((filename) => nativeOutputName(filename)?.key)
      .filter((key): key is string => Boolean(key)),
  );
  for (const filename of previousReceipt.files) {
    const previousKey = nativeOutputName(filename)?.key;
    if (previousKey && currentKeys.has(previousKey)) continue;
    const expectedHash = previousReceipt.fileHashes[filename];
    if (!expectedHash) continue;
    const target = resolveAndContainPath(nativesDir, filename);
    checkPhysicalAncestrySync(nativesDir, target, { disallowSymlinks: true });
    try {
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile() || stat.nlink > 1) continue;
      if ((await hashFile(target, "sha256")) !== expectedHash) continue;
      await fs.promises.unlink(target);
    } catch {
      // Preserve uncertain or concurrently changed files.
    }
  }
}

export class MinecraftBootstrap {
  private static async ensureFile(
    url: string,
    destPath: string,
    expectedHash: string | undefined,
    expectedSize: number | undefined,
    verificationMode: "fast" | "full",
    algorithm: "sha1" | "sha256" = "sha1",
    baseDir: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!baseDir) {
      throw new PathContainmentError(
        "Managed artifact destination requires an approved base directory.",
      );
    }
    // Validate the destination before any existence probe or directory creation. The
    // caller must provide the approved root for every managed artifact.
    checkPhysicalAncestrySync(path.dirname(path.resolve(baseDir)), baseDir, {
      disallowSymlinks: true,
    });
    checkPhysicalAncestrySync(baseDir, destPath, { disallowSymlinks: true });
    if (!expectedHash) {
      throw new Error(
        `Managed artifact '${path.basename(destPath)}' is missing an expected ${algorithm.toUpperCase()} digest.`,
      );
    }
    const normalizedHash = validateDigestString(expectedHash, algorithm);
    if (
      expectedSize !== undefined &&
      (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
    ) {
      throw new Error(
        `Managed artifact '${path.basename(destPath)}' has an invalid expected size.`,
      );
    }
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    // A nested Maven/index component may have appeared while the parent was created;
    // validate the physical ancestry again immediately before the atomic download.
    checkPhysicalAncestrySync(baseDir, destPath, { disallowSymlinks: true });
    if (fs.existsSync(destPath)) {
      try {
        const stat = await fs.promises.stat(destPath);
        const sizeMatches =
          expectedSize === undefined || stat.size === expectedSize;
        if (sizeMatches) {
          // A fast size shortcut is only eligible when the upstream contract
          // supplied that size. Fabric sidecars currently provide a digest but
          // no size, so those cached bytes still require a digest check.
          if (verificationMode === "fast" && expectedSize !== undefined) {
            return false;
          }
          if (normalizedHash) {
            const actualHash = await hashFile(destPath, algorithm);
            if (actualHash.toLowerCase() === normalizedHash) {
              return false;
            }
          }
        }
      } catch {}
    }

    // Do NOT pre-delete destPath: downloadVerified writes to staging sibling and atomically replaces
    await downloadVerified(url, destPath, {
      algorithm,
      expectedHash: normalizedHash,
      expectedSize,
      headers: { "User-Agent": "Lampas-Launcher/1.0" },
      signal,
    });
    return true;
  }

  static async prepareGameEnvironment(
    gameDir: string,
    runtimeInput: MinecraftRuntimeDefinition,
    onLog: (msg: string) => void,
    verificationMode: "fast" | "full" = "fast",
    options?: PrepareGameEnvironmentOptions,
  ): Promise<{ classpath: string[]; mainClass: string; assetIndex: string }> {
    const runtime = validateRuntimeDefinition(runtimeInput);

    // Enforce Minecraft scope boundary (26.2 bounded)
    if (runtime.minecraft !== "26.2") {
      throw new Error(
        `Unsupported Minecraft version '${runtime.minecraft}'. Lampas Launcher currently only supports Minecraft 26.2.`,
      );
    }

    const librariesDir = path.join(gameDir, "libraries");
    const assetsDir = path.join(gameDir, "assets");
    const nativesDir = path.join(gameDir, "natives");
    const versionsDir = path.join(gameDir, "versions", runtime.minecraft);
    const cacheDir = path.join(gameDir, ".lampas", "cache");

    assertSubordinateRoot(gameDir, librariesDir);
    assertSubordinateRoot(gameDir, assetsDir);
    assertSubordinateRoot(gameDir, nativesDir);
    assertSubordinateRoot(gameDir, versionsDir);
    assertSubordinateRoot(gameDir, cacheDir);

    await fs.promises.mkdir(librariesDir, { recursive: true });
    await fs.promises.mkdir(assetsDir, { recursive: true });
    await fs.promises.mkdir(nativesDir, { recursive: true });
    await fs.promises.mkdir(versionsDir, { recursive: true });

    onLog(
      `[Bootstrap] Resolving Minecraft ${runtime.minecraft} environment (Fabric Loader ${runtime.loader.version})...`,
    );

    // 1. Download Minecraft 26.2 Client JAR
    const clientJar = versionMeta262.mainJar.downloads.artifact;
    const clientJarPath = path.join(
      versionsDir,
      `${runtime.minecraft}-client.jar`,
    );
    onLog(`[Bootstrap] Verifying Minecraft ${runtime.minecraft} client JAR...`);
    await this.ensureFile(
      clientJar.url,
      clientJarPath,
      clientJar.sha1,
      clientJar.size,
      verificationMode,
      "sha1",
      versionsDir,
    );

    const classpath: string[] = [clientJarPath];

    // 2. Dynamically resolve Fabric Loader, Intermediary, and runtime libraries from Fabric Meta
    onLog(
      `[Bootstrap] Resolving Fabric Loader ${runtime.loader.version} runtime metadata...`,
    );
    const fabricMeta = await FabricMetaResolver.resolveFabricRuntime(
      runtime,
      cacheDir,
      options?.fabricMetaOptions,
    );

    onLog(
      `[Bootstrap] Verifying ${fabricMeta.libraries.length} Fabric Loader and support libraries...`,
    );
    // Populate fabricPaths[index] strictly preserving Maven classpath order
    const fabricPaths = await runBoundedPool(
      fabricMeta.libraries,
      async (lib, _index, signal) => {
        const coord = parseMavenCoordinate(lib.name);
        const relPath = mavenToPath(coord);
        const destPath = path.join(librariesDir, relPath);
        const repoUrl = lib.url || "https://maven.fabricmc.net/";
        const downloadUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;
        const hash = lib.sha256 || lib.sha1;
        const algorithm: "sha256" | "sha1" = lib.sha256 ? "sha256" : "sha1";

        await this.ensureFile(
          downloadUrl,
          destPath,
          hash,
          undefined,
          verificationMode,
          algorithm,
          librariesDir,
          signal,
        );
        return destPath;
      },
      { concurrency: 6 },
    );
    classpath.push(...fabricPaths);

    // 3. Download Mojang & LWJGL Libraries (Fastutil, Gson, Guava, Log4j, LWJGL, etc.)
    const allLibs = (versionMeta262.libraries || []) as MavenCoordinate[];
    const allowedLibs = allLibs.filter(isLibraryAllowed);
    onLog(
      `[Bootstrap] Verifying ${allowedLibs.length} core game libraries (Mojang & LWJGL)...`,
    );

    const nativeArchives: Array<{ path: string; changed: boolean }> = [];
    const libraryResults = await runBoundedPool(
      allowedLibs,
      async (lib, _index, signal) => {
        const coord = parseMavenCoordinate(lib.name);
        const relPath = mavenToPath(coord);
        const destPath = path.join(librariesDir, relPath);

        let downloadUrl = lib.downloads?.artifact?.url;
        const expectedSha1 = lib.downloads?.artifact?.sha1;

        if (!downloadUrl) {
          const repoUrl = lib.url || "https://libraries.minecraft.net/";
          downloadUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;
        }

        const changed = await MinecraftBootstrap.ensureFile(
          downloadUrl,
          destPath,
          expectedSha1,
          lib.downloads?.artifact?.size,
          verificationMode,
          "sha1",
          librariesDir,
          signal,
        );

        // Extract platform natives if this library is a native bundle
        let nativeArchive: { path: string; changed: boolean } | null = null;
        if (
          coord.classifier?.includes("natives") ||
          coord.artifact.includes("natives") ||
          lib.name.includes("natives")
        ) {
          nativeArchive = { path: destPath, changed };
        }
        return { path: destPath, nativeArchive };
      },
      { concurrency: 6 },
    );
    const libraryPaths = libraryResults.map((result) => {
      if (result.nativeArchive) nativeArchives.push(result.nativeArchive);
      return result.path;
    });
    classpath.push(...libraryPaths);

    // Native Extraction Engine with deterministic staging and receipt validation
    await this.ensureNatives(
      gameDir,
      runtime.minecraft,
      nativeArchives,
      onLog,
      verificationMode,
    );

    // 4. Download Asset Index & Ensure Asset Objects (Textures, Sounds, Panorama)
    const assetIndex = versionMeta262.assetIndex;
    await this.ensureAssets(assetsDir, assetIndex, onLog, verificationMode);

    return {
      classpath,
      mainClass: fabricMeta.mainClass,
      assetIndex: assetIndex.id,
    };
  }

  static async ensureNatives(
    gameDir: string,
    minecraftVersion: string,
    nativeArchives: Array<{ path: string; changed: boolean }>,
    onLog: (msg: string) => void,
    verificationMode: "fast" | "full" = "fast",
  ): Promise<void> {
    const nativesDir = path.join(gameDir, "natives");
    const markerDir = path.join(gameDir, ".lampas");

    assertSubordinateRoot(gameDir, nativesDir);
    assertSubordinateRoot(gameDir, markerDir);

    const nativeMarker = path.join(
      markerDir,
      `natives-${minecraftVersion}-${process.platform}-${process.arch}.json`,
    );
    const legacyMarker = path.join(
      markerDir,
      `natives-${minecraftVersion}-${process.platform}.complete`,
    );
    // Marker existence is itself a trust decision in fast mode. Validate the
    // parent and leaf before using either marker as an extraction receipt.
    checkPhysicalAncestrySync(gameDir, markerDir, { disallowSymlinks: true });
    checkPhysicalAncestrySync(markerDir, nativeMarker, {
      disallowSymlinks: true,
    });
    checkPhysicalAncestrySync(markerDir, legacyMarker, {
      disallowSymlinks: true,
    });
    const previousReceipt = readNativeReceipt(nativeMarker, minecraftVersion);

    let needsNativeExtraction = false;
    if (
      verificationMode === "full" ||
      nativeArchives.some((archive) => archive.changed)
    ) {
      needsNativeExtraction = true;
    } else if (!fs.existsSync(nativeMarker) && !fs.existsSync(legacyMarker)) {
      needsNativeExtraction = true;
    } else {
      try {
        const existingNatives = await fs.promises.readdir(nativesDir);
        if (existingNatives.length === 0) {
          needsNativeExtraction = true;
        }
      } catch {
        needsNativeExtraction = true;
      }
      if (
        !previousReceipt ||
        !nativeReceiptFilesPresent(nativesDir, previousReceipt)
      ) {
        needsNativeExtraction = true;
      }
    }

    if (verificationMode === "full" && nativeArchives.length === 0) {
      if (
        previousReceipt &&
        !(await verifyNativeReceipt(nativesDir, previousReceipt))
      ) {
        throw new Error(
          "Managed native receipt verification failed; run repair to reprovision native libraries.",
        );
      }
      if (!previousReceipt) {
        const existingNatives = await fs.promises
          .readdir(nativesDir)
          .catch(() => [] as string[]);
        if (existingNatives.length > 0) {
          throw new Error(
            "Managed native outputs have no trusted receipt; run repair with native archives available.",
          );
        }
      }
      return;
    }

    if (needsNativeExtraction && nativeArchives.length === 0) {
      const hasMarkers =
        fs.existsSync(nativeMarker) || fs.existsSync(legacyMarker);
      const existingNatives = await fs.promises
        .readdir(nativesDir)
        .catch(() => [] as string[]);
      if (hasMarkers || existingNatives.length > 0) {
        throw new Error(
          "Managed native outputs require native archives for repair.",
        );
      }
    }

    if (needsNativeExtraction && nativeArchives.length > 0) {
      onLog(
        `[Bootstrap] Extracting native libraries (${process.platform}-${process.arch})...`,
      );

      const sortedArchives = [...nativeArchives].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      const stagingDir = path.join(
        nativesDir +
          `.staging.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
      );
      checkPhysicalAncestrySync(gameDir, stagingDir, {
        disallowSymlinks: true,
      });
      let ownsStagingDir = false;
      try {
        // Claim the staging directory exclusively. Recursive mkdir would accept a
        // squatted directory and later allow cleanup to remove its contents.
        await fs.promises.mkdir(stagingDir);
        ownsStagingDir = true;
        checkPhysicalAncestrySync(gameDir, stagingDir, {
          disallowSymlinks: true,
        });
        const extractionBudget: NativeExtractionBudget = {
          archiveBytes: 0,
          entryCount: 0,
          declaredExpandedBytes: 0,
          expandedBytes: 0,
        };
        const extractedNativeBytes = new Map<
          string,
          { name: string; bytes: Uint8Array }
        >();

        for (const archive of sortedArchives) {
          const archiveStat = await fs.promises.lstat(archive.path);
          if (!archiveStat.isFile() || archiveStat.nlink > 1) {
            throw new Error(
              `Native archive '${path.basename(archive.path)}' is not an exclusively owned file.`,
            );
          }
          const archiveOutputs = await extractNativeArchiveBounded(
            archive.path,
            extractionBudget,
          );
          for (const [key, output] of Array.from(archiveOutputs.entries()).sort(
            ([a], [b]) => a.localeCompare(b),
          )) {
            if (extractedNativeBytes.has(key)) {
              throw new Error(
                `Native archives contain duplicate output basename '${key}'.`,
              );
            }
            extractedNativeBytes.set(key, output);
          }
        }

        if (extractedNativeBytes.size === 0) {
          throw new Error(
            `Native archives did not yield any native libraries (.dll/.so/.dylib) for ${process.platform}-${process.arch}`,
          );
        }

        const extractedFiles: string[] = [];
        for (const [key, output] of Array.from(
          extractedNativeBytes.entries(),
        ).sort(([a], [b]) => a.localeCompare(b))) {
          const filename = output.name;
          const dest = resolveAndContainPath(stagingDir, filename);
          checkPhysicalAncestrySync(stagingDir, dest, {
            disallowSymlinks: true,
          });
          await fs.promises.writeFile(dest, Buffer.from(output.bytes), {
            flag: "wx",
          });
          extractedFiles.push(filename);
        }

        await fs.promises.mkdir(nativesDir, { recursive: true });
        for (const filename of extractedFiles) {
          const src = path.join(stagingDir, filename);
          const dst = resolveAndContainPath(nativesDir, filename);
          checkPhysicalAncestrySync(nativesDir, dst, {
            disallowSymlinks: true,
          });

          await copyAtomic(src, dst);
        }

        await removeOwnedStaleNatives(
          nativesDir,
          previousReceipt,
          new Set(extractedFiles),
        );

        await fs.promises.rm(stagingDir, { recursive: true, force: true });
        ownsStagingDir = false;

        checkPhysicalAncestrySync(gameDir, markerDir, {
          disallowSymlinks: true,
        });
        await fs.promises.mkdir(markerDir, { recursive: true });
        const fileHashes: Record<string, string> = {};
        for (const output of extractedNativeBytes.values()) {
          fileHashes[output.name] = createHash("sha256")
            .update(output.bytes)
            .digest("hex");
        }
        const receipt = {
          version: minecraftVersion,
          platform: process.platform,
          arch: process.arch,
          extractedAt: new Date().toISOString(),
          archives: sortedArchives.map((a) => path.basename(a.path)),
          files: extractedFiles,
          fileHashes,
        };
        checkPhysicalAncestrySync(gameDir, markerDir, {
          disallowSymlinks: true,
        });
        checkPhysicalAncestrySync(markerDir, nativeMarker, {
          disallowSymlinks: true,
        });
        checkPhysicalAncestrySync(markerDir, legacyMarker, {
          disallowSymlinks: true,
        });
        await writeAtomicFile(nativeMarker, JSON.stringify(receipt, null, 2), {
          encoding: "utf-8",
        });
        checkPhysicalAncestrySync(markerDir, legacyMarker, {
          disallowSymlinks: true,
        });
        await writeAtomicFile(legacyMarker, new Date().toISOString(), {
          encoding: "utf-8",
        });
      } catch (extractionError) {
        if (ownsStagingDir) {
          await fs.promises
            .rm(stagingDir, { recursive: true, force: true })
            .catch(() => undefined);
        }
        throw extractionError;
      }
    }
  }

  private static async ensureAssets(
    assetsDir: string,
    assetIndexMeta: { id: string; sha1: string; url: string; size: number },
    onLog: (msg: string) => void,
    verificationMode: "fast" | "full",
  ): Promise<void> {
    if (
      !assetIndexMeta ||
      typeof assetIndexMeta.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assetIndexMeta.id) ||
      assetIndexMeta.id.includes("..")
    ) {
      throw new PathContainmentError(
        `Invalid asset index identifier '${String(assetIndexMeta?.id)}'.`,
      );
    }
    const assetIndexHash = validateDigestString(assetIndexMeta.sha1, "sha1");
    if (!Number.isSafeInteger(assetIndexMeta.size) || assetIndexMeta.size < 0) {
      throw new Error(
        `Asset index '${assetIndexMeta.id}' has an invalid expected size.`,
      );
    }
    if (assetIndexMeta.size > TRANSFER_LIMITS.jsonBytes) {
      throw new TransferLimitError(
        "asset index",
        TRANSFER_LIMITS.jsonBytes,
        assetIndexMeta.size,
      );
    }

    const assetIndexDir = path.join(assetsDir, "indexes");
    const assetObjectsDir = path.join(assetsDir, "objects");
    const assetIndexPath = path.join(
      assetIndexDir,
      `${assetIndexMeta.id}.json`,
    );

    checkPhysicalAncestrySync(assetsDir, assetIndexDir, {
      disallowSymlinks: true,
    });
    checkPhysicalAncestrySync(assetsDir, assetIndexPath, {
      disallowSymlinks: true,
    });
    await fs.promises.mkdir(assetIndexDir, { recursive: true });
    checkPhysicalAncestrySync(assetsDir, assetIndexPath, {
      disallowSymlinks: true,
    });

    let needDownloadIndex = false;
    if (!fs.existsSync(assetIndexPath)) {
      needDownloadIndex = true;
    } else if (verificationMode === "full") {
      // In full mode: verify sha1 and size
      try {
        const stat = await fs.promises.stat(assetIndexPath);
        if (
          assetIndexMeta.size !== undefined &&
          stat.size !== assetIndexMeta.size
        ) {
          needDownloadIndex = true;
        } else {
          const actualSha1 = await hashFile(assetIndexPath, "sha1");
          if (actualSha1.toLowerCase() !== assetIndexHash) {
            needDownloadIndex = true;
          }
        }
      } catch {
        needDownloadIndex = true;
      }
    }

    if (needDownloadIndex) {
      onLog(
        `[Bootstrap] Downloading Minecraft asset index (${assetIndexMeta.id})...`,
      );
      await this.ensureFile(
        assetIndexMeta.url,
        assetIndexPath,
        assetIndexHash,
        assetIndexMeta.size,
        "full",
        "sha1",
        assetsDir,
      );
    }

    let indexData: any = {};
    try {
      const localIndexStat = await fs.promises.stat(assetIndexPath);
      if (localIndexStat.size > TRANSFER_LIMITS.jsonBytes) {
        throw new TransferLimitError(
          "asset index",
          TRANSFER_LIMITS.jsonBytes,
          localIndexStat.size,
        );
      }
      indexData = JSON.parse(
        await fs.promises.readFile(assetIndexPath, "utf-8"),
      );
      if (
        !indexData ||
        typeof indexData.objects !== "object" ||
        indexData.objects === null
      ) {
        throw new Error(
          "Invalid asset index shape: objects property missing or not an object",
        );
      }
    } catch {
      onLog(
        `[Bootstrap] Asset index invalid or corrupt. Re-downloading asset index (${assetIndexMeta.id})...`,
      );
      await this.ensureFile(
        assetIndexMeta.url,
        assetIndexPath,
        assetIndexHash,
        assetIndexMeta.size,
        "full",
        "sha1",
        assetsDir,
      );
      const repairedIndexStat = await fs.promises.stat(assetIndexPath);
      if (repairedIndexStat.size > TRANSFER_LIMITS.jsonBytes) {
        throw new TransferLimitError(
          "asset index",
          TRANSFER_LIMITS.jsonBytes,
          repairedIndexStat.size,
        );
      }
      indexData = JSON.parse(
        await fs.promises.readFile(assetIndexPath, "utf-8"),
      );
      if (
        !indexData ||
        typeof indexData.objects !== "object" ||
        indexData.objects === null
      ) {
        throw new Error("Invalid asset index shape after re-download");
      }
    }

    const objects: Record<string, { hash: string; size: number }> =
      indexData.objects || {};
    const objectEntries = Object.entries(objects);
    if (objectEntries.length > MAX_ASSET_OBJECT_COUNT) {
      throw new TransferLimitError(
        "asset index object count",
        MAX_ASSET_OBJECT_COUNT,
        objectEntries.length,
      );
    }

    // Deduplicate asset objects by hash and reject inconsistent metadata
    const uniqueObjectsByHash = new Map<
      string,
      { hash: string; size: number }
    >();
    for (const [key, item] of objectEntries) {
      if (!item || typeof item !== "object" || typeof item.hash !== "string") {
        throw new Error(
          `Asset index entry '${key}' is missing a valid SHA-1 hash.`,
        );
      }
      const validHash = validateDigestString(item.hash, "sha1");
      if (!Number.isSafeInteger(item.size) || item.size < 0) {
        throw new Error(
          `Asset index entry '${key}' has an invalid expected size.`,
        );
      }
      const existing = uniqueObjectsByHash.get(validHash);
      if (existing) {
        if (existing.size !== item.size) {
          throw new Error(
            `Inconsistent asset metadata for hash '${validHash}': mapped with size ${existing.size} and ${item.size}`,
          );
        }
      } else {
        uniqueObjectsByHash.set(validHash, {
          hash: validHash,
          size: item.size,
        });
      }
    }

    const uniqueEntries = Array.from(uniqueObjectsByHash.values());
    let expectedAssetBytes = 0;
    for (const item of uniqueEntries) {
      if (item.size > MAX_ASSET_OBJECT_BYTES) {
        throw new TransferLimitError(
          "asset object",
          MAX_ASSET_OBJECT_BYTES,
          item.size,
        );
      }
      expectedAssetBytes += item.size;
      if (expectedAssetBytes > MAX_ASSET_OPERATION_BYTES) {
        throw new TransferLimitError(
          "asset operation",
          MAX_ASSET_OPERATION_BYTES,
          expectedAssetBytes,
        );
      }
    }
    const assetMarker = path.join(
      assetsDir,
      `.verified-${assetIndexMeta.id}-${assetIndexHash}`,
    );
    checkPhysicalAncestrySync(assetsDir, assetMarker, {
      disallowSymlinks: true,
    });
    if (verificationMode === "fast" && fs.existsSync(assetMarker)) {
      onLog(
        `[Bootstrap] ${uniqueEntries.length} official asset objects ready (cached verification).`,
      );
      return;
    }

    // The complete index has passed its count and byte budget. Only now may
    // the object tree be created or inspected for managed asset publication.
    await fs.promises.mkdir(assetObjectsDir, { recursive: true });
    checkPhysicalAncestrySync(assetsDir, assetObjectsDir, {
      disallowSymlinks: true,
    });

    const missing: Array<{ hash: string; size: number; destFile: string }> = [];
    for (const item of uniqueEntries) {
      const prefix = item.hash.substring(0, 2);
      const destFile = resolveAndContainPath(
        assetObjectsDir,
        path.join(prefix, item.hash),
      );
      checkPhysicalAncestrySync(assetsDir, destFile, {
        disallowSymlinks: true,
      });

      if (fs.existsSync(destFile)) {
        try {
          const stat = await fs.promises.stat(destFile);
          if (
            (item.size === undefined || stat.size === item.size) &&
            (verificationMode === "fast" ||
              (await hashFile(destFile, "sha1")) === item.hash)
          ) {
            continue;
          }
        } catch {}
      }

      missing.push({ hash: item.hash, size: item.size, destFile });
    }

    if (missing.length > 0) {
      onLog(
        `[Bootstrap] Downloading ${missing.length} Minecraft assets from official CDN...`,
      );
      const concurrency = 6;
      let completed = 0;
      const total = missing.length;
      await runBoundedPool(
        missing,
        async (task, _index, signal) => {
          const prefix = task.hash.substring(0, 2);
          const url = `https://resources.download.minecraft.net/${prefix}/${task.hash}`;
          const dir = path.dirname(task.destFile);
          checkPhysicalAncestrySync(assetsDir, task.destFile, {
            disallowSymlinks: true,
          });
          await fs.promises.mkdir(dir, { recursive: true });
          checkPhysicalAncestrySync(assetsDir, task.destFile, {
            disallowSymlinks: true,
          });

          // Atomic downloadVerified directly to destFile without pre-deleting destFile
          await downloadVerified(url, task.destFile, {
            algorithm: "sha1",
            expectedHash: task.hash,
            expectedSize: task.size,
            maxBytes: MAX_ASSET_OBJECT_BYTES,
            headers: { "User-Agent": "Lampas-Launcher/1.0" },
            signal,
          });

          completed++;
          if (completed % 250 === 0 || completed === total) {
            onLog(
              `[Bootstrap] Assets: ${completed}/${total} (${Math.round((completed / total) * 100)}%)...`,
            );
          }
          return task.destFile;
        },
        { concurrency },
      );
    }

    checkPhysicalAncestrySync(assetsDir, assetMarker, {
      disallowSymlinks: true,
    });
    await writeAtomicFile(assetMarker, new Date().toISOString(), {
      encoding: "utf-8",
    });
    onLog(
      `[Bootstrap] All ${uniqueEntries.length} official asset objects verified.`,
    );
  }
}
