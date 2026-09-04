import * as fs from "node:fs";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { downloadVerified, hashFile } from "./file-transfer";
import { FabricMetaResolver, type FabricMetaResolverOptions } from "./fabric-meta";
import { validateRuntimeDefinition } from "./runtime-definition";
import type { MinecraftRuntimeDefinition } from "./types";
import versionMeta262 from "./version-meta-26.2.json";

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

export function parseMavenCoordinate(name: string): {
  group: string;
  artifact: string;
  version: string;
  classifier?: string;
} {
  const parts = name.split(":");
  const group = parts[0];
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts.length > 3 ? parts[3] : undefined;
  return { group, artifact, version, classifier };
}

export function mavenToPath(coord: {
  group: string;
  artifact: string;
  version: string;
  classifier?: string;
}): string {
  const groupPath = coord.group.replace(/\./g, "/");
  const fileSuffix = coord.classifier ? `-${coord.classifier}` : "";
  return `${groupPath}/${coord.artifact}/${coord.version}/${coord.artifact}-${coord.version}${fileSuffix}.jar`;
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

export class MinecraftBootstrap {
  private static async ensureFile(
    url: string,
    destPath: string,
    expectedSha1: string | undefined,
    expectedSize: number | undefined,
    verificationMode: "fast" | "full"
  ): Promise<boolean> {
    if (fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      if (!expectedSize || stat.size === expectedSize) {
        if (
          verificationMode === "fast" ||
          !expectedSha1 ||
          (await hashFile(destPath, "sha1")) === expectedSha1
        ) {
          return false;
        }
      }
    }

    await fs.promises.rm(destPath, { force: true });
    await downloadVerified(url, destPath, {
      algorithm: "sha1",
      expectedHash: expectedSha1,
      expectedSize,
      headers: { "User-Agent": "Lampas-Launcher/1.0" },
    });
    return true;
  }

  private static extractNatives(jarBuffer: Buffer, nativesDir: string): void {
    try {
      const unzipped = unzipSync(new Uint8Array(jarBuffer));
      for (const [filename, fileBytes] of Object.entries(unzipped)) {
        if (
          filename.endsWith(".dll") ||
          filename.endsWith(".so") ||
          filename.endsWith(".dylib") ||
          filename.endsWith(".jnilib")
        ) {
          const dest = path.join(nativesDir, path.basename(filename));
          fs.writeFileSync(dest, Buffer.from(fileBytes));
        }
      }
    } catch {
      // Ignore non-zip or corrupt native jars
    }
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

    fs.mkdirSync(librariesDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(nativesDir, { recursive: true });
    fs.mkdirSync(versionsDir, { recursive: true });

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
    const fabricPaths: string[] = [];
    for (const lib of fabricMeta.libraries) {
      const coord = parseMavenCoordinate(lib.name);
      const relPath = mavenToPath(coord);
      const destPath = path.join(librariesDir, relPath);
      const repoUrl = lib.url || "https://maven.fabricmc.net/";
      const downloadUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;

      await this.ensureFile(downloadUrl, destPath, undefined, undefined, verificationMode);
      fabricPaths.push(destPath);
    }
    classpath.push(...fabricPaths);

    // 3. Download Mojang & LWJGL Libraries (Fastutil, Gson, Guava, Log4j, LWJGL, etc.)
    const allLibs = (versionMeta262.libraries || []) as MavenCoordinate[];
    const allowedLibs = allLibs.filter(isLibraryAllowed);
    onLog(`[Bootstrap] Verifying ${allowedLibs.length} core game libraries (Mojang & LWJGL)...`);

    const nativeArchives: Array<{ path: string; changed: boolean }> = [];
    let nextLibrary = 0;
    const libraryPaths = new Array<string>(allowedLibs.length);
    async function libraryWorker() {
      while (nextLibrary < allowedLibs.length) {
        const index = nextLibrary++;
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
      Array.from({ length: Math.min(8, allowedLibs.length) }, () => libraryWorker())
    );
    classpath.push(...libraryPaths);

    const nativeMarker = path.join(
      gameDir,
      ".lampas",
      `natives-${runtime.minecraft}-${process.platform}.complete`
    );
    if (!fs.existsSync(nativeMarker) || nativeArchives.some((archive) => archive.changed)) {
      for (const archive of nativeArchives)
        this.extractNatives(fs.readFileSync(archive.path), nativesDir);
      fs.mkdirSync(path.dirname(nativeMarker), { recursive: true });
      fs.writeFileSync(nativeMarker, new Date().toISOString(), "utf-8");
    }

    // 4. Download Asset Index & Ensure Asset Objects (Textures, Sounds, Panorama)
    const assetIndex = versionMeta262.assetIndex;
    await this.ensureAssets(assetsDir, assetIndex, onLog, verificationMode);

    return {
      classpath,
      mainClass: fabricMeta.mainClass,
      assetIndex: assetIndex.id,
    };
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

    fs.mkdirSync(assetIndexDir, { recursive: true });
    fs.mkdirSync(assetObjectsDir, { recursive: true });

    if (!fs.existsSync(assetIndexPath)) {
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
      indexData = JSON.parse(fs.readFileSync(assetIndexPath, "utf-8"));
    } catch {
      await fs.promises.rm(assetIndexPath, { force: true });
      await this.ensureFile(
        assetIndexMeta.url,
        assetIndexPath,
        assetIndexMeta.sha1,
        assetIndexMeta.size,
        "full"
      );
      indexData = JSON.parse(fs.readFileSync(assetIndexPath, "utf-8"));
    }

    const objects: Record<string, { hash: string; size: number }> = indexData.objects || {};
    const entries = Object.values(objects);
    const assetMarker = path.join(assetsDir, `.verified-${assetIndexMeta.id}-${assetIndexMeta.sha1}`);
    if (verificationMode === "fast" && fs.existsSync(assetMarker)) {
      onLog(`[Bootstrap] ${entries.length} official asset objects ready (cached verification).`);
      return;
    }

    const missing: Array<{ hash: string; size: number; destFile: string }> = [];
    let alreadyPresentCount = 0;

    for (const item of entries) {
      const prefix = item.hash.substring(0, 2);
      const destDir = path.join(assetObjectsDir, prefix);
      const destFile = path.join(destDir, item.hash);

      if (fs.existsSync(destFile)) {
        try {
          const stat = fs.statSync(destFile);
          if (
            stat.size === item.size &&
            (verificationMode === "fast" || (await hashFile(destFile, "sha1")) === item.hash)
          ) {
            alreadyPresentCount++;
            continue;
          }
        } catch {}
      }

      missing.push({ hash: item.hash, size: item.size, destFile });
    }

    if (missing.length > 0) {
      onLog(`[Bootstrap] Downloading ${missing.length} Minecraft assets from official CDN...`);
      const concurrency = 8;
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
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

          await fs.promises.rm(task.destFile, { force: true });
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

    fs.writeFileSync(assetMarker, new Date().toISOString(), "utf-8");
    onLog(`[Bootstrap] All ${entries.length} official asset objects verified.`);
  }
}
