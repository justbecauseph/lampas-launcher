import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDataDir } from "./config";
import { writeAtomicFileSync } from "./file-transfer";
import { powershellPath } from "./window-maximizer";

// The game is spawned detached so it outlives the launcher. To find it again
// after a restart, the launcher bakes a random marker into the JVM arguments
// and records { pid, sessionId } here. A recorded PID is only adopted when the
// process currently running under it carries the exact marker, which keeps a
// reused PID from being mistaken for the game.

export interface GameSessionRecord {
  version: 1;
  pid: number;
  sessionId: string;
  startedAt: string;
  gameDir: string;
}

export const GAME_SESSION_FILENAME = "game-session.json";
export const SESSION_MARKER_PROPERTY = "lampas.launcher.session";

const MAX_SESSION_FILE_BYTES = 16 * 1024;
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;
const COMMAND_LINE_TIMEOUT_MS = 15000;
const COMMAND_LINE_MAX_BUFFER = 1024 * 1024;

export function getGameSessionPath(): string {
  return path.join(getUserDataDir(), GAME_SESSION_FILENAME);
}

export function newGameSessionId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function sessionMarkerArg(sessionId: string): string {
  return `-D${SESSION_MARKER_PROPERTY}=${sessionId}`;
}

export function writeGameSession(record: GameSessionRecord): void {
  writeAtomicFileSync(getGameSessionPath(), JSON.stringify(record, null, 2));
}

/**
 * Removes the session record. With `expectedSessionId`, a record that belongs
 * to a different session (another launcher instance's game) is left alone and
 * false is returned; an unparsable record is removed either way.
 */
export function clearGameSession(expectedSessionId?: string): boolean {
  const file = getGameSessionPath();
  if (expectedSessionId !== undefined) {
    let current: GameSessionRecord | null = null;
    try {
      const text = readBoundedSessionFile(file);
      current = text === null ? null : parseGameSession(text);
    } catch (err: any) {
      if (err?.code === "ENOENT") return false;
      current = null;
    }
    if (current && current.sessionId !== expectedSessionId) return false;
  }
  fs.rmSync(file, { force: true });
  return true;
}

// Errors that say nothing about the record's validity; the file is kept so a
// later start can read it again.
const TRANSIENT_IO_CODES = new Set([
  "EBUSY",
  "EACCES",
  "EPERM",
  "EMFILE",
  "ENFILE",
  "EAGAIN",
  "EIO",
  "ETXTBSY",
]);

function discardGameSession(): void {
  try {
    clearGameSession();
  } catch {
    // Nothing more can be done with an undeletable record.
  }
}

function readBoundedSessionFile(file: string): string | null {
  const lstat = fs.lstatSync(file);
  if (!lstat.isFile() || lstat.size > MAX_SESSION_FILE_BYTES) return null;
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) return null;
    const bytes = Buffer.alloc(MAX_SESSION_FILE_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (!count) break;
      total += count;
    }
    if (total > MAX_SESSION_FILE_BYTES) return null;
    return bytes.subarray(0, total).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseGameSession(text: string): GameSessionRecord | null {
  const value: any = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== 1) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (
    typeof value.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(value.sessionId)
  )
    return null;
  if (typeof value.startedAt !== "string") return null;
  if (typeof value.gameDir !== "string") return null;
  return {
    version: 1,
    pid: value.pid,
    sessionId: value.sessionId,
    startedAt: value.startedAt,
    gameDir: value.gameDir,
  };
}

/**
 * Returns the recorded session, or null when none exists. A record that is
 * unreadable, oversized, not a regular file, or fails validation is deleted.
 */
export function readGameSession(): GameSessionRecord | null {
  const file = getGameSessionPath();
  try {
    const text = readBoundedSessionFile(file);
    const record = text === null ? null : parseGameSession(text);
    if (record) return record;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    if (TRANSIENT_IO_CODES.has(String(err?.code))) return null;
  }
  discardGameSession();
  return null;
}

export interface ProcessProbe {
  isAlive(pid: number): boolean;
  /** Resolves the full command line of a process, or null when unavailable. */
  readCommandLine(pid: number): Promise<string | null>;
  terminate(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

// The command line contains the Minecraft access token. It must never be
// logged or placed in an error message; every failure here resolves to null.
function runForStdout(
  file: string,
  args: string[],
  options: { windowsHide?: boolean },
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          ...options,
          timeout: COMMAND_LINE_TIMEOUT_MS,
          maxBuffer: COMMAND_LINE_MAX_BUFFER,
        },
        (error, stdout) => {
          if (error) return resolve(null);
          const text = String(stdout).trim();
          resolve(text ? text : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function readCommandLine(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
      return await runForStdout(
        powershellPath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        { windowsHide: true },
      );
    }
    if (process.platform === "linux") {
      const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8");
      const text = raw.replace(/\0/g, " ").trim();
      return text ? text : null;
    }
    if (process.platform === "darwin") {
      return await runForStdout(
        "ps",
        ["-o", "command=", "-p", String(pid)],
        {},
      );
    }
  } catch {
    return null;
  }
  return null;
}

export const systemProcessProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err?.code === "EPERM";
    }
  },
  readCommandLine,
  terminate(pid, signal) {
    process.kill(pid, signal);
  },
};

/**
 * "dead": no process runs under the recorded PID. "mismatch": a process runs
 * there but does not carry the marker (PID reuse). "unknown": the process is
 * alive but its command line could not be read, so nothing can be concluded
 * and the record should be kept for a later attempt. "adoptable": alive and
 * carrying the marker.
 */
export type GameSessionVerdict = "adoptable" | "mismatch" | "dead" | "unknown";

export async function classifyGameSession(
  record: GameSessionRecord,
  probe: ProcessProbe,
): Promise<GameSessionVerdict> {
  if (!probe.isAlive(record.pid)) return "dead";
  let commandLine: string | null;
  try {
    commandLine = await probe.readCommandLine(record.pid);
  } catch {
    // Never surface the error: it may carry the command line.
    commandLine = null;
  }
  if (typeof commandLine !== "string") return "unknown";
  return commandLine.includes(sessionMarkerArg(record.sessionId))
    ? "adoptable"
    : "mismatch";
}

export async function findAdoptableGame(
  record: GameSessionRecord,
  probe: ProcessProbe,
): Promise<boolean> {
  return (await classifyGameSession(record, probe)) === "adoptable";
}
