import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ARGFILE_DIR_PREFIX = "lampas-launch-";
const CRASH_LOG_NAME = /^hs_err_pid\d+\.log$/;
const MAX_CRASH_LOG_BYTES = 8 * 1024 * 1024;
const ACCESS_TOKEN_ARG = /(--accessToken[ \t]+)\S+/g;

/**
 * Quotes one argument for a JDK `@argfile`. Inside the double quotes a
 * backslash and a double quote are escaped; every other character is literal.
 */
export function quoteArgfileToken(value: string): string {
  if (/[\n\r\0]/.test(value)) {
    throw new Error("Launch argument contains a line break or NUL");
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Writes `args` to a private argument file for `java @file` so the access
 * token stays out of the process command line. The file lives in its own
 * directory; `dispose()` removes that directory and never throws.
 */
export function writeLaunchArgfile(
  args: string[],
  baseDir: string = os.tmpdir(),
): { path: string; dispose(): void } {
  // Quote before creating the directory so a bad argument leaves nothing behind.
  const body = args.map((arg) => quoteArgfileToken(arg)).join("\n") + "\n";
  const dir = fs.mkdtempSync(path.join(baseDir, ARGFILE_DIR_PREFIX));
  const dispose = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  try {
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "args");
    fs.writeFileSync(file, body, { mode: 0o600, flag: "wx" });
    return { path: file, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

/**
 * Removes argument-file directories left behind by a launcher that exited
 * before disposing them. Only real directories older than `maxAgeMs` go.
 */
export function sweepStaleLaunchArgfiles(
  baseDir: string = os.tmpdir(),
  maxAgeMs = 120_000,
): void {
  try {
    for (const name of fs.readdirSync(baseDir)) {
      if (!name.startsWith(ARGFILE_DIR_PREFIX)) continue;
      const entry = path.join(baseDir, name);
      try {
        // lstat, so a symlink is never followed or removed as a directory.
        const stat = fs.lstatSync(entry);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        // /tmp is shared: leave other users' directories alone.
        if (
          typeof process.getuid === "function" &&
          stat.uid !== process.getuid()
        )
          continue;
        if (Date.now() - stat.mtimeMs <= maxAgeMs) continue;
        fs.rmSync(entry, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

/**
 * Replaces the access token in JVM crash logs (`hs_err_pid<pid>.log`) in the
 * game folder and its `crash-reports` folder. Returns how many files changed.
 */
export function scrubJvmCrashFiles(gameDir: string): number {
  let rewritten = 0;
  for (const dir of [gameDir, path.join(gameDir, "crash-reports")]) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!CRASH_LOG_NAME.test(name)) continue;
      try {
        if (scrubCrashLog(path.join(dir, name))) rewritten++;
      } catch {}
    }
  }
  return rewritten;
}

function scrubCrashLog(file: string): boolean {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_CRASH_LOG_BYTES) return false;
  // latin1 maps every byte to one character, so the rewrite keeps other bytes intact.
  const text = fs.readFileSync(file, "latin1");
  const redacted = text.replace(ACCESS_TOKEN_ARG, "$1[REDACTED]");
  if (redacted === text) return false;

  const temp = path.join(
    path.dirname(file),
    `${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temp, redacted, {
      mode: 0o600,
      flag: "wx",
      encoding: "latin1",
    });
    fs.renameSync(temp, file);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    return false;
  }
  return true;
}
