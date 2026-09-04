import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigManager, normalizePortalUrl } from "./config";
import { MinecraftBootstrap } from "./minecraft-bootstrap";
import { JavaRuntimeManager } from "./java-runtime";
import { copyAtomic, copyVerified, downloadVerified, fetchJsonWithRetry, hashFile, HttpResponseError } from "./file-transfer";
import { reconcileRequiredResourcePacks } from "./resource-packs";
import { app } from "electron";
import { reconcileConfigPatches } from "./config-patches";
import { LauncherLogger } from "./logger";
import { resolveRuntimeDefinition } from "./runtime-definition";
import type { ConfigPatch, InstallationState, MinecraftRuntimeDefinition, RequiredResourcePack, SyncProgress } from "./types";

export const MAX_SUPPORTED_PROTOCOL = 3;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

const PROTECTED_PREFIXES = [
  "saves/",
  "screenshots/",
  "logs/",
  "crash-reports/",
  "options.txt",
  "servers.dat",
];

export function isPathProtected(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return PROTECTED_PREFIXES.some((p) => norm === p || norm.startsWith(p));
}

export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") return false;
  const normalized = path.normalize(relPath).replace(/\\/g, "/");
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith("//") ||
    normalized.startsWith("\\\\")
  ) {
    return false;
  }
  return true;
}

export class LauncherSync {
  static async syncClient(
    onProgress: (progress: SyncProgress) => void,
    verificationMode: "fast" | "full" = "fast"
  ): Promise<{
    success: boolean;
    version: string;
    packName: string;
    release?: any;
    runtime: MinecraftRuntimeDefinition;
  }> {
    const config = ConfigManager.get();
    if (!config.token) {
      throw new Error("Authentication required: Please log in with your Lampas Portal account.");
    }
    const portalUrl = normalizePortalUrl(config.portalUrl);
    const channel = config.selectedChannel || "stable";
    const gameDir = config.gameDir;

    if (!fs.existsSync(gameDir)) {
      fs.mkdirSync(gameDir, { recursive: true });
    }

    const stateDir = path.join(gameDir, ".lampas");
    const stateFile = path.join(stateDir, "installation.json");
    const cacheDir = path.join(stateDir, "cache", "sha256");
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    onProgress({
      status: "checking",
      message: `Connecting to Lampas Portal channel '${channel}'...`,
      filesCompleted: 0,
      totalFiles: 0,
      percent: 5,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    let targetVersion = "2.0.0";
    let manifest: any;
    let releaseData: any = { pack: "Lampas 2" };

    try {
      // 1. Fetch channel pointer
      const channelHeaders: Record<string, string> = { "User-Agent": "Lampas-Launcher/1.0" };
      if (config.token) {
        channelHeaders["Authorization"] = `Bearer ${config.token}`;
      }

      const channelData: any = await fetchJsonWithRetry(`${portalUrl}/api/v1/channels/${channel}`, channelHeaders);
      targetVersion = channelData.version;

      // 2. Fetch release descriptor
      try {
        releaseData = await fetchJsonWithRetry(`${portalUrl}/api/v1/releases/${targetVersion}`, channelHeaders);
      } catch (error) {
        if (error instanceof HttpResponseError && error.status === 410) {
          throw new Error(`Release v${targetVersion} has been REVOKED due to critical issues. Please select another channel.`);
        }
        throw error;
      }

      // 3. Fetch client manifest
      onProgress({
        status: "checking",
        message: `Fetching client manifest v${targetVersion}...`,
        filesCompleted: 0,
        totalFiles: 0,
        percent: 15,
        bytesDownloaded: 0,
        totalBytes: 0,
      });

      manifest = await fetchJsonWithRetry(`${portalUrl}/api/v1/releases/${targetVersion}/client-manifest`, channelHeaders);
    } catch (portalErr: any) {
      // Offline / Local pipeline fallback
      const localManifestPath = path.join(__dirname, "../../manifest/client-manifest.json");
      if (fs.existsSync(localManifestPath)) {
        manifest = JSON.parse(fs.readFileSync(localManifestPath, "utf-8"));
        targetVersion = manifest.version || "2.0.0";
        const localReleasePath = path.join(__dirname, "../../manifest/release.json");
        if (fs.existsSync(localReleasePath)) {
          try {
            releaseData = JSON.parse(fs.readFileSync(localReleasePath, "utf-8"));
          } catch {}
        }
      } else {
        throw new Error(`Portal unavailable (${portalErr.message}) and no local manifest found.`);
      }
    }

    // Validate protocol capability
    const requiredProtocol = manifest.protocol ?? releaseData.protocol;
    if (typeof requiredProtocol === "number" && requiredProtocol > MAX_SUPPORTED_PROTOCOL) {
      throw new Error(
        `Unsupported modpack protocol: release requires protocol ${requiredProtocol}, but this launcher only supports up to protocol ${MAX_SUPPORTED_PROTOCOL}. Please update Lampas Launcher.`
      );
    }

    // Validate minimum launcher version
    if (releaseData?.minimumLauncherVersion) {
      let currentLauncherVersion = "1.1.0";
      try {
        currentLauncherVersion = app.getVersion();
      } catch {}
      if (compareVersions(currentLauncherVersion, releaseData.minimumLauncherVersion) < 0) {
        throw new Error(
          `Launcher update required: release requires launcher version ${releaseData.minimumLauncherVersion} or newer (current: ${currentLauncherVersion}). Please update Lampas Launcher.`
        );
      }
    }

    // Validate and cross-check runtime definition (fails hard before any pack mutation or download)
    const runtime = resolveRuntimeDefinition(releaseData, manifest);

    const disabledClientMods = new Set(config.disabledClientMods || []);
    const disabledFilenames = new Set(
      (manifest.mods || [])
        .filter((mod: any) => mod.side === "client" && disabledClientMods.has(mod.id))
        .map((mod: any) => mod.filename)
    );
    const manifestFiles: any[] = (manifest.files || []).filter((file: any) =>
      !disabledFilenames.has(path.basename(file.path))
    );

    // Validate relative paths in manifest
    for (const file of manifestFiles) {
      if (!isSafeRelativePath(file.path)) {
        throw new Error(`Unsafe relative path in manifest: '${file.path}'`);
      }
    }

    // 4. Reconcile with local files
    let prevState: InstallationState = { pack: "", version: "", installedAt: "", files: {} };
    if (fs.existsSync(stateFile)) {
      try {
        prevState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      } catch {
        // fresh state
      }
    }

    const desiredFilesMap = new Map<string, any>();
    for (const f of manifestFiles) {
      desiredFilesMap.set(f.path, f);
    }

    const toDownload: any[] = [];
    let upToDateCount = 0;
    const verifiedAt = new Map<string, string>();

    for (const file of manifestFiles) {
      const localPath = path.join(gameDir, file.path);
      const policy = file.policy || "MANAGED";

      if (policy === "PRESERVE" || isPathProtected(file.path)) {
        if (fs.existsSync(localPath)) {
          upToDateCount++;
          continue;
        }
      }

      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        const previous = prevState.files[file.path];
        const metadataMatches =
          verificationMode !== "full" &&
          previous?.sha256 === file.hashes.sha256 &&
          previous.size === file.size &&
          previous.mtimeMs === stat.mtimeMs &&
          stat.size === file.size;
        if (metadataMatches) {
          upToDateCount++;
          continue;
        }

        const hash = await hashFile(localPath, "sha256");
        if (hash === file.hashes.sha256 && stat.size === file.size) {
          upToDateCount++;
          verifiedAt.set(file.path, new Date().toISOString());
          continue;
        } else {
          LauncherLogger.info(
            `  ⚠️ [Hash Mismatch] ${file.path} (expected: ${file.hashes.sha256.slice(0, 10)}..., actual: ${hash.slice(0, 10)}...)`
          );
        }
      }

      toDownload.push(file);
    }

    // Identify obsolete managed files from previous state AND unmanifested mods on disk
    const toDeleteSet = new Set<string>();
    for (const [prevPath, info] of Object.entries(prevState.files)) {
      if (info.policy === "MANAGED" && !desiredFilesMap.has(prevPath) && !isPathProtected(prevPath)) {
        toDeleteSet.add(prevPath);
      }
    }

    // Direct disk reconciliation: preserve explicitly imported local mods.
    const modsDir = path.join(gameDir, "mods");
    const customModFilenames = new Set((config.customClientMods || []).map((mod) => mod.filename.toLowerCase()));
    if (fs.existsSync(modsDir)) {
      try {
        const diskFiles = fs.readdirSync(modsDir);
        for (const file of diskFiles) {
          if (file.endsWith(".jar")) {
            const relModPath = `mods/${file}`;
            if (!desiredFilesMap.has(relModPath) && !isPathProtected(relModPath) && !customModFilenames.has(file.toLowerCase())) {
              toDeleteSet.add(relModPath);
            }
          }
        }
      } catch {
        // ignore read error
      }
    }

    const toDelete = Array.from(toDeleteSet);

    LauncherLogger.info(
      `[Sync] Synchronizing client: ${toDownload.length} to download, ${upToDateCount} up-to-date, ${toDelete.length} obsolete to delete.`
    );

    // 5. Download missing/modified files
    const totalFiles = manifestFiles.length;
    let completedCount = upToDateCount;
    let totalBytes = toDownload.reduce((acc, f) => acc + (f.size || 0), 0);
    let bytesDownloaded = 0;

    if (toDownload.length > 0) {
      const concurrency = 6;
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < toDownload.length) {
          const file = toDownload[nextIndex++];
          if (!file) break;

          let downloadUrl = file.download.url;
          if (downloadUrl.startsWith("/")) {
            downloadUrl = `${portalUrl}${downloadUrl}`;
          }

          // Check blob cache first
          let cached = false;
          const cachePath = path.join(cacheDir, file.hashes.sha256.substring(0, 2), file.hashes.sha256);
          if (fs.existsSync(cachePath)) {
            const cachedHash = await hashFile(cachePath, "sha256");
            if (cachedHash === file.hashes.sha256 && fs.statSync(cachePath).size === file.size) {
              cached = true;
            } else {
              await fs.promises.rm(cachePath, { force: true });
            }
          }

          let networkBytes = 0;
          if (!cached) {
            networkBytes = await cacheFile(file, cachePath);
          }
          verifiedAt.set(file.path, new Date().toISOString());
          completedCount++;
          bytesDownloaded += networkBytes;

          const status = cached ? "⚡ [Cache Hit]" : "✓ [Downloaded]";
          const sizeBytes = fs.existsSync(cachePath) ? fs.statSync(cachePath).size : (file.size || 0);
          const sizeKb = sizeBytes / 1024;
          LauncherLogger.info(`  ${status} ${file.path} (${sizeKb.toFixed(1)} KB)`);

          const percent = Math.min(95, Math.round(15 + (completedCount / totalFiles) * 80));
          onProgress({
            status: "downloading",
            message: `Downloading ${path.basename(file.path)}...`,
            currentFile: file.path,
            filesCompleted: completedCount,
            totalFiles,
            percent,
            bytesDownloaded,
            totalBytes,
          });
        }
      }

      async function cacheFile(fileEntry: any, cachePath: string): Promise<number> {
        let url = fileEntry.download.url;
        const expectedSha256 = fileEntry.hashes.sha256;

        if (url.startsWith("/")) {
          const candidates = [
            path.join(__dirname, "../../pack/common", fileEntry.path),
            path.join(__dirname, "../../pack/client", fileEntry.path),
            path.join(__dirname, "../../pack/custom", path.basename(fileEntry.path)),
          ];
          for (const c of candidates) {
            if (fs.existsSync(c)) {
              await copyVerified(c, cachePath, {
                expectedHash: expectedSha256,
                expectedSize: fileEntry.size,
              });
              return 0;
            }
          }
          url = `${portalUrl}${url}`;
        }

        return downloadVerified(url, cachePath, {
          expectedHash: expectedSha256,
          expectedSize: fileEntry.size,
          headers: { "User-Agent": "Lampas-Launcher/1.0" },
        });
      }

      const workers = Array.from({ length: Math.min(concurrency, toDownload.length) }, () => worker());
      await Promise.all(workers);

      // Apply only after every artifact is present and verified in the cache.
      onProgress({
        status: "staging",
        message: "Staging and applying modpack files...",
        filesCompleted: completedCount,
        totalFiles,
        percent: 96,
        bytesDownloaded,
        totalBytes,
      });

      for (const file of toDownload) {
        const cachePath = path.join(cacheDir, file.hashes.sha256.substring(0, 2), file.hashes.sha256);
        await copyAtomic(cachePath, path.join(gameDir, file.path));
        LauncherLogger.info(`  ✓ [Replaced] ${file.path}`);
      }

    }

    // 6. Delete obsolete managed files
    for (const relPath of toDelete) {
      const fullPath = path.join(gameDir, relPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        LauncherLogger.info(`  🗑 [Deleted Obsolete] ${relPath}`);
      }
    }

    // 7. Reconcile required resource packs (fail hard if reconciliation fails)
    const currentReqPacks: RequiredResourcePack[] = releaseData?.launch?.requiredResourcePacks || [];
    const previousManaged = prevState.managedResourcePacks || [];
    const updatedManagedPacks = await reconcileRequiredResourcePacks(gameDir, {
      required: currentReqPacks,
      previousManaged,
    });
    if (updatedManagedPacks.length > 0) {
      LauncherLogger.info(`  [Resource Pack Enabled] ${updatedManagedPacks.join(", ")}`);
    }

    // 8. Post-mutation verification pass: verify existence, size, and SHA-256 for managed files
    for (const file of manifestFiles) {
      if ((file.policy || "MANAGED") === "MANAGED") {
        const localPath = path.join(gameDir, file.path);
        if (!fs.existsSync(localPath)) {
          throw new Error(`Verification failed: managed file '${file.path}' is missing on disk.`);
        }
        const stat = fs.statSync(localPath);
        if (typeof file.size === "number" && stat.size !== file.size) {
          throw new Error(
            `Verification failed: size mismatch for '${file.path}' (expected ${file.size}, got ${stat.size})`
          );
        }
        const wasDownloaded = toDownload.some((f) => f.path === file.path);
        if (verificationMode === "full" || wasDownloaded) {
          const actualHash = await hashFile(localPath, "sha256");
          if (actualHash.toLowerCase() !== file.hashes.sha256.toLowerCase()) {
            throw new Error(
              `Verification failed: SHA-256 mismatch for '${file.path}' (expected ${file.hashes.sha256}, got ${actualHash})`
            );
          }
        }
      }
    }

    // 9. Reconcile config patches
    let updatedAppliedPatches = prevState.appliedConfigPatches || {};
    const configPatches: ConfigPatch[] = manifest.configPatches || [];
    if (configPatches.length > 0) {
      onProgress({
        status: "staging",
        message: "Applying modpack configuration patches...",
        filesCompleted: totalFiles,
        totalFiles,
        percent: 98,
        bytesDownloaded,
        totalBytes,
      });

      const patchResult = await reconcileConfigPatches({
        gameDir,
        patches: configPatches,
        prevState,
      });
      updatedAppliedPatches = patchResult.appliedState;
    }

    // 10. Write release descriptor and installation state only after successful mutations
    const releaseFilePath = path.join(stateDir, "release.json");
    try {
      fs.writeFileSync(releaseFilePath, JSON.stringify(releaseData, null, 2), "utf-8");
    } catch {}

    const newState: InstallationState = {
      pack: manifest.pack || releaseData.pack || "Lampas 2",
      version: targetVersion,
      installedAt: new Date().toISOString(),
      managedResourcePacks: updatedManagedPacks,
      appliedConfigPatches: updatedAppliedPatches,
      files: {} as Record<string, any>,
    };

    for (const file of manifestFiles) {
      const filePath = path.join(gameDir, file.path);
      const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : undefined;
      const previous = prevState.files[file.path];
      newState.files[file.path] = {
        sha256: file.hashes.sha256,
        size: file.size,
        policy: file.policy || "MANAGED",
        mtimeMs: stat?.mtimeMs,
        verifiedAt: verifiedAt.get(file.path) || previous?.verifiedAt,
      };
    }

    fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), "utf-8");

    LauncherLogger.info(
      `[OK] Client successfully synchronized to ${newState.pack} v${targetVersion}!`
    );

    onProgress({
      status: "complete",
      message: `Lampas Modpack v${targetVersion} is ready!`,
      filesCompleted: totalFiles,
      totalFiles,
      percent: 100,
      bytesDownloaded,
      totalBytes,
    });

    return {
      success: true,
      version: targetVersion,
      packName: newState.pack,
      release: releaseData,
      runtime,
    };
  }

  static async repairInstallation(
    onProgress: (progress: SyncProgress) => void,
    onLog?: (entry: { level: "INFO" | "WARN" | "ERROR"; message: string; timestamp: string }) => void
  ): Promise<{ success: boolean; message: string; version: string; packName: string }> {
    const config = ConfigManager.get();
    const gameDir = config.gameDir;
    const log = (level: "INFO" | "WARN" | "ERROR", msg: string) => {
      if (onLog) {
        onLog({ level, message: msg, timestamp: new Date().toLocaleTimeString() });
      }
    };

    log("INFO", "[Repair] Starting full installation repair and integrity verification...");

    // 1. Force full synchronization of all modpack files with SHA-256 validation
    onProgress({
      status: "repairing",
      message: "Verifying and repairing modpack files...",
      filesCompleted: 0,
      totalFiles: 100,
      percent: 5,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    const syncResult = await this.syncClient((p) => {
      onProgress({
        ...p,
        status: "repairing",
        percent: Math.round(p.percent * 0.4), // 0% - 40%
      });
    }, "full");

    log("INFO", `[Repair] Modpack files verified and repaired (${syncResult.packName} v${syncResult.version}).`);

    // 2. Minecraft 26.2 client JAR, Fabric Loader, libraries, natives, and 5,000+ asset objects
    onProgress({
      status: "repairing",
      message: "Verifying Minecraft libraries, natives, and asset objects...",
      filesCompleted: 40,
      totalFiles: 100,
      percent: 45,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    await MinecraftBootstrap.prepareGameEnvironment(
      gameDir,
      "26.2",
      "0.19.3",
      (msg) => {
        log("INFO", msg);
        onProgress({
          status: "repairing",
          message: msg,
          filesCompleted: 70,
          totalFiles: 100,
          percent: 75,
          bytesDownloaded: 0,
          totalBytes: 0,
        });
      },
      "full"
    );

    // 3. Java 25 verification
    onProgress({
      status: "repairing",
      message: "Verifying OpenJDK 25 runtime environment...",
      filesCompleted: 85,
      totalFiles: 100,
      percent: 85,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    const javaExe = await JavaRuntimeManager.ensureJava25(gameDir, (msg) => log("INFO", msg), "full");
    log("INFO", `[Repair] Java runtime verified: ${javaExe}`);

    onProgress({
      status: "complete",
      message: "Repair complete! All modpack files, assets, and libraries are verified.",
      filesCompleted: 100,
      totalFiles: 100,
      percent: 100,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    log("INFO", "[Repair] All installation components successfully repaired.");

    return {
      success: true,
      message: "Installation repaired successfully.",
      version: syncResult.version,
      packName: syncResult.packName,
    };
  }

  static async getModCatalog(): Promise<any[]> {
    const config = ConfigManager.get();
    const portalUrl = normalizePortalUrl(config.portalUrl);
    const channel = config.selectedChannel || "stable";

    try {
      const channelData: any = await fetchJsonWithRetry(`${portalUrl}/api/v1/channels/${channel}`);
      const manifest: any = await fetchJsonWithRetry(`${portalUrl}/api/v1/releases/${channelData.version}/client-manifest`);
      if (manifest.mods && Array.isArray(manifest.mods)) {
        return this.decorateModCatalog(manifest.mods);
      }
    } catch {}

    const localManifestPath = path.join(__dirname, "../../manifest/client-manifest.json");
    if (fs.existsSync(localManifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(localManifestPath, "utf-8"));
        return this.decorateModCatalog(manifest.mods || []);
      } catch {}
    }

    return [];
  }

  private static decorateModCatalog(mods: any[]): any[] {
    const config = ConfigManager.get();
    const disabled = new Set(config.disabledClientMods || []);
    const official = mods.map((mod) => ({
      ...mod,
      source: "official",
      enabled: mod.side !== "client" || !disabled.has(mod.id),
      canDisable: mod.side === "client",
    }));
    const custom = (config.customClientMods || []).map((mod) => ({
      id: `local:${mod.filename}`,
      name: mod.filename.replace(/\.jar$/i, ""),
      filename: mod.filename,
      description: "Local client mod. Preserved when the Lampas pack synchronizes.",
      side: "client",
      categories: ["custom"],
      source: "custom",
      enabled: mod.enabled,
      canDisable: true,
      size: mod.size,
    }));
    return [...custom, ...official];
  }
}
