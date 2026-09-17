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
  frame: WebFrameMain;
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

export function isLaunchTargetToken(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length === 0) return false;
  // Positional operands and argument files designate main-class / source / argument injection
  if (!trimmed.startsWith("-")) return true;
  // Launch target flags
  if (/^-jar(=|$)/i.test(trimmed)) return true;
  if (/^--source(=|$)/i.test(trimmed)) return true;
  if (/^(-m|--module)(=|$)/i.test(trimmed)) return true;
  return false;
}

const ORDINARY_MEMORY_PATTERN = /^-X(ms|mx|ss|mn)[0-9]+[kKmMgGtT]?$/i;
const ORDINARY_XX_MEMORY_PATTERN =
  /^-XX:(MaxMetaspaceSize|MetaspaceSize|MaxDirectMemorySize|CompressedClassSpaceSize)=[0-9]+[kKmMgGtT]?$/i;
const ORDINARY_GC_SELECTION_PATTERN =
  /^-XX:[+-](UseG1GC|UseZGC|UseShenandoahGC|UseParallelGC|UseSerialGC|UseStringDeduplication|ParallelRefProcEnabled|AlwaysPreTouch|DisableExplicitGC|UnlockExperimentalVMOptions|UnlockDiagnosticVMOptions|OptimizeStringConcat|AggressiveOpts)$/;
const ORDINARY_GC_NUMERIC_PATTERN =
  /^-XX:(G1ReservePercent|InitiatingHeapOccupancyPercent|G1HeapRegionSize|MaxGCPauseMillis|ConcGCThreads|ParallelGCThreads|G1NewSizePercent|G1MaxNewSizePercent|SurvivorRatio|TargetSurvivorRatio|MaxTenuringThreshold|G1MixedGCCountTarget|G1MixedGCLiveThresholdPercent|G1HeapWastePercent|NewRatio)=[0-9]+[kKmMgGtT]?$/i;
const ORDINARY_GC_EXTRA_PATTERN =
  /^-XX:(ZAllocationSpikeTolerance=[0-9.]+|ShenandoahGCHeuristics=(adaptive|compact|passive))$/i;
const ORDINARY_GENERAL_PATTERN =
  /^(-server|-client|-showversion|-D(file|sun\.stdout|sun\.stderr)\.encoding=[a-zA-Z0-9._-]+)$/;
const SAFE_SYSTEM_PROPERTY_PATTERN = /^-D[a-zA-Z0-9._-]+(=[a-zA-Z0-9._/:,-]*)?$/;

const SENSITIVE_SYSTEM_PROPERTY_PATTERN =
  /^-D(java\.system\.class\.loader|java\.class\.path|jdk\.module\.|java\.security\.)/i;

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
  if (SAFE_SYSTEM_PROPERTY_PATTERN.test(trimmed)) {
    return !SENSITIVE_SYSTEM_PROPERTY_PATTERN.test(trimmed);
  }
  return false;
}

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^@/, reason: "Argument file (@argfile)" },
  { pattern: /^-javaagent:/i, reason: "Java agent (-javaagent)" },
  { pattern: /^-agentlib(:|$)/i, reason: "Native agent library (-agentlib)" },
  { pattern: /^-agentpath(:|$)/i, reason: "Native agent path (-agentpath)" },
  { pattern: /^(-cp|-classpath|--class-path)(=|$)/i, reason: "Classpath override (-cp/--class-path)" },
  {
    pattern: /^(-p|--module-path|--upgrade-module-path|--patch-module)(=|$)/i,
    reason: "Module path override (--module-path/--patch-module)",
  },
  { pattern: /^--add-modules(=|$)/i, reason: "Module addition (--add-modules)" },
  { pattern: /^--add-exports(=|$)/i, reason: "Module export override (--add-exports)" },
  { pattern: /^--add-opens(=|$)/i, reason: "Module reflection override (--add-opens)" },
  { pattern: /^--add-reads(=|$)/i, reason: "Module reads override (--add-reads)" },
  { pattern: /^--limit-modules(=|$)/i, reason: "Module limit override (--limit-modules)" },
  { pattern: /^-Xbootclasspath/i, reason: "Bootstrap classpath override (-Xbootclasspath)" },
  { pattern: /^-Djava\.system\.class\.loader=/i, reason: "Custom system class loader" },
  { pattern: /^-Djava\.class\.path=/i, reason: "Class path property override" },
  { pattern: /^-Djdk\.module\./i, reason: "JDK module configuration property" },
  { pattern: /^-XX:OnError=/i, reason: "Error command hook (-XX:OnError)" },
  { pattern: /^-XX:OnOutOfMemoryError=/i, reason: "OOM command hook (-XX:OnOutOfMemoryError)" },
  { pattern: /^-XX:ErrorFile=/i, reason: "Error file path hook (-XX:ErrorFile)" },
  { pattern: /^-XX:HeapDumpPath=/i, reason: "Heap dump path hook (-XX:HeapDumpPath)" },
  { pattern: /^-XX:LogFile=/i, reason: "Log file path hook (-XX:LogFile)" },
  { pattern: /^-XX:NativeMemoryTracking=/i, reason: "Native memory tracking hook" },
  { pattern: /^-Xrunjdwp:/i, reason: "Remote debugger hook (-Xrunjdwp)" },
  { pattern: /^-agentlib:jdwp/i, reason: "JDWP debugger hook" },
  { pattern: /^-Xdebug$/i, reason: "JVM debug mode (-Xdebug)" },
  { pattern: /^-Djava\.security\./i, reason: "Security manager/policy override" },
];

export function classifyJavaArgs(tokens: string[]): JavaArgClassification {
  let hasLaunchTargetOverride = false;
  let isPrivileged = false;
  const launchTargetViolations: string[] = [];
  const privilegedReasons: string[] = [];

  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    if (isLaunchTargetToken(trimmed)) {
      hasLaunchTargetOverride = true;
      isPrivileged = true;
      launchTargetViolations.push(trimmed);
      privilegedReasons.push(`Launch target override: '${trimmed}'`);
      continue;
    }

    for (const sensitive of SENSITIVE_PATTERNS) {
      if (sensitive.pattern.test(trimmed)) {
        isPrivileged = true;
        privilegedReasons.push(`${sensitive.reason}: '${trimmed}'`);
        break;
      }
    }

    if (!isOrdinaryTuningOption(trimmed)) {
      isPrivileged = true;
      if (!privilegedReasons.some((r) => r.includes(trimmed))) {
        privilegedReasons.push(`Unreviewed or sensitive JVM option: '${trimmed}'`);
      }
    }
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
    generationOrTtl?: number,
    maybeTtlMs?: number
  ): void {
    let generation: number | undefined;
    let ttlMs = APPROVAL_TTL_MS;

    if (maybeTtlMs !== undefined) {
      generation = generationOrTtl;
      ttlMs = maybeTtlMs;
    } else if (generationOrTtl !== undefined) {
      if (generationOrTtl > 50) {
        ttlMs = generationOrTtl;
        generation = this.documentGeneration;
      } else {
        generation = generationOrTtl;
      }
    }

    const gen = generation ?? this.documentGeneration;
    if (gen < this.documentGeneration) {
      // Do not grant old-generation result to newer generation
      return;
    }

    const normTarget = normalizeApprovalTarget(target);
    const key = `${operation}:${normTarget}`;
    this.approvals.set(key, {
      operation,
      target: normTarget,
      expiresAt: Date.now() + ttlMs,
      generation: gen,
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
    if (Date.now() > record.expiresAt || record.generation !== this.documentGeneration) {
      this.approvals.delete(key);
      return false;
    }
    this.approvals.delete(key);
    return true;
  }

  static createApprovalSnapshot(event: IpcMainInvokeEvent | IpcMainEvent): ApprovalSnapshot {
    if (!this.mainWindowRef || this.mainWindowRef.isDestroyed?.()) {
      throw new IpcSecurityError("Cannot create approval snapshot: main window is unavailable.");
    }
    const frame = event.senderFrame;
    if (!frame || (typeof (frame as any).isDestroyed === "function" && (frame as any).isDestroyed())) {
      throw new IpcSecurityError("Cannot create approval snapshot: sender frame is destroyed.");
    }
    return {
      generation: this.documentGeneration,
      window: this.mainWindowRef,
      frame,
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
      !snapshot.frame ||
      (typeof (snapshot.frame as any).isDestroyed === "function" && (snapshot.frame as any).isDestroyed()) ||
      snapshot.frame.parent !== null
    ) {
      throw new IpcSecurityError("Sender frame invalidated while awaiting native user approval.");
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

    if (event.sender !== this.mainWindowRef.webContents) {
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
    if (mainFrame && frame !== mainFrame) {
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
      throw new IpcValidationError(`Mod file must have a .jar extension: '${path.basename(resolved)}'`);
    }
    if (!fs.existsSync(resolved)) {
      throw new IpcValidationError(`Mod file does not exist: '${path.basename(resolved)}'`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new IpcValidationError(`Mod path is not a regular file: '${path.basename(resolved)}'`);
    }
    if (stat.size > MAX_CUSTOM_MOD_FILE_SIZE_BYTES) {
      throw new IpcValidationError(
        `Mod file exceeds maximum allowed size of 100MB: '${path.basename(resolved)}'`
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

export function sanitizeIpcError(err: any): Error {
  if (err instanceof IpcSecurityError) {
    return new Error("Security violation: IPC request rejected.");
  }
  const rawMsg = typeof err?.message === "string" ? err.message : String(err || "Operation failed.");
  // Strip raw filesystem paths (Windows drive paths or POSIX absolute paths)
  const sanitized = rawMsg
    .replace(/[a-zA-Z]:\\[^'"\s;:,]+/g, "<path>")
    .replace(/\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+/g, "<path>");
  if (err instanceof IpcValidationError) {
    return new Error(sanitized);
  }
  return new Error(sanitized);
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
