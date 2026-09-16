/**
 * Utility functions for the Lampas Launcher renderer UI.
 */

/**
 * Normalizes technical backend and filesystem errors into clear, friendly guidance for users.
 */
export function formatFriendlyError(err: unknown, fallbackMessage = "An unexpected error occurred."): string {
  if (!err) return fallbackMessage;

  const raw = typeof err === "string" ? err : (err as any)?.message || String(err);
  const clean = raw.replace(/^(Error:\s*)+/i, "").trim();

  // Minecraft running conflict
  if (/Minecraft is running/i.test(clean)) {
    return "Minecraft is currently running. Please close the game first.";
  }

  // Active operation busy conflict
  if (/is currently in progress/i.test(clean) || /operation.*in progress/i.test(clean)) {
    return "Another launcher operation is currently in progress. Please wait for it to finish.";
  }

  // Recovery blocked
  if (/unresolved startup recovery failure/i.test(clean)) {
    return "Launcher operations are temporarily blocked due to a recovery issue. Please restart the launcher.";
  }

  // Mod-specific errors
  if (/destination already exists/i.test(clean)) {
    return "A mod file with this name already exists in your mods folder.";
  }
  if (/missing from the mods folder/i.test(clean)) {
    return "The mod file could not be found in your mods folder.";
  }
  if (/already exists in the mods folder and is not a launcher-managed/i.test(clean)) {
    return "This file already exists in your mods folder and is not managed by the launcher.";
  }
  if (/Only .jar and .zip mod files are allowed/i.test(clean) || /assertJar/i.test(clean)) {
    return "Only .jar and .zip mod files are supported.";
  }

  // Common OS / filesystem errors
  if (/EBUSY/i.test(clean) || /resource locked/i.test(clean)) {
    return "The file is currently locked or open in another program. Please close Minecraft or any file editor and try again.";
  }
  if (/EPERM/i.test(clean) || /EACCES/i.test(clean) || /permission denied/i.test(clean)) {
    return "Permission denied. The launcher does not have permission to modify these files.";
  }
  if (/ENOENT/i.test(clean) || /no such file or directory/i.test(clean)) {
    return "The file or directory could not be found.";
  }
  if (/ENOSPC/i.test(clean) || /no space left on device/i.test(clean)) {
    return "There is not enough free disk space. Please free up space and try again.";
  }

  // Network errors
  if (/Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|NetworkError/i.test(clean)) {
    return "Network connection failed. Please check your internet connection and try again.";
  }

  // Authentication errors
  if (/Unauthorized|Invalid credentials|token expired/i.test(clean)) {
    return "Session expired or invalid credentials. Please log in again.";
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
export function cleanModDisplayName(filename?: string, fallback = "Mod"): string {
  if (!filename) return fallback;
  return filename.replace(/\.disabled$/gi, "").replace(/\.(jar|zip)$/gi, "") || fallback;
}
