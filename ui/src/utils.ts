/**
 * Utility functions for the Lampas Launcher renderer UI.
 */

/** Electron prefixes a rejected ipcRenderer.invoke with the channel name. */
const ELECTRON_IPC_PREFIX = /^\s*Error invoking remote method '[^']*':\s*/i;

function stripErrorPrefixes(raw: string): string {
  return raw
    .replace(ELECTRON_IPC_PREFIX, "")
    .replace(/^(Error:\s*)+/i, "")
    .trim();
}

/** True when the player cancelled a confirmation dialog shown by main. */
export function isUserCancelled(err: unknown): boolean {
  const raw = typeof err === "string" ? err : (err as any)?.message || "";
  return /^You cancelled\b/i.test(stripErrorPrefixes(String(raw)));
}

/**
 * Normalizes technical backend and filesystem errors into clear, friendly guidance for users.
 */
export function formatFriendlyError(
  err: unknown,
  fallbackMessage = "Something went wrong. Open Logs for details.",
): string {
  if (!err) return fallbackMessage;

  const raw =
    typeof err === "string" ? err : (err as any)?.message || String(err);
  const clean = stripErrorPrefixes(raw);

  // Generic failure from the main process
  if (/unexpected internal error/i.test(clean)) {
    return fallbackMessage;
  }

  // Minecraft running conflict
  if (/Minecraft is running/i.test(clean)) {
    return "Close Minecraft first, then try again.";
  }

  // Active operation busy conflict
  if (
    /is currently in progress/i.test(clean) ||
    /operation.*in progress/i.test(clean)
  ) {
    return "The launcher is busy with something else. Try again when it's done.";
  }

  // Recovery blocked
  if (/unresolved startup recovery failure/i.test(clean)) {
    return "The launcher needs a restart. Close it and open it again.";
  }

  // Mod-specific errors
  if (/destination already exists/i.test(clean)) {
    return "You already have a mod file with this name.";
  }
  if (/missing from the mods folder/i.test(clean)) {
    return "That mod file is no longer in your mods folder.";
  }
  if (
    /already exists in the mods folder and is not a launcher-managed/i.test(
      clean,
    )
  ) {
    return "A file with this name is already in your mods folder.";
  }
  if (
    /Only .jar and .zip mod files are allowed/i.test(clean) ||
    /assertJar/i.test(clean)
  ) {
    return "Only .jar and .zip mod files are supported.";
  }

  // Common OS / filesystem errors
  if (/EBUSY/i.test(clean) || /resource locked/i.test(clean)) {
    return "A file is in use by another program. Close Minecraft and anything else using it, then try again.";
  }
  if (
    /EPERM/i.test(clean) ||
    /EACCES/i.test(clean) ||
    /permission denied/i.test(clean)
  ) {
    return "The launcher isn't allowed to change these files. Check that the folder isn't read-only.";
  }
  if (/ENOENT/i.test(clean) || /no such file or directory/i.test(clean)) {
    return "A file or folder is missing.";
  }
  if (/ENOSPC/i.test(clean) || /no space left on device/i.test(clean)) {
    return "Your disk is full. Free up some space and try again.";
  }

  // Network errors
  if (
    /Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|NetworkError/i.test(
      clean,
    )
  ) {
    return "Can't connect. Check your internet connection and try again.";
  }

  // Authentication errors
  if (/Unauthorized|Invalid credentials|token expired/i.test(clean)) {
    return "You've been signed out. Sign in again.";
  }

  // If there are multiple lines (e.g. stack trace), take only the first line
  const firstLine = clean.split("\n")[0].trim();
  if (!firstLine) return fallbackMessage;

  // Clean trailing technical details like (code: -1) or IPC error headers
  const sanitized = firstLine
    .replace(/^IPC_ERROR:\s*/i, "")
    .replace(/^Uncaught\s*/i, "")
    .trim();

  const formatted = sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
  return formatted.endsWith(".") ? formatted : `${formatted}.`;
}

/**
 * Strips extensions like .jar, .zip, .disabled from filenames to produce a clean display name.
 */
export function cleanModDisplayName(
  filename?: string,
  fallback = "Mod",
): string {
  if (!filename) return fallback;
  return (
    filename.replace(/\.disabled$/gi, "").replace(/\.(jar|zip)$/gi, "") ||
    fallback
  );
}
