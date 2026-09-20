import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicFile } from "./file-transfer";
import {
  assertSubordinateRoot,
  checkPhysicalAncestrySync,
} from "./path-policy";
import { sanitizeLogText } from "./privacy";

const MARKER_SCHEMA_VERSION = 1;
const MARKER_FILENAME = "sync-safety.json";
const MAX_MARKER_BYTES = 64 * 1024;
const MEMORY_BLOCKS = new Map<string, SyncSafetyBlock>();

export type SyncSafetyReason = "DENIAL" | "SCHEMA" | "INTEGRITY";

export interface SyncSafetyContext {
  origin: string;
  channel: string;
  gameDir: string;
}

export interface SyncSafetyBlock {
  schemaVersion: 1;
  origin: string;
  channel: "stable" | "beta" | "dev";
  gameDir: string;
  reason: SyncSafetyReason;
  message: string;
  createdAt: string;
}

export class SyncSafetyBlockError extends Error {
  readonly block: SyncSafetyBlock | null;

  constructor(message: string, block: SyncSafetyBlock | null = null) {
    super(message);
    this.name = "SyncSafetyBlockError";
    this.block = block;
  }
}

export class SyncSafetyPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncSafetyPersistenceError";
  }
}

function normalizedContext(context: SyncSafetyContext): SyncSafetyContext {
  return {
    origin: String(context.origin).trim(),
    channel: context.channel,
    gameDir: path.resolve(context.gameDir),
  };
}

function gameDirKey(gameDir: string): string {
  const resolved = path.resolve(gameDir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function markerPath(gameDir: string): string {
  return path.join(path.resolve(gameDir), ".lampas", MARKER_FILENAME);
}

function parseMarker(raw: unknown, filePath: string): SyncSafetyBlock {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new SyncSafetyBlockError(
      `Malformed sync safety marker at '${filePath}'.`,
    );
  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "origin",
    "channel",
    "gameDir",
    "reason",
    "message",
    "createdAt",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new SyncSafetyBlockError(
        `Malformed sync safety marker at '${filePath}'.`,
      );
  }
  if (
    value.schemaVersion !== MARKER_SCHEMA_VERSION ||
    typeof value.origin !== "string" ||
    typeof value.gameDir !== "string" ||
    (value.channel !== "stable" &&
      value.channel !== "beta" &&
      value.channel !== "dev") ||
    (value.reason !== "DENIAL" &&
      value.reason !== "SCHEMA" &&
      value.reason !== "INTEGRITY") ||
    typeof value.message !== "string" ||
    value.message.length > 512 ||
    typeof value.createdAt !== "string"
  ) {
    throw new SyncSafetyBlockError(
      `Malformed sync safety marker at '${filePath}'.`,
    );
  }
  return {
    schemaVersion: 1,
    origin: value.origin,
    channel: value.channel,
    gameDir: path.resolve(value.gameDir),
    reason: value.reason,
    message: value.message,
    createdAt: value.createdAt,
  };
}

function readBoundedUtf8(filePath: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("file exceeds bounded read limit");
    const buffer = Buffer.alloc(stat.size);
    const bytesRead =
      stat.size === 0 ? 0 : fs.readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readMarker(filePath: string): SyncSafetyBlock | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES)
      throw new Error("marker is not a bounded regular file");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw new SyncSafetyBlockError(
      `Malformed sync safety marker at '${filePath}'.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedUtf8(filePath, MAX_MARKER_BYTES));
  } catch {
    throw new SyncSafetyBlockError(
      `Malformed sync safety marker at '${filePath}'.`,
    );
  }
  return parseMarker(parsed, filePath);
}

export function assertSyncSafetyAdmission(context: SyncSafetyContext): void {
  const current = normalizedContext(context);
  const memoryBlock = MEMORY_BLOCKS.get(gameDirKey(current.gameDir));
  if (memoryBlock)
    throw new SyncSafetyBlockError(
      `Synchronization is blocked after ${memoryBlock.reason.toLowerCase()} metadata failure: ${memoryBlock.message}`,
      memoryBlock,
    );

  const filePath = markerPath(current.gameDir);
  try {
    assertSubordinateRoot(
      current.gameDir,
      path.join(current.gameDir, ".lampas"),
    );
    checkPhysicalAncestrySync(current.gameDir, filePath, {
      disallowSymlinks: true,
      expectedCategory: "RESERVED_INTERNAL",
    });
  } catch {
    throw new SyncSafetyBlockError(
      "Synchronization safety metadata is not physically contained by the active game directory.",
    );
  }
  const marker = readMarker(filePath);
  if (!marker) return;
  if (
    marker.origin !== current.origin ||
    marker.channel !== current.channel ||
    marker.gameDir.toLowerCase() !== current.gameDir.toLowerCase()
  ) {
    throw new SyncSafetyBlockError(
      "Synchronization remains blocked until a validated sync or full repair clears the prior context's safety marker.",
      marker,
    );
  }
  MEMORY_BLOCKS.set(gameDirKey(current.gameDir), marker);
  throw new SyncSafetyBlockError(
    `Synchronization is blocked after ${marker.reason.toLowerCase()} metadata failure: ${marker.message}`,
    marker,
  );
}

export async function persistSyncSafetyBlock(
  context: SyncSafetyContext,
  reason: SyncSafetyReason,
  error: unknown,
): Promise<void> {
  const current = normalizedContext(context);
  if (
    current.channel !== "stable" &&
    current.channel !== "beta" &&
    current.channel !== "dev"
  ) {
    throw new SyncSafetyPersistenceError(
      "Cannot persist a synchronization safety marker for an unsupported channel.",
    );
  }
  const message = sanitizeLogText(
    String(error instanceof Error ? error.message : error),
  ).slice(0, 512);
  const stateDir = path.join(current.gameDir, ".lampas");
  const filePath = path.join(stateDir, MARKER_FILENAME);
  let prior: SyncSafetyBlock | null =
    MEMORY_BLOCKS.get(gameDirKey(current.gameDir)) ?? null;
  let effectiveReason: SyncSafetyReason =
    reason === "INTEGRITY" || prior?.reason === "INTEGRITY"
      ? "INTEGRITY"
      : reason;
  const hadIntegrityBeforeDiskRead = effectiveReason === "INTEGRITY";
  let marker: SyncSafetyBlock = {
    schemaVersion: 1,
    origin: current.origin,
    channel: current.channel,
    gameDir: current.gameDir,
    reason: effectiveReason,
    message,
    createdAt: new Date().toISOString(),
  };
  // Set the process latch before any filesystem inspection. A failed marker
  // write or an unsafe pre-existing marker must not open a context-change gap.
  MEMORY_BLOCKS.set(gameDirKey(current.gameDir), marker);
  try {
    assertSubordinateRoot(current.gameDir, stateDir);
    checkPhysicalAncestrySync(current.gameDir, filePath, {
      disallowSymlinks: true,
      expectedCategory: "RESERVED_INTERNAL",
    });
    prior = readMarker(filePath) ?? prior;
  } catch (readError) {
    throw new SyncSafetyPersistenceError(
      "Cannot safely inspect the synchronization safety marker.",
      { cause: readError },
    );
  }
  effectiveReason =
    hadIntegrityBeforeDiskRead ||
    reason === "INTEGRITY" ||
    prior?.reason === "INTEGRITY"
      ? "INTEGRITY"
      : reason;
  marker = { ...marker, reason: effectiveReason };
  MEMORY_BLOCKS.set(gameDirKey(current.gameDir), marker);
  try {
    fs.mkdirSync(current.gameDir, { recursive: true });
    assertSubordinateRoot(current.gameDir, stateDir);
    fs.mkdirSync(stateDir, { recursive: true });
    assertSubordinateRoot(current.gameDir, stateDir);
    await writeAtomicFile(filePath, JSON.stringify(marker, null, 2), {
      encoding: "utf-8",
    });
  } catch (writeError) {
    throw new SyncSafetyPersistenceError(
      "Failed to persist the synchronization safety marker; launch remains blocked for this process.",
      { cause: writeError },
    );
  }
}

export function clearSyncSafetyBlock(
  gameDir: string,
  options: { requireFullValidation?: boolean } = {},
): void {
  const resolvedGameDir = path.resolve(gameDir);
  const key = gameDirKey(resolvedGameDir);
  const memoryBlock = MEMORY_BLOCKS.get(key);
  const filePath = markerPath(resolvedGameDir);
  assertSubordinateRoot(resolvedGameDir, path.join(resolvedGameDir, ".lampas"));
  checkPhysicalAncestrySync(resolvedGameDir, filePath, {
    disallowSymlinks: true,
    expectedCategory: "RESERVED_INTERNAL",
  });
  const marker = readMarker(filePath);
  const effectiveBlock = marker ?? memoryBlock;
  if (
    (marker?.reason === "INTEGRITY" || memoryBlock?.reason === "INTEGRITY") &&
    !options.requireFullValidation
  )
    return;
  if (marker) fs.rmSync(filePath, { force: true });
  MEMORY_BLOCKS.delete(key);
}
