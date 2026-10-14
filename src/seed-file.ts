import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type SeedPlacement = "placed" | "kept";

/**
 * Reports whether anything exists at `destination`, using lstat. A file, a
 * directory, a symlink, or a dangling symlink all count. Nothing is followed.
 */
export async function seedEntryExists(destination: string): Promise<boolean> {
  try {
    await fs.promises.lstat(destination);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Creates `destination` from `sourcePath` only if no entry exists there. The
 * bytes are staged in a sibling temp file, then hard-linked into place. When
 * link fails with EEXIST, something exists, so the entry is kept. Any other
 * link failure falls back to an exclusive copy (COPYFILE_EXCL), which also
 * reports EEXIST as kept. The destination appears whole or not at all. The
 * caller must check ancestry and symlinks before calling.
 */
export async function placeSeedFileIfAbsent(
  sourcePath: string,
  destination: string,
): Promise<SeedPlacement> {
  if (await seedEntryExists(destination)) return "kept";

  const dir = path.dirname(destination);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(destination)}.${crypto.randomUUID()}.seed-tmp`,
  );
  await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
  try {
    try {
      await fs.promises.link(tempPath, destination);
      return "placed";
    } catch (linkError: any) {
      if (linkError?.code === "EEXIST") return "kept";
      // Any other link failure (unsupported filesystem, EISDIR, EINVAL, ...)
      // falls through to the exclusive copy.
    }
    try {
      await fs.promises.copyFile(
        tempPath,
        destination,
        fs.constants.COPYFILE_EXCL,
      );
      return "placed";
    } catch (copyError: any) {
      if (copyError?.code === "EEXIST") return "kept";
      // This call may have created the destination, so a partial copy must not remain.
      await fs.promises.rm(destination, { force: true }).catch(() => undefined);
      throw copyError;
    }
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
