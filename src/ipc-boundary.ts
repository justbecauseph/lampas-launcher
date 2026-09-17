import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import * as electronModule from "electron";

const electron: any = electronModule;
const app = electron?.app ?? electron?.default?.app;
const dialog = electron?.dialog ?? electron?.default?.dialog;
const ipcMain = electron?.ipcMain ?? electron?.default?.ipcMain;
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePortalUrl, validateWebUrl } from "./config";
import { parseJavaArgs } from "./game-runner";
import { LauncherLogger } from "./logger";
import type { KnownLocationId, UpdateSettingsDto } from "./types";

export class IpcSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcSecurityError";
  }
}

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcValidationError";
  }
}

interface ApprovalRecord {
  operation: string;
  target: string;
  expiresAt: number;
  generation: number;
}

const PRIVILEGED_ARG_PATTERNS = [
  /^-javaagent:/i,
  /^-agentlib:/i,
  /^-agentpath:/i,
  /^@/i,
  /^(-cp|-classpath|--class-path)$/i,
  /^(-p|--module-path|-m|--module|--add-modules|--patch-module|--upgrade-module-path)$/i,
  /^-Djava\.system\.class\.loader=/i,
  /^-Djava\.class\.path=/i,
  /^-Djdk\.module\.main=/i,
  /^-Xbootclasspath/i,
];

export function isPrivilegedJavaArg(arg: string): boolean {
  const trimmed = arg.trim();
  return PRIVILEGED_ARG_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function normalizeFilePath(rawPath: string): string {
  try {
    const resolved = path.resolve(rawPath);
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
    return resolved;
  } catch {
    return path.resolve(rawPath);
  }
}

function fileUrlToPath(fileUrl: string): string | null {
  try {
    const parsed = new URL(fileUrl);
    if (parsed.protocol !== "file:") return null;
    let pathname = decodeURIComponent(parsed.pathname);
    if (process.platform === "win32" && pathname.startsWith("/")) {
      pathname = pathname.slice(1);
    }
    return path.normalize(pathname);
  } catch {
    return null;
  }
}

export class IpcBoundary {
  private static mainWindowRef: BrowserWindow | null = null;
  private static documentGeneration = 1;
  private static approvedDocumentUrl: string | null = null;
  private static approvals = new Map<string, ApprovalRecord>();
  private static productionOverride: boolean | null = null;

  static setMainWindow(win: BrowserWindow | null): void {
    this.mainWindowRef = win;
    if (win && !win.isDestroyed()) {
      win.webContents?.on?.("did-finish-load", () => {
        this.onDocumentLoaded(win.webContents.getURL());
      });
      win.webContents?.on?.("did-start-navigation", () => {
        this.invalidateApprovals();
        this.incrementDocumentGeneration();
      });
    }
  }

  static getMainWindow(): BrowserWindow | null {
    return this.mainWindowRef;
  }

  static setProductionOverride(isProd: boolean | null): void {
    this.productionOverride = isProd;
  }

  static isPackagedProduction(): boolean {
    if (this.productionOverride !== null) return this.productionOverride;
    return Boolean(app?.isPackaged);
  }

  static setApprovedDocumentUrl(url: string | null): void {
    this.approvedDocumentUrl = url;
  }

  static getApprovedDocumentUrl(): string | null {
    return this.approvedDocumentUrl;
  }

  static onDocumentLoaded(url: string): void {
    this.approvedDocumentUrl = url;
    this.incrementDocumentGeneration();
    this.invalidateApprovals();
  }

  static getDocumentGeneration(): number {
    return this.documentGeneration;
  }

  static incrementDocumentGeneration(): number {
    return ++this.documentGeneration;
  }

  static grantApproval(operation: string, target: string, ttlMs = 300000): void {
    const key = `${operation}:${normalizeFilePath(target).toLowerCase()}`;
    this.approvals.set(key, {
      operation,
      target: normalizeFilePath(target),
      expiresAt: Date.now() + ttlMs,
      generation: this.documentGeneration,
    });
  }

  static hasApproval(operation: string, target: string): boolean {
    const key = `${operation}:${normalizeFilePath(target).toLowerCase()}`;
    const record = this.approvals.get(key);
    if (!record) return false;
    if (Date.now() > record.expiresAt || record.generation !== this.documentGeneration) {
      this.approvals.delete(key);
      return false;
    }
    return true;
  }

  static consumeApproval(operation: string, target: string): boolean {
    const key = `${operation}:${normalizeFilePath(target).toLowerCase()}`;
    const record = this.approvals.get(key);
    if (!record) return false;
    this.approvals.delete(key);
    if (Date.now() > record.expiresAt || record.generation !== this.documentGeneration) {
      return false;
    }
    return true;
  }

  static invalidateApprovals(): void {
    this.approvals.clear();
  }

  static resetForTesting(): void {
    this.mainWindowRef = null;
    this.documentGeneration = 1;
    this.approvedDocumentUrl = null;
    this.approvals.clear();
    this.productionOverride = null;
  }

  static validateIpcSender(
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
  ): { sender: Electron.WebContents; frame: Electron.WebFrameMain } {
    const mainWin = this.mainWindowRef;
    if (!mainWin || mainWin.isDestroyed()) {
      throw new IpcSecurityError("Unauthorized IPC caller: main application window is unavailable or destroyed.");
    }

    if (!event.sender || event.sender.isDestroyed?.() || event.sender !== mainWin.webContents) {
      throw new IpcSecurityError("Unauthorized IPC caller: caller webContents does not match main window.");
    }

    const frame = event.senderFrame;
    if (!frame || frame.isDestroyed?.()) {
      throw new IpcSecurityError("Unauthorized IPC caller: missing or destroyed sender frame.");
    }

    if (frame.parent !== null) {
      throw new IpcSecurityError("Unauthorized IPC caller: child frames and subdocuments are not permitted.");
    }

    const frameUrl = frame.url;
    if (!frameUrl || frameUrl === "" || frameUrl === "about:blank") {
      throw new IpcSecurityError("Unauthorized IPC caller: uninitialized or blank document.");
    }

    // Origin and Document URL verification
    this.assertApprovedDocument(frameUrl);

    // In-window navigation consistency check
    if (event.sender.getURL && event.sender.getURL() !== frameUrl) {
      throw new IpcSecurityError("Unauthorized IPC caller: document has navigated away from active frame URL.");
    }

    return { sender: event.sender, frame };
  }

  private static assertApprovedDocument(frameUrl: string): void {
    // If an approved document URL was explicitly registered, match it
    if (this.approvedDocumentUrl) {
      if (frameUrl === this.approvedDocumentUrl) return;
    }

    const isPackaged = this.isPackagedProduction();

    // In packaged production, ONLY the canonical packaged renderer document is approved
    if (isPackaged) {
      const prodPath = path.resolve(__dirname, "renderer/index.html");
      const candidatePath = fileUrlToPath(frameUrl);
      if (!candidatePath) {
        throw new IpcSecurityError(
          `Unauthorized IPC caller: packaged production requires file:// renderer document, received: ${frameUrl}`
        );
      }
      const canonicalProd = normalizeFilePath(prodPath);
      const canonicalCandidate = normalizeFilePath(candidatePath);
      const matches =
        process.platform === "win32"
          ? canonicalProd.toLowerCase() === canonicalCandidate.toLowerCase()
          : canonicalProd === canonicalCandidate;
      if (!matches) {
        throw new IpcSecurityError(
          `Unauthorized IPC caller: document does not match packaged renderer index.html. Candidate: ${canonicalCandidate}, Expected: ${canonicalProd}`
        );
      }
      return;
    }

    // In development mode (!isPackaged)
    // 1. Loopback Vite dev server URL is permitted
    try {
      const parsed = new URL(frameUrl);
      if (
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
        (parsed.protocol === "http:" || parsed.protocol === "https:")
      ) {
        return;
      }
    } catch {}

    // 2. Local index.html file URL is permitted
    const candidatePath = fileUrlToPath(frameUrl);
    if (candidatePath) {
      const prodPath = path.resolve(__dirname, "renderer/index.html");
      const devUiPath = path.resolve(__dirname, "../ui/index.html");
      const canonicalCandidate = normalizeFilePath(candidatePath);
      const allowedPaths = [normalizeFilePath(prodPath), normalizeFilePath(devUiPath)];

      const matches = allowedPaths.some((allowed) =>
        process.platform === "win32"
          ? allowed.toLowerCase() === canonicalCandidate.toLowerCase()
          : allowed === canonicalCandidate
      );
      if (matches) return;
    }

    throw new IpcSecurityError(
      `Unauthorized IPC caller: document URL is not an approved application document: ${frameUrl}`
    );
  }
}

export async function confirmPrivilegedOperation(
  mainWindow: BrowserWindow | null,
  options: {
    title: string;
    message: string;
    detail?: string;
    confirmButtonText?: string;
    cancelButtonText?: string;
  }
): Promise<boolean> {
  if (!dialog || typeof dialog.showMessageBox !== "function") {
    return true;
  }
  const result = await dialog.showMessageBox(mainWindow || (undefined as any), {
    type: "warning",
    buttons: [options.confirmButtonText || "Confirm", options.cancelButtonText || "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: options.title,
    message: options.message,
    detail: options.detail,
    noLink: true,
  });
  return result.response === 0;
}

// ═══════════════════════════════════════════════════
// Strict Schema Validators for Inbound IPC Payloads
// ═══════════════════════════════════════════════════

const ALLOWED_CONFIG_KEYS = new Set([
  "portalUrl",
  "selectedChannel",
  "allocatedRamGb",
  "noSync",
  "javaPath",
  "javaArgs",
]);

export function validateConfigSet(payload: unknown): UpdateSettingsDto {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new IpcValidationError("Settings payload must be a non-null object.");
  }

  const raw = payload as Record<string, unknown>;
  const keys = Object.keys(raw);

  for (const key of keys) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new IpcValidationError(`Unknown or unauthorized settings field: '${key}'`);
    }
  }

  const sanitized: UpdateSettingsDto = {};

  if (raw.portalUrl !== undefined) {
    if (typeof raw.portalUrl !== "string" || raw.portalUrl.trim().length === 0) {
      throw new IpcValidationError("portalUrl must be a non-empty string.");
    }
    if (raw.portalUrl.length > 512) {
      throw new IpcValidationError("portalUrl exceeds maximum length of 512 characters.");
    }
    sanitized.portalUrl = normalizePortalUrl(raw.portalUrl);
  }

  if (raw.selectedChannel !== undefined) {
    if (typeof raw.selectedChannel !== "string" || !["stable", "beta", "dev"].includes(raw.selectedChannel)) {
      throw new IpcValidationError("selectedChannel must be one of: 'stable', 'beta', 'dev'.");
    }
    sanitized.selectedChannel = raw.selectedChannel as "stable" | "beta" | "dev";
  }

  if (raw.allocatedRamGb !== undefined) {
    if (
      typeof raw.allocatedRamGb !== "number" ||
      !Number.isInteger(raw.allocatedRamGb) ||
      raw.allocatedRamGb < 2 ||
      raw.allocatedRamGb > 64
    ) {
      throw new IpcValidationError("allocatedRamGb must be an integer between 2 and 64.");
    }
    sanitized.allocatedRamGb = raw.allocatedRamGb;
  }

  if (raw.noSync !== undefined) {
    if (typeof raw.noSync !== "boolean") {
      throw new IpcValidationError("noSync must be a boolean.");
    }
    sanitized.noSync = raw.noSync;
  }

  if (raw.javaPath !== undefined) {
    if (typeof raw.javaPath !== "string") {
      throw new IpcValidationError("javaPath must be a string.");
    }
    if (raw.javaPath.length > 1024) {
      throw new IpcValidationError("javaPath exceeds maximum length of 1024 characters.");
    }
    sanitized.javaPath = raw.javaPath;
  }

  if (raw.javaArgs !== undefined) {
    if (typeof raw.javaArgs !== "string") {
      throw new IpcValidationError("javaArgs must be a string.");
    }
    if (raw.javaArgs.length > 2048) {
      throw new IpcValidationError("javaArgs exceeds maximum length of 2048 characters.");
    }
    parseJavaArgs(raw.javaArgs);
    sanitized.javaArgs = raw.javaArgs;
  }

  return sanitized;
}

export function validateOpenPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new IpcValidationError("Target path must be a non-empty string.");
  }
  if (raw.length > 1024) {
    throw new IpcValidationError("Target path exceeds maximum length of 1024 characters.");
  }
  return raw.trim();
}

export function validateOpenSourcePage(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new IpcValidationError("URL must be a non-empty string.");
  }
  if (raw.length > 2048) {
    throw new IpcValidationError("URL exceeds maximum length of 2048 characters.");
  }
  return validateWebUrl(raw.trim());
}

const KNOWN_LOCATIONS = new Set<KnownLocationId>([
  "gameDir",
  "modsDir",
  "logsDir",
  "launcherLog",
  "minecraftLog",
]);

export function validateOpenKnownLocation(raw: unknown): KnownLocationId {
  if (typeof raw !== "string" || !KNOWN_LOCATIONS.has(raw as KnownLocationId)) {
    throw new IpcValidationError(
      `Invalid known location '${raw}'. Permitted: gameDir, modsDir, logsDir, launcherLog, minecraftLog`
    );
  }
  return raw as KnownLocationId;
}

export function validateGameDirTarget(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new IpcValidationError("Directory target path must be a non-empty string.");
  }
  if (raw.length > 1024) {
    throw new IpcValidationError("Directory target path exceeds maximum length of 1024 characters.");
  }
  return path.resolve(raw.trim());
}

export function validateOptionalPath(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new IpcValidationError("Path argument must be a string if provided.");
  }
  if (raw.length > 1024) {
    throw new IpcValidationError("Path exceeds maximum length of 1024 characters.");
  }
  return raw.trim();
}

export function validateGameDirValidateArgs(
  targetPath: unknown,
  currentPath?: unknown
): { targetPath: string; currentPath?: string } {
  return {
    targetPath: validateGameDirTarget(targetPath),
    currentPath: validateOptionalPath(currentPath),
  };
}

export function validateModPaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new IpcValidationError("Mod paths must be a non-empty array of file paths.");
  }
  if (raw.length > 50) {
    throw new IpcValidationError("Cannot import more than 50 mod files at once.");
  }
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new IpcValidationError("Each mod path must be a non-empty string.");
    }
    if (item.length > 1024) {
      throw new IpcValidationError("Mod path exceeds maximum length of 1024 characters.");
    }
    const resolved = path.resolve(item.trim());
    if (path.extname(resolved).toLowerCase() !== ".jar") {
      throw new IpcValidationError(`Mod file must have a .jar extension: '${path.basename(resolved)}'`);
    }
    result.push(resolved);
  }
  return result;
}

export function validateOfficialModToggle(id: unknown, enabled: unknown): { id: string; enabled: boolean } {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new IpcValidationError("Official mod identifier must be an alphanumeric string (max 128 chars).");
  }
  if (typeof enabled !== "boolean") {
    throw new IpcValidationError("Enabled flag must be a boolean.");
  }
  return { id, enabled };
}

export function validateCustomModToggle(
  filename: unknown,
  enabled: unknown
): { filename: string; enabled: boolean } {
  if (
    typeof filename !== "string" ||
    filename !== path.basename(filename) ||
    !filename.toLowerCase().endsWith(".jar") ||
    filename.length > 256
  ) {
    throw new IpcValidationError("Custom mod filename must be a valid .jar basename without directory separators.");
  }
  if (typeof enabled !== "boolean") {
    throw new IpcValidationError("Enabled flag must be a boolean.");
  }
  return { filename, enabled };
}

export function validateCustomModFilename(filename: unknown): string {
  if (
    typeof filename !== "string" ||
    filename !== path.basename(filename) ||
    !filename.toLowerCase().endsWith(".jar") ||
    filename.length > 256
  ) {
    throw new IpcValidationError("Custom mod filename must be a valid .jar basename without directory separators.");
  }
  return filename;
}

export function validateLogAck(payload: unknown): { batchId: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new IpcValidationError("LogAck payload must be an object.");
  }
  const batchId = (payload as any).batchId;
  if (typeof batchId !== "number" || !Number.isInteger(batchId) || batchId < 0) {
    throw new IpcValidationError("batchId must be a non-negative integer.");
  }
  return { batchId };
}

export function sanitizeIpcError(err: any): Error {
  if (err instanceof IpcSecurityError || err instanceof IpcValidationError) {
    return new Error(err.message);
  }
  const msg = err?.message || "Internal operation error";
  return new Error(LauncherLogger.sanitize(msg));
}

export const IpcSchemas = {
  noArgs: (..._args: unknown[]): [] => [],
  configSet: (payload: unknown): [UpdateSettingsDto] => [validateConfigSet(payload)],
  openPath: (target: unknown): [string] => [validateOpenPath(target)],
  openSourcePage: (url: unknown): [string] => [validateOpenSourcePage(url)],
  openKnownLocation: (location: unknown): [KnownLocationId] => [validateOpenKnownLocation(location)],
  gameDirBrowse: (defaultPath?: unknown): [string | undefined] => [validateOptionalPath(defaultPath)],
  gameDirValidate: (targetPath: unknown, currentPath?: unknown): [string, string | undefined] => {
    const res = validateGameDirValidateArgs(targetPath, currentPath);
    return [res.targetPath, res.currentPath];
  },
  gameDirTarget: (targetPath: unknown): [string] => [validateGameDirTarget(targetPath)],
  modPaths: (paths: unknown): [string[]] => [validateModPaths(paths)],
  officialModToggle: (id: unknown, enabled: unknown): [string, boolean] => {
    const res = validateOfficialModToggle(id, enabled);
    return [res.id, res.enabled];
  },
  customModToggle: (filename: unknown, enabled: unknown): [string, boolean] => {
    const res = validateCustomModToggle(filename, enabled);
    return [res.filename, res.enabled];
  },
  customModFilename: (filename: unknown): [string] => [validateCustomModFilename(filename)],
  logAck: (data?: unknown): [{ batchId: number }] => [validateLogAck(data)],
};

export function registerSecureHandler<TArgs extends any[], TRes>(
  channel: string,
  validator: ((...args: any[]) => TArgs) | null,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: TArgs) => Promise<TRes> | TRes
): void {
  ipcMain.handle(channel, async (event: Electron.IpcMainInvokeEvent, ...rawArgs: any[]) => {
    try {
      IpcBoundary.validateIpcSender(event);
      const validatedArgs = validator ? validator(...rawArgs) : (rawArgs as unknown as TArgs);
      return await handler(event, ...validatedArgs);
    } catch (err: any) {
      LauncherLogger.warn(`[IPC Handler Error: ${channel}] ${err?.message || err}`);
      throw sanitizeIpcError(err);
    }
  });
}

export function registerSecureListener<TArgs extends any[]>(
  channel: string,
  validator: ((...args: any[]) => TArgs) | null,
  listener: (event: Electron.IpcMainEvent, ...args: TArgs) => void
): void {
  ipcMain.on(channel, (event: Electron.IpcMainEvent, ...rawArgs: any[]) => {
    try {
      IpcBoundary.validateIpcSender(event);
      const validatedArgs = validator ? validator(...rawArgs) : (rawArgs as unknown as TArgs);
      listener(event, ...validatedArgs);
    } catch (err: any) {
      LauncherLogger.warn(`[IPC Listener Error: ${channel}] ${err?.message || err}`);
    }
  });
}

