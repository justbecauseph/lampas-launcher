"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LauncherSync =
  exports.assertSubordinateRoot =
  exports.normalizePathKey =
  exports.sanitizeInstallationState =
  exports.isPathProtected =
  exports.isSafeRelativePath =
  exports.MAX_SUPPORTED_PROTOCOL =
    void 0;
exports.compareVersions = compareVersions;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const config_1 = require("./config");
const minecraft_bootstrap_1 = require("./minecraft-bootstrap");
const java_runtime_1 = require("./java-runtime");
const file_transfer_1 = require("./file-transfer");
const resource_packs_1 = require("./resource-packs");
const electron_1 = require("electron");
const config_patches_1 = require("./config-patches");
const logger_1 = require("./logger");
const runtime_definition_1 = require("./runtime-definition");
const async_pool_1 = require("./async-pool");
const metadata_policy_1 = require("./metadata-policy");
const sync_safety_1 = require("./sync-safety");
exports.MAX_SUPPORTED_PROTOCOL = 3;
function metadataUrl(portalUrl, value, context) {
  const resolved = new URL(value, `${portalUrl}/`);
  const portal = new URL(`${portalUrl}/`);
  if (resolved.origin !== portal.origin) {
    throw new metadata_policy_1.MetadataValidationError(
      `${context} points outside the configured Portal.`,
    );
  }
  return resolved.toString();
}
function httpStatus(error) {
  for (const candidate of errorChain(error)) {
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.status === "number"
    ) {
      return candidate.status;
    }
  }
  return undefined;
}
function errorChain(error) {
  const chain = [];
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}
function isKnownSyncSafetyFailure(error) {
  const status = httpStatus(error);
  if (status === 401 || status === 403 || status === 410) return true;
  for (const candidate of errorChain(error)) {
    const name = String(candidate.name || "");
    if (
      name === "MetadataValidationError" ||
      name === "MetadataIntegrityError" ||
      name === "PortalRedirectPolicyError" ||
      name === "TransferIntegrityError" ||
      name === "PathContainmentError"
    )
      return true;
    if (
      candidate instanceof Error &&
      /Invalid (?:Lampas )?(?:release|client manifest)|Verification failed|Integrity violation|Unsafe relative path|installation state is malformed|Unsupported modpack protocol/i.test(
        candidate.message,
      )
    )
      return true;
  }
  return false;
}
function safetyReason(error) {
  const status = httpStatus(error);
  if (status === 401 || status === 403 || status === 410) return "DENIAL";
  for (const candidate of errorChain(error)) {
    const name = String(candidate.name || "");
    if (
      candidate instanceof Error &&
      /REVOKED|denied|forbidden|unauthorized/i.test(candidate.message)
    )
      return "DENIAL";
    if (
      [
        "PathContainmentError",
        "TransferIntegrityError",
        "MetadataIntegrityError",
      ].includes(name)
    )
      return "INTEGRITY";
  }
  return "SCHEMA";
}
function compareVersions(a, b) {
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
const path_policy_1 = require("./path-policy");
Object.defineProperty(exports, "isSafeRelativePath", {
  enumerable: true,
  get: function () {
    return path_policy_1.isSafeRelativePath;
  },
});
Object.defineProperty(exports, "isPathProtected", {
  enumerable: true,
  get: function () {
    return path_policy_1.isPathProtected;
  },
});
Object.defineProperty(exports, "sanitizeInstallationState", {
  enumerable: true,
  get: function () {
    return path_policy_1.sanitizeInstallationState;
  },
});
Object.defineProperty(exports, "normalizePathKey", {
  enumerable: true,
  get: function () {
    return path_policy_1.normalizePathKey;
  },
});
Object.defineProperty(exports, "assertSubordinateRoot", {
  enumerable: true,
  get: function () {
    return path_policy_1.assertSubordinateRoot;
  },
});
class LauncherSync {
  static async syncClient(onProgress, verificationMode = "fast") {
    return this.runSyncWithSafety(onProgress, verificationMode, true);
  }
  static async runSyncWithSafety(onProgress, verificationMode, clearOnSuccess) {
    const config = config_1.ConfigManager.get();
    const safetyContext = {
      origin: (0, config_1.normalizePortalUrl)(config.portalUrl),
      channel: config.selectedChannel || "stable",
      gameDir: config.gameDir,
    };
    try {
      const result = await this.syncClientInternal(
        onProgress,
        verificationMode,
      );
      // A full pack pass does not verify the bootstrap/runtime/Java surfaces
      // covered by repairInstallation. Keep an integrity block until that
      // complete path succeeds.
      if (clearOnSuccess)
        (0, sync_safety_1.clearSyncSafetyBlock)(config.gameDir);
      return result;
    } catch (error) {
      if (isKnownSyncSafetyFailure(error))
        await (0, sync_safety_1.persistSyncSafetyBlock)(
          safetyContext,
          safetyReason(error),
          error,
        );
      throw error;
    }
  }
  static async syncClientInternal(onProgress, verificationMode = "fast") {
    const config = config_1.ConfigManager.get();
    const portalUrl = (0, config_1.normalizePortalUrl)(config.portalUrl);
    if (
      !config.token ||
      !config.sessionPortalUrl ||
      config.sessionPortalUrl !== portalUrl
    ) {
      throw new Error(
        "Authentication required: Please log in with your Lampas Portal account.",
      );
    }
    const channel = config.selectedChannel || "stable";
    const gameDir = config.gameDir;
    const stateDir = path.join(gameDir, ".lampas");
    const stateFile = path.join(stateDir, "installation.json");
    const cacheDir = path.join(stateDir, "cache", "sha256");
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
    let manifest;
    let releaseData;
    try {
      // 1. Fetch channel pointer
      const channelHeaders = { "User-Agent": "Lampas-Launcher/1.0" };
      if (config.token) {
        channelHeaders["Authorization"] = `Bearer ${config.token}`;
      }
      const channelData = (0, metadata_policy_1.validateChannelResponse)(
        await (0, file_transfer_1.fetchPortalJsonWithRetry)(
          `${portalUrl}/api/v1/channels/${channel}`,
          channelHeaders,
        ),
        channel,
      );
      targetVersion = channelData.version;
      const channelReleaseUrl = metadataUrl(
        portalUrl,
        channelData.release,
        "channel release",
      );
      const channelReleaseMatch = new URL(channelReleaseUrl).pathname.match(
        /^\/api\/v1\/releases\/([^/]+)$/,
      );
      if (
        !channelReleaseMatch ||
        decodeURIComponent(channelReleaseMatch[1]) !== targetVersion
      ) {
        throw new metadata_policy_1.MetadataValidationError(
          "channel release pointer does not match channel version.",
        );
      }
      // 2. Fetch release descriptor
      try {
        releaseData = (0, metadata_policy_1.validateReleaseDescriptor)(
          await (0, file_transfer_1.fetchPortalJsonWithRetry)(
            channelReleaseUrl,
            channelHeaders,
          ),
        );
      } catch (error) {
        if (httpStatus(error) === 410) {
          throw new metadata_policy_1.MetadataIntegrityError(
            `Release v${targetVersion} has been REVOKED due to critical issues. Please select another channel.`,
          );
        }
        throw error;
      }
      if (releaseData.version !== targetVersion) {
        throw new metadata_policy_1.MetadataValidationError(
          `Release descriptor version '${releaseData.version}' does not match channel target '${targetVersion}'.`,
        );
      }
      if (String(releaseData.status || "").toUpperCase() === "REVOKED") {
        throw new metadata_policy_1.MetadataIntegrityError(
          `Release v${targetVersion} has been REVOKED due to critical issues. Please select another channel.`,
        );
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
      manifest = await (0, file_transfer_1.fetchPortalJsonWithRetry)(
        metadataUrl(
          portalUrl,
          releaseData.clientManifest,
          "release client manifest",
        ),
        channelHeaders,
      );
      (0, metadata_policy_1.validateClientManifest)(manifest, releaseData);
    } catch (portalErr) {
      // Only an unavailable Portal can use the explicitly supported local
      // development fallback.  Denials, revocations, redirects, malformed
      // metadata, and integrity failures must stop synchronization.
      if (!(0, metadata_policy_1.isTransientMetadataFetchFailure)(portalErr)) {
        throw portalErr;
      }
      const localManifestPath = path.join(
        __dirname,
        "../../manifest/client-manifest.json",
      );
      const localReleasePath = path.join(
        __dirname,
        "../../manifest/release.json",
      );
      if (
        !fs.existsSync(localManifestPath) ||
        !fs.existsSync(localReleasePath)
      ) {
        throw new Error(
          `Portal unavailable (${portalErr.message}) and no local manifest found.`,
        );
      }
      try {
        releaseData = (0, metadata_policy_1.validateReleaseDescriptor)(
          JSON.parse(fs.readFileSync(localReleasePath, "utf-8")),
        );
        targetVersion = releaseData.version;
        manifest = JSON.parse(fs.readFileSync(localManifestPath, "utf-8"));
        (0, metadata_policy_1.validateClientManifest)(manifest, releaseData);
      } catch {
        const metadataError = new metadata_policy_1.MetadataValidationError(
          `Portal unavailable (${portalErr.message}) and local metadata is invalid.`,
        );
        throw metadataError;
      }
    }
    // Validate protocol capability
    const requiredProtocol = manifest.protocol ?? releaseData.protocol;
    if (
      typeof requiredProtocol === "number" &&
      requiredProtocol > exports.MAX_SUPPORTED_PROTOCOL
    ) {
      throw new Error(
        `Unsupported modpack protocol: release requires protocol ${requiredProtocol}, but this launcher only supports up to protocol ${exports.MAX_SUPPORTED_PROTOCOL}. Please update Lampas Launcher.`,
      );
    }
    // Validate minimum launcher version
    if (releaseData?.minimumLauncherVersion) {
      let currentLauncherVersion = "1.1.0";
      try {
        currentLauncherVersion = electron_1.app.getVersion();
      } catch {}
      if (
        compareVersions(
          currentLauncherVersion,
          releaseData.minimumLauncherVersion,
        ) < 0
      ) {
        throw new Error(
          `Launcher update required: release requires launcher version ${releaseData.minimumLauncherVersion} or newer (current: ${currentLauncherVersion}). Please update Lampas Launcher.`,
        );
      }
    }
    // Validate complete manifest and release metadata before any filesystem mutation
    // Validate and cross-check runtime definition (fails hard before any pack mutation or download)
    const runtime = (0, runtime_definition_1.resolveRuntimeDefinition)(
      releaseData,
      manifest,
    );
    // Initialize directory structure only after release, manifest, and runtime are validated
    if (!fs.existsSync(gameDir)) {
      fs.mkdirSync(gameDir, { recursive: true });
    }
    (0, path_policy_1.assertSubordinateRoot)(gameDir, stateDir);
    (0, path_policy_1.assertSubordinateRoot)(gameDir, cacheDir);
    (0, path_policy_1.assertSubordinateRoot)(
      gameDir,
      path.join(gameDir, "mods"),
    );
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const disabledClientMods = new Set(config.disabledClientMods || []);
    const disabledFilenames = new Set(
      (manifest.mods || [])
        .filter(
          (mod) => mod.side === "client" && disabledClientMods.has(mod.id),
        )
        .map((mod) => mod.filename),
    );
    const manifestFiles = (manifest.files || []).filter(
      (file) => !disabledFilenames.has(path.basename(file.path)),
    );
    // Validate relative paths in manifest
    for (const file of manifestFiles) {
      if (!(0, path_policy_1.isSafeRelativePath)(file.path)) {
        throw new Error(`Unsafe relative path in manifest: '${file.path}'`);
      }
    }
    // 4. Reconcile with local files
    let prevState = { pack: "", version: "", installedAt: "", files: {} };
    if (fs.existsSync(stateFile)) {
      try {
        const rawPrev = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        const sanitized = (0, path_policy_1.sanitizeInstallationState)(
          rawPrev,
          gameDir,
        );
        if (sanitized.quarantinedKeys.length > 0) {
          logger_1.LauncherLogger.warn(
            `[Sync] Quarantined ${sanitized.quarantinedKeys.length} unsafe/traversal paths from previous installation state: ${sanitized.quarantinedKeys.join(", ")}`,
          );
        }
        prevState = (0, metadata_policy_1.validateInstallationState)(
          rawPrev,
          gameDir,
        );
      } catch (stateError) {
        throw new Error(
          "Installation state is malformed; synchronization is blocked until it is repaired or removed.",
          { cause: stateError },
        );
      }
    }
    // Index desired files by canonical platform-aware key (case-folding on Windows, case-sensitive on POSIX)
    const desiredFilesMap = new Map();
    for (const f of manifestFiles) {
      desiredFilesMap.set((0, path_policy_1.normalizePathKey)(f.path), f);
    }
    const syncGenerationId = `gen-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const transferOutcomes = new Map();
    const toDownload = [];
    let upToDateCount = 0;
    const verifiedAt = new Map();
    // Bounded async metadata checking across manifest files (concurrency 8)
    const checkResults = new Array(manifestFiles.length);
    await (0, async_pool_1.runBoundedPool)(
      manifestFiles,
      async (file, index) => {
        const localPath = path.join(gameDir, file.path);
        const policy = file.policy || "MANAGED";
        if (
          policy === "PRESERVE" ||
          (0, path_policy_1.isPathProtected)(file.path)
        ) {
          if (fs.existsSync(localPath)) {
            checkResults[index] = { file, needDownload: false };
            return;
          }
        }
        const stat = await fs.promises.stat(localPath).catch(() => null);
        if (stat) {
          const previous = prevState.files[file.path];
          const metadataMatches =
            verificationMode !== "full" &&
            previous?.sha256 === file.hashes.sha256 &&
            previous.size === file.size &&
            previous.mtimeMs === stat.mtimeMs &&
            stat.size === file.size;
          if (metadataMatches) {
            checkResults[index] = { file, needDownload: false };
            return;
          }
          const hash = await (0, file_transfer_1.hashFile)(localPath, "sha256");
          if (
            hash.toLowerCase() === file.hashes.sha256.toLowerCase() &&
            stat.size === file.size
          ) {
            checkResults[index] = {
              file,
              needDownload: false,
              verifiedTimestamp: new Date().toISOString(),
            };
            return;
          } else {
            logger_1.LauncherLogger.info(
              `  ⚠️ [Hash Mismatch] ${file.path} (expected: ${file.hashes.sha256.slice(0, 10)}..., actual: ${hash.slice(0, 10)}...)`,
            );
          }
        }
        checkResults[index] = { file, needDownload: true };
      },
      { concurrency: 8 },
    );
    for (const r of checkResults) {
      if (!r) continue;
      if (r.needDownload) {
        toDownload.push(r.file);
      } else {
        upToDateCount++;
        if (r.verifiedTimestamp) {
          verifiedAt.set(r.file.path, r.verifiedTimestamp);
        }
      }
    }
    const stagedPathsSet = new Set(toDownload.map((f) => f.path));
    // Gather all custom client mod filenames (enabled and disabled)
    const customModFilenames = new Set(
      (config.customClientMods || []).flatMap((mod) => [
        mod.filename.toLowerCase(),
        mod.filename.toLowerCase() + ".disabled",
      ]),
    );
    // Identify obsolete managed files from previous state AND unmanifested mods on disk
    const toDeleteSet = new Set();
    for (const [prevPath, info] of Object.entries(prevState.files)) {
      const prevKey = (0, path_policy_1.normalizePathKey)(prevPath);
      const prevBasename = path.basename(prevPath).toLowerCase();
      const isCustomMod =
        customModFilenames.has(prevBasename) ||
        customModFilenames.has(prevBasename.replace(/\.disabled$/, ""));
      if (
        info.policy === "MANAGED" &&
        !desiredFilesMap.has(prevKey) &&
        !(0, path_policy_1.isPathProtected)(prevPath) &&
        !isCustomMod
      ) {
        try {
          const fullPath = (0, path_policy_1.resolveAndContainPath)(
            gameDir,
            prevPath,
          );
          (0, path_policy_1.checkPhysicalAncestrySync)(gameDir, fullPath, {
            enforceOwnership: true,
          });
          toDeleteSet.add(prevPath);
        } catch {
          logger_1.LauncherLogger.warn(
            `[Sync] Skipping uncontained/protected obsolete candidate: ${prevPath}`,
          );
        }
      }
    }
    // Direct disk reconciliation: preserve explicitly imported local mods.
    const modsDir = path.join(gameDir, "mods");
    if (fs.existsSync(modsDir)) {
      try {
        const diskFiles = fs.readdirSync(modsDir);
        for (const file of diskFiles) {
          if (
            file.toLowerCase().endsWith(".jar") ||
            file.toLowerCase().endsWith(".jar.disabled")
          ) {
            const relModPath = `mods/${file}`;
            const modKey = (0, path_policy_1.normalizePathKey)(relModPath);
            const isCustom =
              customModFilenames.has(file.toLowerCase()) ||
              customModFilenames.has(
                file.toLowerCase().replace(/\.disabled$/, ""),
              );
            if (
              !desiredFilesMap.has(modKey) &&
              !(0, path_policy_1.isPathProtected)(relModPath) &&
              !isCustom
            ) {
              try {
                const fullPath = (0, path_policy_1.resolveAndContainPath)(
                  gameDir,
                  relModPath,
                );
                (0, path_policy_1.checkPhysicalAncestrySync)(
                  gameDir,
                  fullPath,
                  { enforceOwnership: true },
                );
                toDeleteSet.add(relModPath);
              } catch {
                logger_1.LauncherLogger.warn(
                  `[Sync] Skipping uncontained mod candidate: ${relModPath}`,
                );
              }
            }
          }
        }
      } catch {
        // ignore read error
      }
    }
    const toDelete = Array.from(toDeleteSet);
    // Integrity check: verify that NO desired physical file appears in obsolete deletion plan
    for (const delPath of toDelete) {
      const delKey = (0, path_policy_1.normalizePathKey)(delPath);
      if (desiredFilesMap.has(delKey)) {
        throw new Error(
          `Integrity violation: desired file '${delPath}' was classified as obsolete and scheduled for deletion.`,
        );
      }
    }
    logger_1.LauncherLogger.info(
      `[Sync] Synchronizing client: ${toDownload.length} to download, ${upToDateCount} up-to-date, ${toDelete.length} obsolete to delete.`,
    );
    // 5. Download missing/modified files
    const totalFiles = manifestFiles.length;
    let completedCount = upToDateCount;
    let totalBytes = toDownload.reduce((acc, f) => acc + (f.size || 0), 0);
    let bytesDownloaded = 0;
    if (toDownload.length > 0) {
      const concurrency = 6;
      async function cacheFile(fileEntry, cachePath, signal) {
        await (0, path_policy_1.checkPhysicalAncestry)(gameDir, cachePath, {
          disallowSymlinks: true,
          expectedCategory: "RESERVED_INTERNAL",
        });
        let url = fileEntry.download.url;
        const expectedSha256 = fileEntry.hashes.sha256;
        if (url.startsWith("/")) {
          const candidates = [
            path.join(__dirname, "../../pack/common", fileEntry.path),
            path.join(__dirname, "../../pack/client", fileEntry.path),
            path.join(
              __dirname,
              "../../pack/custom",
              path.basename(fileEntry.path),
            ),
          ];
          for (const c of candidates) {
            if (fs.existsSync(c)) {
              await (0, file_transfer_1.copyVerified)(c, cachePath, {
                expectedHash: expectedSha256,
                expectedSize: fileEntry.size,
                signal,
              });
              return 0;
            }
          }
          url = `${portalUrl}${url}`;
        }
        return (0, file_transfer_1.downloadVerified)(url, cachePath, {
          expectedHash: expectedSha256,
          expectedSize: fileEntry.size,
          headers: { "User-Agent": "Lampas-Launcher/1.0" },
          signal,
        });
      }
      await (0, async_pool_1.runBoundedPool)(
        toDownload,
        async (file, _index, signal) => {
          let downloadUrl = file.download.url;
          if (downloadUrl.startsWith("/")) {
            downloadUrl = `${portalUrl}${downloadUrl}`;
          }
          // Check blob cache first
          (0, path_policy_1.validateDigestString)(file.hashes.sha256, "sha256");
          let cached = false;
          const cachePath = path.join(
            cacheDir,
            file.hashes.sha256.substring(0, 2),
            file.hashes.sha256,
          );
          await (0, path_policy_1.checkPhysicalAncestry)(gameDir, cachePath, {
            disallowSymlinks: true,
            expectedCategory: "RESERVED_INTERNAL",
          });
          if (fs.existsSync(cachePath)) {
            const cachedHash = await (0, file_transfer_1.hashFile)(
              cachePath,
              "sha256",
            );
            if (
              cachedHash === file.hashes.sha256 &&
              fs.statSync(cachePath).size === file.size
            ) {
              cached = true;
            } else {
              await fs.promises.rm(cachePath, { force: true });
            }
          }
          let networkBytes = 0;
          if (!cached) {
            networkBytes = await cacheFile(file, cachePath, signal);
          }
          transferOutcomes.set(file.path, {
            artifactId: file.hashes.sha256,
            cacheVerified: true,
            destinationPath: path.join(gameDir, file.path),
            size: file.size,
            stage: "cached",
            operationId: syncGenerationId,
          });
          completedCount++;
          bytesDownloaded += networkBytes;
          const status = cached ? "⚡ [Cache Hit]" : "✓ [Downloaded]";
          const sizeBytes = fs.existsSync(cachePath)
            ? fs.statSync(cachePath).size
            : file.size || 0;
          const sizeKb = sizeBytes / 1024;
          logger_1.LauncherLogger.info(
            `  ${status} ${file.path} (${sizeKb.toFixed(1)} KB)`,
          );
          const percent = Math.min(
            95,
            Math.round(15 + (completedCount / totalFiles) * 80),
          );
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
        },
        { concurrency },
      );
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
        (0, path_policy_1.validateDigestString)(file.hashes.sha256, "sha256");
        const cachePath = path.join(
          cacheDir,
          file.hashes.sha256.substring(0, 2),
          file.hashes.sha256,
        );
        await (0, path_policy_1.checkPhysicalAncestry)(gameDir, cachePath, {
          disallowSymlinks: true,
          expectedCategory: "RESERVED_INTERNAL",
        });
        const destPath = (0, path_policy_1.resolveAndContainPath)(
          gameDir,
          file.path,
        );
        await (0, path_policy_1.checkPhysicalAncestry)(gameDir, destPath, {
          enforceOwnership: true,
          disallowSymlinks: true,
        });
        await (0, file_transfer_1.copyAtomic)(cachePath, destPath);
        logger_1.LauncherLogger.info(`  ✓ [Replaced] ${file.path}`);
        const outcome = transferOutcomes.get(file.path);
        if (outcome) {
          outcome.stage = "installed";
        }
      }
    }
    // 6. Delete obsolete managed files
    for (const relPath of toDelete) {
      try {
        const fullPath = (0, path_policy_1.resolveAndContainPath)(
          gameDir,
          relPath,
        );
        (0, path_policy_1.checkPhysicalAncestrySync)(gameDir, fullPath, {
          enforceOwnership: true,
        });
        if (fs.existsSync(fullPath)) {
          const lstat = fs.lstatSync(fullPath);
          if (lstat.isSymbolicLink()) {
            logger_1.LauncherLogger.warn(
              `[Sync] Refusing to delete symlink during obsolete file cleanup: ${relPath}`,
            );
            continue;
          }
          fs.unlinkSync(fullPath);
          logger_1.LauncherLogger.info(`  🗑 [Deleted Obsolete] ${relPath}`);
        }
      } catch (delErr) {
        logger_1.LauncherLogger.warn(
          `[Sync] Failed to safely delete obsolete file '${relPath}': ${delErr.message}`,
        );
      }
    }
    // 7. Reconcile required resource packs (fail hard if reconciliation fails)
    const currentReqPacks = releaseData?.launch?.requiredResourcePacks || [];
    const previousManaged = prevState.managedResourcePacks || [];
    const updatedManagedPacks = await (0,
    resource_packs_1.reconcileRequiredResourcePacks)(gameDir, {
      required: currentReqPacks,
      previousManaged,
    });
    if (updatedManagedPacks.length > 0) {
      logger_1.LauncherLogger.info(
        `  [Resource Pack Enabled] ${updatedManagedPacks.join(", ")}`,
      );
    }
    // 8. Post-mutation verification pass: verify existence, size, and SHA-256 for managed files
    for (const file of manifestFiles) {
      if ((file.policy || "MANAGED") === "MANAGED") {
        const localPath = path.join(gameDir, file.path);
        const stat = await fs.promises.stat(localPath).catch(() => null);
        if (!stat) {
          throw new Error(
            `Verification failed: managed file '${file.path}' is missing on disk.`,
          );
        }
        if (typeof file.size === "number" && stat.size !== file.size) {
          throw new Error(
            `Verification failed: size mismatch for '${file.path}' (expected ${file.size}, got ${stat.size})`,
          );
        }
        const wasDownloaded = stagedPathsSet.has(file.path);
        if (verificationMode === "full" || wasDownloaded) {
          const actualHash = await (0, file_transfer_1.hashFile)(
            localPath,
            "sha256",
          );
          if (actualHash.toLowerCase() !== file.hashes.sha256.toLowerCase()) {
            throw new Error(
              `Verification failed: SHA-256 mismatch for '${file.path}' (expected ${file.hashes.sha256}, got ${actualHash})`,
            );
          }
        }
        const outcome = transferOutcomes.get(file.path);
        if (outcome) {
          outcome.stage = "verified";
        }
        verifiedAt.set(file.path, new Date().toISOString());
      }
    }
    // 9. Reconcile config patches
    let updatedAppliedPatches = prevState.appliedConfigPatches || {};
    const configPatches = manifest.configPatches || [];
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
      const patchResult = await (0, config_patches_1.reconcileConfigPatches)({
        gameDir,
        patches: configPatches,
        prevState,
      });
      updatedAppliedPatches = patchResult.appliedState;
    }
    // 10. Write release descriptor and installation state only after successful mutations
    const releaseFilePath = path.join(stateDir, "release.json");
    await (0, path_policy_1.checkPhysicalAncestry)(gameDir, releaseFilePath, {
      disallowSymlinks: true,
      expectedCategory: "RESERVED_INTERNAL",
    });
    const releaseWithGen = {
      ...releaseData,
      syncGeneration: syncGenerationId,
    };
    // Atomic temporary publication for release.json - DO NOT swallow error!
    await (0, file_transfer_1.writeAtomicFile)(
      releaseFilePath,
      JSON.stringify(releaseWithGen, null, 2),
      { encoding: "utf-8" },
    );
    const newState = {
      pack: manifest.pack || releaseData.pack || "Lampas 2",
      version: targetVersion,
      installedAt: new Date().toISOString(),
      syncGeneration: syncGenerationId,
      releaseVersion: targetVersion,
      managedResourcePacks: updatedManagedPacks,
      appliedConfigPatches: updatedAppliedPatches,
      files: {},
    };
    for (const file of manifestFiles) {
      const filePath = path.join(gameDir, file.path);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      const previous = prevState.files[file.path];
      newState.files[file.path] = {
        sha256: file.hashes.sha256,
        size: file.size,
        policy: file.policy || "MANAGED",
        mtimeMs: stat?.mtimeMs,
        verifiedAt: verifiedAt.get(file.path) || previous?.verifiedAt,
      };
    }
    // Atomic temporary publication for installation.json
    await (0, path_policy_1.checkPhysicalAncestry)(gameDir, stateFile, {
      disallowSymlinks: true,
      expectedCategory: "RESERVED_INTERNAL",
    });
    await (0, file_transfer_1.writeAtomicFile)(
      stateFile,
      JSON.stringify(newState, null, 2),
      { encoding: "utf-8" },
    );
    logger_1.LauncherLogger.info(
      `[OK] Client successfully synchronized to ${newState.pack} v${targetVersion}!`,
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
  static async repairInstallation(onProgress, onLog) {
    const config = config_1.ConfigManager.get();
    const safetyContext = {
      origin: (0, config_1.normalizePortalUrl)(config.portalUrl),
      channel: config.selectedChannel || "stable",
      gameDir: config.gameDir,
    };
    // Commit the repair intent before changing any installation bytes. A
    // process crash cannot run the catch below; restart must still require
    // complete verification rather than trusting a partially repaired runtime.
    await (0, sync_safety_1.persistSyncSafetyBlock)(
      safetyContext,
      "INTEGRITY",
      new Error("Full repair has not completed verification."),
    );
    try {
      const result = await this.repairInstallationInternal(onProgress, onLog);
      (0, sync_safety_1.clearSyncSafetyBlock)(config.gameDir, {
        requireFullValidation: true,
      });
      return result;
    } catch (error) {
      // A repair that fails after pack synchronization still leaves the
      // installation incomplete. Preserve launch blocking for every repair
      // failure, including generic bootstrap and Java errors that may have
      // lost their original cause while being wrapped for the UI.
      await (0, sync_safety_1.persistSyncSafetyBlock)(
        safetyContext,
        "INTEGRITY",
        error,
      );
      throw error;
    }
  }
  static async repairInstallationInternal(onProgress, onLog) {
    const config = config_1.ConfigManager.get();
    const gameDir = config.gameDir;
    const log = (level, msg) => {
      if (onLog) {
        onLog({
          level,
          message: msg,
          timestamp: new Date().toLocaleTimeString(),
        });
      }
    };
    log(
      "INFO",
      "[Repair] Starting full installation repair and integrity verification...",
    );
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
    const syncResult = await this.runSyncWithSafety(
      (p) => {
        onProgress({
          ...p,
          status: "repairing",
          percent: Math.round(p.percent * 0.4), // 0% - 40%
        });
      },
      "full",
      false,
    );
    log(
      "INFO",
      `[Repair] Modpack files verified and repaired (${syncResult.packName} v${syncResult.version}).`,
    );
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
    await minecraft_bootstrap_1.MinecraftBootstrap.prepareGameEnvironment(
      gameDir,
      syncResult.runtime,
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
      "full",
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
    const javaExe = await java_runtime_1.JavaRuntimeManager.ensureJava25(
      gameDir,
      (msg) => log("INFO", msg),
      "full",
    );
    log("INFO", `[Repair] Java runtime verified: ${javaExe}`);
    onProgress({
      status: "complete",
      message:
        "Repair complete! All modpack files, assets, and libraries are verified.",
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
  static async getModCatalog() {
    const config = config_1.ConfigManager.get();
    const portalUrl = (0, config_1.normalizePortalUrl)(config.portalUrl);
    const channel = config.selectedChannel || "stable";
    try {
      const channelData = (0, metadata_policy_1.validateChannelResponse)(
        await (0, file_transfer_1.fetchPortalJsonWithRetry)(
          `${portalUrl}/api/v1/channels/${channel}`,
        ),
        channel,
      );
      const release = (0, metadata_policy_1.validateReleaseDescriptor)(
        await (0, file_transfer_1.fetchPortalJsonWithRetry)(
          metadataUrl(portalUrl, channelData.release, "channel release"),
        ),
      );
      if (release.version !== channelData.version) {
        throw new Error("Channel and release versions do not match.");
      }
      const manifest = await (0, file_transfer_1.fetchPortalJsonWithRetry)(
        metadataUrl(
          portalUrl,
          release.clientManifest,
          "release client manifest",
        ),
      );
      (0, metadata_policy_1.validateClientManifest)(manifest, release);
      if (Array.isArray(manifest.mods))
        return this.decorateModCatalog(manifest.mods);
    } catch (error) {
      if (!(0, metadata_policy_1.isTransientMetadataFetchFailure)(error))
        throw error;
    }
    const localManifestPath = path.join(
      __dirname,
      "../../manifest/client-manifest.json",
    );
    if (fs.existsSync(localManifestPath)) {
      try {
        const localReleasePath = path.join(
          __dirname,
          "../../manifest/release.json",
        );
        const release = (0, metadata_policy_1.validateReleaseDescriptor)(
          JSON.parse(fs.readFileSync(localReleasePath, "utf-8")),
        );
        const manifest = JSON.parse(
          fs.readFileSync(localManifestPath, "utf-8"),
        );
        (0, metadata_policy_1.validateClientManifest)(manifest, release);
        return this.decorateModCatalog(manifest.mods || []);
      } catch (error) {
        throw new Error(
          "Local metadata is invalid; refusing to return an unvalidated mod catalog.",
          { cause: error },
        );
      }
    }
    return [];
  }
  static decorateModCatalog(mods) {
    const config = config_1.ConfigManager.get();
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
      description:
        "Local client mod. Preserved when the Lampas pack synchronizes.",
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
exports.LauncherSync = LauncherSync;
