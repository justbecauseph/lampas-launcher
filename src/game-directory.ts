import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ConfigManager, getDefaultGameDir, getUserDataDir } from "./config";
import { GameRunner } from "./game-runner";
import { LauncherLogger } from "./logger";
import { writeAtomicFileSync } from "./file-transfer";
import { runBoundedPool } from "./async-pool";
import { checkPhysicalAncestrySync, PathContainmentError, resolveAndContainPath } from "./path-policy";
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

export interface StagingMarker {
  operationId: string;
  source: string;
  target: string;
  staging: string;
  timestamp: string;
}

export function writeStagingMarker(stagingDir: string, marker: StagingMarker): void {
  const markerPath = path.join(stagingDir, STAGING_MARKER_FILENAME);
  writeAtomicFileSync(markerPath, JSON.stringify(marker, null, 2));
}

export function readStagingMarker(stagingDir: string): StagingMarker | null {
  try {
    const markerPath = path.join(stagingDir, STAGING_MARKER_FILENAME);
    if (!fs.existsSync(markerPath)) return null;
    const data = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    if (data && typeof data === "object" && typeof data.operationId === "string") {
      return data as StagingMarker;
    }
    return null;
  } catch {
    return null;
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

export function readMoveReceipt(dir: string, expectedOpId?: string): MoveReceipt | null {
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
  phase: "preparing" | "renaming" | "copying" | "verifying" | "finalizing" | "cleaning";
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
  phase: "preparing" | "renaming" | "copying" | "verifying" | "finalizing" | "cleaning";
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
export async function scanDirectoryAsync(dir: string, baseDir: string = dir): Promise<ScannedDirectoryInventory> {
  const files: ScannedFile[] = [];
  const directories: string[] = [];
  let totalBytes = 0;

  async function traverse(currentDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (err: any) {
      throw new Error(`Failed to read directory at ${currentDir}: ${err.message}`);
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(baseDir, fullPath);

      let lstat: fs.Stats;
      try {
        lstat = await fs.promises.lstat(fullPath);
      } catch (err: any) {
        throw new Error(`Unreadable entry encountered at ${fullPath}: ${err.message}`);
      }

      if (
        lstat.isSymbolicLink() ||
        lstat.isFIFO() ||
        lstat.isSocket() ||
        lstat.isCharacterDevice() ||
        lstat.isBlockDevice()
      ) {
        throw new Error(
          `Unsupported file type (symlink or special file) encountered at ${relPath}. Cannot safely move directory without data loss.`
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
    await traverse(dir);
  }

  return { files, directories, totalBytes };
}

/**
 * Synchronous scan fallback for compatibility.
 */
export function scanDirectory(dir: string, baseDir: string = dir): ScannedFile[] {
  let results: ScannedFile[] = [];
  if (!fs.existsSync(dir)) return results;
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
export async function computeFileSha256Async(filePath: string): Promise<string> {
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
  dest: string
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
    writeStream
  );

  return { hash: hash.digest("hex"), bytes };
}

/**
 * Checks for external modification of the source tree during the move operation.
 * Returns true if source drift was detected.
 */
export async function checkSourceDrift(
  sourceDir: string,
  originalFiles: ScannedFile[]
): Promise<boolean> {
  let currentInventory: ScannedDirectoryInventory;
  try {
    currentInventory = await scanDirectoryAsync(sourceDir);
  } catch {
    return true; // Drift or unreadable
  }

  if (currentInventory.files.length !== originalFiles.length) {
    return true;
  }

  const originalMap = new Map(originalFiles.map((f) => [f.relativePath, f]));
  for (const curr of currentInventory.files) {
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
    if (msg.includes("cross-device") || msg.includes("different volume") || msg.includes("exdev")) {
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
      `.lampas-write-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    fs.writeFileSync(probeFile, "test");
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    return false;
  }
}

export class GameDirectoryManager {
  static _renameFn: (src: string, dest: string) => Promise<void> | void = async (src, dest) => {
    await fs.promises.rename(src, dest);
  };
  static _copyFn: (src: string, dest: string) => Promise<void> | void = fs.copyFileSync;

  static resetForTesting(): void {
    this._renameFn = async (src, dest) => {
      await fs.promises.rename(src, dest);
    };
    this._copyFn = fs.copyFileSync;
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
    const hasInstallation = exists && fs.existsSync(path.join(gameDir, ".lampas", "installation.json"));

    return {
      gameDir,
      isConfigured: !!config.gameDirConfigured,
      defaultGameDir: this.getDefaultPath(),
      exists,
      hasInstallation,
    };
  }

  static validateTarget(targetPath: string, currentPath?: string): DirectoryValidationResult {
    if (!targetPath || typeof targetPath !== "string" || targetPath.trim().length === 0) {
      return { valid: false, reason: "Target directory path cannot be empty." };
    }

    const trimmed = targetPath.trim();
    if (/^[a-zA-Z]:[\\/]?$/.test(trimmed) || trimmed === "/" || trimmed === "\\") {
      return { valid: false, reason: "Target directory cannot be a root drive directory." };
    }

    const resolvedTarget = path.resolve(trimmed);
    const parsed = path.parse(resolvedTarget);

    // Reject filesystem roots (e.g. C:\, /, D:\)
    if (
      parsed.root.toLowerCase() === resolvedTarget.toLowerCase() ||
      /^[a-zA-Z]:[\\/]?$/.test(resolvedTarget) ||
      resolvedTarget === "/"
    ) {
      return { valid: false, reason: "Target directory cannot be a root drive directory." };
    }

    // Check relationship with currentPath
    if (currentPath) {
      const resolvedCurrent = path.resolve(currentPath);
      if (resolvedCurrent.toLowerCase() === resolvedTarget.toLowerCase()) {
        return { valid: false, reason: "Target directory is the same as the current installation directory." };
      }

      const relToTarget = path.relative(resolvedCurrent, resolvedTarget);
      if (!relToTarget.startsWith("..") && !path.isAbsolute(relToTarget) && relToTarget !== "") {
        return { valid: false, reason: "Target directory cannot be inside the current installation directory." };
      }

      const relToCurrent = path.relative(resolvedTarget, resolvedCurrent);
      if (!relToCurrent.startsWith("..") && !path.isAbsolute(relToCurrent) && relToCurrent !== "") {
        return { valid: false, reason: "Current installation directory cannot be inside the target directory." };
      }
    }

    // Check writability
    if (!checkWritable(resolvedTarget)) {
      return { valid: false, reason: "Target location is not writable or access is denied." };
    }

    return { valid: true };
  }

  static async configureInitial(targetPath: string): Promise<LauncherConfig> {
    if (ConfigManager.get().gameDirConfigured) {
      throw new Error("Game directory is already configured; use Move Installation.");
    }

    const validation = this.validateTarget(targetPath);
    if (!validation.valid) {
      throw new Error(validation.reason || "Invalid game directory target.");
    }

    const resolved = path.resolve(targetPath.trim());
    if (!fs.existsSync(resolved)) {
      await fs.promises.mkdir(resolved, { recursive: true });
    }

    return ConfigManager.set({
      gameDir: resolved,
      gameDirConfigured: true,
    });
  }

  static async moveInstallation(
    targetPath: string,
    onProgress?: (progress: DirectoryMoveProgress) => void,
    signal?: AbortSignal
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
          `Direct rename failed due to cross-device boundary (${renameErr.code || renameErr.message}); proceeding to staged copy.`
        );
      } else {
        LauncherLogger.error(
          `Direct rename failed with fatal error (${renameErr.code || renameErr.message}): ${renameErr.message}`
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

      const inventory = await scanDirectoryAsync(source);
      const totalFiles = inventory.files.length;
      const totalBytes = inventory.totalBytes;
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
      for (const dirRel of inventory.directories) {
        await fs.promises.mkdir(path.join(staging, dirRel), { recursive: true });
      }

      // Copy files with bounded concurrency (concurrency 6)
      await runBoundedPool(
        inventory.files,
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
            const streamRes = await streamCopyAndHash(file.absolutePath, destPath);
            sourceHash = streamRes.hash;
          }

          sourceHashes.set(file.relativePath, sourceHash);

          try {
            await fs.promises.utimes(destPath, file.atimeMs / 1000, file.mtimeMs / 1000);
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
            percent: totalBytes > 0 ? Math.min(99, Math.round((bytesCompleted / totalBytes) * 100)) : 99,
          });
        },
        { concurrency: 6, signal }
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
      const stagedPayloadFiles = stagedInventory.files.filter(
        (f) => f.relativePath !== STAGING_MARKER_FILENAME && f.relativePath !== MOVE_RECEIPT_FILENAME
      );
      if (stagedPayloadFiles.length !== totalFiles) {
        throw new Error(`Verification failed: Expected ${totalFiles} files, but staging has ${stagedPayloadFiles.length} files.`);
      }

      // Verify all empty directories exist in staging
      for (const dirRel of inventory.directories) {
        const stagedDirPath = path.join(staging, dirRel);
        if (!fs.existsSync(stagedDirPath)) {
          throw new Error(`Verification failed: missing directory ${dirRel} in staging.`);
        }
      }

      const stagedMap = new Map(stagedPayloadFiles.map((f) => [f.relativePath, f.size]));

      // Verify destination readback with bounded concurrency (concurrency 4)
      await runBoundedPool(
        inventory.files,
        async (file) => {
          if (signal?.aborted) {
            throw new Error("Move operation aborted.");
          }

          const stagedSize = stagedMap.get(file.relativePath);
          if (stagedSize === undefined || stagedSize !== file.size) {
            throw new Error(`Verification failed for file: ${file.relativePath} (size mismatch: original ${file.size}, copied ${stagedSize})`);
          }

          const expectedHash = sourceHashes.get(file.relativePath);
          const stagedFilePath = path.join(staging, file.relativePath);
          const actualHash = await computeFileSha256Async(stagedFilePath);
          if (expectedHash && actualHash !== expectedHash) {
            throw new Error(`Verification failed for file: ${file.relativePath} (content SHA-256 mismatch: expected ${expectedHash}, got ${actualHash})`);
          }
        },
        { concurrency: 4, signal }
      );

      // 4. Check for source drift before finalizing
      const drifted = await checkSourceDrift(source, inventory.files);
      if (drifted) {
        throw new Error("Source directory modified during move (source drift detected). Operation aborted to preserve data.");
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
        directories: inventory.directories,
        files: inventory.files.map((f) => ({
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
        throw new Error("Promotion verification failed: move receipt missing in target directory.");
      }

      // 7. Update configuration. Failure here preserves the journal and source for recovery.
      try {
        ConfigManager.set({ gameDir: target, gameDirConfigured: true });
      } catch (cfgErr: any) {
        LauncherLogger.error(`Failed to update config after moving game directory: ${cfgErr.message}`);
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
        LauncherLogger.warn(`Failed to remove old game directory after move: ${cleanErr.message}`);
      }

      // 9. Clean receipt from target and remove journal
      try {
        if (fs.existsSync(targetReceiptPath)) {
          await fs.promises.unlink(targetReceiptPath);
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
      if (journalData.phase !== "finalizing" && journalData.phase !== "cleaning") {
        if (fs.existsSync(staging)) {
          try {
            await fs.promises.rm(staging, { recursive: true, force: true });
          } catch {}
        }
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
    const journalPath = path.join(userDataDir, "directory-move.json");
    if (!fs.existsSync(journalPath)) return;

    let rawJournal: any;
    try {
      const data = await fs.promises.readFile(journalPath, "utf-8");
      rawJournal = JSON.parse(data);
    } catch (err: any) {
      LauncherLogger.error(`Failed to parse move journal: ${err.message}`);
      quarantineJournal(journalPath, `Corrupted JSON syntax: ${err.message}`);
      return;
    }

    const currentConfigGameDir = ConfigManager.get().gameDir || getDefaultGameDir();
    const validation = validateMoveJournal(rawJournal, currentConfigGameDir, userDataDir);
    if (!validation.valid) {
      quarantineJournal(journalPath, validation.reason);
      return;
    }

    const journal = validation.journal;
    LauncherLogger.warn(
      `Found valid interrupted directory move journal (phase=${journal.phase}, opId=${journal.operationId}, source=${journal.source}, target=${journal.target})`
    );

    const sourceExists = fs.existsSync(journal.source);
    const targetExists = fs.existsSync(journal.target);
    const stagingExists = fs.existsSync(journal.staging);

    // Case 1: Target exists, but source does not exist
    if (targetExists && !sourceExists) {
      ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });
      if (stagingExists) {
        try {
          checkPhysicalAncestrySync(path.dirname(journal.target), journal.staging);
          await fs.promises.rm(journal.staging, { recursive: true, force: true });
        } catch {}
      }
      try {
        const receiptPath = path.join(journal.target, MOVE_RECEIPT_FILENAME);
        if (fs.existsSync(receiptPath)) await fs.promises.unlink(receiptPath);
      } catch {}
      try {
        await fs.promises.unlink(journalPath);
      } catch {}
      LauncherLogger.info(`Move recovery: confirmed target in place without source; updated config to ${journal.target}`);
      return;
    }

    // Case 2: Journal phase is "cleaning"
    if (journal.phase === "cleaning") {
      if (!targetExists) {
        LauncherLogger.error(
          `Move recovery: phase is 'cleaning' but target directory '${journal.target}' does not exist! Aborting source deletion to preserve user data.`
        );
        throw new Error(
          `Recovery aborted: target directory '${journal.target}' is missing during cleaning phase. Source directory '${journal.source}' has been preserved.`
        );
      }

      const receipt = readMoveReceipt(journal.target, journal.operationId);
      if (!receipt || (journal.source && receipt.source !== journal.source)) {
        LauncherLogger.error(
          `Move recovery: target directory '${journal.target}' exists but lacks verified move receipt for opId ${journal.operationId}. Aborting source deletion.`
        );
        throw new Error(
          `Recovery aborted: target directory '${journal.target}' does not contain a verified move receipt for operation ${journal.operationId}. Source directory '${journal.source}' has been preserved.`
        );
      }

      // Re-establish exact target inventory, hashes, sizes, directory structure, and source consistency
      await verifyTargetCompleteness(journal.target, receipt, journal.source);

      // Target is 100% verified complete
      ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });
      if (sourceExists) {
        try {
          await fs.promises.rm(journal.source, { recursive: true, force: true });
        } catch (err: any) {
          LauncherLogger.warn(`Move recovery: failed to remove old source directory: ${err.message}`);
        }
      }
      if (stagingExists) {
        try {
          checkPhysicalAncestrySync(path.dirname(journal.target), journal.staging);
          await fs.promises.rm(journal.staging, { recursive: true, force: true });
        } catch {}
      }
      try {
        const receiptPath = path.join(journal.target, MOVE_RECEIPT_FILENAME);
        if (fs.existsSync(receiptPath)) await fs.promises.unlink(receiptPath);
      } catch {}
      try {
        await fs.promises.unlink(journalPath);
      } catch {}
      LauncherLogger.info(`Move recovery: cleaning phase completed successfully; target verified at ${journal.target}`);
      return;
    }

    // Case 3: Journal phase is "finalizing"
    if (journal.phase === "finalizing") {
      if (targetExists) {
        const receipt = readMoveReceipt(journal.target, journal.operationId);
        if (receipt && (!journal.source || receipt.source === journal.source)) {
          // Re-establish exact target inventory, hashes, sizes, directory structure, and source consistency
          await verifyTargetCompleteness(journal.target, receipt, journal.source);

          ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });
          if (sourceExists) {
            try {
              await fs.promises.rm(journal.source, { recursive: true, force: true });
            } catch (err: any) {
              LauncherLogger.warn(`Move recovery: failed to remove old source: ${err.message}`);
            }
          }
          if (stagingExists) {
            try {
              checkPhysicalAncestrySync(path.dirname(journal.target), journal.staging);
              await fs.promises.rm(journal.staging, { recursive: true, force: true });
            } catch {}
          }
          try {
            const receiptPath = path.join(journal.target, MOVE_RECEIPT_FILENAME);
            if (fs.existsSync(receiptPath)) await fs.promises.unlink(receiptPath);
          } catch {}
          try {
            await fs.promises.unlink(journalPath);
          } catch {}
          LauncherLogger.info(`Move recovery: finalizing phase completed for verified target at ${journal.target}`);
          return;
        }

        LauncherLogger.error(
          `Move recovery: target directory '${journal.target}' exists but lacks a valid move receipt for operation ${journal.operationId}. Preserving source.`
        );
        throw new Error(
          `Recovery aborted: target directory '${journal.target}' exists without a matching move receipt for operation ${journal.operationId}. Source directory '${journal.source}' has been preserved.`
        );
      }

      // Target does not exist; check staging
      if (stagingExists && journal.stagingVerified) {
        const stagingReceipt = readMoveReceipt(journal.staging, journal.operationId);
        if (!stagingReceipt) {
          LauncherLogger.error(
            `Move recovery: staging directory '${journal.staging}' lacks a valid move receipt. Preserving source.`
          );
          throw new Error(
            `Recovery aborted: staging directory '${journal.staging}' lacks a verified move receipt for operation ${journal.operationId}. Source directory '${journal.source}' has been preserved.`
          );
        }

        await verifyTargetCompleteness(journal.staging, stagingReceipt, journal.source);

        try {
          checkPhysicalAncestrySync(path.dirname(journal.target), journal.staging);
          await fs.promises.rename(journal.staging, journal.target);
        } catch (renameErr: any) {
          LauncherLogger.error(`Move recovery: failed to promote staging to target: ${renameErr.message}`);
          throw new Error(
            `Recovery failed during promotion of staging to target: ${renameErr.message}. Source directory '${journal.source}' has been preserved.`
          );
        }

        const promotedReceipt = readMoveReceipt(journal.target, journal.operationId);
        if (!promotedReceipt) {
          throw new Error(
            `Recovery failed: target directory does not contain verified move receipt after promotion. Source directory '${journal.source}' has been preserved.`
          );
        }

        ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });
        if (sourceExists) {
          try {
            await fs.promises.rm(journal.source, { recursive: true, force: true });
          } catch (err: any) {
            LauncherLogger.warn(`Move recovery: failed to remove old source directory: ${err.message}`);
          }
        }
        try {
          const receiptPath = path.join(journal.target, MOVE_RECEIPT_FILENAME);
          if (fs.existsSync(receiptPath)) await fs.promises.unlink(receiptPath);
        } catch {}
        try {
          await fs.promises.unlink(journalPath);
        } catch {}
        LauncherLogger.info(`Move recovery: promoted staging to target and finalized at ${journal.target}`);
        return;
      }

      // Neither target with receipt nor staging with receipt exists!
      LauncherLogger.error("Move recovery: finalizing phase has neither verified target nor verified staging. Preserving source.");
      throw new Error(
        `Recovery aborted: cannot finalize move for operation ${journal.operationId}; neither verified target nor verified staging exists. Source directory '${journal.source}' has been preserved.`
      );
    }

    // Case 4: Earlier phases ("preparing", "renaming", "copying", "verifying")
    // Staging was not finalized or verified. Source is preserved intact.
    if (stagingExists) {
      const marker = readStagingMarker(journal.staging);
      if (
        !marker ||
        marker.operationId !== journal.operationId ||
        marker.source !== journal.source ||
        marker.target !== journal.target
      ) {
        LauncherLogger.warn(
          `Move recovery: staging directory '${journal.staging}' lacks matching operation ownership marker for operation ${journal.operationId}. Preserving staging directory without deletion.`
        );
      } else {
        try {
          checkPhysicalAncestrySync(path.dirname(journal.target), journal.staging);
          await fs.promises.rm(journal.staging, { recursive: true, force: true });
        } catch (err: any) {
          LauncherLogger.warn(`Move recovery: failed to purge staging directory: ${err.message}`);
        }
      }
    }
    try {
      await fs.promises.unlink(journalPath);
    } catch {}
    LauncherLogger.info(`Move recovery: discarded incomplete move (${journal.phase}); original source preserved at ${journal.source}`);
  }
}

async function verifyTargetCompleteness(
  targetDir: string,
  receipt: MoveReceipt,
  sourceDir?: string
): Promise<void> {
  // 1. Receipt schema check: must be version 2 with valid files array
  if (!receipt || typeof receipt !== "object" || receipt.version !== 2 || !Array.isArray(receipt.files)) {
    throw new Error(
      "Recovery aborted: move receipt lacks verified per-file inventory evidence (legacy or incomplete receipt); preserving source."
    );
  }

  // 2. Scan target directory
  let targetInventory: ScannedDirectoryInventory;
  try {
    targetInventory = await scanDirectoryAsync(targetDir);
  } catch (scanErr: any) {
    throw new Error(
      `Recovery aborted: failed to scan target directory '${targetDir}': ${scanErr.message}. Source directory has been preserved.`
    );
  }

  const payloadFiles = targetInventory.files.filter(
    (f) =>
      f.relativePath !== MOVE_RECEIPT_FILENAME &&
      f.relativePath !== ".lampas_move_receipt.json" &&
      f.relativePath !== STAGING_MARKER_FILENAME
  );
  const payloadBytes = payloadFiles.reduce((sum, f) => sum + f.size, 0);

  // File count check
  if (payloadFiles.length !== receipt.files.length) {
    throw new Error(
      `Recovery aborted: target file count mismatch for '${targetDir}' (expected ${receipt.files.length}, found ${payloadFiles.length}). Source directory has been preserved.`
    );
  }

  // Total bytes check
  if (payloadBytes !== receipt.totalBytes) {
    throw new Error(
      `Recovery aborted: target total bytes mismatch for '${targetDir}' (expected ${receipt.totalBytes}, found ${payloadBytes}). Source directory has been preserved.`
    );
  }

  // Exact per-file check
  const targetMap = new Map(payloadFiles.map((f) => [f.relativePath, f]));
  for (const expected of receipt.files) {
    const targetFile = targetMap.get(expected.relativePath);
    if (!targetFile) {
      throw new Error(
        `Recovery aborted: target directory is missing expected file '${expected.relativePath}'. Source directory has been preserved.`
      );
    }
    if (targetFile.size !== expected.size) {
      throw new Error(
        `Recovery aborted: file size mismatch for '${expected.relativePath}' in target (expected ${expected.size}, found ${targetFile.size}). Source directory has been preserved.`
      );
    }
    const actualHash = await computeFileSha256Async(targetFile.absolutePath);
    if (actualHash.toLowerCase() !== expected.sha256.toLowerCase()) {
      throw new Error(
        `Recovery aborted: file content SHA-256 mismatch for '${expected.relativePath}' in target (expected ${expected.sha256}, actual ${actualHash}). Source directory has been preserved.`
      );
    }
  }

  // Verify all directories (including empty directories)
  if (Array.isArray(receipt.directories)) {
    for (const dirRel of receipt.directories) {
      const fullDir = path.join(targetDir, dirRel);
      if (!fs.existsSync(fullDir)) {
        throw new Error(
          `Recovery aborted: missing expected directory '${dirRel}' in target directory. Source directory has been preserved.`
        );
      }
      try {
        const stat = fs.statSync(fullDir);
        if (!stat.isDirectory()) {
          throw new Error(
            `Recovery aborted: expected directory path '${dirRel}' in target is not a directory. Source directory has been preserved.`
          );
        }
      } catch (err: any) {
        throw new Error(
          `Recovery aborted: cannot inspect directory '${dirRel}' in target: ${err.message}. Source directory has been preserved.`
        );
      }
    }
  }

  // 3. Compare against preserved source if source exists on disk
  if (sourceDir && fs.existsSync(sourceDir)) {
    let sourceInventory: ScannedDirectoryInventory;
    try {
      sourceInventory = await scanDirectoryAsync(sourceDir);
    } catch (scanErr: any) {
      throw new Error(
        `Recovery aborted: failed to scan source directory '${sourceDir}': ${scanErr.message}. Source directory has been preserved.`
      );
    }

    const sourcePayloadFiles = sourceInventory.files.filter(
      (f) =>
        f.relativePath !== MOVE_RECEIPT_FILENAME &&
        f.relativePath !== ".lampas_move_receipt.json" &&
        f.relativePath !== STAGING_MARKER_FILENAME
    );

    if (sourcePayloadFiles.length !== receipt.files.length) {
      throw new Error(
        `Recovery aborted: source directory file count changed after interruption (expected ${receipt.files.length}, found ${sourcePayloadFiles.length}). Source directory has been preserved.`
      );
    }

    const sourceMap = new Map(sourcePayloadFiles.map((f) => [f.relativePath, f]));
    for (const expected of receipt.files) {
      const srcFile = sourceMap.get(expected.relativePath);
      if (!srcFile) {
        throw new Error(
          `Recovery aborted: source directory inventory changed (missing '${expected.relativePath}'). Source directory has been preserved.`
        );
      }
      if (srcFile.size !== expected.size) {
        throw new Error(
          `Recovery aborted: source file size changed for '${expected.relativePath}' (expected ${expected.size}, found ${srcFile.size}). Source directory has been preserved.`
        );
      }
      const srcHash = await computeFileSha256Async(srcFile.absolutePath);
      if (srcHash.toLowerCase() !== expected.sha256.toLowerCase()) {
        throw new Error(
          `Recovery aborted: source file content was modified after interruption for '${expected.relativePath}'. Source directory has been preserved.`
        );
      }
    }

    if (Array.isArray(receipt.directories)) {
      for (const dirRel of receipt.directories) {
        const fullDir = path.join(sourceDir, dirRel);
        if (!fs.existsSync(fullDir)) {
          throw new Error(
            `Recovery aborted: directory structure in source changed after interruption (missing '${dirRel}'). Source directory has been preserved.`
          );
        }
      }
    }
  }
}

export function quarantineJournal(journalPath: string, reason: string): void {
  const quarantinePath = `${journalPath}.quarantine.${Date.now()}`;
  try {
    fs.renameSync(journalPath, quarantinePath);
  } catch {
    try {
      fs.copyFileSync(journalPath, quarantinePath);
      fs.unlinkSync(journalPath);
    } catch {}
  }
  LauncherLogger.error(
    `[Move Recovery] Quarantined invalid/unverified move journal: ${reason}. Stored at '${quarantinePath}'. No destructive operations were performed.`
  );
}

export function validateMoveJournal(
  journal: any,
  configuredGameDir: string,
  userDataDir: string
): { valid: true; journal: DirectoryMoveJournal } | { valid: false; reason: string } {
  if (!journal || typeof journal !== "object") {
    return { valid: false, reason: "Move journal is not an object" };
  }

  if (journal.version !== undefined && journal.version !== 1 && journal.version !== 2) {
    return { valid: false, reason: `Unsupported move journal version: ${journal.version}` };
  }

  const validPhases = new Set(["preparing", "renaming", "copying", "verifying", "finalizing", "cleaning"]);
  if (!journal.phase || !validPhases.has(journal.phase)) {
    return { valid: false, reason: `Invalid move journal phase: ${journal.phase}` };
  }

  if (
    !journal.operationId ||
    typeof journal.operationId !== "string" ||
    !/^[0-9a-zA-Z_-]{8,64}$/.test(journal.operationId)
  ) {
    return { valid: false, reason: `Invalid or missing operationId format: ${journal.operationId}` };
  }

  if (!journal.source || typeof journal.source !== "string" || !path.isAbsolute(journal.source)) {
    return { valid: false, reason: "Source path is missing or not absolute" };
  }

  if (!journal.target || typeof journal.target !== "string" || !path.isAbsolute(journal.target)) {
    return { valid: false, reason: "Target path is missing or not absolute" };
  }

  if (!journal.staging || typeof journal.staging !== "string" || !path.isAbsolute(journal.staging)) {
    return { valid: false, reason: "Staging path is missing or not absolute" };
  }

  const resolvedSource = path.resolve(journal.source);
  const resolvedTarget = path.resolve(journal.target);
  const resolvedStaging = path.resolve(journal.staging);
  const resolvedUserData = path.resolve(userDataDir);
  const resolvedConfiguredGame = path.resolve(configuredGameDir);
  const homeDir = path.resolve(os.homedir());

  // Check roots
  const isWindows = process.platform === "win32";
  const sourceParsed = path.parse(resolvedSource);
  const targetParsed = path.parse(resolvedTarget);
  const stagingParsed = path.parse(resolvedStaging);

  if (
    sourceParsed.root.toLowerCase() === resolvedSource.toLowerCase() ||
    targetParsed.root.toLowerCase() === resolvedTarget.toLowerCase() ||
    stagingParsed.root.toLowerCase() === resolvedStaging.toLowerCase()
  ) {
    return { valid: false, reason: "Source, target, or staging cannot be a filesystem root directory" };
  }

  // Source and target disjointness
  const cmpSource = isWindows ? resolvedSource.toLowerCase() : resolvedSource;
  const cmpTarget = isWindows ? resolvedTarget.toLowerCase() : resolvedTarget;
  if (cmpSource === cmpTarget) {
    return { valid: false, reason: "Source and target directories cannot be identical" };
  }

  const sourcePrefix = cmpSource.endsWith(path.sep) ? cmpSource : cmpSource + path.sep;
  const targetPrefix = cmpTarget.endsWith(path.sep) ? cmpTarget : cmpTarget + path.sep;

  if (cmpTarget.startsWith(sourcePrefix) || cmpSource.startsWith(targetPrefix)) {
    return { valid: false, reason: "Source and target directories cannot be nested inside each other" };
  }

  // Staging must strictly be within targetParent or sourceParent
  const targetParent = path.dirname(resolvedTarget);
  const sourceParent = path.dirname(resolvedSource);
  const stagingParent = path.dirname(resolvedStaging);
  const cmpStagingParent = isWindows ? stagingParent.toLowerCase() : stagingParent;
  const cmpTargetParent = isWindows ? targetParent.toLowerCase() : targetParent;
  const cmpSourceParent = isWindows ? sourceParent.toLowerCase() : sourceParent;

  if (cmpStagingParent !== cmpTargetParent && cmpStagingParent !== cmpSourceParent) {
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
    checkPhysicalAncestrySync(stagingParent, resolvedStaging);
  } catch (ancestryErr: any) {
    return {
      valid: false,
      reason: `Staging directory fails physical ancestry check: ${ancestryErr.message}`,
    };
  }

  // Staging disjointness from sensitive areas
  const cmpStaging = isWindows ? resolvedStaging.toLowerCase() : resolvedStaging;
  const cmpUserData = isWindows ? resolvedUserData.toLowerCase() : resolvedUserData;
  const cmpHome = isWindows ? homeDir.toLowerCase() : homeDir;

  if (cmpStaging === cmpSource || cmpStaging === cmpTarget || cmpStaging === cmpUserData || cmpStaging === cmpHome) {
    return { valid: false, reason: "Staging directory collides with critical system/user directory" };
  }

  // Relationship to configured instance (always enforced without NODE_ENV bypass)
  const cmpConfigured = isWindows ? resolvedConfiguredGame.toLowerCase() : resolvedConfiguredGame;
  const defaultDir = isWindows ? path.resolve(getDefaultGameDir()).toLowerCase() : path.resolve(getDefaultGameDir());
  if (cmpSource !== cmpConfigured && cmpTarget !== cmpConfigured && cmpSource !== defaultDir && cmpTarget !== defaultDir) {
    return { valid: false, reason: "Journal source and target are unrelated to current launcher configuration" };
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
