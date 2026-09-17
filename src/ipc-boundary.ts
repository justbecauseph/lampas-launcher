import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebFrameMain } from "electron";
import * as electronModule from "electron";

const electron: any = electronModule;
const app = electron?.app ?? electron?.default?.app;
const dialog = electron?.dialog ?? electron?.default?.dialog;
const ipcMain = electron?.ipcMain ?? electron?.default?.ipcMain;
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePortalUrl, validateWebUrl } from "./config";
import { LauncherLogger } from "./logger";
import type { KnownLocationId, UpdateSettingsDto } from "./types";

export const APPROVAL_TTL_MS = 60_000; // 60 seconds TTL
export const MAX_CUSTOM_MOD_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

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

export interface ApprovalRecord {
  operation: string;
  target: string;
  expiresAt: number;
  generation: number;
}

export interface ApprovalSnapshot {
  generation: number;
  window: BrowserWindow;
  webContents: Electron.WebContents;
  frame: WebFrameMain;
  frameUrl: string;
}

export interface GrantApprovalOptions {
  generation?: number;
  ttlMs?: number;
}

export interface StartupPolicy {
  isPackaged: boolean;
  appPath: string;
  devEndpoint?: string | null;
}

export interface JavaArgClassification {
  hasLaunchTargetOverride: boolean;
  isPrivileged: boolean;
  launchTargetViolations: string[];
  privilegedReasons: string[];
}

export function normalizeApprovalTarget(rawTarget: string): string {
  try {
    const resolved = path.resolve(rawTarget);
    if (process.platform === "win32") {
      return resolved.toLowerCase();
    }
    return resolved;
  } catch {
    return process.platform === "win32" ? rawTarget.toLowerCase() : rawTarget;
  }
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

export function parseJavaArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const input = value.trim();
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      const next = input[index + 1];
      if (next === "\\" || next === '"' || next === "'" || /\s/.test(next || "")) escaped = true;
      else current += char;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Custom Java arguments contain an unclosed quote.");
  if (current) args.push(current);
  return args;
}

// ═══════════════════════════════════════════════════
// Comprehensive Java Argument Privilege Classification
// ═══════════════════════════════════════════════════

export const ORDINARY_SYSTEM_PROPERTIES: Readonly<Record<string, RegExp>> = {
  "file.encoding": /^[a-zA-Z0-9_-]+$/,
  "sun.stdout.encoding": /^[a-zA-Z0-9_-]+$/,
  "sun.stderr.encoding": /^[a-zA-Z0-9_-]+$/,
  "user.language": /^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,3})?$/,
  "user.country": /^[a-zA-Z]{2,3}$/,
  "java.awt.headless": /^(?:true|false)$/i,
  "org.lwjgl.util.Debug": /^(?:true|false)$/i,
  "org.lwjgl.opengl.Window.undecorated": /^(?:true|false)$/i,
  "sun.java2d.opengl": /^(?:true|false)$/i,
  "sun.java2d.d3d": /^(?:true|false)$/i,
  "sun.java2d.noddraw": /^(?:true|false)$/i,
  "sun.rmi.dgc.client.gcInterval": /^\d+$/,
  "sun.rmi.dgc.server.gcInterval": /^\d+$/,
  "fabric.disableTelemetry": /^(?:true|false)$/i,
};

const LAUNCH_AUTHORITY_PROPERTY_PATTERN =
  /^(?:(?:fabric|quilt|forge|neoforge)\.(?:addMods|modsFolder|disabledMods|modDir|customModDir|libraryPath)|java\.library\.path|org\.lwjgl\.librarypath|minecraft\.applet\.TargetDirectory|minecraft\.launcher\.(?:brand|version)|java\.system\.class\.loader|java\.class\.path|jdk\.module\..+|com\.sun\.management\..+|java\.rmi\.server\..+|java\.security\..+)$/i;

const ORDINARY_MEMORY_PATTERN = /^-X(ms|mx|ss|mn)[0-9]+[kKmMgGtT]?$/i;
const ORDINARY_XX_MEMORY_PATTERN =
  /^-XX:(MaxMetaspaceSize|MetaspaceSize|MaxDirectMemorySize|CompressedClassSpaceSize)=[0-9]+[kKmMgGtT]?$/i;
const ORDINARY_GC_SELECTION_PATTERN =
  /^-XX:[+-](UseG1GC|UseZGC|UseShenandoahGC|UseParallelGC|UseSerialGC|UseStringDeduplication|ParallelRefProcEnabled|AlwaysPreTouch|DisableExplicitGC|UnlockExperimentalVMOptions|OptimizeStringConcat|UseFastAccessorMethods|AggressiveOpts)$/;
const ORDINARY_GC_NUMERIC_PATTERN =
  /^-XX:(G1ReservePercent|InitiatingHeapOccupancyPercent|G1HeapRegionSize|MaxGCPauseMillis|ConcGCThreads|ParallelGCThreads|G1NewSizePercent|G1MaxNewSizePercent|SurvivorRatio|TargetSurvivorRatio|MaxTenuringThreshold|G1MixedGCCountTarget|G1MixedGCLiveThresholdPercent|G1HeapWastePercent|NewRatio)=[0-9]+[kKmMgGtT]?$/i;
const ORDINARY_GC_EXTRA_PATTERN =
  /^-XX:(ZAllocationSpikeTolerance=[0-9.]+|ShenandoahGCHeuristics=(adaptive|compact|passive))$/i;
const ORDINARY_GENERAL_PATTERN =
  /^(-server|-client|-showversion)$/;

export function isOrdinaryTuningOption(token: string): boolean {
  const trimmed = token.trim();
  if (
    ORDINARY_MEMORY_PATTERN.test(trimmed) ||
    ORDINARY_XX_MEMORY_PATTERN.test(trimmed) ||
    ORDINARY_GC_SELECTION_PATTERN.test(trimmed) ||
    ORDINARY_GC_NUMERIC_PATTERN.test(trimmed) ||
    ORDINARY_GC_EXTRA_PATTERN.test(trimmed) ||
    ORDINARY_GENERAL_PATTERN.test(trimmed)
  ) {
    return true;
  }
  if (trimmed.startsWith("-D")) {
    const match = trimmed.match(/^-D([^=]+)(?:=(.*))?$/);
    if (match) {
      const prop = match[1];
      const val = match[2] ?? "";
      const allowed = ORDINARY_SYSTEM_PROPERTIES[prop];
      if (allowed && allowed.test(val)) {
        return true;
      }
    }
  }
  return false;
}

export function isLaunchTargetToken(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.startsWith("-")) return true;
  if (/^-jar(=|$)/i.test(trimmed)) return true;
  if (/^--source(=|$)/i.test(trimmed)) return true;
  if (/^(-m|--module)(=|$)/i.test(trimmed)) return true;
  if (trimmed.startsWith("-D")) {
    const match = trimmed.match(/^-D([^=]+)/);
    if (match && LAUNCH_AUTHORITY_PROPERTY_PATTERN.test(match[1])) {
      return true;
    }
  }
  return false;
}

export function classifyJavaArgs(tokens: string[]): JavaArgClassification {
  let hasLaunchTargetOverride = false;
  let isPrivileged = false;
  const launchTargetViolations: string[] = [];
  const privilegedReasons: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].trim();
    if (!token) continue;

    // 1. Argument files
    if (token.startsWith("@")) {
      hasLaunchTargetOverride = true;
      isPrivileged = true;
      launchTargetViolations.push(token);
      privilegedReasons.push(`Argument file (@argfile): '${token}'`);
      continue;
    }

    // 2. Launch target flags: -jar
    if (token === "-jar" || token.startsWith("-jar=")) {
      hasLaunchTargetOverride = true;
      isPrivileged = true;
      launchTargetViolations.push(token);
      privilegedReasons.push(`Launch target override (-jar): '${token}'`);
      if (token === "-jar" && i + 1 < tokens.length) {
        i++;
        launchTargetViolations.push(tokens[i]);
      }
      continue;
    }

    // 3. Module launch target: -m or --module
    if (token === "-m" || token === "--module") {
      hasLaunchTargetOverride = true;
      isPrivileged = true;
      launchTargetViolations.push(token);
      privilegedReasons.push(`Module launch target override: '${token}'`);
      if (i + 1 < tokens.length) {
        i++;
        launchTargetViolations.push(tokens[i]);
      }
      continue;
    }
    if (token.startsWith("-m=") || token.startsWith("--module=")) {
      hasLaunchTargetOverride = true;
      isPrivileged = true;
      launchTargetViolations.push(token);
      privilegedReasons.push(`Module launch target override: '${token}'`);
      continue;
    }

    // 4. Source file launch: --source
    if (token === "--source") {
      hasLaunchTargetOverride = true;
      isPrivileged = true;
      launchTargetViolations.push(token);
      privilegedReasons.push(`Source launch target override: '${token}'`);
      if (i + 1 < tokens.length) {
        i++;
        launchTargetViolations.push(tokens[i]);
      }
      continue;
    }
    if (token.startsWith("--source=")) {
      hasLaunchTargetOverride = true;
      isPrivileged = true;
      launchTargetViolations.push(token);
      privilegedReasons.push(`Source launch target override: '${token}'`);
      continue;
    }

    // 5. Positional operands (non-option tokens not consumed as operands of prior options)
    if (!token.startsWith("-")) {
      hasLaunchTargetOverride = true;
      isPrivileged = true;
      launchTargetViolations.push(token);
      privilegedReasons.push(`Positional launch target override: '${token}'`);
      continue;
    }

    // 6. Options with separate operands or equals form:
    // Classpath: -cp, -classpath, --class-path
    if (token === "-cp" || token === "-classpath" || token === "--class-path") {
      isPrivileged = true;
      privilegedReasons.push(`Classpath override: '${token}'`);
      if (i + 1 < tokens.length) {
        i++; // consume operand so it is not treated as a positional main class
      }
      continue;
    }
    if (token.startsWith("-cp=") || token.startsWith("-classpath=") || token.startsWith("--class-path=")) {
      isPrivileged = true;
      privilegedReasons.push(`Classpath override: '${token}'`);
      continue;
    }

    // Module path: -p, --module-path
    if (token === "-p" || token === "--module-path") {
      isPrivileged = true;
      privilegedReasons.push(`Module path override: '${token}'`);
      if (i + 1 < tokens.length) {
        i++;
      }
      continue;
    }
    if (token.startsWith("-p=") || token.startsWith("--module-path=")) {
      isPrivileged = true;
      privilegedReasons.push(`Module path override: '${token}'`);
      continue;
    }

    // Advanced module options: --upgrade-module-path, --patch-module, etc.
    const moduleOptMatch = token.match(/^(--upgrade-module-path|--patch-module|--add-modules|--add-exports|--add-opens|--add-reads|--limit-modules)(?:=(.*))?$/);
    if (moduleOptMatch) {
      isPrivileged = true;
      privilegedReasons.push(`Module configuration override: '${token}'`);
      if (moduleOptMatch[2] === undefined && i + 1 < tokens.length) {
        i++;
      }
      continue;
    }

    // Agents and debuggers
    if (/^-javaagent:/i.test(token)) {
      isPrivileged = true;
      privilegedReasons.push(`Java agent: '${token}'`);
      continue;
    }
    if (/^-agentlib(:|$)/i.test(token)) {
      isPrivileged = true;
      privilegedReasons.push(`Native agent library: '${token}'`);
      continue;
    }
    if (/^-agentpath(:|$)/i.test(token)) {
      isPrivileged = true;
      privilegedReasons.push(`Native agent path: '${token}'`);
      continue;
    }
    if (/^-Xbootclasspath/i.test(token)) {
      isPrivileged = true;
      privilegedReasons.push(`Bootstrap classpath override: '${token}'`);
      continue;
    }
    if (/^-Xrunjdwp:/i.test(token) || /^-Xdebug$/i.test(token)) {
      isPrivileged = true;
      privilegedReasons.push(`JVM debugger hook: '${token}'`);
      continue;
    }

    // Command hooks and error files
    if (/^-XX:(OnError|OnOutOfMemoryError|ErrorFile|HeapDumpPath|LogFile|NativeMemoryTracking)=/i.test(token)) {
      isPrivileged = true;
      privilegedReasons.push(`JVM diagnostic/command hook: '${token}'`);
      continue;
    }

    // System properties (-D)
    if (token.startsWith("-D")) {
      const match = token.match(/^-D([^=]+)(?:=(.*))?$/);
      if (match) {
        const propName = match[1];
        const propVal = match[2] ?? "";

        // Check launch/mod authority hijacking
        if (LAUNCH_AUTHORITY_PROPERTY_PATTERN.test(propName)) {
          hasLaunchTargetOverride = true;
          isPrivileged = true;
          launchTargetViolations.push(token);
          privilegedReasons.push(`Launch authority property override: '${token}'`);
          continue;
        }

        // Check ordinary allowlist
        const allowedRegex = ORDINARY_SYSTEM_PROPERTIES[propName];
        if (allowedRegex && allowedRegex.test(propVal)) {
          // Permitted ordinary tuning property
          continue;
        }

        // Unknown or sensitive system property
        isPrivileged = true;
        privilegedReasons.push(`Unreviewed or sensitive system property: '${token}'`);
        continue;
      }
    }

    // 7. Check ordinary memory and GC options
    if (isOrdinaryTuningOption(token)) {
      continue;
    }

    // Any remaining unknown or unreviewed option
    isPrivileged = true;
    privilegedReasons.push(`Unreviewed or sensitive JVM option: '${token}'`);
  }

  return {
    hasLaunchTargetOverride,
    isPrivileged,
    launchTargetViolations,
    privilegedReasons,
  };
}

export function isPrivilegedJavaArg(arg: string): boolean {
  const classification = classifyJavaArgs([arg]);
  return classification.isPrivileged || classification.hasLaunchTargetOverride;
}

// ═══════════════════════════════════════════════════
// Unified IPC Boundary Class
// ═══════════════════════════════════════════════════

export class IpcBoundary {
  private static mainWindowRef: BrowserWindow | null = null;
  private static documentGeneration = 1;
  private static startupPolicy: StartupPolicy | null = null;
  private static canonicalRendererPath: string | null = null;
  private static allowedDevOrigin: string | null = null;
  private static approvals = new Map<string, ApprovalRecord>();

  static initializeStartupPolicy(policy: StartupPolicy): void {
    this.startupPolicy = policy;
    const appDir = path.resolve(policy.appPath);
    this.canonicalRendererPath = normalizeFilePath(path.join(appDir, "dist/renderer/index.html"));
    if (!policy.isPackaged && policy.devEndpoint) {
      try {
        this.allowedDevOrigin = new URL(policy.devEndpoint).origin;
      } catch {
        this.allowedDevOrigin = null;
      }
    } else {
      this.allowedDevOrigin = null;
    }
  }

  static getStartupPolicy(): StartupPolicy | null {
    return this.startupPolicy;
  }

  static isPackagedProduction(): boolean {
    if (this.startupPolicy) {
      return this.startupPolicy.isPackaged;
    }
    return Boolean(app?.isPackaged);
  }

  static resetForTesting(): void {
    this.mainWindowRef = null;
    this.documentGeneration = 1;
    this.startupPolicy = null;
    this.canonicalRendererPath = null;
    this.allowedDevOrigin = null;
    this.approvals.clear();
  }

  static setApprovedDocumentUrl(url: string): void {
    if (url.startsWith("file:")) {
      try {
        this.canonicalRendererPath = fileURLToPath(url);
      } catch {
        this.canonicalRendererPath = url;
      }
      this.startupPolicy = {
        isPackaged: true,
        appPath: process.cwd(),
      };
    } else {
      try {
        this.allowedDevOrigin = new URL(url).origin;
      } catch {
        this.allowedDevOrigin = url;
      }
      this.startupPolicy = {
        isPackaged: false,
        devEndpoint: url,
        appPath: process.cwd(),
      };
    }
  }

  static setMainWindow(win: BrowserWindow | null): void {
    this.mainWindowRef = win;
    if (win && !win.isDestroyed?.()) {
      win.webContents?.on?.("did-finish-load", () => {
        this.onDocumentLoaded();
      });
      win.webContents?.on?.("did-start-navigation", () => {
        this.onNavigation();
      });
    }
  }

  static getMainWindow(): BrowserWindow | null {
    return this.mainWindowRef;
  }

  static onNavigation(): void {
    this.invalidateApprovals();
    this.incrementDocumentGeneration();
  }

  static onDocumentLoaded(): void {
    this.invalidateApprovals();
    this.incrementDocumentGeneration();
  }

  static getDocumentGeneration(): number {
    return this.documentGeneration;
  }

  static incrementDocumentGeneration(): number {
    return ++this.documentGeneration;
  }

  static invalidateApprovals(): void {
    this.approvals.clear();
  }

  static grantApproval(
    operation: string,
    target: string,
    options?: GrantApprovalOptions
  ): void {
    const generation = options?.generation ?? this.documentGeneration;
    const ttlMs = options?.ttlMs ?? APPROVAL_TTL_MS;

    // Require exact current-generation equality
    if (generation !== this.documentGeneration) {
      throw new IpcSecurityError(
        `Approval generation mismatch: expected generation ${this.documentGeneration}, but got ${generation}.`
      );
    }

    const normTarget = normalizeApprovalTarget(target);
    const key = `${operation}:${normTarget}`;
    this.approvals.set(key, {
      operation,
      target: normTarget,
      expiresAt: Date.now() + ttlMs,
      generation,
    });
  }

  static hasApproval(operation: string, target: string): boolean {
    const normTarget = normalizeApprovalTarget(target);
    const key = `${operation}:${normTarget}`;
    const record = this.approvals.get(key);
    if (!record) return false;
    if (Date.now() > record.expiresAt || record.generation !== this.documentGeneration) {
      this.approvals.delete(key);
      return false;
    }
    return true;
  }

  static consumeApproval(operation: string, target: string): boolean {
    const normTarget = normalizeApprovalTarget(target);
    const key = `${operation}:${normTarget}`;
    const record = this.approvals.get(key);
    if (!record) return false;
    this.approvals.delete(key);
    if (Date.now() > record.expiresAt || record.generation !== this.documentGeneration) {
      return false;
    }
    return true;
  }

  static createApprovalSnapshot(event: IpcMainInvokeEvent | IpcMainEvent): ApprovalSnapshot {
    if (!this.mainWindowRef || this.mainWindowRef.isDestroyed?.()) {
      throw new IpcSecurityError("Cannot create approval snapshot: main window is unavailable.");
    }
    const webContents = this.mainWindowRef.webContents;
    if (!webContents || (typeof (webContents as any).isDestroyed === "function" && (webContents as any).isDestroyed())) {
      throw new IpcSecurityError("Cannot create approval snapshot: webContents is unavailable or destroyed.");
    }
    if (event.sender !== webContents) {
      throw new IpcSecurityError("Cannot create approval snapshot: caller webContents does not match main window.");
    }
    const currentMainFrame = webContents.mainFrame;
    if (!currentMainFrame || (typeof (currentMainFrame as any).isDestroyed === "function" && (currentMainFrame as any).isDestroyed())) {
      throw new IpcSecurityError("Cannot create approval snapshot: missing or destroyed main frame.");
    }
    const frame = event.senderFrame;
    if (!frame || (typeof (frame as any).isDestroyed === "function" && (frame as any).isDestroyed())) {
      throw new IpcSecurityError("Cannot create approval snapshot: sender frame is destroyed.");
    }
    if (frame !== currentMainFrame) {
      throw new IpcSecurityError("Cannot create approval snapshot: sender frame is not the active main frame.");
    }
    if (frame.parent !== null) {
      throw new IpcSecurityError("Cannot create approval snapshot: sender frame is not top-level.");
    }
    const frameUrl = frame.url;
    if (!frameUrl || frameUrl.trim() === "" || frameUrl === "about:blank") {
      throw new IpcSecurityError("Cannot create approval snapshot: uninitialized or blank document.");
    }
    this.assertApprovedDocument(frameUrl);

    return {
      generation: this.documentGeneration,
      window: this.mainWindowRef,
      webContents,
      frame,
      frameUrl,
    };
  }

  static validateApprovalSnapshot(snapshot: ApprovalSnapshot): void {
    if (this.documentGeneration !== snapshot.generation) {
      throw new IpcSecurityError("Document generation changed while awaiting native user approval.");
    }
    if (!snapshot.window || snapshot.window.isDestroyed?.() || snapshot.window !== this.mainWindowRef) {
      throw new IpcSecurityError("Application window destroyed or replaced while awaiting native user approval.");
    }
    if (
      !snapshot.webContents ||
      (typeof (snapshot.webContents as any).isDestroyed === "function" && (snapshot.webContents as any).isDestroyed()) ||
      snapshot.window.webContents !== snapshot.webContents
    ) {
      throw new IpcSecurityError("WebContents invalidated while awaiting native user approval.");
    }
    const currentMainFrame = snapshot.webContents.mainFrame;
    if (
      !currentMainFrame ||
      (typeof (currentMainFrame as any).isDestroyed === "function" && (currentMainFrame as any).isDestroyed())
    ) {
      throw new IpcSecurityError("Active main frame destroyed or unavailable while awaiting native user approval.");
    }
    if (
      !snapshot.frame ||
      (typeof (snapshot.frame as any).isDestroyed === "function" && (snapshot.frame as any).isDestroyed()) ||
      snapshot.frame !== currentMainFrame ||
      snapshot.frame.parent !== null
    ) {
      throw new IpcSecurityError("Sender frame invalidated while awaiting native user approval.");
    }

    // Revalidate the approved document after native approval
    const currentUrl = currentMainFrame.url;
    if (!currentUrl || currentUrl !== snapshot.frameUrl) {
      throw new IpcSecurityError("Document URL changed while awaiting native user approval.");
    }
    this.assertApprovedDocument(currentUrl);

    if (snapshot.webContents.getURL && snapshot.webContents.getURL() !== currentUrl) {
      throw new IpcSecurityError("Document has navigated away from active frame URL.");
    }
  }

  static async confirmPrivilegedOperation(
    event: IpcMainInvokeEvent,
    options: {
      title: string;
      message: string;
      detail?: string;
      confirmButtonText?: string;
      cancelButtonText?: string;
    }
  ): Promise<boolean> {
    if (!dialog || typeof dialog.showMessageBox !== "function") {
      throw new IpcSecurityError("Native dialog service unavailable; privileged action denied fail-closed.");
    }
    const snapshot = this.createApprovalSnapshot(event);
    const result = await dialog.showMessageBox(snapshot.window, {
      type: "warning",
      buttons: [options.confirmButtonText || "Confirm", options.cancelButtonText || "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: options.title,
      message: options.message,
      detail: options.detail,
      noLink: true,
    });
    this.validateApprovalSnapshot(snapshot);
    return result.response === 0;
  }

  static validateIpcSender(event: IpcMainInvokeEvent | IpcMainEvent): { sender: any; frame: any } {
    if (!this.mainWindowRef || this.mainWindowRef.isDestroyed?.()) {
      throw new IpcSecurityError("Unauthorized IPC caller: main application window is unavailable.");
    }

    const webContents = this.mainWindowRef.webContents;
    if (
      !webContents ||
      (typeof (webContents as any).isDestroyed === "function" && (webContents as any).isDestroyed()) ||
      (typeof (event.sender as any)?.isDestroyed === "function" && (event.sender as any).isDestroyed())
    ) {
      throw new IpcSecurityError("Unauthorized IPC caller: webContents is unavailable or destroyed.");
    }

    if (event.sender !== webContents) {
      throw new IpcSecurityError("Unauthorized IPC caller: caller webContents does not match main window.");
    }

    const frame = event.senderFrame;
    if (!frame) {
      throw new IpcSecurityError("Unauthorized IPC caller: missing or destroyed sender frame.");
    }

    if (frame.parent !== null) {
      throw new IpcSecurityError("Unauthorized IPC caller: child frames and subdocuments are not permitted.");
    }

    if (typeof (frame as any).isDestroyed === "function" && (frame as any).isDestroyed()) {
      throw new IpcSecurityError("Unauthorized IPC caller: sender frame is detached or destroyed.");
    }

    const mainFrame = this.mainWindowRef.webContents?.mainFrame;
    if (!mainFrame || (typeof (mainFrame as any).isDestroyed === "function" && (mainFrame as any).isDestroyed())) {
      throw new IpcSecurityError("Unauthorized IPC caller: missing or destroyed main frame.");
    }
    if (frame !== mainFrame) {
      throw new IpcSecurityError("Unauthorized IPC caller: sender frame is not the active main frame.");
    }

    if (!this.startupPolicy) {
      throw new IpcSecurityError("Unauthorized IPC caller: startup policy not initialized.");
    }

    const frameUrl = frame.url;
    if (!frameUrl || frameUrl.trim() === "" || frameUrl === "about:blank") {
      throw new IpcSecurityError("Unauthorized IPC caller: uninitialized or blank document.");
    }

    this.assertApprovedDocument(frameUrl);

    if (event.sender.getURL && event.sender.getURL() !== frameUrl) {
      throw new IpcSecurityError("Unauthorized IPC caller: document has navigated away from active frame URL.");
    }

    return { sender: event.sender, frame };
  }

  private static assertApprovedDocument(frameUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(frameUrl);
    } catch {
      throw new IpcSecurityError(`Unauthorized IPC caller: malformed frame URL '${frameUrl}'`);
    }

    if (
      parsed.protocol === "about:" ||
      parsed.protocol === "data:" ||
      parsed.protocol === "blob:" ||
      parsed.protocol === "javascript:"
    ) {
      throw new IpcSecurityError(`Unauthorized IPC caller: disallowed document scheme '${parsed.protocol}'`);
    }

    const isPackaged = this.isPackagedProduction();

    if (parsed.protocol === "file:") {
      // Reject foreign file-URL authorities (e.g. file://evil.com/ or UNC file://share/...)
      if (parsed.hostname !== "" && parsed.hostname !== "localhost") {
        throw new IpcSecurityError(
          `Unauthorized IPC caller: foreign file URL authority '${parsed.hostname}' is prohibited.`
        );
      }

      let candidatePath: string;
      try {
        candidatePath = fileURLToPath(frameUrl);
      } catch {
        throw new IpcSecurityError(`Unauthorized IPC caller: invalid file URL path conversion '${frameUrl}'`);
      }

      const canonicalCandidate = normalizeFilePath(candidatePath);
      const expectedPath =
        this.canonicalRendererPath || normalizeFilePath(path.resolve(__dirname, "renderer/index.html"));
      const devUiPath = normalizeFilePath(
        path.resolve(this.startupPolicy?.appPath || __dirname, "ui/index.html")
      );

      const allowedPaths = isPackaged ? [expectedPath] : [expectedPath, devUiPath];

      const matches = allowedPaths.some((allowed) =>
        process.platform === "win32"
          ? allowed.toLowerCase() === canonicalCandidate.toLowerCase()
          : allowed === canonicalCandidate
      );

      if (!matches) {
        throw new IpcSecurityError(
          `Unauthorized IPC caller: document does not match approved renderer path. Candidate: ${canonicalCandidate}`
        );
      }
      return;
    }

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (isPackaged) {
        throw new IpcSecurityError(
          `Unauthorized IPC caller: remote or loopback dev server document is prohibited in packaged production: ${frameUrl}`
        );
      }

      if (!this.allowedDevOrigin) {
        throw new IpcSecurityError(
          `Unauthorized IPC caller: no development endpoint configured for remote document: ${frameUrl}`
        );
      }

      if (parsed.origin !== this.allowedDevOrigin) {
        throw new IpcSecurityError(
          `Unauthorized IPC caller: not an approved application document: origin '${parsed.origin}' does not match configured development endpoint '${this.allowedDevOrigin}'`
        );
      }
      return;
    }

    throw new IpcSecurityError(`Unauthorized IPC caller: unsupported protocol '${parsed.protocol}'`);
  }
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
      throw new IpcValidationError("Unknown or unauthorized settings field.");
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
    const tokens = parseJavaArgs(raw.javaArgs);
    const classification = classifyJavaArgs(tokens);
    if (classification.hasLaunchTargetOverride) {
      throw new IpcValidationError("Custom Java arguments cannot override launch target or main class.");
    }
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
    throw new IpcValidationError("Invalid known location identifier.");
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

export function validateGameDirBrowse(defaultPath?: unknown): string | undefined {
  return validateOptionalPath(defaultPath);
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
      throw new IpcValidationError("Mod file must have a .jar extension.");
    }
    if (!fs.existsSync(resolved)) {
      throw new IpcValidationError("Mod file does not exist.");
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new IpcValidationError("Mod path is not a regular file.");
    }
    if (stat.size > MAX_CUSTOM_MOD_FILE_SIZE_BYTES) {
      throw new IpcValidationError(
        "Mod file exceeds maximum allowed size of 100MB."
      );
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
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new IpcValidationError("Mod filename must be a non-empty string.");
  }
  if (filename.length > 256) {
    throw new IpcValidationError("Mod filename exceeds maximum length of 256 characters.");
  }
  if (path.basename(filename) !== filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new IpcValidationError("Invalid mod filename path traversal attempt.");
  }
  if (typeof enabled !== "boolean") {
    throw new IpcValidationError("Enabled flag must be a boolean.");
  }
  return { filename, enabled };
}

export function validateCustomModFilename(filename: unknown): string {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new IpcValidationError("Mod filename must be a non-empty string.");
  }
  if (filename.length > 256) {
    throw new IpcValidationError("Mod filename exceeds maximum length of 256 characters.");
  }
  if (path.basename(filename) !== filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new IpcValidationError("Invalid mod filename path traversal attempt.");
  }
  return filename;
}

export function validateLogAck(payload: unknown): { batchId: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new IpcValidationError("LogAck payload must be an object.");
  }
  const batchId = (payload as any).batchId;
  if (typeof batchId !== "number" || !Number.isInteger(batchId) || batchId < 0) {
    throw new IpcValidationError("LogAck payload must include a non-negative integer batchId.");
  }
  return { batchId };
}

export const IpcSchemas = {
  noArgs: (): [] => [],
  openPath: (raw: unknown): [string] => [validateOpenPath(raw)],
  openSourcePage: (raw: unknown): [string] => [validateOpenSourcePage(raw)],
  openKnownLocation: (raw: unknown): [KnownLocationId] => [validateOpenKnownLocation(raw)],
  configSet: (raw: unknown): [UpdateSettingsDto] => [validateConfigSet(raw)],
  gameDirTarget: (raw: unknown): [string] => [validateGameDirTarget(raw)],
  gameDirValidate: (targetPath: unknown, currentPath?: unknown): [string, string | undefined] => {
    const res = validateGameDirValidateArgs(targetPath, currentPath);
    return [res.targetPath, res.currentPath];
  },
  gameDirBrowse: (defaultPath?: unknown): [string | undefined] => [validateGameDirBrowse(defaultPath)],
  modPaths: (raw: unknown): [string[]] => [validateModPaths(raw)],
  officialModToggle: (id: unknown, enabled: unknown): [string, boolean] => {
    const res = validateOfficialModToggle(id, enabled);
    return [res.id, res.enabled];
  },
  customModToggle: (filename: unknown, enabled: unknown): [string, boolean] => {
    const res = validateCustomModToggle(filename, enabled);
    return [res.filename, res.enabled];
  },
  customModFilename: (raw: unknown): [string] => [validateCustomModFilename(raw)],
  logAck: (data?: unknown): [{ batchId: number }] => [validateLogAck(data)],
};

// ═══════════════════════════════════════════════════
// Error Sanitization & Secure Registration Wrappers
// ═══════════════════════════════════════════════════

export function scrubErrorText(text: string): string {
  let s = text;
  // 1. Strip stack trace lines (lines starting with whitespace followed by 'at ')
  s = s.replace(/\r?\n\s*at\s+.*$/s, "");
  s = s.replace(/\r?\n\s*at\s+[^\r\n]*/g, "");
  // 2. Collapse newlines and multiline spacing to single line
  s = s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  // 3. Scrub Windows drive paths and UNC paths
  s = s.replace(/[a-zA-Z]:[\\/][^'"\s;:,]+/g, "<path>");
  s = s.replace(/\\\\[^'"\s;:,]+/g, "<path>");
  // 4. Scrub POSIX absolute paths (both single-component and multi-component: /etc, /tmp, /secret, /a/b/c)
  s = s.replace(/(?<=^|[\s'"`;:])\/(?:[a-zA-Z0-9._-]+\/?)+/g, "<path>");
  // 5. Scrub synthetic secrets and credential values
  s = s.replace(
    /(?<=\b(?:token|bearer|secret|password|access_token|refresh_token|code|key)[\s:=]+)['"]?[^\s'"`;:,]+['"]?/gi,
    "<redacted>"
  );
  s = s.replace(
    /(?<=^|[\s'"`;:])(?:eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|[a-fA-F0-9]{32,}|[a-zA-Z0-9+/]{32,}={0,2})(?=$|[\s'"`;:])/g,
    "<redacted>"
  );
  return s.trim();
}

export function sanitizeIpcError(err: any): Error {
  if (err instanceof IpcSecurityError) {
    return new Error("Security violation: IPC request rejected.");
  }

  if (err instanceof IpcValidationError) {
    const rawMsg = typeof err?.message === "string" ? err.message : "Validation error.";
    const scrubbed = scrubErrorText(rawMsg);
    const bounded = scrubbed.length > 120 ? scrubbed.slice(0, 117) + "..." : scrubbed;
    return new Error(bounded);
  }

  // Handle test harness interception
  if (err && typeof err.message === "string" && err.message.includes("[SecurityHarness]")) {
    return new Error(err.message);
  }

  // Handle known expected domain / operational conflict errors
  if (err && typeof err.message === "string") {
    const msg = err.message;
    if (
      msg.includes("is currently in progress") ||
      msg.includes("while Minecraft is running") ||
      msg.includes("Cannot modify client mods while") ||
      msg.includes("Authentication required") ||
      msg.includes("Session expired") ||
      msg.includes("No bound Minecraft account found") ||
      msg.includes("Incompatible installation state detected") ||
      msg.includes("Incompatible installation generation detected") ||
      msg.includes("Missing installation state metadata") ||
      msg.includes("Installation state metadata is empty") ||
      msg.includes("Installation state metadata is missing") ||
      msg.includes("Installation state metadata is corrupted") ||
      msg.includes("No installed Lampas release found") ||
      msg.includes("Release descriptor is corrupted") ||
      msg.includes("Release descriptor metadata is missing") ||
      msg.includes("Cannot disable unknown official mod") ||
      msg.includes("is required and cannot be disabled") ||
      msg.includes("is required by the server modpack and cannot be disabled") ||
      msg.includes("Mod import cancelled by user") ||
      msg.includes("Mod file must have a .jar extension") ||
      msg.includes("Mod file does not exist") ||
      msg.includes("Mod path is not a regular file") ||
      msg.includes("Mod file exceeds maximum allowed size") ||
      msg.includes("Privileged action rejected by user") ||
      msg.includes("Privileged Java arguments rejected by user") ||
      msg.includes("Custom Java executable update cancelled by user") ||
      msg.includes("Configuration cancelled by user") ||
      msg.includes("Move cancelled by user") ||
      msg.includes("Native dialog service unavailable") ||
      msg.includes("Document generation changed while awaiting native user approval") ||
      msg.includes("Operation state changed while awaiting native user approval") ||
      msg.includes("Custom Java arguments cannot override launch target") ||
      msg.includes("Process argument sink rejected launch target override") ||
      msg.includes("does not exist") ||
      msg.includes("Expected file") ||
      msg.includes("Expected directory") ||
      msg.includes("Refusing to open") ||
      msg.includes("escaping") ||
      msg.includes("Cannot access file") ||
      msg.includes("Access denied") ||
      msg.includes("Location identifier must be a non-empty string") ||
      msg.includes("No existing ancestor for path") ||
      msg.includes("Portal URL") ||
      msg.includes("Web URL") ||
      msg.includes("Remote portal")
    ) {
      const scrubbed = scrubErrorText(msg);
      const bounded = scrubbed.length > 200 ? scrubbed.slice(0, 197) + "..." : scrubbed;
      return new Error(bounded);
    }
  }

  // Unexpected backend failures return a stable generic public error
  return new Error("Operation failed: An unexpected internal error occurred.");
}

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
