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
  algorithm: "sha256" | "sha1" = "sha256",
): string {
  if (typeof hash !== "string") {
    throw new PathContainmentError(
      `Invalid digest: expected string, got ${typeof hash}`,
    );
  }
  const trimmed = hash.trim().toLowerCase();
  const expectedLength = algorithm === "sha256" ? 64 : 40;
  const regex = algorithm === "sha256" ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;

  if (trimmed.length !== expectedLength || !regex.test(trimmed)) {
    throw new PathContainmentError(
      `Invalid ${algorithm.toUpperCase()} digest format: '${hash}' (expected ${expectedLength} hex characters)`,
    );
  }
  return trimmed;
}

export function isValidDigestString(
  hash: string,
  algorithm: "sha256" | "sha1" = "sha256",
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
    throw new PathContainmentError(
      "Relative path contains prohibited control characters.",
    );
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
    throw new PathContainmentError(
      `Absolute or drive-rooted paths are not permitted: '${relPath}'`,
    );
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
        throw new PathContainmentError(
          `Path must not start with a slash: '${relPath}'`,
        );
      }
      if (i === segments.length - 1) {
        // Trailing slash
        continue;
      }
      throw new PathContainmentError(
        `Path contains consecutive slashes: '${relPath}'`,
      );
    }

    // Traversal check
    if (rawSeg === "." || rawSeg === "..") {
      throw new PathContainmentError(
        `Path traversal segment '${rawSeg}' is prohibited: '${relPath}'`,
      );
    }

    // Prototype pollution check
    if (
      rawSeg === "__proto__" ||
      rawSeg === "constructor" ||
      rawSeg === "prototype"
    ) {
      throw new PathContainmentError(
        `Prototype-sensitive segment '${rawSeg}' is prohibited: '${relPath}'`,
      );
    }

    // Windows Alternate Data Streams (ADS)
    if (ADS_REGEX.test(rawSeg)) {
      throw new PathContainmentError(
        `Windows Alternate Data Stream notation is prohibited: '${rawSeg}'`,
      );
    }

    // Trailing dots and spaces (Windows filesystem aliases)
    if (rawSeg.endsWith(".") || rawSeg.endsWith(" ")) {
      throw new PathContainmentError(
        `Path segment with trailing space or dot is prohibited: '${rawSeg}'`,
      );
    }

    // DOS device names
    if (DOS_DEVICE_REGEX.test(rawSeg)) {
      throw new PathContainmentError(
        `Reserved device name is prohibited: '${rawSeg}'`,
      );
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
 * Normalizes a relative path into a platform-aware key for set/map lookups:
 * - On Windows: lowercase POSIX path (NTFS case-insensitive)
 * - On POSIX: case-sensitive POSIX path
 */
export function normalizePathKey(relPath: string): string {
  const canonical = canonicalizeRelativePath(relPath);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * Formal Ownership Categories for Game Directory Files
 */
export type PathOwnershipCategory =
  | "RESERVED_INTERNAL" // .lampas, .lampas/*, .lampas-moving-* (Launcher state, receipts, release, cache, staging)
  | "PROTECTED_PLAYER_DATA" // saves/*, screenshots/*, logs/*, crash-reports/*, options.txt, servers.dat, usercache.json, hotbar.nbt, realms_persistence.json
  | "MANAGED_PACK_FILES" // mods/*, config/*, resourcepacks/* (pack-managed content)
  | "UNPROTECTED";

const RESERVED_INTERNAL_PREFIXES = [".lampas", ".lampas/", ".lampas-moving-"];

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
    if (
      lower === prefix ||
      lower.startsWith(".lampas/") ||
      lower.startsWith(".lampas-moving-")
    ) {
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

  // 4. Managed pack files directories
  const MANAGED_PACK_DIRS = ["mods/", "config/", "resourcepacks/"];
  for (const dir of MANAGED_PACK_DIRS) {
    if (lower === dir.slice(0, -1) || lower.startsWith(dir.toLowerCase())) {
      return "MANAGED_PACK_FILES";
    }
  }

  return "UNPROTECTED";
}

/**
 * Checks whether a relative path falls into either RESERVED_INTERNAL (.lampas, .lampas-moving-*)
 * or PROTECTED_PLAYER_DATA (saves, screenshots, logs, crash-reports, options.txt, etc.).
 *
 * Invariants:
 * - Normalizes dot-aliases before checking (mods/../saves/world.txt is recognized as protected)
 * - Case-insensitive on Windows and across all platforms for defense-in-depth
 * - Reserves .lampas and .lampas-moving-* launcher namespaces
 */
export function isPathProtected(relPath: string): boolean {
  const category = getOwnershipCategory(relPath);
  return (
    category === "RESERVED_INTERNAL" || category === "PROTECTED_PLAYER_DATA"
  );
}

const OPTIONS_KEYBIND_KEY_PATTERN = /^key_[A-Za-z0-9_.\-]+$/;
const OPTIONS_KEYBIND_VALUE_PATTERN =
  /^key\.(keyboard|mouse)\.[A-Za-z0-9_.\-]+$/;

/**
 * The one config-patch exception to PROTECTED_PLAYER_DATA: a pack may rebind
 * keybinds in options.txt. Returns true only for a `properties` patch with
 * `mode: "once"` and `missingFile: "defer"` whose operations are all `set` ops
 * on a `key_*` entry with a `key.keyboard.*` or `key.mouse.*` value. The target
 * must be exactly `options.txt` in lowercase. An enforce-mode keybind patch would
 * revert the player's rebind on every sync, so it gets no exception.
 *
 * The reconciler rewrites only lines that already exist (see keybind-lines.ts).
 *
 * Accepts raw manifest objects, which may name the target `file` instead of
 * `path`, the same way validateManifestMetadata does. Never throws.
 */
export function isOptionsKeybindPatch(patch: unknown): boolean {
  try {
    if (!patch || typeof patch !== "object") return false;
    const raw = patch as Record<string, unknown>;
    const rawPath =
      typeof raw.path === "string" && raw.path.trim()
        ? raw.path
        : typeof raw.file === "string" && raw.file.trim()
          ? raw.file
          : "";
    if (!rawPath) return false;
    if (canonicalizeRelativePath(rawPath) !== "options.txt") return false;
    if (raw.adapter !== "properties") return false;
    if (raw.mode !== "once") return false;
    if (raw.missingFile !== "defer") return false;
    const operations = raw.operations;
    if (!Array.isArray(operations) || operations.length === 0) return false;
    return operations.every((operation: unknown) => {
      if (!operation || typeof operation !== "object") return false;
      const op = operation as Record<string, unknown>;
      if (op.op !== "set") return false;
      const keyPath = op.path;
      if (!Array.isArray(keyPath) || keyPath.length !== 1) return false;
      const key = keyPath[0];
      if (typeof key !== "string" || !OPTIONS_KEYBIND_KEY_PATTERN.test(key)) {
        return false;
      }
      return (
        typeof op.value === "string" &&
        OPTIONS_KEYBIND_VALUE_PATTERN.test(op.value)
      );
    });
  } catch {
    return false;
  }
}

// Protected player files that a pack may seed. A seed is placed only when the
// player has no such file, and it is never recorded in installation state.
const PRESERVED_SEED_FILES: ReadonlySet<string> = new Set([
  "options.txt",
  "servers.dat",
]);

/**
 * Returns true for a pack seed file: a manifest file whose path is exactly
 * `options.txt` or `servers.dat` in lowercase, with policy PRESERVE. Other
 * spellings (OPTIONS.TXT, Servers.dat), other policies, and other protected
 * paths get no exception.
 */
export function isPreservedSeedFile(
  relPath: unknown,
  policy: unknown,
): boolean {
  if (policy !== "PRESERVE" || typeof relPath !== "string") return false;
  try {
    return PRESERVED_SEED_FILES.has(canonicalizeRelativePath(relPath));
  } catch {
    return false;
  }
}

function stripExtendedPathPrefix(p: string): string {
  if (process.platform !== "win32") return p;
  if (p.startsWith("\\\\?\\UNC\\")) {
    return "\\\\" + p.substring(8);
  }
  if (p.startsWith("\\\\?\\")) {
    return p.substring(4);
  }
  return p;
}

export function realpathCanonicalSync(targetPath: string): string {
  const fn = fs.realpathSync.native || fs.realpathSync;
  return stripExtendedPathPrefix(fn(targetPath));
}

export async function realpathCanonical(targetPath: string): Promise<string> {
  const res = await fs.promises.realpath(targetPath);
  return stripExtendedPathPrefix(res);
}

/**
 * Safely resolves the canonical realpath of a directory or path,
 * falling back to resolving the nearest existing ancestor if the path itself does not exist.
 * This guarantees consistent resolution of 8.3 short paths (e.g. RUNNER~1 vs runneradmin)
 * and symlinks on Windows and UNIX platforms.
 */
export function getCanonicalDiskPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (fs.existsSync(resolved)) {
    try {
      return realpathCanonicalSync(resolved);
    } catch {
      return resolved;
    }
  }

  // Walk up to find nearest existing ancestor
  let ancestor = resolved;
  const missingParts: string[] = [];
  while (ancestor) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    missingParts.unshift(path.basename(ancestor));
    ancestor = parent;
    if (fs.existsSync(ancestor)) {
      try {
        const realAncestor = realpathCanonicalSync(ancestor);
        return path.join(realAncestor, ...missingParts);
      } catch {
        return resolved;
      }
    }
  }

  return resolved;
}

/**
 * Resolves a path relative to a base directory and verifies that it is strictly contained within baseDir.
 * Returns the resolved canonical absolute path.
 */
export function resolveAndContainPath(
  baseDir: string,
  targetRelOrAbs: string,
  options: { allowEqual?: boolean } = {},
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
    throw new PathContainmentError(
      `Target path cannot be identical to base directory: '${targetRelOrAbs}'`,
    );
  }

  const basePrefix = compBase.endsWith(path.sep)
    ? compBase
    : compBase + path.sep;
  if (!compTarget.startsWith(basePrefix)) {
    // On Windows, paths can differ by 8.3 short name (e.g. RUNNER~1 vs runneradmin).
    // If initial prefix match fails, compare canonical disk paths.
    if (isWindows) {
      const canonBase = getCanonicalDiskPath(resolvedBase).toLowerCase();
      const canonTarget = getCanonicalDiskPath(resolvedTarget).toLowerCase();
      const canonPrefix = canonBase.endsWith(path.sep)
        ? canonBase
        : canonBase + path.sep;

      if (canonTarget === canonBase) {
        if (options.allowEqual) return resolvedTarget;
        throw new PathContainmentError(
          `Target path cannot be identical to base directory: '${targetRelOrAbs}'`,
        );
      }
      if (canonTarget.startsWith(canonPrefix)) {
        return resolvedTarget;
      }
    }

    throw new PathContainmentError(
      `Path containment violation: '${targetRelOrAbs}' resolves outside base directory '${baseDir}'`,
    );
  }

  return resolvedTarget;
}

/**
 * Asserts that a subordinate directory (e.g. .lampas, runtime, natives, mods)
 * is physically located within the approved instance root (gameDir).
 * Rejects symlinks, junctions, or links that point outside gameDir or into protected namespaces.
 */
export function assertSubordinateRoot(gameDir: string, subDir: string): string {
  const resolvedGameDir = path.resolve(gameDir);
  const resolvedSubDir = path.isAbsolute(subDir)
    ? path.resolve(subDir)
    : path.resolve(resolvedGameDir, subDir);

  // Lexical containment
  resolveAndContainPath(resolvedGameDir, resolvedSubDir, { allowEqual: true });

  const canonGameDir = getCanonicalDiskPath(resolvedGameDir);
  const rel = path
    .relative(resolvedGameDir, resolvedSubDir)
    .replace(/\\/g, "/");
  const lowerRel = rel.toLowerCase();
  let expectedCategory: PathOwnershipCategory | undefined;
  if (lowerRel === ".lampas" || lowerRel.startsWith(".lampas/")) {
    expectedCategory = "RESERVED_INTERNAL";
  } else if (lowerRel === "mods" || lowerRel.startsWith("mods/")) {
    expectedCategory = "MANAGED_PACK_FILES";
  }

  // If subDir exists, verify physical ancestry
  if (fs.existsSync(resolvedSubDir)) {
    const stat = fs.lstatSync(resolvedSubDir);
    if (stat.isSymbolicLink()) {
      throw new PathContainmentError(
        `Subordinate root cannot be a symbolic link: '${resolvedSubDir}'`,
      );
    }
    checkPhysicalAncestrySync(resolvedGameDir, resolvedSubDir, {
      disallowSymlinks: true,
      expectedCategory,
    });
    const realSubDir = getCanonicalDiskPath(resolvedSubDir);
    resolveAndContainPath(canonGameDir, realSubDir, { allowEqual: true });
  } else {
    // If not yet created, verify its closest existing ancestor
    let parent = path.dirname(resolvedSubDir);
    while (parent && !fs.existsSync(parent) && parent !== resolvedGameDir) {
      parent = path.dirname(parent);
    }
    if (fs.existsSync(parent)) {
      checkPhysicalAncestrySync(resolvedGameDir, parent, {
        disallowSymlinks: true,
      });
      const realParent = getCanonicalDiskPath(parent);
      resolveAndContainPath(canonGameDir, realParent, { allowEqual: true });
    }
  }

  return resolvedSubDir;
}

export interface PhysicalAncestryOptions {
  disallowSymlinks?: boolean;
  enforceOwnership?: boolean;
  expectedCategory?: PathOwnershipCategory;
}

/**
 * Synchronously inspects the physical ancestry of a path from baseDir to fullPath.
 * Detects symlink or junction escapes that point outside baseDir, ensures
 * existing files are regular files (not special files, sockets, FIFOs, devices),
 * and if enforceOwnership is true, rejects links or destinations resolving into protected namespaces.
 */
export function checkPhysicalAncestrySync(
  baseDir: string,
  fullPath: string,
  options: PhysicalAncestryOptions = {},
): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(fullPath);

  // Containment check first
  resolveAndContainPath(resolvedBase, resolvedTarget, { allowEqual: true });

  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel === ".") return;

  const canonBase = getCanonicalDiskPath(resolvedBase);

  const parts = rel.split(path.sep);
  let current = resolvedBase;

  for (const part of parts) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        break;
      }
      throw new PathContainmentError(
        `Cannot lstat physical ancestor '${current}': ${err.message}`,
      );
    }

    if (options.disallowSymlinks && stat.isSymbolicLink()) {
      throw new PathContainmentError(
        `Prohibited symbolic link along path: '${current}'`,
      );
    }

    if (stat.isSymbolicLink()) {
      // Follow symlink and verify target remains within baseDir
      let realTarget: string;
      try {
        realTarget = realpathCanonicalSync(current);
      } catch (err: any) {
        throw new PathContainmentError(
          `Cannot resolve symlink target at '${current}': ${err.message}`,
        );
      }
      resolveAndContainPath(canonBase, realTarget, { allowEqual: true });

      if (options.enforceOwnership) {
        const relToRoot = path
          .relative(canonBase, realTarget)
          .replace(/\\/g, "/");
        if (isPathProtected(relToRoot)) {
          throw new PathContainmentError(
            `Physical link target at '${current}' resolves into protected or reserved namespace '${relToRoot}'`,
          );
        }
      }
    }

    if (
      stat.isFIFO() ||
      stat.isSocket() ||
      stat.isCharacterDevice() ||
      stat.isBlockDevice()
    ) {
      throw new PathContainmentError(
        `Prohibited special file type encountered in physical ancestry: '${current}'`,
      );
    }
  }

  // Inspect the resolved realpath of the target or its closest existing ancestor
  if (options.enforceOwnership || options.expectedCategory) {
    let checkPath = resolvedTarget;
    while (
      checkPath &&
      !fs.existsSync(checkPath) &&
      checkPath !== resolvedBase
    ) {
      checkPath = path.dirname(checkPath);
    }
    if (fs.existsSync(checkPath) && checkPath !== resolvedBase) {
      try {
        const realTarget = realpathCanonicalSync(checkPath);
        resolveAndContainPath(canonBase, realTarget, { allowEqual: true });
        const relToRoot = path
          .relative(canonBase, realTarget)
          .replace(/\\/g, "/");
        const category = getOwnershipCategory(relToRoot);

        if (options.expectedCategory) {
          if (category !== options.expectedCategory) {
            throw new PathContainmentError(
              `Physical destination resolves into unexpected category '${category}' (expected '${options.expectedCategory}'): '${relToRoot}'`,
            );
          }
        } else if (options.enforceOwnership) {
          if (isPathProtected(relToRoot)) {
            throw new PathContainmentError(
              `Physical destination resolves into protected or reserved namespace: '${relToRoot}'`,
            );
          }
        }
      } catch (err: any) {
        if (err instanceof PathContainmentError) throw err;
      }
    }
  }
}

/**
 * Asynchronously inspects the physical ancestry of a path from baseDir to fullPath.
 */
export async function checkPhysicalAncestry(
  baseDir: string,
  fullPath: string,
  options: PhysicalAncestryOptions = {},
): Promise<void> {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(fullPath);

  resolveAndContainPath(resolvedBase, resolvedTarget, { allowEqual: true });

  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel === ".") return;

  const canonBase = getCanonicalDiskPath(resolvedBase);

  const parts = rel.split(path.sep);
  let current = resolvedBase;

  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.promises.lstat(current);

      if (options.disallowSymlinks && stat.isSymbolicLink()) {
        throw new PathContainmentError(
          `Prohibited symbolic link along path: '${current}'`,
        );
      }

      if (stat.isSymbolicLink()) {
        const realTarget = await realpathCanonical(current);
        resolveAndContainPath(canonBase, realTarget, { allowEqual: true });

        if (options.enforceOwnership) {
          const relToRoot = path
            .relative(canonBase, realTarget)
            .replace(/\\/g, "/");
          if (isPathProtected(relToRoot)) {
            throw new PathContainmentError(
              `Physical link target at '${current}' resolves into protected or reserved namespace '${relToRoot}'`,
            );
          }
        }
      }
      if (
        stat.isFIFO() ||
        stat.isSocket() ||
        stat.isCharacterDevice() ||
        stat.isBlockDevice()
      ) {
        throw new PathContainmentError(
          `Prohibited special file type encountered in physical ancestry: '${current}'`,
        );
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        break;
      }
      if (err instanceof PathContainmentError) {
        throw err;
      }
      throw new PathContainmentError(
        `Cannot inspect physical ancestry at '${current}': ${err.message}`,
      );
    }
  }

  if (options.enforceOwnership || options.expectedCategory) {
    let checkPath = resolvedTarget;
    while (
      checkPath &&
      !fs.existsSync(checkPath) &&
      checkPath !== resolvedBase
    ) {
      checkPath = path.dirname(checkPath);
    }
    if (fs.existsSync(checkPath) && checkPath !== resolvedBase) {
      try {
        const realTarget = await realpathCanonical(checkPath);
        resolveAndContainPath(canonBase, realTarget, { allowEqual: true });
        const relToRoot = path
          .relative(canonBase, realTarget)
          .replace(/\\/g, "/");
        const category = getOwnershipCategory(relToRoot);

        if (options.expectedCategory) {
          if (category !== options.expectedCategory) {
            throw new PathContainmentError(
              `Physical destination resolves into unexpected category '${category}' (expected '${options.expectedCategory}'): '${relToRoot}'`,
            );
          }
        } else if (options.enforceOwnership) {
          if (isPathProtected(relToRoot)) {
            throw new PathContainmentError(
              `Physical destination resolves into protected or reserved namespace: '${relToRoot}'`,
            );
          }
        }
      } catch (err: any) {
        if (err instanceof PathContainmentError) throw err;
      }
    }
  }
}

/**
 * Validates manifest metadata and file definitions before any mutation or download:
 * - Enforces mandatory 'files' array
 * - Canonicalizes relative paths in-place
 * - Rejects protected namespace targets
 * - Validates SHA-256 digest format
 * - Validates positive integer sizes
 * - Detects duplicate or case-equivalent destinations
 * - Validates config patches: uniqueness, safety, no collision with whole-file paths
 */
export function validateManifestMetadata(
  manifest: any,
  releaseData?: any,
): void {
  if (!manifest || typeof manifest !== "object") {
    throw new PathContainmentError("Invalid client manifest: expected object.");
  }

  const files = manifest.files;
  if (!files || !Array.isArray(files)) {
    throw new PathContainmentError(
      "Invalid manifest: 'files' array is mandatory.",
    );
  }

  const destinationMap = new Map<string, any>();
  const isWindows = process.platform === "win32";

  for (const file of files) {
    if (!file || typeof file !== "object") {
      throw new PathContainmentError(
        "Invalid file entry in manifest: expected object.",
      );
    }

    if (typeof file.path !== "string" || !file.path) {
      throw new PathContainmentError("Manifest file entry is missing 'path'.");
    }

    // 1. Canonicalize relative path and update file.path in-place to normalized canonical path
    let canonicalPath: string;
    try {
      canonicalPath = canonicalizeRelativePath(file.path);
      file.path = canonicalPath;
    } catch (err: any) {
      throw new PathContainmentError(
        `Unsafe relative path in manifest: '${file.path}': ${err.message}`,
      );
    }

    // 2. Reject attempts to target protected namespaces or launcher internal state
    if (
      isPathProtected(canonicalPath) &&
      !isPreservedSeedFile(canonicalPath, file.policy)
    ) {
      throw new PathContainmentError(
        `Manifest file '${file.path}' targets protected or reserved namespace '${canonicalPath}'. Pack files cannot overwrite user data or launcher state.`,
      );
    }

    // 3. Detect duplicate or case-equivalent destinations
    const lookupKey = normalizePathKey(canonicalPath);
    if (destinationMap.has(lookupKey)) {
      throw new PathContainmentError(
        `Duplicate manifest destination detected: '${canonicalPath}' conflicts with '${destinationMap.get(lookupKey).path}'`,
      );
    }
    destinationMap.set(lookupKey, file);

    // 4. Validate SHA-256 digest format
    if (
      !file.hashes ||
      typeof file.hashes !== "object" ||
      !file.hashes.sha256
    ) {
      throw new PathContainmentError(
        `Manifest file '${file.path}' is missing SHA-256 hash.`,
      );
    }
    validateDigestString(file.hashes.sha256, "sha256");

    // 5. Validate size
    if (
      typeof file.size !== "number" ||
      file.size < 0 ||
      !Number.isSafeInteger(file.size)
    ) {
      throw new PathContainmentError(
        `Manifest file '${file.path}' has invalid size: ${file.size}`,
      );
    }
  }

  // 6. Validate config patches
  const patches =
    manifest.configPatches ??
    (releaseData && (releaseData as any).configPatches);
  if (patches !== undefined) {
    if (!Array.isArray(patches)) {
      throw new PathContainmentError(
        "Invalid manifest: 'configPatches' must be an array.",
      );
    }

    const patchIds = new Set<string>();
    const patchPaths = new Map<string, string>();

    for (const patch of patches) {
      if (!patch || typeof patch !== "object") {
        throw new PathContainmentError(
          "Invalid config patch entry: expected object.",
        );
      }

      if (typeof patch.id !== "string" || !patch.id.trim()) {
        throw new PathContainmentError("Config patch entry is missing 'id'.");
      }
      if (patchIds.has(patch.id)) {
        throw new PathContainmentError(
          `Duplicate config patch ID: '${patch.id}'`,
        );
      }
      patchIds.add(patch.id);

      const patchPathRaw =
        typeof patch.path === "string" && patch.path.trim()
          ? patch.path
          : typeof patch.file === "string" && patch.file.trim()
            ? patch.file
            : "";
      if (!patchPathRaw) {
        throw new PathContainmentError(
          `Config patch '${patch.id}' is missing 'path'.`,
        );
      }

      let canonicalPatchPath: string;
      try {
        canonicalPatchPath = canonicalizeRelativePath(patchPathRaw);
        if (patch.path) patch.path = canonicalPatchPath;
        if (patch.file) patch.file = canonicalPatchPath;
      } catch (err: any) {
        throw new PathContainmentError(
          `Unsafe config patch path in '${patch.id}': ${err.message}`,
        );
      }

      if (
        isPathProtected(canonicalPatchPath) &&
        !isOptionsKeybindPatch(patch)
      ) {
        throw new PathContainmentError(
          `Config patch '${patch.id}' targets protected namespace: '${canonicalPatchPath}'`,
        );
      }

      // Check collision between whole-file management and config patches. The
      // one exception: a PRESERVE seed options.txt may ship alongside keybind
      // patches on it, which apply to existing player files. isOptionsKeybindPatch
      // accepts only options.txt, so servers.dat has no exception.
      const patchKey = normalizePathKey(canonicalPatchPath);
      const wholeFile = destinationMap.get(patchKey);
      if (
        wholeFile &&
        !(
          isPreservedSeedFile(wholeFile.path, wholeFile.policy) &&
          isOptionsKeybindPatch(patch)
        )
      ) {
        throw new PathContainmentError(
          `Conflict: file '${canonicalPatchPath}' is managed both as a whole file and by config patch '${patch.id}'.`,
        );
      }
      patchPaths.set(patchKey, patch.id);
    }
  }
}

/**
 * Strictly sanitizes and validates previous installation state.
 * Any key in `prevState.files` that fails containment, attempts traversal, targets
 * protected namespaces, or lacks valid metadata loses authority and is quarantined
 * so it cannot trigger deletion of arbitrary files.
 */
export function sanitizeInstallationState(
  rawState: any,
  gameDir: string,
): { files: Record<string, any>; quarantinedKeys: string[] } {
  const resultFiles: Record<string, any> = {};
  const quarantinedKeys: string[] = [];

  if (
    !rawState ||
    typeof rawState !== "object" ||
    !rawState.files ||
    typeof rawState.files !== "object"
  ) {
    return { files: resultFiles, quarantinedKeys };
  }

  for (const [key, info] of Object.entries(rawState.files)) {
    // 1. Drop non-objects, null, undefined
    if (!info || typeof info !== "object") {
      quarantinedKeys.push(key);
      continue;
    }

    const fileObj = info as Record<string, any>;

    // 2. Must be a safe relative path
    if (!isSafeRelativePath(key)) {
      quarantinedKeys.push(key);
      continue;
    }

    // 3. Canonicalize key
    let canonicalKey: string;
    try {
      canonicalKey = canonicalizeRelativePath(key);
    } catch {
      quarantinedKeys.push(key);
      continue;
    }

    // 4. Must not resolve into protected player data or reserved launcher internal state
    if (isPathProtected(canonicalKey)) {
      quarantinedKeys.push(key);
      continue;
    }

    // 5. Must resolve strictly inside gameDir
    try {
      resolveAndContainPath(gameDir, canonicalKey);
    } catch {
      quarantinedKeys.push(key);
      continue;
    }

    // 6. Must have an explicit, recognized policy. NEVER default unknown/missing to MANAGED!
    if (
      fileObj.policy !== "MANAGED" &&
      fileObj.policy !== "PRESERVE" &&
      fileObj.policy !== "OPTIONAL" &&
      fileObj.policy !== "GENERATED"
    ) {
      quarantinedKeys.push(key);
      continue;
    }

    // 7. If MANAGED, validate SHA-256 hash
    if (fileObj.policy === "MANAGED") {
      const sha256 =
        fileObj.sha256 || (fileObj.hashes && fileObj.hashes.sha256);
      if (
        !sha256 ||
        typeof sha256 !== "string" ||
        !isValidDigestString(sha256, "sha256")
      ) {
        quarantinedKeys.push(key);
        continue;
      }
    }

    resultFiles[canonicalKey] = {
      ...fileObj,
      path: canonicalKey,
      policy: fileObj.policy,
    };
  }

  return { files: resultFiles, quarantinedKeys };
}
