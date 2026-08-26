import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ConfigManager, getDefaultGameDir, getUserDataDir } from "./config";
import { GameRunner } from "./game-runner";
import { LauncherLogger } from "./logger";
import type {
  DirectoryMoveProgress,
  DirectoryMoveResult,
  DirectoryStatus,
  DirectoryValidationResult,
  LauncherConfig,
} from "./types";

interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

function scanDirectory(dir: string, baseDir: string = dir): ScannedFile[] {
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
        });
      } catch {
        // Skip unreadable files
      }
    }
  }
  return results;
}

function computeFileSha256(filePath: string): string {
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
  static _renameFn: (src: string, dest: string) => void = fs.renameSync;
  static _copyFn: (src: string, dest: string) => void = fs.copyFileSync;

  static resetForTesting(): void {
    this._renameFn = fs.renameSync;
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
      fs.mkdirSync(resolved, { recursive: true });
    }

    return ConfigManager.set({
      gameDir: resolved,
      gameDirConfigured: true,
    });
  }

  static async moveInstallation(
    targetPath: string,
    onProgress?: (progress: DirectoryMoveProgress) => void
  ): Promise<DirectoryMoveResult> {
    if (GameRunner.isGameRunning()) {
      throw new Error("Cannot move installation while Minecraft is running.");
    }

    const config = ConfigManager.get();
    const source = path.resolve(config.gameDir);
    const target = path.resolve(targetPath);

    const validation = this.validateTarget(target, source);
    if (!validation.valid) {
      throw new Error(validation.reason || "Invalid target directory");
    }

    // Strictly validate existing target directory:
    // If target exists and is empty (common when chosen from Electron openDirectory picker),
    // remove the empty directory before renaming so fs.rename does not fail.
    if (fs.existsSync(target)) {
      if (fs.readdirSync(target).length > 0) {
        throw new Error("Target directory already exists and is not empty.");
      }
      fs.rmdirSync(target);
    }

    // If source directory doesn't exist on disk (e.g. moved prior to first sync)
    if (!fs.existsSync(source)) {
      fs.mkdirSync(target, { recursive: true });
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
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    const journalPath = path.join(userDataDir, "directory-move.json");
    const targetParent = path.dirname(target);
    if (!fs.existsSync(targetParent)) {
      fs.mkdirSync(targetParent, { recursive: true });
    }

    const staging = path.join(
      targetParent,
      `.lampas-moving-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );

    const journalData = {
      source,
      target,
      staging,
      phase: "preparing",
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2), "utf-8");

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
    fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2), "utf-8");

    let directRenameSuccess = false;
    try {
      this._renameFn(source, target);
      directRenameSuccess = true;
    } catch {
      // Cross-device link (EXDEV) or other rename limitation - fall through to staged copy + verify
    }

    if (directRenameSuccess) {
      journalData.phase = "finalizing";
      fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2), "utf-8");

      ConfigManager.set({ gameDir: target, gameDirConfigured: true });
      if (fs.existsSync(journalPath)) {
        try {
          fs.unlinkSync(journalPath);
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
      fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2), "utf-8");

      const files = scanDirectory(source);
      const totalFiles = files.length;
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      const sourceHashes = new Map<string, string>();
      let filesCompleted = 0;
      let bytesCompleted = 0;

      fs.mkdirSync(staging, { recursive: true });

      for (const file of files) {
        const destPath = path.join(staging, file.relativePath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        sourceHashes.set(file.relativePath, computeFileSha256(file.absolutePath));
        this._copyFn(file.absolutePath, destPath);
        try {
          const stat = fs.statSync(file.absolutePath);
          fs.utimesSync(destPath, stat.atime, stat.mtime);
        } catch {}

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
      }

      // 3. Verify copied tree: file counts, sizes, and full content SHA-256 hashes
      journalData.phase = "verifying";
      fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2), "utf-8");

      onProgress?.({
        phase: "verifying",
        filesCompleted,
        totalFiles,
        bytesCompleted,
        totalBytes,
        percent: 99,
      });

      const stagedFiles = scanDirectory(staging);
      if (stagedFiles.length !== totalFiles) {
        throw new Error(`Verification failed: Expected ${totalFiles} files, but staging has ${stagedFiles.length} files.`);
      }

      const stagedMap = new Map(stagedFiles.map((f) => [f.relativePath, f.size]));
      for (const file of files) {
        const stagedSize = stagedMap.get(file.relativePath);
        if (stagedSize === undefined || stagedSize !== file.size) {
          throw new Error(`Verification failed for file: ${file.relativePath} (size mismatch: original ${file.size}, copied ${stagedSize})`);
        }

        const expectedHash = sourceHashes.get(file.relativePath);
        const stagedFilePath = path.join(staging, file.relativePath);
        const actualHash = computeFileSha256(stagedFilePath);
        if (expectedHash && actualHash !== expectedHash) {
          throw new Error(`Verification failed for file: ${file.relativePath} (content SHA-256 mismatch: expected ${expectedHash}, got ${actualHash})`);
        }
      }

      // 4. Rename staging to target (fast rename within same parent directory)
      journalData.phase = "finalizing";
      fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2), "utf-8");

      fs.renameSync(staging, target);

      // 5. Update configuration
      ConfigManager.set({ gameDir: target, gameDirConfigured: true });

      // 6. Clean old source
      journalData.phase = "cleaning";
      fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2), "utf-8");

      onProgress?.({
        phase: "cleaning",
        filesCompleted,
        totalFiles,
        bytesCompleted,
        totalBytes,
        percent: 100,
      });

      try {
        fs.rmSync(source, { recursive: true, force: true });
      } catch (cleanErr: any) {
        LauncherLogger.warn(`Failed to remove old game directory after move: ${cleanErr.message}`);
      }

      // 7. Remove journal
      if (fs.existsSync(journalPath)) {
        try {
          fs.unlinkSync(journalPath);
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
      if (fs.existsSync(staging)) {
        try {
          fs.rmSync(staging, { recursive: true, force: true });
        } catch {}
      }
      if (journalData.phase !== "finalizing" && journalData.phase !== "cleaning") {
        if (fs.existsSync(journalPath)) {
          try {
            fs.unlinkSync(journalPath);
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

    try {
      const data = fs.readFileSync(journalPath, "utf-8");
      const journal = JSON.parse(data);
      LauncherLogger.warn(
        `Found interrupted directory move journal (phase=${journal.phase}, source=${journal.source}, target=${journal.target})`
      );

      const sourceExists = journal.source && fs.existsSync(journal.source);
      const targetExists = journal.target && fs.existsSync(journal.target);
      const stagingExists = journal.staging && fs.existsSync(journal.staging);

      if (targetExists && !sourceExists) {
        // Target was renamed/moved in place; finalize config and cleanup
        ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });
        if (stagingExists) {
          try {
            fs.rmSync(journal.staging, { recursive: true, force: true });
          } catch {}
        }
        try {
          fs.unlinkSync(journalPath);
        } catch {}
      } else if (journal.phase === "cleaning" || journal.phase === "finalizing") {
        // Destination move finalized on disk; update config and clean up source/staging
        if (targetExists) {
          ConfigManager.set({ gameDir: journal.target, gameDirConfigured: true });
          if (sourceExists) {
            try {
              fs.rmSync(journal.source, { recursive: true, force: true });
            } catch {}
          }
        }
        if (stagingExists) {
          try {
            fs.rmSync(journal.staging, { recursive: true, force: true });
          } catch {}
        }
        try {
          fs.unlinkSync(journalPath);
        } catch {}
      } else {
        // Move was interrupted during copy or verification before target became active;
        // discard staging and preserve original source
        if (stagingExists) {
          try {
            fs.rmSync(journal.staging, { recursive: true, force: true });
          } catch {}
        }
        try {
          fs.unlinkSync(journalPath);
        } catch {}
      }
    } catch (err: any) {
      LauncherLogger.error(`Failed to process move journal recovery: ${err.message}`);
    }
  }
}
