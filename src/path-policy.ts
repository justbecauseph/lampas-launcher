import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Custom error thrown when a path violates containment, ownership, or canonicalization policies.
 */
export class PathContainmentError extends Error {
  readonly isMainOwnedError = true;
  constructor(message: string) {
    super(message);
    this.name = "PathContainmentError";
  }
}

/**
 * Validates that a string is a valid cryptographic digest hexadecimal string.
 * Prevents traversal attacks when hashes are used as path components.
 */
export function validateDigestString(
  hash: string,
  algorithm: "sha256" | "sha1" = "sha256"
): string {
  if (typeof hash !== "string") {
    throw new PathContainmentError(`Invalid digest: expected string, got ${typeof hash}`);
  }
  const trimmed = hash.trim().toLowerCase();
  const expectedLength = algorithm === "sha256" ? 64 : 40;
  const regex = algorithm === "sha256" ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;

  if (trimmed.length !== expectedLength || !regex.test(trimmed)) {
    throw new PathContainmentError(
      `Invalid ${algorithm.toUpperCase()} digest format: '${hash}' (expected ${expectedLength} hex characters)`
    );
  }
  return trimmed;
}

export function isValidDigestString(
  hash: string,
  algorithm: "sha256" | "sha1" = "sha256"
): boolean {
  try {
    validateDigestString(hash, algorithm);
    return true;
  } catch {
    return false;
  }
}

// Windows reserved device names: CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9 (case-insensitive, with/without extension)
const DOS_DEVICE_REGEX = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

// Windows Alternate Data Streams token
const ADS_REGEX = /:/;

// Forbidden control characters (NUL through 0x1F)
const CONTROL_CHAR_REGEX = /[\x00-\x1f]/;

/**
 * Canonicalizes an untrusted relative path:
 * - Normalizes separators to '/'
 * - Rejects absolute paths, UNC paths, drive letters, and drive-relative paths
 * - Rejects dot-dot (..) and dot (.) segments
 * - Rejects trailing spaces and dots on path segments
 * - Rejects Windows Alternate Data Streams (:)
 * - Rejects DOS device names (CON, NUL, AUX, etc.)
 * - Rejects prototype pollution property keys (__proto__, constructor, prototype)
 * - Returns a clean relative path with '/' separators.
 */
export function canonicalizeRelativePath(relPath: string): string {
  if (!relPath || typeof relPath !== "string") {
    throw new PathContainmentError("Relative path must be a non-empty string.");
  }

  if (CONTROL_CHAR_REGEX.test(relPath)) {
    throw new PathContainmentError("Relative path contains prohibited control characters.");
  }

  // Check for UNC, drive-relative, or absolute prefix before normalization
  const trimmed = relPath.trim();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    throw new PathContainmentError(`Absolute or drive-rooted paths are not permitted: '${relPath}'`);
  }

  // Convert all backslashes to forward slashes
  const normalizedSeparators = relPath.replace(/\\/g, "/");

  // Check posix normalized form
  const segments = normalizedSeparators.split("/");
  const cleanSegments: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const rawSeg = segments[i];

    // Empty segments from leading/trailing or double slashes
    if (rawSeg === "") {
      if (i === 0 && segments.length > 1) {
        throw new PathContainmentError(`Path must not start with a slash: '${relPath}'`);
      }
      if (i === segments.length - 1) {
        // Trailing slash
        continue;
      }
      throw new PathContainmentError(`Path contains consecutive slashes: '${relPath}'`);
    }

    // Traversal check
    if (rawSeg === "." || rawSeg === "..") {
      throw new PathContainmentError(`Path traversal segment '${rawSeg}' is prohibited: '${relPath}'`);
    }

    // Prototype pollution check
    if (rawSeg === "__proto__" || rawSeg === "constructor" || rawSeg === "prototype") {
      throw new PathContainmentError(`Prototype-sensitive segment '${rawSeg}' is prohibited: '${relPath}'`);
    }

    // Windows Alternate Data Streams (ADS)
    if (ADS_REGEX.test(rawSeg)) {
      throw new PathContainmentError(`Windows Alternate Data Stream notation is prohibited: '${rawSeg}'`);
    }

    // Trailing dots and spaces (Windows filesystem aliases)
    if (rawSeg.endsWith(".") || rawSeg.endsWith(" ")) {
      throw new PathContainmentError(`Path segment with trailing space or dot is prohibited: '${rawSeg}'`);
    }

    // DOS device names
    if (DOS_DEVICE_REGEX.test(rawSeg)) {
      throw new PathContainmentError(`Reserved device name is prohibited: '${rawSeg}'`);
    }

    cleanSegments.push(rawSeg);
  }

  if (cleanSegments.length === 0) {
    throw new PathContainmentError("Path resolved to empty target.");
  }

  return cleanSegments.join("/");
}

/**
 * Safe boolean predicate: returns true if the path can be canonicalized without error.
 */
export function isSafeRelativePath(relPath: string): boolean {
  try {
    canonicalizeRelativePath(relPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Formal Ownership Categories for Game Directory Files
 */
export type PathOwnershipCategory =
  | "RESERVED_INTERNAL"     // .lampas, .lampas/* (Launcher state, receipts, release, cache)
  | "PROTECTED_PLAYER_DATA" // saves/*, screenshots/*, logs/*, crash-reports/*, options.txt, servers.dat, usercache.json, hotbar.nbt, realms_persistence.json
  | "MANAGED_PACK_FILES"    // mods/*, config/*, resourcepacks/* (pack-managed content)
  | "UNPROTECTED";

const RESERVED_INTERNAL_PREFIXES = [
  ".lampas",
  ".lampas/",
];

const PROTECTED_PLAYER_DATA_ITEMS = [
  "options.txt",
  "servers.dat",
  "usercache.json",
  "hotbar.nbt",
  "realms_persistence.json",
];

const PROTECTED_PLAYER_DATA_DIRS = [
  "saves/",
  "screenshots/",
  "logs/",
  "crash-reports/",
];

/**
 * Determines the ownership category of a relative path.
 * Normalizes dot-aliases and performs case-insensitive matching across platforms.
 */
export function getOwnershipCategory(relPath: string): PathOwnershipCategory {
  if (!relPath || typeof relPath !== "string") {
    return "UNPROTECTED";
  }

  // Normalize path resolving dot-aliases (e.g. mods/../saves/world.txt -> saves/world.txt)
  let normalized = relPath.replace(/\\/g, "/");
  normalized = path.posix.normalize(normalized).replace(/^\/+/, "");
  const lower = normalized.toLowerCase();

  // 1. Reserved internal launcher namespace
  for (const prefix of RESERVED_INTERNAL_PREFIXES) {
    if (lower === prefix || lower.startsWith(".lampas/")) {
      return "RESERVED_INTERNAL";
    }
  }

  // 2. Protected player data single files
  for (const item of PROTECTED_PLAYER_DATA_ITEMS) {
    if (lower === item.toLowerCase()) {
      return "PROTECTED_PLAYER_DATA";
    }
  }

  // 3. Protected player data directories
  for (const dir of PROTECTED_PLAYER_DATA_DIRS) {
    if (lower === dir.slice(0, -1) || lower.startsWith(dir.toLowerCase())) {
      return "PROTECTED_PLAYER_DATA";
    }
  }

  return "UNPROTECTED";
}

/**
 * Checks whether a relative path falls into either RESERVED_INTERNAL (.lampas)
 * or PROTECTED_PLAYER_DATA (saves, screenshots, logs, crash-reports, options.txt, etc.).
 *
 * Invariants:
 * - Normalizes dot-aliases before checking (mods/../saves/world.txt is recognized as protected)
 * - Case-insensitive on Windows and across all platforms for defense-in-depth
 * - Reserves .lampas launcher state directory
 */
export function isPathProtected(relPath: string): boolean {
  const category = getOwnershipCategory(relPath);
  return category === "RESERVED_INTERNAL" || category === "PROTECTED_PLAYER_DATA";
}

/**
 * Resolves a path relative to a base directory and verifies that it is strictly contained within baseDir.
 * Returns the resolved canonical absolute path.
 */
export function resolveAndContainPath(
  baseDir: string,
  targetRelOrAbs: string,
  options: { allowEqual?: boolean } = {}
): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.isAbsolute(targetRelOrAbs)
    ? path.resolve(targetRelOrAbs)
    : path.resolve(resolvedBase, targetRelOrAbs);

  const isWindows = process.platform === "win32";
  const compBase = isWindows ? resolvedBase.toLowerCase() : resolvedBase;
  const compTarget = isWindows ? resolvedTarget.toLowerCase() : resolvedTarget;

  if (compTarget === compBase) {
    if (options.allowEqual) {
      return resolvedTarget;
    }
    throw new PathContainmentError(`Target path cannot be identical to base directory: '${targetRelOrAbs}'`);
  }

  const basePrefix = compBase.endsWith(path.sep) ? compBase : compBase + path.sep;
  if (!compTarget.startsWith(basePrefix)) {
    throw new PathContainmentError(
      `Path containment violation: '${targetRelOrAbs}' resolves outside base directory '${baseDir}'`
    );
  }

  return resolvedTarget;
}

/**
 * Synchronously inspects the physical ancestry of a path from baseDir to fullPath.
 * Detects symlink or junction escapes that point outside baseDir, and ensures
 * existing files are regular files (not special files, sockets, FIFOs, devices).
 */
export function checkPhysicalAncestrySync(baseDir: string, fullPath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(fullPath);

  // Containment check first
  resolveAndContainPath(resolvedBase, resolvedTarget, { allowEqual: true });

  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel === ".") return;

  const parts = rel.split(path.sep);
  let current = resolvedBase;

  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      // Once an element doesn't exist, remaining children don't exist yet
      break;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err: any) {
      throw new PathContainmentError(`Cannot lstat physical ancestor '${current}': ${err.message}`);
    }

    if (stat.isSymbolicLink()) {
      // Follow symlink and verify target remains within baseDir
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(current);
      } catch (err: any) {
        throw new PathContainmentError(`Cannot resolve symlink target at '${current}': ${err.message}`);
      }
      resolveAndContainPath(resolvedBase, realTarget, { allowEqual: true });
    }

    if (
      stat.isFIFO() ||
      stat.isSocket() ||
      stat.isCharacterDevice() ||
      stat.isBlockDevice()
    ) {
      throw new PathContainmentError(
        `Prohibited special file type encountered in physical ancestry: '${current}'`
      );
    }
  }
}

/**
 * Asynchronously inspects the physical ancestry of a path from baseDir to fullPath.
 */
export async function checkPhysicalAncestry(baseDir: string, fullPath: string): Promise<void> {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(fullPath);

  resolveAndContainPath(resolvedBase, resolvedTarget, { allowEqual: true });

  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel === ".") return;

  const parts = rel.split(path.sep);
  let current = resolvedBase;

  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) {
        const realTarget = await fs.promises.realpath(current);
        resolveAndContainPath(resolvedBase, realTarget, { allowEqual: true });
      }
      if (
        stat.isFIFO() ||
        stat.isSocket() ||
        stat.isCharacterDevice() ||
        stat.isBlockDevice()
      ) {
        throw new PathContainmentError(
          `Prohibited special file type encountered in physical ancestry: '${current}'`
        );
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        break;
      }
      if (err instanceof PathContainmentError) {
        throw err;
      }
      throw new PathContainmentError(`Cannot inspect physical ancestry at '${current}': ${err.message}`);
    }
  }
}

/**
 * Validates manifest metadata and file definitions before any mutation or download:
 * - Enforces protocol limit
 * - Validates relative paths: safe relative path, no protected namespace targets
 * - Validates SHA-256 digest format
 * - Validates positive sizes
 * - Detects duplicate or case-equivalent destinations
 * - Validates config patches: uniqueness, safety, no collision with whole-file paths
 */
export function validateManifestMetadata(manifest: any, releaseData?: any): void {
  if (!manifest || typeof manifest !== "object") {
    throw new PathContainmentError("Invalid client manifest: expected object.");
  }

  const files = manifest.files;
  if (files !== undefined && !Array.isArray(files)) {
    throw new PathContainmentError("Invalid manifest: 'files' must be an array.");
  }

  const destinationMap = new Map<string, any>();
  const isWindows = process.platform === "win32";

  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || typeof file !== "object") {
        throw new PathContainmentError("Invalid file entry in manifest: expected object.");
      }

      if (typeof file.path !== "string" || !file.path) {
        throw new PathContainmentError("Manifest file entry is missing 'path'.");
      }

      // 1. Canonicalize relative path
      let canonicalPath: string;
      try {
        canonicalPath = canonicalizeRelativePath(file.path);
      } catch (err: any) {
        throw new PathContainmentError(`Unsafe relative path in manifest: '${file.path}': ${err.message}`);
      }

      // 2. Reject attempts to target protected namespaces or launcher internal state
      if (isPathProtected(canonicalPath)) {
        throw new PathContainmentError(
          `Manifest file '${file.path}' targets protected or reserved namespace '${canonicalPath}'. Pack files cannot overwrite user data or launcher state.`
        );
      }

      // 3. Detect duplicate or case-equivalent destinations
      const lookupKey = isWindows ? canonicalPath.toLowerCase() : canonicalPath;
      if (destinationMap.has(lookupKey)) {
        throw new PathContainmentError(
          `Duplicate manifest destination detected: '${canonicalPath}' conflicts with '${destinationMap.get(lookupKey).path}'`
        );
      }
      destinationMap.set(lookupKey, file);

      // 4. Validate SHA-256 digest format
      if (!file.hashes || typeof file.hashes !== "object" || !file.hashes.sha256) {
        throw new PathContainmentError(`Manifest file '${file.path}' is missing SHA-256 hash.`);
      }
      validateDigestString(file.hashes.sha256, "sha256");

      // 5. Validate size
      if (typeof file.size !== "number" || file.size < 0 || !Number.isSafeInteger(file.size)) {
        throw new PathContainmentError(`Manifest file '${file.path}' has invalid size: ${file.size}`);
      }
    }
  }

  // 6. Validate config patches
  const patches = manifest.configPatches ?? (releaseData && (releaseData as any).configPatches);
  if (patches !== undefined) {
    if (!Array.isArray(patches)) {
      throw new PathContainmentError("Invalid manifest: 'configPatches' must be an array.");
    }

    const patchIds = new Set<string>();
    const patchPaths = new Map<string, string>();

    for (const patch of patches) {
      if (!patch || typeof patch !== "object") {
        throw new PathContainmentError("Invalid config patch entry: expected object.");
      }

      if (typeof patch.id !== "string" || !patch.id.trim()) {
        throw new PathContainmentError("Config patch entry is missing 'id'.");
      }
      if (patchIds.has(patch.id)) {
        throw new PathContainmentError(`Duplicate config patch ID: '${patch.id}'`);
      }
      patchIds.add(patch.id);

      const patchPathRaw =
        typeof patch.path === "string" && patch.path.trim()
          ? patch.path
          : typeof patch.file === "string" && patch.file.trim()
            ? patch.file
            : "";
      if (!patchPathRaw) {
        throw new PathContainmentError(`Config patch '${patch.id}' is missing 'path'.`);
      }

      let canonicalPatchPath: string;
      try {
        canonicalPatchPath = canonicalizeRelativePath(patchPathRaw);
      } catch (err: any) {
        throw new PathContainmentError(`Unsafe config patch path in '${patch.id}': ${err.message}`);
      }

      if (isPathProtected(canonicalPatchPath)) {
        throw new PathContainmentError(
          `Config patch '${patch.id}' targets protected namespace: '${canonicalPatchPath}'`
        );
      }

      // Check collision between whole-file management and config patches
      const patchKey = isWindows ? canonicalPatchPath.toLowerCase() : canonicalPatchPath;
      if (destinationMap.has(patchKey)) {
        throw new PathContainmentError(
          `Conflict: file '${canonicalPatchPath}' is managed both as a whole file and by config patch '${patch.id}'.`
        );
      }
      patchPaths.set(patchKey, patch.id);
    }
  }
}

/**
 * Strictly sanitizes and validates previous installation state.
 * Any key in `prevState.files` that fails containment, attempts traversal, or targets
 * protected namespaces is stripped so it cannot trigger deletion of arbitrary files.
 */
export function sanitizeInstallationState(
  rawState: any,
  gameDir: string
): { files: Record<string, any>; quarantinedKeys: string[] } {
  const resultFiles: Record<string, any> = {};
  const quarantinedKeys: string[] = [];

  if (!rawState || typeof rawState !== "object" || !rawState.files || typeof rawState.files !== "object") {
    return { files: resultFiles, quarantinedKeys };
  }

  for (const [key, info] of Object.entries(rawState.files)) {
    // 1. Must be a safe relative path
    if (!isSafeRelativePath(key)) {
      quarantinedKeys.push(key);
      continue;
    }

    // 2. Must not resolve into protected player data or reserved launcher internal state
    if (isPathProtected(key)) {
      quarantinedKeys.push(key);
      continue;
    }

    // 3. Must resolve strictly inside gameDir
    try {
      resolveAndContainPath(gameDir, key);
    } catch {
      quarantinedKeys.push(key);
      continue;
    }

    // 4. Must have valid policy
    const fileObj = info && typeof info === "object" ? (info as any) : {};
    resultFiles[key] = {
      ...fileObj,
      policy: fileObj.policy === "PRESERVE" ? "PRESERVE" : "MANAGED",
    };
  }

  return { files: resultFiles, quarantinedKeys };
}
