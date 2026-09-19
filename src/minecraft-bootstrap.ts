import * as fs from "node:fs";
import * as path from "node:path";
import { unzip } from "fflate";
import { copyAtomic, downloadVerified, hashFile } from "./file-transfer";
import { assertSubordinateRoot, checkPhysicalAncestrySync, resolveAndContainPath, validateDigestString } from "./path-policy";
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
    classifiers?: Record<string, { sha1: string; size: number; url: string; path?: string }>;
  };
}

function isLibraryAllowed(lib: MavenCoordinate): boolean {
  if (!lib.rules || lib.rules.length === 0) return true;

  const currentOs =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
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

function asyncUnzip(buffer: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(buffer, (err, unzipped) => {
      if (err) reject(err);
      else resolve(unzipped);
    });
  });
}

export class MinecraftBootstrap {
  private static async ensureFile(
    url: string,
    destPath: string,
    expectedHash: string | undefined,
    expectedSize: number | undefined,
    verificationMode: "fast" | "full",
    algorithm: "sha1" | "sha256" = "sha1"
  ): Promise<boolean> {
    if (fs.existsSync(destPath)) {
      try {
        const stat = await fs.promises.stat(destPath);
        const sizeMatches = expectedSize === undefined || stat.size === expectedSize;
        if (sizeMatches) {
          if (verificationMode === "fast") {
            return false;
          }
          if (expectedHash) {
            const actualHash = await hashFile(destPath, algorithm);
            if (actualHash.toLowerCase() === expectedHash.toLowerCase()) {
              return false;
            }
          }
        }
      } catch {}
    }

    // Do NOT pre-delete destPath: downloadVerified writes to staging sibling and atomically replaces
    await downloadVerified(url, destPath, {
      algorithm,
      expectedHash: expectedHash ? expectedHash.toLowerCase() : undefined,
      expectedSize,
      headers: { "User-Agent": "Lampas-Launcher/1.0" },
    });
    return true;
  }

  static async prepareGameEnvironment(
    gameDir: string,
    runtimeInput: MinecraftRuntimeDefinition,
    onLog: (msg: string) => void,
    verificationMode: "fast" | "full" = "fast",
    options?: PrepareGameEnvironmentOptions
  ): Promise<{ classpath: string[]; mainClass: string; assetIndex: string }> {
    const runtime = validateRuntimeDefinition(runtimeInput);

    // Enforce Minecraft scope boundary (26.2 bounded)
    if (runtime.minecraft !== "26.2") {
      throw new Error(
        `Unsupported Minecraft version '${runtime.minecraft}'. Lampas Launcher currently only supports Minecraft 26.2.`
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
      `[Bootstrap] Resolving Minecraft ${runtime.minecraft} environment (Fabric Loader ${runtime.loader.version})...`
    );

    // 1. Download Minecraft 26.2 Client JAR
    const clientJar = versionMeta262.mainJar.downloads.artifact;
    const clientJarPath = path.join(versionsDir, `${runtime.minecraft}-client.jar`);
    onLog(`[Bootstrap] Verifying Minecraft ${runtime.minecraft} client JAR...`);
    await this.ensureFile(
      clientJar.url,
      clientJarPath,
      clientJar.sha1,
      clientJar.size,
      verificationMode
    );

    const classpath: string[] = [clientJarPath];

    // 2. Dynamically resolve Fabric Loader, Intermediary, and runtime libraries from Fabric Meta
    onLog(
      `[Bootstrap] Resolving Fabric Loader ${runtime.loader.version} runtime metadata...`
    );
    const fabricMeta = await FabricMetaResolver.resolveFabricRuntime(
      runtime,
      cacheDir,
      options?.fabricMetaOptions
    );

    onLog(
      `[Bootstrap] Verifying ${fabricMeta.libraries.length} Fabric Loader and support libraries...`
    );
    // Populate fabricPaths[index] strictly preserving Maven classpath order
    const fabricPaths = new Array<string>(fabricMeta.libraries.length);
    const fabricConcurrency = 6;
    let nextFabric = 0;
    const fabricWorker = async () => {
      while (nextFabric < fabricMeta.libraries.length) {
        const index = nextFabric++;
        if (index >= fabricMeta.libraries.length) break;
        const lib = fabricMeta.libraries[index];
        const coord = parseMavenCoordinate(lib.name);
        const relPath = mavenToPath(coord);
        const destPath = path.join(librariesDir, relPath);
        const repoUrl = lib.url || "https://maven.fabricmc.net/";
        const downloadUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;
        const hash = lib.sha256 || lib.sha1;
        const algorithm: "sha256" | "sha1" = lib.sha256 ? "sha256" : "sha1";

        await this.ensureFile(downloadUrl, destPath, hash, undefined, verificationMode, algorithm);
        fabricPaths[index] = destPath;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(fabricConcurrency, fabricMeta.libraries.length) }, () =>
        fabricWorker()
      )
    );
    classpath.push(...fabricPaths);

    // 3. Download Mojang & LWJGL Libraries (Fastutil, Gson, Guava, Log4j, LWJGL, etc.)
    const allLibs = (versionMeta262.libraries || []) as MavenCoordinate[];
    const allowedLibs = allLibs.filter(isLibraryAllowed);
    onLog(`[Bootstrap] Verifying ${allowedLibs.length} core game libraries (Mojang & LWJGL)...`);

    const nativeArchives: Array<{ path: string; changed: boolean }> = [];
    let nextLibrary = 0;
    // Populate libraryPaths[index] strictly preserving Mojang classpath order
    const libraryPaths = new Array<string>(allowedLibs.length);
    const libraryConcurrency = 6;

    async function libraryWorker() {
      while (nextLibrary < allowedLibs.length) {
        const index = nextLibrary++;
        if (index >= allowedLibs.length) break;
        const lib = allowedLibs[index];
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
          verificationMode
        );
        libraryPaths[index] = destPath;

        // Extract platform natives if this library is a native bundle
        if (
          coord.classifier?.includes("natives") ||
          coord.artifact.includes("natives") ||
          lib.name.includes("natives")
        ) {
          nativeArchives.push({ path: destPath, changed });
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(libraryConcurrency, allowedLibs.length) }, () => libraryWorker())
    );
    classpath.push(...libraryPaths);

    // Native Extraction Engine with deterministic staging and receipt validation
    await this.ensureNatives(gameDir, runtime.minecraft, nativeArchives, onLog, verificationMode);

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
    verificationMode: "fast" | "full" = "fast"
  ): Promise<void> {
    const nativesDir = path.join(gameDir, "natives");
    const markerDir = path.join(gameDir, ".lampas");

    assertSubordinateRoot(gameDir, nativesDir);
    assertSubordinateRoot(gameDir, markerDir);

    const nativeMarker = path.join(
      markerDir,
      `natives-${minecraftVersion}-${process.platform}-${process.arch}.json`
    );
    const legacyMarker = path.join(
      markerDir,
      `natives-${minecraftVersion}-${process.platform}.complete`
    );

    let needsNativeExtraction = false;
    if (verificationMode === "full" || nativeArchives.some((archive) => archive.changed)) {
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
    }

    if (needsNativeExtraction && nativeArchives.length > 0) {
      onLog(`[Bootstrap] Extracting native libraries (${process.platform}-${process.arch})...`);

      const sortedArchives = [...nativeArchives].sort((a, b) => a.path.localeCompare(b.path));
      const stagingDir = path.join(
        nativesDir + `.staging.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
      );
      await fs.promises.mkdir(stagingDir, { recursive: true });

      try {
        const extractedFiles: string[] = [];

        for (const archive of sortedArchives) {
          const jarBytes = await fs.promises.readFile(archive.path);
          let unzipped: Record<string, Uint8Array>;
          try {
            unzipped = await asyncUnzip(new Uint8Array(jarBytes));
          } catch (unzipErr: any) {
            throw new Error(
              `Failed to decompress native archive '${path.basename(archive.path)}': ${unzipErr.message}`
            );
          }

          const sortedFilenames = Object.keys(unzipped).sort();
          for (const filename of sortedFilenames) {
            if (
              filename.endsWith(".dll") ||
              filename.endsWith(".so") ||
              filename.endsWith(".dylib") ||
              filename.endsWith(".jnilib")
            ) {
              const fileBytes = unzipped[filename];
              const baseName = path.basename(filename);
              const dest = resolveAndContainPath(stagingDir, baseName);
              await fs.promises.writeFile(dest, Buffer.from(fileBytes));
              extractedFiles.push(baseName);
            }
          }
        }

        if (extractedFiles.length === 0) {
          throw new Error(
            `Native archives did not yield any native libraries (.dll/.so/.dylib) for ${process.platform}-${process.arch}`
          );
        }

        await fs.promises.mkdir(nativesDir, { recursive: true });
        for (const filename of extractedFiles) {
          const src = path.join(stagingDir, filename);
          const dst = resolveAndContainPath(nativesDir, filename);
          checkPhysicalAncestrySync(nativesDir, dst);

          // Break pre-existing symlink or hard-link squatting before copying
          if (fs.existsSync(dst)) {
            try {
              const lstat = await fs.promises.lstat(dst);
              if (lstat.isSymbolicLink() || (lstat.nlink && lstat.nlink > 1)) {
                await fs.promises.unlink(dst);
              }
            } catch {}
          }

          await copyAtomic(src, dst);
        }

        await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);

        await fs.promises.mkdir(markerDir, { recursive: true });
        const receipt = {
          version: minecraftVersion,
          platform: process.platform,
          arch: process.arch,
          extractedAt: new Date().toISOString(),
          archives: sortedArchives.map((a) => path.basename(a.path)),
          files: extractedFiles,
        };
        await fs.promises.writeFile(nativeMarker, JSON.stringify(receipt, null, 2), "utf-8");
        await fs.promises.writeFile(legacyMarker, new Date().toISOString(), "utf-8");
      } catch (extractionError) {
        await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        throw extractionError;
      }
    }
  }

  private static async ensureAssets(
    assetsDir: string,
    assetIndexMeta: { id: string; sha1: string; url: string; size: number },
    onLog: (msg: string) => void,
    verificationMode: "fast" | "full"
  ): Promise<void> {
    const assetIndexDir = path.join(assetsDir, "indexes");
    const assetObjectsDir = path.join(assetsDir, "objects");
    const assetIndexPath = path.join(assetIndexDir, `${assetIndexMeta.id}.json`);

    await fs.promises.mkdir(assetIndexDir, { recursive: true });
    await fs.promises.mkdir(assetObjectsDir, { recursive: true });

    let needDownloadIndex = false;
    if (!fs.existsSync(assetIndexPath)) {
      needDownloadIndex = true;
    } else if (verificationMode === "full") {
      // In full mode: verify sha1 and size
      try {
        const stat = await fs.promises.stat(assetIndexPath);
        if (assetIndexMeta.size !== undefined && stat.size !== assetIndexMeta.size) {
          needDownloadIndex = true;
        } else {
          const actualSha1 = await hashFile(assetIndexPath, "sha1");
          if (actualSha1.toLowerCase() !== assetIndexMeta.sha1.toLowerCase()) {
            needDownloadIndex = true;
          }
        }
      } catch {
        needDownloadIndex = true;
      }
    }

    if (needDownloadIndex) {
      onLog(`[Bootstrap] Downloading Minecraft asset index (${assetIndexMeta.id})...`);
      await this.ensureFile(
        assetIndexMeta.url,
        assetIndexPath,
        assetIndexMeta.sha1,
        assetIndexMeta.size,
        "full"
      );
    }

    let indexData: any = {};
    try {
      indexData = JSON.parse(await fs.promises.readFile(assetIndexPath, "utf-8"));
      if (!indexData || typeof indexData.objects !== "object" || indexData.objects === null) {
        throw new Error("Invalid asset index shape: objects property missing or not an object");
      }
    } catch {
      onLog(`[Bootstrap] Asset index invalid or corrupt. Re-downloading asset index (${assetIndexMeta.id})...`);
      await this.ensureFile(
        assetIndexMeta.url,
        assetIndexPath,
        assetIndexMeta.sha1,
        assetIndexMeta.size,
        "full"
      );
      indexData = JSON.parse(await fs.promises.readFile(assetIndexPath, "utf-8"));
      if (!indexData || typeof indexData.objects !== "object" || indexData.objects === null) {
        throw new Error("Invalid asset index shape after re-download");
      }
    }

    const objects: Record<string, { hash: string; size: number }> = indexData.objects || {};

    // Deduplicate asset objects by hash and reject inconsistent metadata
    const uniqueObjectsByHash = new Map<string, { hash: string; size: number }>();
    for (const [key, item] of Object.entries(objects)) {
      if (!item || typeof item.hash !== "string" || item.size === undefined) {
        continue;
      }
      const validHash = validateDigestString(item.hash, "sha1");
      const existing = uniqueObjectsByHash.get(validHash);
      if (existing) {
        if (existing.size !== item.size) {
          throw new Error(
            `Inconsistent asset metadata for hash '${validHash}': mapped with size ${existing.size} and ${item.size}`
          );
        }
      } else {
        uniqueObjectsByHash.set(validHash, { hash: validHash, size: item.size });
      }
    }

    const uniqueEntries = Array.from(uniqueObjectsByHash.values());
    const assetMarker = path.join(assetsDir, `.verified-${assetIndexMeta.id}-${assetIndexMeta.sha1}`);
    if (verificationMode === "fast" && fs.existsSync(assetMarker)) {
      onLog(`[Bootstrap] ${uniqueEntries.length} official asset objects ready (cached verification).`);
      return;
    }

    const missing: Array<{ hash: string; size: number; destFile: string }> = [];
    for (const item of uniqueEntries) {
      const prefix = item.hash.substring(0, 2);
      const destFile = resolveAndContainPath(assetObjectsDir, path.join(prefix, item.hash));

      if (fs.existsSync(destFile)) {
        try {
          const stat = await fs.promises.stat(destFile);
          if (
            (item.size === undefined || stat.size === item.size) &&
            (verificationMode === "fast" || (await hashFile(destFile, "sha1")) === item.hash)
          ) {
            continue;
          }
        } catch {}
      }

      missing.push({ hash: item.hash, size: item.size, destFile });
    }

    if (missing.length > 0) {
      onLog(`[Bootstrap] Downloading ${missing.length} Minecraft assets from official CDN...`);
      const concurrency = 6;
      let nextAsset = 0;
      let completed = 0;
      const total = missing.length;

      async function worker() {
        while (nextAsset < missing.length) {
          const task = missing[nextAsset++];
          if (!task) break;

          const prefix = task.hash.substring(0, 2);
          const url = `https://resources.download.minecraft.net/${prefix}/${task.hash}`;
          const dir = path.dirname(task.destFile);
          await fs.promises.mkdir(dir, { recursive: true });

          // Atomic downloadVerified directly to destFile without pre-deleting destFile
          await downloadVerified(url, task.destFile, {
            algorithm: "sha1",
            expectedHash: task.hash,
            expectedSize: task.size,
            headers: { "User-Agent": "Lampas-Launcher/1.0" },
          });

          completed++;
          if (completed % 250 === 0 || completed === total) {
            onLog(
              `[Bootstrap] Assets: ${completed}/${total} (${Math.round((completed / total) * 100)}%)...`
            );
          }
        }
      }

      const workers = Array.from({ length: Math.min(concurrency, missing.length) }, () => worker());
      await Promise.all(workers);
    }

    await fs.promises.writeFile(assetMarker, new Date().toISOString(), "utf-8");
    onLog(`[Bootstrap] All ${uniqueEntries.length} official asset objects verified.`);
  }
}
