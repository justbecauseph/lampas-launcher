import * as fs from "node:fs";
import * as path from "node:path";
import { listPreexistingEntries } from "./game-files-removal";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ConfigManager,
  getDefaultGameDir,
  getStoreRedirectedPath,
  getUserDataDir,
  isDefaultGameDirAppStorage,
} from "./config";
import { GameRunner } from "./game-runner";
import { LauncherLogger } from "./logger";
import { writeAtomicFileSync } from "./file-transfer";
import { runBoundedPool } from "./async-pool";
import {
  checkPhysicalAncestrySync,
  getCanonicalDiskPath,
  isSafeRelativePath,
  isValidDigestString,
  normalizePathKey,
  PathContainmentError,
  resolveAndContainPath,
} from "./path-policy";
import type {
  DirectoryMoveProgress,
  DirectoryMoveResult,
  DirectoryStatus,
  DirectoryValidationResult,
  LauncherConfig,
} from "./types";

export interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

export interface ScannedDirectoryInventory {
  files: ScannedFile[];
  directories: string[];
  totalBytes: number;
}

export const MOVE_RECEIPT_FILENAME = ".lampas_move_receipt.json";
export const STAGING_MARKER_FILENAME = ".lampas_staging_marker.json";

function movePathEquals(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function movePathsAreDisjoint(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (movePathEquals(resolvedLeft, resolvedRight)) return false;

  const leftToRight = path.relative(resolvedLeft, resolvedRight);
  const rightToLeft = path.relative(resolvedRight, resolvedLeft);
  const isInside = (relative: string) =>
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  return !isInside(leftToRight) && !isInside(rightToLeft);
}

function hasMoveMetadataIdentity(data: any, metadataDir: string): boolean {
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.operationId !== "string" ||
    !/^[0-9A-Za-z_-]{8,64}$/.test(data.operationId) ||
    typeof data.source !== "string" ||
    typeof data.target !== "string" ||
    typeof data.staging !== "string" ||
    typeof data.timestamp !== "string" ||
    Number.isNaN(Date.parse(data.timestamp)) ||
    !path.isAbsolute(data.source) ||
    !path.isAbsolute(data.target) ||
    !path.isAbsolute(data.staging)
  ) {
    return false;
  }

  const source = path.resolve(data.source);
  const target = path.resolve(data.target);
  const staging = path.resolve(data.staging);
  const expectedStagingName = `.lampas-moving-${data.operationId}`;
  if (
    path.basename(staging) !== expectedStagingName ||
    !movePathsAreDisjoint(source, target)
  ) {
    return false;
  }

  const sourceParent = path.dirname(source);
  const targetParent = path.dirname(target);
  const stagingParent = path.dirname(staging);
  if (
    !movePathEquals(stagingParent, sourceParent) &&
    !movePathEquals(stagingParent, targetParent)
  ) {
    return false;
  }

  // A metadata file is launcher-owned only when the directory containing the file
  // is one of this operation's three exact roots.
  return (
    movePathEquals(metadataDir, source) ||
    movePathEquals(metadataDir, target) ||
    movePathEquals(metadataDir, staging)
  );
}

/**
 * Classifies whether a scanned file is a legitimate launcher move-operation metadata
 * file (one that should be excluded from the payload), a non-metadata file (payload),
 * or a foreign/malformed entry that should block the operation.
 *
 * The classification requires that the file's content matches the expected schema
 * AND that the source/target paths in the metadata belong to the same base directory
 * as the current operation. This prevents silently dropping user files that happen
 * to share a metadata filename.
 */
export function classifyMoveMetadata(
  file: ScannedFile,
  baseDir: string,
): "NOT_METADATA" | "LEGITIMATE" | "MALFORMED_OR_FOREIGN" {
  const name = file.relativePath;
  if (name !== STAGING_MARKER_FILENAME && name !== MOVE_RECEIPT_FILENAME) {
    return "NOT_METADATA";
  }

  // Bind the scanned record to the directory supplied by the inventory caller;
  // do not let a self-declared metadata path authorize reading a different file.
  const expectedPath = path.resolve(baseDir, name);
  if (!movePathEquals(file.absolutePath, expectedPath))
    return "MALFORMED_OR_FOREIGN";

  // It has a metadata filename. Now inspect its content.
  try {
    const raw = fs.readFileSync(file.absolutePath, "utf-8");
    const data = JSON.parse(raw);
    const metadataDir = path.dirname(path.resolve(file.absolutePath));

    if (name === STAGING_MARKER_FILENAME) {
      // Must have the required StagingMarker fields
      if (!hasMoveMetadataIdentity(data, metadataDir)) {
        return "MALFORMED_OR_FOREIGN";
      }
      return "LEGITIMATE";
    }

    if (name === MOVE_RECEIPT_FILENAME) {
      // Must have the required MoveReceipt fields
      if (
        !hasMoveMetadataIdentity(data, metadataDir) ||
        data.version !== 2 ||
        typeof data.fileCount !== "number" ||
        !Number.isInteger(data.fileCount) ||
        data.fileCount < 0 ||
        typeof data.totalBytes !== "number" ||
        !Number.isFinite(data.totalBytes) ||
        data.totalBytes < 0 ||
        !Number.isInteger(data.totalBytes) ||
        !Array.isArray(data.directories) ||
        !Array.isArray(data.files) ||
        data.files.length !== data.fileCount ||
        data.stagingVerified !== true
      ) {
        return "MALFORMED_OR_FOREIGN";
      }

      let totalBytes = 0;
      const fileKeys = new Set<string>();
      for (const entry of data.files) {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.relativePath !== "string" ||
          !isSafeRelativePath(entry.relativePath) ||
          typeof entry.size !== "number" ||
          !Number.isInteger(entry.size) ||
          entry.size < 0 ||
          !isValidDigestString(entry.sha256, "sha256")
        ) {
          return "MALFORMED_OR_FOREIGN";
        }
        const fileKey = normalizePathKey(entry.relativePath);
        if (fileKeys.has(fileKey)) return "MALFORMED_OR_FOREIGN";
        fileKeys.add(fileKey);
        totalBytes += entry.size;
      }
      if (totalBytes !== data.totalBytes) {
        return "MALFORMED_OR_FOREIGN";
      }

      const directoryKeys = new Set<string>();
      for (const directory of data.directories) {
        if (typeof directory !== "string" || !isSafeRelativePath(directory))
          return "MALFORMED_OR_FOREIGN";
        const directoryKey = normalizePathKey(directory);
        if (directoryKeys.has(directoryKey)) return "MALFORMED_OR_FOREIGN";
        directoryKeys.add(directoryKey);
      }
      return "LEGITIMATE";
    }
  } catch {
    return "MALFORMED_OR_FOREIGN";
  }

  return "MALFORMED_OR_FOREIGN";
}

export interface StagingMarker {
  operationId: string;
  source: string;
  target: string;
  staging: string;
  timestamp: string;
}

export function writeStagingMarker(
  stagingDir: string,
  marker: StagingMarker,
): void {
  const markerPath = path.join(stagingDir, STAGING_MARKER_FILENAME);
  writeAtomicFileSync(markerPath, JSON.stringify(marker, null, 2));
}

export function readStagingMarker(stagingDir: string): StagingMarker | null {
  try {
    const markerPath = path.join(stagingDir, STAGING_MARKER_FILENAME);
    if (!fs.existsSync(markerPath)) return null;
    const data = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    if (
      data &&
      typeof data === "object" &&
      typeof data.operationId === "string"
    ) {
      return data as StagingMarker;
    }
    return null;
  } catch {
    return null;
  }
}

export async function authorizeAndRemoveStaging(journal: {
  staging: string;
  operationId: string;
  source: string;
  target: string;
}): Promise<boolean> {
  if (!fs.existsSync(journal.staging)) return false;

  try {
    const stagingStat = await fs.promises.lstat(journal.staging);
    if (
      stagingStat.isSymbolicLink() ||
      stagingStat.isFIFO() ||
      stagingStat.isSocket() ||
      stagingStat.isCharacterDevice() ||
      stagingStat.isBlockDevice()
    ) {
      LauncherLogger.error(
        `Move recovery: staging directory '${journal.staging}' is a symlink or special file. Refusing deletion.`,
      );
      return false;
    }
  } catch (err: any) {
    LauncherLogger.error(
      `Move recovery: cannot lstat staging directory '${journal.staging}': ${err.message}`,
    );
    return false;
  }

  // Verify staging ownership marker
  const marker = readStagingMarker(journal.staging);
  if (
    !marker ||
    marker.operationId !== journal.operationId ||
    marker.source !== journal.source ||
    marker.target !== journal.target
  ) {
    LauncherLogger.warn(
      `Move recovery: staging directory '${journal.staging}' lacks matching operation ownership marker for operation ${journal.operationId}. Preserving staging directory without deletion.`,
    );
    return false;
  }

  // Verify physical ancestry within target or source parent
  try {
    const parent = path.dirname(journal.staging);
    checkPhysicalAncestrySync(parent, journal.staging, {
      disallowSymlinks: true,
      enforceOwnership: false,
    });
  } catch (err: any) {
    LauncherLogger.error(
      `Move recovery: staging directory failed physical ancestry check: ${err.message}. Preserving staging directory.`,
    );
    return false;
  }

  try {
    await fs.promises.rm(journal.staging, { recursive: true, force: true });
    return true;
  } catch (err: any) {
    LauncherLogger.warn(
      `Move recovery: failed to remove staging directory '${journal.staging}': ${err.message}`,
    );
    return false;
  }
}

export interface MoveReceiptFileEntry {
  relativePath: string;
  size: number;
  sha256: string;
}

export interface MoveReceipt {
  version: 2;
  operationId: string;
  source: string;
  target: string;
  staging: string;
  fileCount: number;
  totalBytes: number;
  directories: string[];
  files: MoveReceiptFileEntry[];
  stagingVerified: boolean;
  timestamp: string;
}

export function readMoveReceipt(
  dir: string,
  expectedOpId?: string,
): MoveReceipt | null {
  try {
    const receiptPath = path.join(dir, MOVE_RECEIPT_FILENAME);
    if (!fs.existsSync(receiptPath)) return null;
    const data = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
    if (
      data &&
      typeof data === "object" &&
      data.stagingVerified === true &&
      (!expectedOpId || data.operationId === expectedOpId)
    ) {
      return data as MoveReceipt;
    }
    return null;
  } catch {
    return null;
  }
}

export interface DirectoryMoveJournal {
  version: 2;
  operationId: string;
  source: string;
  target: string;
  staging: string;
  phase:
    | "preparing"
    | "renaming"
    | "copying"
    | "verifying"
    | "finalizing"
    | "cleaning";
  timestamp: string;
  stagingVerified?: boolean;
  stagingReceipt?: {
    fileCount: number;
    totalBytes: number;
  };
}

interface AnyMoveJournal {
  version?: number;
  operationId?: string;
  source: string;
  target: string;
  staging: string;
  phase:
    | "preparing"
    | "renaming"
    | "copying"
    | "verifying"
    | "finalizing"
    | "cleaning";
  timestamp?: string;
  stagingVerified?: boolean;
  stagingReceipt?: {
    fileCount: number;
    totalBytes: number;
  };
}

/**
 * Asynchronously traverses a directory to build a complete inventory of regular files
 * and directories (including empty directories) while validating metadata.
 *
 * Invariants:
 * - Links (symlinks, junctions) and special files (FIFOs, sockets, devices) fail closed with a clear error
 *   to guarantee no silent omission or data loss.
 * - Unreadable entries fail closed before source deletion.
 * - Flat collection into pre-allocated lists avoiding repeated array concatenation.
 */
export async function scanDirectoryAsync(
  dir: string,
  baseDir: string = dir,
): Promise<ScannedDirectoryInventory> {
  const files: ScannedFile[] = [];
  const directories: string[] = [];
  let totalBytes = 0;

  async function traverse(currentDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (err: any) {
      throw new Error(
        `Failed to read directory at ${currentDir}: ${err.message}`,
      );
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(baseDir, fullPath);

      let lstat: fs.Stats;
      try {
        lstat = await fs.promises.lstat(fullPath);
      } catch (err: any) {
        throw new Error(
          `Unreadable entry encountered at ${fullPath}: ${err.message}`,
        );
      }

      if (
        lstat.isSymbolicLink() ||
        lstat.isFIFO() ||
        lstat.isSocket() ||
        lstat.isCharacterDevice() ||
        lstat.isBlockDevice()
      ) {
        throw new Error(
          `Unsupported file type (symlink or special file) encountered at ${relPath}. Cannot safely move directory without data loss.`,
        );
      }

      if (lstat.isDirectory()) {
        directories.push(relPath);
        await traverse(fullPath);
      } else if (lstat.isFile()) {
        files.push({
          relativePath: relPath,
          absolutePath: fullPath,
          size: lstat.size,
          mode: lstat.mode,
          atimeMs: lstat.atimeMs,
          mtimeMs: lstat.mtimeMs,
        });
        totalBytes += lstat.size;
      }
    }
  }

  if (fs.existsSync(dir)) {
    const rootStat = await fs.promises.lstat(dir);
    if (
      rootStat.isSymbolicLink() ||
      rootStat.isFIFO() ||
      rootStat.isSocket() ||
      rootStat.isCharacterDevice() ||
      rootStat.isBlockDevice()
    ) {
      throw new Error(
        `Unsupported file type (symlink or special file) encountered at directory root '${dir}'. Cannot safely move or scan directory.`,
      );
    }
    await traverse(dir);
  }

  return { files, directories, totalBytes };
}

/**
 * Synchronous scan fallback for compatibility.
 */
export function scanDirectory(
  dir: string,
  baseDir: string = dir,
): ScannedFile[] {
  let results: ScannedFile[] = [];
  if (!fs.existsSync(dir)) return results;
  const rootStat = fs.lstatSync(dir);
  if (
    rootStat.isSymbolicLink() ||
    rootStat.isFIFO() ||
    rootStat.isSocket() ||
    rootStat.isCharacterDevice() ||
    rootStat.isBlockDevice()
  ) {
    throw new Error(
      `Unsupported file type (symlink or special file) encountered at directory root '${dir}'. Cannot safely scan directory.`,
    );
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(scanDirectory(fullPath, baseDir));
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        results.push({
          relativePath: path.relative(baseDir, fullPath),
          absolutePath: fullPath,
          size: stat.size,
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable files in legacy helper
      }
    }
  }
  return results;
}

/**
 * Computes SHA-256 digest asynchronously by streaming the file from disk.
 */
export async function computeFileSha256Async(
  filePath: string,
): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Computes SHA-256 digest synchronously.
 */
export function computeFileSha256(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Streams a regular file from src to dest once while computing its SHA-256 digest in-flight.
 * Eliminates redundant source pre-hash passes.
 */
export async function streamCopyAndHash(
  src: string,
  dest: string,
): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const readStream = fs.createReadStream(src);
  const writeStream = fs.createWriteStream(dest);

  await pipeline(
    readStream,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    writeStream,
  );

  return { hash: hash.digest("hex"), bytes };
}

/**
 * Checks for external modification of the source tree during the move operation.
 * Returns true if source drift was detected.
 */
export async function checkSourceDrift(
  sourceDir: string,
  originalFiles: ScannedFile[],
): Promise<boolean> {
  let currentInventory: ScannedDirectoryInventory;
  try {
    currentInventory = await scanDirectoryAsync(sourceDir);
  } catch {
    return true; // Drift or unreadable
  }

  const currentPayloadFiles: ScannedFile[] = [];
  for (const f of currentInventory.files) {
    const cls = classifyMoveMetadata(f, sourceDir);
    // Treat malformed/foreign reserved-name files as drift. They must never be
    // filtered out before the source deletion decision.
    if (cls === "MALFORMED_OR_FOREIGN") return true;
    if (cls === "NOT_METADATA") currentPayloadFiles.push(f);
  }

  if (currentPayloadFiles.length !== originalFiles.length) {
    return true;
  }

  const originalMap = new Map(originalFiles.map((f) => [f.relativePath, f]));
  for (const curr of currentPayloadFiles) {
    const orig = originalMap.get(curr.relativePath);
    if (!orig) return true; // new file added
    if (orig.size !== curr.size || Math.abs(orig.mtimeMs - curr.mtimeMs) > 1) {
      return true; // file modified
    }
  }

  return false;
}

/**
 * Determines whether an error from fs.rename is a recognized cross-device boundary
 * requiring staged copy fallback, rather than an arbitrary permission or lock error.
 */
export function isCrossDeviceError(err: any): boolean {
  if (!err) return false;
  if (err.code === "EXDEV") return true;
  if (err.code === "ENOTSUP" || err.code === "EOPNOTSUPP") return true;
  if (typeof err.message === "string") {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("cross-device") ||
      msg.includes("different volume") ||
      msg.includes("exdev")
    ) {
      return true;
    }
  }
  return false;
}

function checkWritable(targetPath: string): boolean {
  try {
    let checkDir = targetPath;
    while (checkDir && !fs.existsSync(checkDir)) {
      const parent = path.dirname(checkDir);
      if (parent === checkDir) break;
      checkDir = parent;
    }
    if (!fs.existsSync(checkDir)) return false;

    const probeFile = path.join(
      checkDir,
      `.lampas-write-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.writeFileSync(probeFile, "test");
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    return false;
  }
}

export class GameDirectoryManager {
  static _renameFn: (src: string, dest: string) => Promise<void> | void =
    async (src, dest) => {
      await fs.promises.rename(src, dest);
    };
  static _copyFn: (src: string, dest: string) => Promise<void> | void =
    fs.copyFileSync;

  static resetForTesting(): void {
    this._renameFn = async (src, dest) => {
      await fs.promises.rename(src, dest);
    };
    this._copyFn = fs.copyFileSync;
    this.resolveRecoveryHold();
  }

  /**
   * Removes the durable recovery hold file written by quarantineJournal.
   * Call this after manual inspection and resolution of the interrupted move.
   */
  static resolveRecoveryHold(): void {
    try {
      const holdPath = path.join(getUserDataDir(), RECOVERY_HOLD_FILENAME);
      if (fs.existsSync(holdPath)) {
        fs.unlinkSync(holdPath);
        LauncherLogger.info(
          `[Move Recovery] Recovery hold resolved; launcher operations re-enabled.`,
        );
      }
    } catch (err: any) {
      LauncherLogger.warn(
        `[Move Recovery] Failed to resolve recovery hold: ${err.message}`,
      );
    }
  }

  static getDefaultPath(): string {
    return getDefaultGameDir();
  }

  static needsInitialSetup(): boolean {
    const config = ConfigManager.get();
    return !config.gameDirConfigured;
  }

  static getStatus(): DirectoryStatus {
    const config = ConfigManager.get();
    const gameDir = config.gameDir || this.getDefaultPath();
    const exists = fs.existsSync(gameDir);
    const hasInstallation =
      exists &&
      fs.existsSync(path.join(gameDir, ".lampas", "installation.json"));

    return {
      gameDir,
      isConfigured: !!config.gameDirConfigured,
      defaultGameDir: this.getDefaultPath(),
      defaultIsAppStorage: isDefaultGameDirAppStorage(),
      exists,
      hasInstallation,
    };
  }

  static validateTarget(
    targetPath: string,
    currentPath?: string,
  ): DirectoryValidationResult {
    if (
      !targetPath ||
      typeof targetPath !== "string" ||
      targetPath.trim().length === 0
    ) {
      return { valid: false, reason: "Target directory path cannot be empty." };
    }

    const trimmed = targetPath.trim();
    if (
      /^[a-zA-Z]:[\\/]?$/.test(trimmed) ||
      trimmed === "/" ||
      trimmed === "\\"
    ) {
      return {
        valid: false,
        reason: "Target directory cannot be a root drive directory.",
      };
    }

    const resolvedTarget = path.resolve(trimmed);
    const parsed = path.parse(resolvedTarget);

    // Reject filesystem roots (e.g. C:\, /, D:\)
    if (
      parsed.root.toLowerCase() === resolvedTarget.toLowerCase() ||
      /^[a-zA-Z]:[\\/]?$/.test(resolvedTarget) ||
      resolvedTarget === "/"
    ) {
      return {
        valid: false,
        reason: "Target directory cannot be a root drive directory.",
      };
    }

    // If target exists on disk, it must not be a symlink or special file
    if (fs.existsSync(resolvedTarget)) {
      try {
        const stat = fs.lstatSync(resolvedTarget);
        if (
          stat.isSymbolicLink() ||
          stat.isFIFO() ||
          stat.isSocket() ||
          stat.isCharacterDevice() ||
          stat.isBlockDevice()
        ) {
          return {
            valid: false,
            reason:
              "Target directory cannot be a symbolic link or special file.",
          };
        }
        if (!stat.isDirectory()) {
          return {
            valid: false,
            reason: "Target path exists but is not a directory.",
          };
        }
      } catch (err: any) {
        return {
          valid: false,
          reason: `Cannot inspect target directory: ${err.message}`,
        };
      }
    }

    const canonTarget = getCanonicalDiskPath(resolvedTarget);
    const parsedCanon = path.parse(canonTarget);
    if (parsedCanon.root.toLowerCase() === canonTarget.toLowerCase()) {
      return {
        valid: false,
        reason: "Target directory cannot resolve to a root drive directory.",
      };
    }

    // Check relationship with currentPath
    if (currentPath) {
      const resolvedCurrent = path.resolve(currentPath);
      const isWindows = process.platform === "win32";

      // 1. Lexical comparison
      const cmpLexCurrent = isWindows
        ? resolvedCurrent.toLowerCase()
        : resolvedCurrent;
      const cmpLexTarget = isWindows
        ? resolvedTarget.toLowerCase()
        : resolvedTarget;
      if (cmpLexCurrent === cmpLexTarget) {
        return {
          valid: false,
          reason:
            "Target directory is the same as the current installation directory.",
        };
      }

      const relToTarget = path.relative(resolvedCurrent, resolvedTarget);
      if (
        !relToTarget.startsWith("..") &&
        !path.isAbsolute(relToTarget) &&
        relToTarget !== ""
      ) {
        return {
          valid: false,
          reason:
            "Target directory cannot be inside the current installation directory.",
        };
      }

      const relToCurrent = path.relative(resolvedTarget, resolvedCurrent);
      if (
        !relToCurrent.startsWith("..") &&
        !path.isAbsolute(relToCurrent) &&
        relToCurrent !== ""
      ) {
        return {
          valid: false,
          reason:
            "Current installation directory cannot be inside the target directory.",
        };
      }

      // 2. Physical canonical comparison (handles symlinks, junctions, 8.3 aliases)
      const canonCurrent = getCanonicalDiskPath(resolvedCurrent);
      const cmpCanonTarget = isWindows
        ? canonTarget.toLowerCase()
        : canonTarget;
      const cmpCanonCurrent = isWindows
        ? canonCurrent.toLowerCase()
        : canonCurrent;

      if (cmpCanonCurrent === cmpCanonTarget) {
        return {
          valid: false,
          reason:
            "Target directory physically aliases the current installation directory.",
        };
      }

      const currentPrefix = cmpCanonCurrent.endsWith(path.sep)
        ? cmpCanonCurrent
        : cmpCanonCurrent + path.sep;
      const targetPrefix = cmpCanonTarget.endsWith(path.sep)
        ? cmpCanonTarget
        : cmpCanonTarget + path.sep;

      if (cmpCanonTarget.startsWith(currentPrefix)) {
        return {
          valid: false,
          reason:
            "Target directory cannot be inside the current installation directory.",
        };
      }

      if (cmpCanonCurrent.startsWith(targetPrefix)) {
        return {
          valid: false,
          reason:
            "Current installation directory cannot be inside the target directory.",
        };
      }
    }

    // Store (MSIX) installs: Windows keeps folders the launcher creates under
    // AppData private to the package, where Minecraft can't see them, and
    // deletes them on uninstall. A move always recreates its target, so it
    // can't go there. First-run setup may adopt a folder that already exists
    // there for real, such as one left by a non-Store build.
    const redirectedTarget = getStoreRedirectedPath(resolvedTarget);
    if (
      redirectedTarget &&
      (currentPath !== undefined ||
        !fs.existsSync(resolvedTarget) ||
        fs.existsSync(redirectedTarget))
    ) {
      return {
        valid: false,
        reason:
          "This folder is inside AppData. Windows keeps new folders there private to the Store launcher, so Minecraft can't use them. Choose a folder outside AppData, for example on another drive.",
      };
    }

    // Check writability
    if (!checkWritable(resolvedTarget)) {
      return {
        valid: false,
        reason: "Target location is not writable or access is denied.",
      };
    }

    return { valid: true };
  }

  static async configureInitial(targetPath: string): Promise<LauncherConfig> {
    if (ConfigManager.get().gameDirConfigured) {
      throw new Error(
        "Game directory is already configured; use Move Installation.",
      );
    }

    const validation = this.validateTarget(targetPath);
    if (!validation.valid) {
      throw new Error(validation.reason || "Invalid game directory target.");
    }

    const resolved = path.resolve(targetPath.trim());
    // A folder that already holds things: remember them so Settings >
    // Remove game files never deletes them.
    const preexisting = await listPreexistingEntries(resolved);
    if (!fs.existsSync(resolved)) {
      await fs.promises.mkdir(resolved, { recursive: true });
    }

    return ConfigManager.set({
      gameDir: resolved,
      gameDirConfigured: true,
      gameDirPreexistingEntries: preexisting,
    });
  }

  static async moveInstallation(
    targetPath: string,
    onProgress?: (progress: DirectoryMoveProgress) => void,
    signal?: AbortSignal,
  ): Promise<DirectoryMoveResult> {
    if (GameRunner.isGameRunning()) {
      throw new Error("Cannot move installation while Minecraft is running.");
    }

    if (signal?.aborted) {
      throw new Error("Move operation aborted.");
    }

    const config = ConfigManager.get();
    const source = path.resolve(config.gameDir);
    const target = path.resolve(targetPath);

    const validation = this.validateTarget(target, source);
    if (!validation.valid) {
      throw new Error(validation.reason || "Invalid target directory");
    }

    // Strictly validate existing target directory:
    // If target exists and is empty, remove it before renaming so rename does not fail.
    if (fs.existsSync(target)) {
      const entries = await fs.promises.readdir(target);
      if (entries.length > 0) {
        throw new Error("Target directory already exists and is not empty.");
      }
      await fs.promises.rmdir(target);
    }

    // If source directory doesn't exist on disk (e.g. moved prior to first sync)
    if (!fs.existsSync(source)) {
      await fs.promises.mkdir(target, { recursive: true });
      ConfigManager.set({ gameDir: target, gameDirConfigured: true });
      onProgress?.({
        phase: "complete",
        filesCompleted: 0,
        totalFiles: 0,
        bytesCompleted: 0,
        totalBytes: 0,
        percent: 100,
      });
      return { success: true, gameDir: target, previousGameDir: source };
    }

    const userDataDir = getUserDataDir();
    if (!fs.existsSync(userDataDir)) {
      await fs.promises.mkdir(userDataDir, { recursive: true });
    }
    const journalPath = path.join(userDataDir, "directory-move.json");
    const targetParent = path.dirname(target);
    if (!fs.existsSync(targetParent)) {
      await fs.promises.mkdir(targetParent, { recursive: true });
    }

    const operationNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const staging = path.join(targetParent, `.lampas-moving-${operationNonce}`);

    const journalData: DirectoryMoveJournal = {
      version: 2,
      operationId: operationNonce,
      source,
      target,
      staging,
      phase: "preparing",
      timestamp: new Date().toISOString(),
    };

    writeAtomicFileSync(journalPath, JSON.stringify(journalData, null, 2));

    onProgress?.({
      phase: "preparing",
      filesCompleted: 0,
      totalFiles: 0,
      bytesCompleted: 0,
      totalBytes: 0,
      percent: 0,
    });

    // 1. Try fast same-filesystem rename with explicit state transition
    journalData.phase = "renaming";
    writeAtomicFileSync(journalPath, JSON.stringify(journalData, null, 2));

    let directRenameSuccess = false;
    try {
      await this._renameFn(source, target);
      directRenameSuccess = true;
    } catch (renameErr: any) {
      if (isCrossDeviceError(renameErr)) {
        LauncherLogger.info(
          `Direct rename failed due to cross-device boundary (${renameErr.code || renameErr.message}); proceeding to staged copy.`,
        );
      } else {
        LauncherLogger.error(
          `Direct rename failed with fatal error (${renameErr.code || renameErr.message}): ${renameErr.message}`,
        );
        throw renameErr;
      }
    }

    if (directRenameSuccess) {
      journalData.phase = "finalizing";
      writeAtomicFileSync(journalPath, JSON.stringify(journalData, null, 2));

      ConfigManager.set({ gameDir: target, gameDirConfigured: true });
      if (fs.existsSync(journalPath)) {
        try {
          await fs.promises.unlink(journalPath);
        } catch {}
      }
      onProgress?.({
        phase: "complete",
        filesCompleted: 0,
        totalFiles: 0,
        bytesCompleted: 0,
        totalBytes: 0,
        percent: 100,
      });
      return { success: true, gameDir: target, previousGameDir: source };
    }

    // 2. Fallback: Copy to staging + SHA-256 hash verify + atomic rename staging to target + cleanup source
    try {
      journalData.phase = "copying";
      writeAtomicFileSync(journalPath, JSON.stringify(journalData, null, 2));

      const rawInventory = await scanDirectoryAsync(source);
      const payloadFiles: ScannedFile[] = [];
      for (const f of rawInventory.files) {
        const cls = classifyMoveMetadata(f, source);
        if (cls === "MALFORMED_OR_FOREIGN") {
          throw new Error(
            `Move aborted: source directory contains a foreign or malformed metadata file '${f.relativePath}'. ` +
              `Remove or inspect this file before proceeding to prevent data loss.`,
          );
        }
        if (cls === "NOT_METADATA") {
          payloadFiles.push(f);
        }
        // LEGITIMATE metadata files are excluded from the payload (they are move artifacts)
      }
      const payloadDirectories = rawInventory.directories;
      const totalFiles = payloadFiles.length;
      const totalBytes = payloadFiles.reduce((sum, f) => sum + f.size, 0);
      const sourceHashes = new Map<string, string>();
      let filesCompleted = 0;
      let bytesCompleted = 0;

      await fs.promises.mkdir(staging, { recursive: true });
      writeStagingMarker(staging, {
        operationId: operationNonce,
        source,
        target,
        staging,
        timestamp: new Date().toISOString(),
      });

      // Recreate all directory structures (including empty directories)
      for (const dirRel of payloadDirectories) {
        await fs.promises.mkdir(path.join(staging, dirRel), {
          recursive: true,
        });
      }

      // Copy files with bounded concurrency (concurrency 6)
      await runBoundedPool(
        payloadFiles,
        async (file) => {
          if (signal?.aborted) {
            throw new Error("Move operation aborted.");
          }

          const destPath = path.join(staging, file.relativePath);
          const destDir = path.dirname(destPath);
          if (!fs.existsSync(destDir)) {
            await fs.promises.mkdir(destDir, { recursive: true });
          }

          let sourceHash: string;
          if (this._copyFn !== fs.copyFileSync) {
            sourceHash = await computeFileSha256Async(file.absolutePath);
            await this._copyFn(file.absolutePath, destPath);
          } else {
            const streamRes = await streamCopyAndHash(
              file.absolutePath,
              destPath,
            );
            sourceHash = streamRes.hash;
          }

          sourceHashes.set(file.relativePath, sourceHash);

          try {
            await fs.promises.utimes(
              destPath,
              file.atimeMs / 1000,
              file.mtimeMs / 1000,
            );
          } catch {}

          if (process.platform !== "win32") {
            try {
              await fs.promises.chmod(destPath, file.mode);
            } catch {}
          }

          filesCompleted++;
          bytesCompleted += file.size;

          onProgress?.({
            phase: "moving",
            filesCompleted,
            totalFiles,
            bytesCompleted,
            totalBytes,
            currentFile: file.relativePath,
            percent:
              totalBytes > 0
                ? Math.min(99, Math.round((bytesCompleted / totalBytes) * 100))
                : 99,
          });
        },
        { concurrency: 6, signal },
      );

      // 3. Verify copied tree: file counts, directories, sizes, and independent destination readback SHA-256 hashes
      journalData.phase = "verifying";
      writeAtomicFileSync(journalPath, JSON.stringify(journalData, null, 2));

      onProgress?.({
        phase: "verifying",
        filesCompleted,
        totalFiles,
        bytesCompleted,
        totalBytes,
        percent: 99,
      });

      const stagedInventory = await scanDirectoryAsync(staging);
      const stagedPayloadFiles = payloadFilesOrThrow(
        stagedInventory,
        staging,
        "staging directory",
      );
      if (stagedPayloadFiles.length !== totalFiles) {
        throw new Error(
          `Verification failed: Expected ${totalFiles} files, but staging has ${stagedPayloadFiles.length} files.`,
        );
      }

      // Verify all empty directories exist in staging
      for (const dirRel of payloadDirectories) {
        const stagedDirPath = path.join(staging, dirRel);
        if (!fs.existsSync(stagedDirPath)) {
          throw new Error(
            `Verification failed: missing directory ${dirRel} in staging.`,
          );
        }
      }

      const stagedMap = new Map(
        stagedPayloadFiles.map((f) => [f.relativePath, f.size]),
      );

      // Verify destination readback with bounded concurrency (concurrency 4)
      await runBoundedPool(
        payloadFiles,
        async (file) => {
          if (signal?.aborted) {
            throw new Error("Move operation aborted.");
          }

          const stagedSize = stagedMap.get(file.relativePath);
          if (stagedSize === undefined || stagedSize !== file.size) {
            throw new Error(
              `Verification failed for file: ${file.relativePath} (size mismatch: original ${file.size}, copied ${stagedSize})`,
            );
          }

          const expectedHash = sourceHashes.get(file.relativePath);
          const stagedFilePath = path.join(staging, file.relativePath);
          const actualHash = await computeFileSha256Async(stagedFilePath);
          if (expectedHash && actualHash !== expectedHash) {
            throw new Error(
              `Verification failed for file: ${file.relativePath} (content SHA-256 mismatch: expected ${expectedHash}, got ${actualHash})`,
            );
          }
        },
        { concurrency: 4, signal },
      );

      // 4. Check for source drift before finalizing
      const drifted = await checkSourceDrift(source, payloadFiles);
      if (drifted) {
        throw new Error(
          "Source directory modified during move (source drift detected). Operation aborted to preserve data.",
        );
      }

      // 5. Write receipt marker to staging before updating journal to finalizing
      const receipt: MoveReceipt = {
        version: 2,
        operationId: operationNonce,
        source,
        target,
        staging,
        fileCount: totalFiles,
        totalBytes,
        directories: payloadDirectories,
        files: payloadFiles.map((f) => ({
          relativePath: f.relativePath,
          size: f.size,
          sha256: sourceHashes.get(f.relativePath) || "",
        })),
        stagingVerified: true,
        timestamp: new Date().toISOString(),
      };
      const stagingReceiptPath = path.join(staging, MOVE_RECEIPT_FILENAME);
      writeAtomicFileSync(stagingReceiptPath, JSON.stringify(receipt, null, 2));

      // 6. Finalize staging to target
      journalData.phase = "finalizing";
      journalData.stagingVerified = true;
      journalData.stagingReceipt = { fileCount: totalFiles, totalBytes };
      writeAtomicFileSync(journalPath, JSON.stringify(journalData, null, 2));

      // Strictly validate target before promotion
      if (fs.existsSync(target)) {
        const entries = await fs.promises.readdir(target);
        if (entries.length > 0) {
          throw new Error("Target directory already exists and is not empty.");
        }
        await fs.promises.rmdir(target);
      }

      await fs.promises.rename(staging, target);

      // Verify receipt exists in promoted target
      const targetReceiptPath = path.join(target, MOVE_RECEIPT_FILENAME);
      if (!fs.existsSync(targetReceiptPath)) {
        throw new Error(
          "Promotion verification failed: move receipt missing in target directory.",
        );
      }

      // 7. Update configuration. Failure here preserves the journal and source for recovery.
      try {
        ConfigManager.set({ gameDir: target, gameDirConfigured: true });
      } catch (cfgErr: any) {
        LauncherLogger.error(
          `Failed to update config after moving game directory: ${cfgErr.message}`,
        );
        throw cfgErr;
      }

      // 8. Clean old source
      journalData.phase = "cleaning";
      writeAtomicFileSync(journalPath, JSON.stringify(journalData, null, 2));

      onProgress?.({
        phase: "cleaning",
        filesCompleted,
        totalFiles,
        bytesCompleted,
        totalBytes,
        percent: 100,
      });

      try {
        await fs.promises.rm(source, { recursive: true, force: true });
      } catch (cleanErr: any) {
        LauncherLogger.warn(
          `Failed to remove old game directory after move: ${cleanErr.message}`,
        );
      }

      // 9. Clean receipt and staging marker from target and remove journal
      const targetMarkerPath = path.join(target, STAGING_MARKER_FILENAME);
      try {
        if (fs.existsSync(targetReceiptPath)) {
          await fs.promises.unlink(targetReceiptPath);
        }
      } catch {}
      try {
        if (fs.existsSync(targetMarkerPath)) {
          await fs.promises.unlink(targetMarkerPath);
        }
      } catch {}

      if (fs.existsSync(journalPath)) {
        try {
          await fs.promises.unlink(journalPath);
        } catch {}
      }

      onProgress?.({
        phase: "complete",
        filesCompleted,
        totalFiles,
        bytesCompleted,
        totalBytes,
        percent: 100,
      });

      return { success: true, gameDir: target, previousGameDir: source };
    } catch (err: any) {
      if (
        journalData.phase !== "finalizing" &&
        journalData.phase !== "cleaning"
      ) {
        await authorizeAndRemoveStaging(journalData);
        if (fs.existsSync(journalPath)) {
          try {
            await fs.promises.unlink(journalPath);
          } catch {}
        }
      }
      throw err;
    }
  }

  static async recoverInterruptedMove(): Promise<void> {
    const userDataDir = getUserDataDir();

    // Check for a durable recovery hold written by quarantineJournal on a previous run.
    const holdPath = path.join(userDataDir, RECOVERY_HOLD_FILENAME);
    if (fs.existsSync(holdPath)) {
      let holdReason = "unknown (hold file unreadable)";
      try {
        const holdData = JSON.parse(fs.readFileSync(holdPath, "utf-8"));
        if (typeof holdData?.reason === "string") holdReason = holdData.reason;
      } catch {}
      throw new Error(
        `[Move Recovery] Durable recovery hold is active: ${holdReason}. ` +
          `Remove '${holdPath}' after resolving to re-enable launcher operations.`,
      );
    }

    const journalPath = path.join(userDataDir, "directory-move.json");
    if (!fs.existsSync(journalPath)) return;

    let rawJournal: any;
    try {
      const data = await fs.promises.readFile(journalPath, "utf-8");
      rawJournal = JSON.parse(data);
    } catch (err: any) {
      LauncherLogger.error(`Failed to parse move journal: ${err.message}`);
      // quarantineJournal throws — propagate so main.ts calls blockMutations
      quarantineJournal(journalPath, `Corrupted JSON syntax: ${err.message}`);
      return; // unreachable, but satisfies the compiler
    }

    const currentConfigGameDir =
      ConfigManager.get().gameDir || getDefaultGameDir();
    const validation = validateMoveJournal(
      rawJournal,
      currentConfigGameDir,
      userDataDir,
    );
    if (!validation.valid) {
      // quarantineJournal throws — propagate so main.ts calls blockMutations
      quarantineJournal(journalPath, validation.reason);
      return; // unreachable, but satisfies the compiler
    }

    const journal = validation.journal;
    LauncherLogger.warn(
      `Found valid interrupted directory move journal (phase=${journal.phase}, opId=${journal.operationId}, source=${journal.source}, target=${journal.target})`,
    );

    const sourceExists = fs.existsSync(journal.source);
    const targetExists = fs.existsSync(journal.target);
    const stagingExists = fs.existsSync(journal.staging);

    // Case 1: Target exists, but source does not exist
    if (targetExists && !sourceExists) {
      ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });
      if (stagingExists) {
        const removed = await authorizeAndRemoveStaging(journal);
        if (!removed) {
          throw new Error(
            `Move recovery: staging directory '${journal.staging}' could not be authorized for removal ` +
              `(missing or mismatched marker). Manual cleanup required to prevent data loss. ` +
              `Target has been configured at '${journal.target}'.`,
          );
        }
      }
      try {
        const receiptPath = path.join(journal.target, MOVE_RECEIPT_FILENAME);
        if (fs.existsSync(receiptPath)) await fs.promises.unlink(receiptPath);
      } catch {}
      try {
        const markerPath = path.join(journal.target, STAGING_MARKER_FILENAME);
        if (fs.existsSync(markerPath)) await fs.promises.unlink(markerPath);
      } catch {}
      try {
        await fs.promises.unlink(journalPath);
      } catch {}
      LauncherLogger.info(
        `Move recovery: confirmed target in place without source; updated config to ${journal.target}`,
      );
      return;
    }

    // Case 2: Journal phase is "cleaning"
    if (journal.phase === "cleaning") {
      if (!targetExists) {
        LauncherLogger.error(
          `Move recovery: phase is 'cleaning' but target directory '${journal.target}' does not exist! Aborting source deletion to preserve user data.`,
        );
        throw new Error(
          `Recovery aborted: target directory '${journal.target}' is missing during cleaning phase. Source directory '${journal.source}' has been preserved.`,
        );
      }

      const receipt = readMoveReceipt(journal.target, journal.operationId);
      if (!receipt || (journal.source && receipt.source !== journal.source)) {
        LauncherLogger.error(
          `Move recovery: target directory '${journal.target}' exists but lacks verified move receipt for opId ${journal.operationId}. Aborting source deletion.`,
        );
        throw new Error(
          `Recovery aborted: target directory '${journal.target}' does not contain a verified move receipt for operation ${journal.operationId}. Source directory '${journal.source}' has been preserved.`,
        );
      }

      // Re-establish exact target inventory, hashes, sizes, directory structure, and source consistency
      await verifyTargetCompleteness(journal.target, receipt, journal.source);

      // Target is 100% verified complete
      ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });

      // Before deleting source, verify physical distinctness
      if (sourceExists) {
        const canonSource = getCanonicalDiskPath(journal.source);
        const canonTarget = getCanonicalDiskPath(journal.target);
        const isWindows = process.platform === "win32";
        const cmpSource = isWindows ? canonSource.toLowerCase() : canonSource;
        const cmpTarget = isWindows ? canonTarget.toLowerCase() : canonTarget;
        if (cmpSource === cmpTarget) {
          throw new Error(
            "Recovery safety violation: target directory physically aliases source directory. Aborting source deletion.",
          );
        }
        const sourcePrefix = cmpSource.endsWith(path.sep)
          ? cmpSource
          : cmpSource + path.sep;
        const targetPrefix = cmpTarget.endsWith(path.sep)
          ? cmpTarget
          : cmpTarget + path.sep;
        if (
          cmpTarget.startsWith(sourcePrefix) ||
          cmpSource.startsWith(targetPrefix)
        ) {
          throw new Error(
            "Recovery safety violation: target directory and source directory physically nest inside each other. Aborting source deletion.",
          );
        }

        try {
          await fs.promises.rm(journal.source, {
            recursive: true,
            force: true,
          });
        } catch (err: any) {
          LauncherLogger.warn(
            `Move recovery: failed to remove old source directory: ${err.message}`,
          );
        }
      }

      if (stagingExists) {
        const removed = await authorizeAndRemoveStaging(journal);
        if (!removed) {
          throw new Error(
            `Move recovery: staging directory '${journal.staging}' could not be authorized for removal ` +
              `(missing or mismatched marker). Manual cleanup required.`,
          );
        }
      }
      try {
        const receiptPath = path.join(journal.target, MOVE_RECEIPT_FILENAME);
        if (fs.existsSync(receiptPath)) await fs.promises.unlink(receiptPath);
      } catch {}
      try {
        const markerPath = path.join(journal.target, STAGING_MARKER_FILENAME);
        if (fs.existsSync(markerPath)) await fs.promises.unlink(markerPath);
      } catch {}
      try {
        await fs.promises.unlink(journalPath);
      } catch {}
      LauncherLogger.info(
        `Move recovery: cleaning phase completed successfully; target verified at ${journal.target}`,
      );
      return;
    }

    // Case 3: Journal phase is "finalizing"
    if (journal.phase === "finalizing") {
      if (targetExists) {
        const receipt = readMoveReceipt(journal.target, journal.operationId);
        if (receipt && (!journal.source || receipt.source === journal.source)) {
          // Re-establish exact target inventory, hashes, sizes, directory structure, and source consistency
          await verifyTargetCompleteness(
            journal.target,
            receipt,
            journal.source,
          );

          ConfigManager.set({
            gameDir: journal.target,
            gameDirConfigured: true,
          });

          // Before deleting source, verify physical distinctness
          if (sourceExists) {
            const canonSource = getCanonicalDiskPath(journal.source);
            const canonTarget = getCanonicalDiskPath(journal.target);
            const isWindows = process.platform === "win32";
            const cmpSource = isWindows
              ? canonSource.toLowerCase()
              : canonSource;
            const cmpTarget = isWindows
              ? canonTarget.toLowerCase()
              : canonTarget;
            if (cmpSource === cmpTarget) {
              throw new Error(
                "Recovery safety violation: target directory physically aliases source directory. Aborting source deletion.",
              );
            }
            const sourcePrefix = cmpSource.endsWith(path.sep)
              ? cmpSource
              : cmpSource + path.sep;
            const targetPrefix = cmpTarget.endsWith(path.sep)
              ? cmpTarget
              : cmpTarget + path.sep;
            if (
              cmpTarget.startsWith(sourcePrefix) ||
              cmpSource.startsWith(targetPrefix)
            ) {
              throw new Error(
                "Recovery safety violation: target directory and source directory physically nest inside each other. Aborting source deletion.",
              );
            }

            try {
              await fs.promises.rm(journal.source, {
                recursive: true,
                force: true,
              });
            } catch (err: any) {
              LauncherLogger.warn(
                `Move recovery: failed to remove old source: ${err.message}`,
              );
            }
          }

          if (stagingExists) {
            const removed = await authorizeAndRemoveStaging(journal);
            if (!removed) {
              throw new Error(
                `Move recovery: staging directory '${journal.staging}' could not be authorized for removal ` +
                  `(missing or mismatched marker). Manual cleanup required.`,
              );
            }
          }
          try {
            const receiptPath = path.join(
              journal.target,
              MOVE_RECEIPT_FILENAME,
            );
            if (fs.existsSync(receiptPath))
              await fs.promises.unlink(receiptPath);
          } catch {}
          try {
            const markerPath = path.join(
              journal.target,
              STAGING_MARKER_FILENAME,
            );
            if (fs.existsSync(markerPath)) await fs.promises.unlink(markerPath);
          } catch {}
          try {
            await fs.promises.unlink(journalPath);
          } catch {}
          LauncherLogger.info(
            `Move recovery: finalizing phase completed for verified target at ${journal.target}`,
          );
          return;
        }

        LauncherLogger.error(
          `Move recovery: target directory '${journal.target}' exists but lacks a valid move receipt for operation ${journal.operationId}. Preserving source.`,
        );
        throw new Error(
          `Recovery aborted: target directory '${journal.target}' exists without a matching move receipt for operation ${journal.operationId}. Source directory '${journal.source}' has been preserved.`,
        );
      }

      // Target does not exist; check staging
      if (stagingExists && journal.stagingVerified) {
        const stagingReceipt = readMoveReceipt(
          journal.staging,
          journal.operationId,
        );
        if (!stagingReceipt) {
          LauncherLogger.error(
            `Move recovery: staging directory '${journal.staging}' lacks a valid move receipt. Preserving source.`,
          );
          throw new Error(
            `Recovery aborted: staging directory '${journal.staging}' lacks a verified move receipt for operation ${journal.operationId}. Source directory '${journal.source}' has been preserved.`,
          );
        }

        await verifyTargetCompleteness(
          journal.staging,
          stagingReceipt,
          journal.source,
        );

        try {
          checkPhysicalAncestrySync(
            path.dirname(journal.target),
            journal.staging,
            { disallowSymlinks: true, enforceOwnership: false },
          );
          await fs.promises.rename(journal.staging, journal.target);
        } catch (renameErr: any) {
          LauncherLogger.error(
            `Move recovery: failed to promote staging to target: ${renameErr.message}`,
          );
          throw new Error(
            `Recovery failed during promotion of staging to target: ${renameErr.message}. Source directory '${journal.source}' has been preserved.`,
          );
        }

        const promotedReceipt = readMoveReceipt(
          journal.target,
          journal.operationId,
        );
        if (!promotedReceipt) {
          throw new Error(
            `Recovery failed: target directory does not contain verified move receipt after promotion. Source directory '${journal.source}' has been preserved.`,
          );
        }

        ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });

        // Before deleting source, verify physical distinctness
        if (sourceExists) {
          const canonSource = getCanonicalDiskPath(journal.source);
          const canonTarget = getCanonicalDiskPath(journal.target);
          const isWindows = process.platform === "win32";
          const cmpSource = isWindows ? canonSource.toLowerCase() : canonSource;
          const cmpTarget = isWindows ? canonTarget.toLowerCase() : canonTarget;
          if (cmpSource === cmpTarget) {
            throw new Error(
              "Recovery safety violation: target directory physically aliases source directory. Aborting source deletion.",
            );
          }
          const sourcePrefix = cmpSource.endsWith(path.sep)
            ? cmpSource
            : cmpSource + path.sep;
          const targetPrefix = cmpTarget.endsWith(path.sep)
            ? cmpTarget
            : cmpTarget + path.sep;
          if (
            cmpTarget.startsWith(sourcePrefix) ||
            cmpSource.startsWith(targetPrefix)
          ) {
            throw new Error(
              "Recovery safety violation: target directory and source directory physically nest inside each other. Aborting source deletion.",
            );
          }

          try {
            await fs.promises.rm(journal.source, {
              recursive: true,
              force: true,
            });
          } catch (err: any) {
            LauncherLogger.warn(
              `Move recovery: failed to remove old source directory: ${err.message}`,
            );
          }
        }

        try {
          const receiptPath = path.join(journal.target, MOVE_RECEIPT_FILENAME);
          if (fs.existsSync(receiptPath)) await fs.promises.unlink(receiptPath);
        } catch {}
        try {
          const markerPath = path.join(journal.target, STAGING_MARKER_FILENAME);
          if (fs.existsSync(markerPath)) await fs.promises.unlink(markerPath);
        } catch {}
        try {
          await fs.promises.unlink(journalPath);
        } catch {}
        LauncherLogger.info(
          `Move recovery: promoted staging to target and finalized at ${journal.target}`,
        );
        return;
      }

      // Neither target with receipt nor staging with receipt exists!
      LauncherLogger.error(
        "Move recovery: finalizing phase has neither verified target nor verified staging. Preserving source.",
      );
      throw new Error(
        `Recovery aborted: cannot finalize move for operation ${journal.operationId}; neither verified target nor verified staging exists. Source directory '${journal.source}' has been preserved.`,
      );
    }

    // Case 4: Earlier phases ("preparing", "renaming", "copying", "verifying")
    // Staging was not finalized or verified. Source is preserved intact.
    if (stagingExists) {
      const removed = await authorizeAndRemoveStaging(journal);
      if (!removed) {
        throw new Error(
          `Move recovery: staging directory '${journal.staging}' could not be authorized for removal ` +
            `(missing or mismatched marker) during ${journal.phase} phase. ` +
            `Manual cleanup required. Source is preserved at '${journal.source}'.`,
        );
      }
    }
    try {
      await fs.promises.unlink(journalPath);
    } catch {}
    LauncherLogger.info(
      `Move recovery: discarded incomplete move (${journal.phase}); original source preserved at ${journal.source}`,
    );
  }
}

async function verifyTargetCompleteness(
  targetDir: string,
  receipt: MoveReceipt,
  sourceDir?: string,
): Promise<void> {
  // 1. Receipt schema and integrity validation (receipt is untrusted until proven valid)
  if (
    !receipt ||
    typeof receipt !== "object" ||
    receipt.version !== 2 ||
    !Array.isArray(receipt.files)
  ) {
    throw new Error(
      "Recovery aborted: move receipt lacks verified per-file inventory evidence (legacy or incomplete receipt); preserving source.",
    );
  }

  if (!Array.isArray(receipt.directories)) {
    throw new Error(
      "Recovery aborted: move receipt directories field is missing or not an array; preserving source.",
    );
  }

  if (
    typeof receipt.fileCount !== "number" ||
    receipt.fileCount < 0 ||
    !Number.isInteger(receipt.fileCount)
  ) {
    throw new Error(
      "Recovery aborted: move receipt contains invalid fileCount; preserving source.",
    );
  }

  if (typeof receipt.totalBytes !== "number" || receipt.totalBytes < 0) {
    throw new Error(
      "Recovery aborted: move receipt contains invalid totalBytes; preserving source.",
    );
  }

  if (receipt.files.length !== receipt.fileCount) {
    throw new Error(
      `Recovery aborted: move receipt fileCount mismatch (declared ${receipt.fileCount}, found ${receipt.files.length} entries); preserving source.`,
    );
  }

  // Validate every receipt file entry, check duplicates, validate hash format and totalBytes
  const receiptFileKeys = new Set<string>();
  let calculatedReceiptBytes = 0;
  for (const entry of receipt.files) {
    if (!entry || typeof entry !== "object") {
      throw new Error(
        "Recovery aborted: receipt contains malformed file entry; preserving source.",
      );
    }
    if (!entry.relativePath || !isSafeRelativePath(entry.relativePath)) {
      throw new Error(
        `Recovery aborted: receipt contains unsafe relative file path '${entry.relativePath}'; preserving source.`,
      );
    }
    if (
      typeof entry.size !== "number" ||
      entry.size < 0 ||
      !Number.isInteger(entry.size)
    ) {
      throw new Error(
        `Recovery aborted: receipt contains invalid file size for '${entry.relativePath}'; preserving source.`,
      );
    }
    if (!isValidDigestString(entry.sha256, "sha256")) {
      throw new Error(
        `Recovery aborted: receipt contains invalid sha256 digest for '${entry.relativePath}'; preserving source.`,
      );
    }
    const key = normalizePathKey(entry.relativePath);
    if (receiptFileKeys.has(key)) {
      throw new Error(
        `Recovery aborted: receipt contains duplicate file entry '${entry.relativePath}'; preserving source.`,
      );
    }
    receiptFileKeys.add(key);
    calculatedReceiptBytes += entry.size;
  }

  if (calculatedReceiptBytes !== receipt.totalBytes) {
    throw new Error(
      `Recovery aborted: receipt totalBytes mismatch (declared ${receipt.totalBytes}, sum of files ${calculatedReceiptBytes}); preserving source.`,
    );
  }

  // Validate directory entries in receipt
  const receiptDirKeys = new Set<string>();
  for (const dirRel of receipt.directories) {
    if (!dirRel || !isSafeRelativePath(dirRel)) {
      throw new Error(
        `Recovery aborted: receipt contains unsafe directory path '${dirRel}'; preserving source.`,
      );
    }
    const key = normalizePathKey(dirRel);
    if (receiptDirKeys.has(key)) {
      throw new Error(
        `Recovery aborted: receipt contains duplicate directory entry '${dirRel}'; preserving source.`,
      );
    }
    receiptDirKeys.add(key);
  }

  // 2. Physical and canonical distinctness check between target and source
  if (sourceDir && fs.existsSync(sourceDir)) {
    const canonTarget = getCanonicalDiskPath(targetDir);
    const canonSource = getCanonicalDiskPath(sourceDir);
    const isWindows = process.platform === "win32";
    const cmpTarget = isWindows ? canonTarget.toLowerCase() : canonTarget;
    const cmpSource = isWindows ? canonSource.toLowerCase() : canonSource;
    if (cmpTarget === cmpSource) {
      throw new Error(
        "Recovery safety violation: target directory physically aliases source directory. Aborting recovery.",
      );
    }
    const sourcePrefix = cmpSource.endsWith(path.sep)
      ? cmpSource
      : cmpSource + path.sep;
    const targetPrefix = cmpTarget.endsWith(path.sep)
      ? cmpTarget
      : cmpTarget + path.sep;
    if (
      cmpTarget.startsWith(sourcePrefix) ||
      cmpSource.startsWith(targetPrefix)
    ) {
      throw new Error(
        "Recovery safety violation: target directory and source directory physically nest inside each other. Aborting recovery.",
      );
    }
  }

  // 3. Scan target directory
  let targetInventory: ScannedDirectoryInventory;
  try {
    targetInventory = await scanDirectoryAsync(targetDir);
  } catch (scanErr: any) {
    throw new Error(
      `Recovery aborted: failed to scan target directory '${targetDir}': ${scanErr.message}. Source directory has been preserved.`,
    );
  }

  const payloadFiles = payloadFilesOrThrow(
    targetInventory,
    targetDir,
    "target directory",
  );
  const payloadBytes = payloadFiles.reduce((sum, f) => sum + f.size, 0);

  // File count check
  if (payloadFiles.length !== receipt.files.length) {
    throw new Error(
      `Recovery aborted: target file count mismatch for '${targetDir}' (expected ${receipt.files.length}, found ${payloadFiles.length}). Source directory has been preserved.`,
    );
  }

  // Total bytes check
  if (payloadBytes !== receipt.totalBytes) {
    throw new Error(
      `Recovery aborted: target total bytes mismatch for '${targetDir}' (expected ${receipt.totalBytes}, found ${payloadBytes}). Source directory has been preserved.`,
    );
  }

  // Build target file map with normalizePathKey
  const targetMap = new Map<string, ScannedFile>();
  for (const f of payloadFiles) {
    const key = normalizePathKey(f.relativePath);
    if (targetMap.has(key)) {
      throw new Error(
        `Recovery aborted: target directory contains duplicate/colliding file '${f.relativePath}'. Source directory has been preserved.`,
      );
    }
    targetMap.set(key, f);
  }

  // Exact bidirectional per-file check
  for (const expected of receipt.files) {
    const key = normalizePathKey(expected.relativePath);
    const targetFile = targetMap.get(key);
    if (!targetFile) {
      throw new Error(
        `Recovery aborted: target directory is missing expected file '${expected.relativePath}'. Source directory has been preserved.`,
      );
    }
    if (targetFile.size !== expected.size) {
      throw new Error(
        `Recovery aborted: file size mismatch for '${expected.relativePath}' in target (expected ${expected.size}, found ${targetFile.size}). Source directory has been preserved.`,
      );
    }
    const actualHash = await computeFileSha256Async(targetFile.absolutePath);
    if (actualHash.toLowerCase() !== expected.sha256.toLowerCase()) {
      throw new Error(
        `Recovery aborted: file content SHA-256 mismatch for '${expected.relativePath}' in target (expected ${expected.sha256}, actual ${actualHash}). Source directory has been preserved.`,
      );
    }
  }

  for (const targetFile of payloadFiles) {
    const key = normalizePathKey(targetFile.relativePath);
    if (!receiptFileKeys.has(key)) {
      throw new Error(
        `Recovery aborted: target directory contains unexpected file '${targetFile.relativePath}' not recorded in receipt. Source directory has been preserved.`,
      );
    }
  }

  // Verify all directories in target
  const targetDirKeys = new Set<string>();
  for (const dirRel of targetInventory.directories) {
    targetDirKeys.add(normalizePathKey(dirRel));
  }

  for (const expectedDir of receipt.directories) {
    const fullDir = path.join(targetDir, expectedDir);
    if (!fs.existsSync(fullDir)) {
      throw new Error(
        `Recovery aborted: missing expected directory '${expectedDir}' in target directory. Source directory has been preserved.`,
      );
    }
    try {
      const stat = fs.statSync(fullDir);
      if (!stat.isDirectory()) {
        throw new Error(
          `Recovery aborted: expected directory path '${expectedDir}' in target is not a directory. Source directory has been preserved.`,
        );
      }
    } catch (err: any) {
      throw new Error(
        `Recovery aborted: cannot inspect directory '${expectedDir}' in target: ${err.message}. Source directory has been preserved.`,
      );
    }
  }

  for (const dirRel of receipt.directories) {
    const key = normalizePathKey(dirRel);
    if (!targetDirKeys.has(key)) {
      throw new Error(
        `Recovery aborted: missing expected directory '${dirRel}' in target directory. Source directory has been preserved.`,
      );
    }
  }

  if (targetDirKeys.size !== receiptDirKeys.size) {
    throw new Error(
      `Recovery aborted: target directory structure mismatch (expected ${receiptDirKeys.size} directories, found ${targetDirKeys.size}). Source directory has been preserved.`,
    );
  }

  // 4. Compare against preserved source if source exists on disk
  if (sourceDir && fs.existsSync(sourceDir)) {
    let sourceInventory: ScannedDirectoryInventory;
    try {
      sourceInventory = await scanDirectoryAsync(sourceDir);
    } catch (scanErr: any) {
      throw new Error(
        `Recovery aborted: failed to scan source directory '${sourceDir}': ${scanErr.message}. Source directory has been preserved.`,
      );
    }

    const sourcePayloadFiles = payloadFilesOrThrow(
      sourceInventory,
      sourceDir,
      "source directory",
    );

    if (sourcePayloadFiles.length !== receipt.files.length) {
      throw new Error(
        `Recovery aborted: source directory file count changed after interruption (expected ${receipt.files.length}, found ${sourcePayloadFiles.length}). Source directory has been preserved.`,
      );
    }

    const sourceMap = new Map<string, ScannedFile>();
    for (const f of sourcePayloadFiles) {
      const key = normalizePathKey(f.relativePath);
      if (sourceMap.has(key)) {
        throw new Error(
          `Recovery aborted: source directory contains duplicate/colliding file '${f.relativePath}'. Source directory has been preserved.`,
        );
      }
      sourceMap.set(key, f);
    }

    for (const expected of receipt.files) {
      const key = normalizePathKey(expected.relativePath);
      const srcFile = sourceMap.get(key);
      if (!srcFile) {
        throw new Error(
          `Recovery aborted: source directory inventory changed (missing '${expected.relativePath}'). Source directory has been preserved.`,
        );
      }
      if (srcFile.size !== expected.size) {
        throw new Error(
          `Recovery aborted: source file size changed for '${expected.relativePath}' (expected ${expected.size}, found ${srcFile.size}). Source directory has been preserved.`,
        );
      }
      const srcHash = await computeFileSha256Async(srcFile.absolutePath);
      if (srcHash.toLowerCase() !== expected.sha256.toLowerCase()) {
        throw new Error(
          `Recovery aborted: source file content was modified after interruption for '${expected.relativePath}'. Source directory has been preserved.`,
        );
      }
    }

    for (const srcFile of sourcePayloadFiles) {
      const key = normalizePathKey(srcFile.relativePath);
      if (!receiptFileKeys.has(key)) {
        throw new Error(
          `Recovery aborted: source directory contains unexpected file '${srcFile.relativePath}' after interruption. Source directory has been preserved.`,
        );
      }
    }

    // Source directory drift check (detects new empty directories added to source!)
    const sourceDirKeys = new Set<string>();
    for (const dirRel of sourceInventory.directories) {
      sourceDirKeys.add(normalizePathKey(dirRel));
    }

    if (sourceDirKeys.size !== receiptDirKeys.size) {
      throw new Error(
        `Recovery aborted: source directory structure changed after interruption (expected ${receiptDirKeys.size} directories, found ${sourceDirKeys.size}). Source directory has been preserved.`,
      );
    }

    for (const key of sourceDirKeys) {
      if (!receiptDirKeys.has(key)) {
        throw new Error(
          `Recovery aborted: source directory contains unexpected directory after interruption. Source directory has been preserved.`,
        );
      }
    }
  }
}

function payloadFilesOrThrow(
  inventory: ScannedDirectoryInventory,
  baseDir: string,
  label: string,
): ScannedFile[] {
  const payloadFiles: ScannedFile[] = [];
  for (const file of inventory.files) {
    const classification = classifyMoveMetadata(file, baseDir);
    if (classification === "MALFORMED_OR_FOREIGN") {
      throw new Error(
        `Recovery aborted: ${label} contains malformed or foreign move metadata '${file.relativePath}'. ` +
          `Source directory has been preserved.`,
      );
    }
    if (classification === "NOT_METADATA") payloadFiles.push(file);
  }
  return payloadFiles;
}

export const RECOVERY_HOLD_FILENAME = "recovery-hold.json";

export function quarantineJournal(journalPath: string, reason: string): void {
  const quarantinePath = `${journalPath}.quarantine.${Date.now()}`;
  const userDataDir = getUserDataDir();
  const holdPath = path.join(userDataDir, RECOVERY_HOLD_FILENAME);
  const holdData = {
    reason,
    quarantinedAt: new Date().toISOString(),
    quarantinePath,
  };

  // Persist the durable hold before moving the journal. If this write fails, the
  // journal remains in its original location so the next startup retries recovery
  // instead of seeing an apparently clean state and permitting mutations.
  try {
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    writeAtomicFileSync(holdPath, JSON.stringify(holdData, null, 2), "utf-8");
  } catch (writeErr: any) {
    LauncherLogger.error(
      `[Move Recovery] Failed to write recovery hold file: ${writeErr.message}`,
    );
    throw new Error(
      `[Move Recovery] Failed to persist durable recovery hold at '${holdPath}': ${writeErr.message}. ` +
        `The invalid move journal remains at '${journalPath}' and no destructive operations were performed.`,
    );
  }

  let quarantined = false;
  try {
    fs.renameSync(journalPath, quarantinePath);
    quarantined = true;
  } catch {
    try {
      fs.copyFileSync(journalPath, quarantinePath);
      fs.unlinkSync(journalPath);
      quarantined = true;
    } catch (quarantineErr: any) {
      LauncherLogger.error(
        `[Move Recovery] Failed to quarantine invalid/unverified move journal after persisting hold: ${quarantineErr.message}`,
      );
    }
  }

  if (!quarantined) {
    throw new Error(
      `[Move Recovery] Failed to quarantine invalid/unverified move journal: ${reason}. ` +
        `The durable recovery hold is active and the journal remains at '${journalPath}'.`,
    );
  }

  LauncherLogger.error(
    `[Move Recovery] Quarantined invalid/unverified move journal: ${reason}. Stored at '${quarantinePath}'. No destructive operations were performed.`,
  );

  throw new Error(
    `[Move Recovery] Invalid move journal quarantined: ${reason}. Manual intervention required. ` +
      `Remove '${holdPath}' after resolving to re-enable launcher operations.`,
  );
}

export function validateMoveJournal(
  journal: any,
  configuredGameDir: string,
  userDataDir: string,
):
  | { valid: true; journal: DirectoryMoveJournal }
  | { valid: false; reason: string } {
  if (!journal || typeof journal !== "object") {
    return { valid: false, reason: "Move journal is not an object" };
  }

  if (
    journal.version !== undefined &&
    journal.version !== 1 &&
    journal.version !== 2
  ) {
    return {
      valid: false,
      reason: `Unsupported move journal version: ${journal.version}`,
    };
  }

  const validPhases = new Set([
    "preparing",
    "renaming",
    "copying",
    "verifying",
    "finalizing",
    "cleaning",
  ]);
  if (!journal.phase || !validPhases.has(journal.phase)) {
    return {
      valid: false,
      reason: `Invalid move journal phase: ${journal.phase}`,
    };
  }

  if (
    !journal.operationId ||
    typeof journal.operationId !== "string" ||
    !/^[0-9a-zA-Z_-]{8,64}$/.test(journal.operationId)
  ) {
    return {
      valid: false,
      reason: `Invalid or missing operationId format: ${journal.operationId}`,
    };
  }

  if (
    !journal.source ||
    typeof journal.source !== "string" ||
    !path.isAbsolute(journal.source)
  ) {
    return { valid: false, reason: "Source path is missing or not absolute" };
  }

  if (
    !journal.target ||
    typeof journal.target !== "string" ||
    !path.isAbsolute(journal.target)
  ) {
    return { valid: false, reason: "Target path is missing or not absolute" };
  }

  if (
    !journal.staging ||
    typeof journal.staging !== "string" ||
    !path.isAbsolute(journal.staging)
  ) {
    return { valid: false, reason: "Staging path is missing or not absolute" };
  }

  const resolvedSource = path.resolve(journal.source);
  const resolvedTarget = path.resolve(journal.target);
  const resolvedStaging = path.resolve(journal.staging);
  const resolvedUserData = path.resolve(userDataDir);
  const resolvedConfiguredGame = path.resolve(configuredGameDir);
  const homeDir = path.resolve(os.homedir());

  // If roots exist, reject symlinks and special files
  if (fs.existsSync(resolvedTarget)) {
    try {
      const stat = fs.lstatSync(resolvedTarget);
      if (
        stat.isSymbolicLink() ||
        stat.isFIFO() ||
        stat.isSocket() ||
        stat.isCharacterDevice() ||
        stat.isBlockDevice()
      ) {
        return {
          valid: false,
          reason: "Target directory cannot be a symbolic link or special file",
        };
      }
      if (!stat.isDirectory()) {
        return {
          valid: false,
          reason: "Target path exists but is not a directory",
        };
      }
    } catch (err: any) {
      return {
        valid: false,
        reason: `Cannot inspect target directory: ${err.message}`,
      };
    }
  }

  if (fs.existsSync(resolvedSource)) {
    try {
      const stat = fs.lstatSync(resolvedSource);
      if (
        stat.isSymbolicLink() ||
        stat.isFIFO() ||
        stat.isSocket() ||
        stat.isCharacterDevice() ||
        stat.isBlockDevice()
      ) {
        return {
          valid: false,
          reason: "Source directory cannot be a symbolic link or special file",
        };
      }
      if (!stat.isDirectory()) {
        return {
          valid: false,
          reason: "Source path exists but is not a directory",
        };
      }
    } catch (err: any) {
      return {
        valid: false,
        reason: `Cannot inspect source directory: ${err.message}`,
      };
    }
  }

  if (fs.existsSync(resolvedStaging)) {
    try {
      const stat = fs.lstatSync(resolvedStaging);
      if (
        stat.isSymbolicLink() ||
        stat.isFIFO() ||
        stat.isSocket() ||
        stat.isCharacterDevice() ||
        stat.isBlockDevice()
      ) {
        return {
          valid: false,
          reason: "Staging directory cannot be a symbolic link or special file",
        };
      }
    } catch (err: any) {
      return {
        valid: false,
        reason: `Cannot inspect staging directory: ${err.message}`,
      };
    }
  }

  // Check lexical roots
  const isWindows = process.platform === "win32";
  const sourceParsed = path.parse(resolvedSource);
  const targetParsed = path.parse(resolvedTarget);
  const stagingParsed = path.parse(resolvedStaging);

  if (
    sourceParsed.root.toLowerCase() === resolvedSource.toLowerCase() ||
    targetParsed.root.toLowerCase() === resolvedTarget.toLowerCase() ||
    stagingParsed.root.toLowerCase() === resolvedStaging.toLowerCase()
  ) {
    return {
      valid: false,
      reason:
        "Source, target, or staging cannot be a filesystem root directory",
    };
  }

  // Check canonical roots
  const canonSource = getCanonicalDiskPath(resolvedSource);
  const canonTarget = getCanonicalDiskPath(resolvedTarget);
  const canonStaging = getCanonicalDiskPath(resolvedStaging);

  if (
    path.parse(canonSource).root.toLowerCase() === canonSource.toLowerCase() ||
    path.parse(canonTarget).root.toLowerCase() === canonTarget.toLowerCase() ||
    path.parse(canonStaging).root.toLowerCase() === canonStaging.toLowerCase()
  ) {
    return {
      valid: false,
      reason:
        "Source, target, or staging cannot resolve to a filesystem root directory",
    };
  }

  // 1. Lexical source and target disjointness
  const cmpSource = isWindows ? resolvedSource.toLowerCase() : resolvedSource;
  const cmpTarget = isWindows ? resolvedTarget.toLowerCase() : resolvedTarget;
  if (cmpSource === cmpTarget) {
    return {
      valid: false,
      reason: "Source and target directories cannot be identical",
    };
  }

  const sourcePrefix = cmpSource.endsWith(path.sep)
    ? cmpSource
    : cmpSource + path.sep;
  const targetPrefix = cmpTarget.endsWith(path.sep)
    ? cmpTarget
    : cmpTarget + path.sep;

  if (
    cmpTarget.startsWith(sourcePrefix) ||
    cmpSource.startsWith(targetPrefix)
  ) {
    return {
      valid: false,
      reason:
        "Source and target directories cannot be nested inside each other",
    };
  }

  // 2. Physical canonical source and target disjointness
  const cmpCanonSource = isWindows ? canonSource.toLowerCase() : canonSource;
  const cmpCanonTarget = isWindows ? canonTarget.toLowerCase() : canonTarget;
  if (cmpCanonSource === cmpCanonTarget) {
    return {
      valid: false,
      reason:
        "Source and target directories physically alias the same directory",
    };
  }

  const canonSourcePrefix = cmpCanonSource.endsWith(path.sep)
    ? cmpCanonSource
    : cmpCanonSource + path.sep;
  const canonTargetPrefix = cmpCanonTarget.endsWith(path.sep)
    ? cmpCanonTarget
    : cmpCanonTarget + path.sep;

  if (
    cmpCanonTarget.startsWith(canonSourcePrefix) ||
    cmpCanonSource.startsWith(canonTargetPrefix)
  ) {
    return {
      valid: false,
      reason:
        "Source and target directories cannot physically nest inside each other",
    };
  }

  // Staging must strictly be within targetParent or sourceParent
  const targetParent = path.dirname(resolvedTarget);
  const sourceParent = path.dirname(resolvedSource);
  const stagingParent = path.dirname(resolvedStaging);
  const cmpStagingParent = isWindows
    ? stagingParent.toLowerCase()
    : stagingParent;
  const cmpTargetParent = isWindows ? targetParent.toLowerCase() : targetParent;
  const cmpSourceParent = isWindows ? sourceParent.toLowerCase() : sourceParent;

  if (
    cmpStagingParent !== cmpTargetParent &&
    cmpStagingParent !== cmpSourceParent
  ) {
    return {
      valid: false,
      reason: `Staging path '${journal.staging}' is not located in the parent directory of target or source`,
    };
  }

  // Staging basename must strictly match .lampas-moving-${journal.operationId}
  const stagingBase = path.basename(resolvedStaging);
  const expectedStagingName = `.lampas-moving-${journal.operationId}`;
  if (stagingBase !== expectedStagingName) {
    return {
      valid: false,
      reason: `Staging directory '${stagingBase}' does not correspond to journal operationId '${journal.operationId}' (expected '${expectedStagingName}')`,
    };
  }

  // Physical ancestry check
  try {
    checkPhysicalAncestrySync(stagingParent, resolvedStaging, {
      disallowSymlinks: true,
      enforceOwnership: false,
    });
  } catch (ancestryErr: any) {
    return {
      valid: false,
      reason: `Staging directory fails physical ancestry check: ${ancestryErr.message}`,
    };
  }

  // Staging disjointness from sensitive areas
  const cmpStaging = isWindows
    ? resolvedStaging.toLowerCase()
    : resolvedStaging;
  const cmpUserData = isWindows
    ? resolvedUserData.toLowerCase()
    : resolvedUserData;
  const cmpHome = isWindows ? homeDir.toLowerCase() : homeDir;

  const cmpCanonStaging = isWindows ? canonStaging.toLowerCase() : canonStaging;
  const cmpCanonUserData = isWindows
    ? getCanonicalDiskPath(resolvedUserData).toLowerCase()
    : getCanonicalDiskPath(resolvedUserData);
  const cmpCanonHome = isWindows
    ? getCanonicalDiskPath(homeDir).toLowerCase()
    : getCanonicalDiskPath(homeDir);

  if (
    cmpStaging === cmpSource ||
    cmpStaging === cmpTarget ||
    cmpStaging === cmpUserData ||
    cmpStaging === cmpHome ||
    cmpCanonStaging === cmpCanonSource ||
    cmpCanonStaging === cmpCanonTarget ||
    cmpCanonStaging === cmpCanonUserData ||
    cmpCanonStaging === cmpCanonHome
  ) {
    return {
      valid: false,
      reason: "Staging directory collides with critical system/user directory",
    };
  }

  // Relationship to configured instance (always enforced without NODE_ENV bypass)
  const cmpConfigured = isWindows
    ? resolvedConfiguredGame.toLowerCase()
    : resolvedConfiguredGame;
  const defaultDir = isWindows
    ? path.resolve(getDefaultGameDir()).toLowerCase()
    : path.resolve(getDefaultGameDir());
  if (
    cmpSource !== cmpConfigured &&
    cmpTarget !== cmpConfigured &&
    cmpSource !== defaultDir &&
    cmpTarget !== defaultDir
  ) {
    return {
      valid: false,
      reason:
        "Journal source and target are unrelated to current launcher configuration",
    };
  }

  return {
    valid: true,
    journal: {
      ...journal,
      version: 2,
      operationId: journal.operationId,
      source: resolvedSource,
      target: resolvedTarget,
      staging: resolvedStaging,
    },
  };
}
