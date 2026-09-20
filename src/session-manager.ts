import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as jsonc from "jsonc-parser";
import {
  CredentialStore,
  type StoredCredentialRecord,
  type SaveCredentialsResult,
  type ClearCredentialsResult,
  type StorageBackendType,
} from "./credential-store";
import { normalizePortalUrl } from "./portal-policy";
import { writeAtomicFileSync } from "./file-transfer";
import { LauncherLogger } from "./logger";
import type { UserProfile } from "./types";

export interface SessionCredentials {
  token: string;
  refreshToken?: string;
  minecraftAccessToken?: string;
  portalUrl: string;
}

export interface AuthStorageStatusDto {
  backend: StorageBackendType;
  sessionOnly: boolean;
  persistenceAvailable: boolean;
  sessionPersisted?: boolean;
  lastPersistenceError?: string | null;
  lastCleanupError?: string | null;
}

export interface MigrationOutcome {
  protectedLoaded: boolean;
  failedProtectedLoad: boolean;
  legacyPlaintextDetected: boolean;
  legacyScrubbed: boolean;
  migrated: boolean;
  error?: string;
}

const SECRET_KEYS_SET = new Set([
  "token",
  "refreshToken",
  "minecraftAccessToken",
  "sessionPortalUrl",
]);

function decodeJsonStringToken(content: string): string {
  try {
    return JSON.parse(`"${content.replace(/"/g, '\\"')}"`);
  } catch {
    return content.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
}

function detectPlaintextSecretKeys(parsed: any, raw?: string | null): boolean {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const key of Object.keys(parsed)) {
      if (SECRET_KEYS_SET.has(key)) return true;
    }
  }

  if (!raw || typeof raw !== "string") return false;

  try {
    const tolerant = jsonc.parse(raw);
    if (tolerant && typeof tolerant === "object" && !Array.isArray(tolerant)) {
      for (const key of Object.keys(tolerant)) {
        if (SECRET_KEYS_SET.has(key)) return true;
      }
    }
  } catch {}

  const keyRegex = /"((?:[^"\\]|\\.)*)"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(raw)) !== null) {
    const decoded = decodeJsonStringToken(match[1]);
    if (SECRET_KEYS_SET.has(decoded)) return true;
  }

  return false;
}

const MINECRAFT_UUID_REGEX =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32})$/;
const ZERO_UUID_REGEX = /^(?:0{8}-0{4}-0{4}-0{4}-0{12}|0{32})$/;

export function isValidMinecraftUuid(uuid: any): boolean {
  if (typeof uuid !== "string") return false;
  const trimmed = uuid.trim();
  if (!MINECRAFT_UUID_REGEX.test(trimmed)) return false;
  if (ZERO_UUID_REGEX.test(trimmed)) return false;
  return true;
}

export class SessionManager {
  private static sessionEpoch: number = 1;
  private static currentRecord: StoredCredentialRecord | null = null;
  private static currentUser: UserProfile | null = null;
  private static activeLoginEpoch: number = 0;
  private static isCurrentSessionPersisted: boolean = false;
  private static refreshPromises = new Map<
    string,
    Promise<{ valid: boolean; user?: UserProfile; token?: string }>
  >();
  private static initialized: boolean = false;
  private static lastMigrationOutcome: MigrationOutcome | null = null;
  private static sessionListeners: Array<
    (creds: SessionCredentials | null) => void
  > = [];

  static addSessionListener(
    listener: (creds: SessionCredentials | null) => void,
  ): () => void {
    this.sessionListeners.push(listener);
    return () => {
      this.sessionListeners = this.sessionListeners.filter(
        (l) => l !== listener,
      );
    };
  }

  private static notifySessionChange(creds: SessionCredentials | null): void {
    for (const listener of this.sessionListeners) {
      try {
        listener(creds);
      } catch {}
    }
  }

  static getSessionEpoch(): number {
    return this.sessionEpoch;
  }

  static advanceSessionEpoch(): number {
    this.refreshPromises.clear();
    return ++this.sessionEpoch;
  }

  static getActiveLoginEpoch(): number {
    return this.activeLoginEpoch;
  }

  static nextLoginEpoch(): number {
    this.advanceSessionEpoch();
    return ++this.activeLoginEpoch;
  }

  static isAuthenticated(): boolean {
    return this.currentRecord !== null && Boolean(this.currentRecord.token);
  }

  static getCredentials(): SessionCredentials | null {
    if (!this.currentRecord || !this.currentRecord.token) {
      return null;
    }
    return {
      token: this.currentRecord.token,
      refreshToken: this.currentRecord.refreshToken,
      minecraftAccessToken: this.currentRecord.minecraftAccessToken,
      portalUrl: this.currentRecord.portalUrl,
    };
  }

  static getCurrentRecord(): StoredCredentialRecord | null {
    return this.currentRecord ? { ...this.currentRecord } : null;
  }

  static getCurrentUser(): UserProfile | null {
    return this.currentUser;
  }

  /**
   * Sets current user profile while strictly preventing silent relabeling of credentials
   * belonging to a different Portal account or Minecraft UUID.
   */
  static setCurrentUser(user: UserProfile | null): void {
    if (user) {
      if (typeof user.id !== "string" || typeof user.name !== "string") {
        throw new Error(
          "Cannot set current user: user ID and name must be strings",
        );
      }
      const uName = user.name.trim();
      const uId = user.id.trim();
      if (
        !uName ||
        !uId ||
        uName.toLowerCase() === "player" ||
        uName.toLowerCase() === "account" ||
        uName.toLowerCase() === "unverified-migration" ||
        uId.toLowerCase() === "player" ||
        uId.toLowerCase() === "account" ||
        uId.toLowerCase() === "unverified-migration"
      ) {
        throw new Error(
          "Cannot set current user: placeholder or invalid identity",
        );
      }
    }

    if (user && this.currentRecord) {
      const existingPortalId = this.currentRecord.portalAccountId;
      const existingMcUuid = this.currentRecord.minecraftUuid;

      if (
        this.currentUser &&
        this.currentUser.id &&
        user.id &&
        this.currentUser.id !== user.id
      ) {
        throw new Error(
          `Cannot relabel credentials: active session belongs to portal user ${this.currentUser.id}, not ${user.id}`,
        );
      }

      if (
        existingPortalId &&
        existingPortalId !== "account" &&
        existingPortalId !== "unverified-migration" &&
        !existingPortalId.startsWith("config-account-") &&
        !existingPortalId.startsWith("session-account-") &&
        user.id &&
        existingPortalId !== user.id
      ) {
        throw new Error(
          `Cannot relabel credentials: active session belongs to portal user ${existingPortalId}, not ${user.id}`,
        );
      }

      if (
        existingMcUuid &&
        existingMcUuid !== "00000000-0000-0000-0000-000000000000" &&
        user.minecraftUuid &&
        existingMcUuid !== user.minecraftUuid
      ) {
        throw new Error(
          `Cannot relabel credentials: active session belongs to Minecraft UUID ${existingMcUuid}, not ${user.minecraftUuid}`,
        );
      }

      this.currentUser = user;
      if (user.id) this.currentRecord.portalAccountId = user.id;
      if (user.name) this.currentRecord.portalUsername = user.name;
      if (user.minecraftUuid)
        this.currentRecord.minecraftUuid = user.minecraftUuid;
      if (user.minecraftUsername)
        this.currentRecord.minecraftUsername = user.minecraftUsername;
      this.currentRecord.accountId =
        this.currentRecord.portalAccountId || this.currentRecord.accountId;
      this.currentRecord.accountUsername =
        this.currentRecord.portalUsername || this.currentRecord.accountUsername;
    } else {
      this.currentUser = user;
    }
  }

  /**
   * Validates a candidate session record and optional user profile.
   * Enforces complete schema, identity non-placeholder rules, and type invariants.
   */
  static validateCandidateSession(
    record: StoredCredentialRecord,
    user?: UserProfile,
  ): { valid: boolean; error?: string } {
    if (!CredentialStore.validateRecord(record)) {
      return {
        valid: false,
        error: "Candidate record failed credential store schema validation",
      };
    }

    if (
      record.portalAccountId !== undefined &&
      typeof record.portalAccountId !== "string"
    ) {
      return {
        valid: false,
        error:
          "Candidate record has malformed portalAccountId (must be string)",
      };
    }
    if (
      record.accountId !== undefined &&
      typeof record.accountId !== "string"
    ) {
      return {
        valid: false,
        error: "Candidate record has malformed accountId (must be string)",
      };
    }
    if (
      record.portalUsername !== undefined &&
      typeof record.portalUsername !== "string"
    ) {
      return {
        valid: false,
        error: "Candidate record has malformed portalUsername (must be string)",
      };
    }
    if (
      record.accountUsername !== undefined &&
      typeof record.accountUsername !== "string"
    ) {
      return {
        valid: false,
        error:
          "Candidate record has malformed accountUsername (must be string)",
      };
    }

    const rawAccountId = record.portalAccountId ?? record.accountId;
    if (typeof rawAccountId !== "string") {
      return {
        valid: false,
        error: "Candidate record lacks valid string account ID",
      };
    }
    const portalAccountId = rawAccountId.trim();
    if (
      !portalAccountId ||
      portalAccountId.toLowerCase() === "account" ||
      portalAccountId.toLowerCase() === "unverified-migration" ||
      portalAccountId.toLowerCase() === "player"
    ) {
      return {
        valid: false,
        error: `Invalid account identity '${portalAccountId}'`,
      };
    }

    const rawUsername = record.portalUsername ?? record.accountUsername;
    if (typeof rawUsername !== "string") {
      return {
        valid: false,
        error: "Candidate record lacks valid string username",
      };
    }
    const portalUsername = rawUsername.trim();
    if (
      !portalUsername ||
      portalUsername.toLowerCase() === "player" ||
      portalUsername.toLowerCase() === "account" ||
      portalUsername.toLowerCase() === "unverified-migration"
    ) {
      return { valid: false, error: `Invalid username '${portalUsername}'` };
    }

    if (record.minecraftUuid !== undefined) {
      if (!isValidMinecraftUuid(record.minecraftUuid)) {
        return {
          valid: false,
          error: "Candidate record has invalid Minecraft UUID format",
        };
      }
    }

    if (user) {
      if (typeof user.id !== "string") {
        return { valid: false, error: "User profile lacks valid string ID" };
      }
      const uId = user.id.trim();
      if (
        !uId ||
        uId.toLowerCase() === "player" ||
        uId.toLowerCase() === "account" ||
        uId.toLowerCase() === "unverified-migration"
      ) {
        return {
          valid: false,
          error: `User profile has invalid or placeholder ID '${uId}'`,
        };
      }
      if (typeof user.name !== "string") {
        return { valid: false, error: "User profile lacks valid string name" };
      }
      const uName = user.name.trim();
      if (
        !uName ||
        uName.toLowerCase() === "player" ||
        uName.toLowerCase() === "account" ||
        uName.toLowerCase() === "unverified-migration"
      ) {
        return {
          valid: false,
          error: `User profile has invalid or placeholder name '${uName}'`,
        };
      }
      if (!isValidMinecraftUuid(user.minecraftUuid)) {
        return {
          valid: false,
          error: "User profile lacks valid bound Minecraft UUID format",
        };
      }
      if (typeof user.minecraftUsername !== "string") {
        return {
          valid: false,
          error: "User profile lacks valid string Minecraft username",
        };
      }
      const mcUsername = user.minecraftUsername.trim();
      if (
        !mcUsername ||
        mcUsername.toLowerCase() === "player" ||
        mcUsername.toLowerCase() === "account"
      ) {
        return {
          valid: false,
          error: "User profile lacks valid Minecraft username",
        };
      }
      if (
        user.minecraftAccessToken !== undefined &&
        typeof user.minecraftAccessToken !== "string"
      ) {
        return {
          valid: false,
          error:
            "User profile has malformed Minecraft access token (must be string)",
        };
      }
    }

    return { valid: true };
  }

  static isSessionOnlyMode(): boolean {
    return CredentialStore.detectStorageBackend() === "session_only";
  }

  static isPersistenceAvailable(): boolean {
    return CredentialStore.isPersistenceAvailable();
  }

  static getLastPersistenceError(): string | null {
    return CredentialStore.getLastPersistenceError();
  }

  static getLastCleanupError(): string | null {
    return CredentialStore.getLastCleanupError();
  }

  static getLastMigrationOutcome(): MigrationOutcome | null {
    return this.lastMigrationOutcome;
  }

  static getStorageStatus(): AuthStorageStatusDto {
    const backend = CredentialStore.detectStorageBackend();
    const persistenceAvailable = CredentialStore.isPersistenceAvailable();
    const hasActiveSession = Boolean(this.currentRecord);
    const sessionOnly =
      !persistenceAvailable ||
      (hasActiveSession && !this.isCurrentSessionPersisted);

    return {
      backend,
      sessionOnly,
      persistenceAvailable,
      sessionPersisted: hasActiveSession && this.isCurrentSessionPersisted,
      lastPersistenceError: this.getLastPersistenceError(),
      lastCleanupError: this.getLastCleanupError(),
    };
  }

  /**
   * Scoped refresh coalescing:
   * Keys pending refresh work strictly by (portalUrl + accountId + sessionEpoch).
   * New sessions with a different epoch or account do not inherit obsolete promises.
   */
  static getCoalescedRefresh(
    portalUrl: string,
    accountId: string,
    epoch: number,
    factory: () => Promise<{
      valid: boolean;
      user?: UserProfile;
      token?: string;
    }>,
  ): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const key = `${normalizePortalUrl(portalUrl)}::${accountId}::${epoch}`;
    const existing = this.refreshPromises.get(key);
    if (existing) {
      return existing;
    }

    let task!: Promise<{ valid: boolean; user?: UserProfile; token?: string }>;
    task = (async () => {
      try {
        return await factory();
      } finally {
        if (this.refreshPromises.get(key) === task) {
          this.refreshPromises.delete(key);
        }
      }
    })();

    this.refreshPromises.set(key, task);
    return task;
  }

  /**
   * Deterministic, Restart-Safe Migration State Machine:
   * 1. Inspect OS-encrypted store (CredentialStore).
   *    - If valid and origin matches: establish session.
   *    - If wrong origin: clear on-disk store, leave logged out.
   *    - If corrupted/invalid schema: clear corrupt store, mark failedProtectedLoad = true.
   * 2. ALWAYS inspect config.json for legacy plaintext credentials (even when protected record exists).
   *    - If protected record already loaded: scrub legacy plaintext immediately (protected record precedence).
   *    - If failedProtectedLoad = true: do NOT silently restore legacy plaintext! Scrub plaintext, fail closed.
   *    - If no protected record existed:
   *      - If legacy record is malformed, refresh-only (no token), or wrong origin: scrub plaintext, fail closed.
   *      - If legacy record is eligible and origin matches:
   *        - In session_only mode: load in memory, scrub plaintext.
   *        - In persistent mode: save to CredentialStore, verify read-back:
   *          - If verified: establish session, scrub plaintext.
   *          - If save or verify fails: clear CredentialStore, scrub plaintext, fail closed.
   * 3. Explicit cleanup outcomes returned; never leaves plaintext un-scrubbed.
   */
  static initialize(
    configPath: string,
    activePortalUrl: string,
  ): MigrationOutcome {
    if (this.initialized) {
      return (
        this.lastMigrationOutcome || {
          protectedLoaded: Boolean(this.currentRecord),
          failedProtectedLoad: false,
          legacyPlaintextDetected: false,
          legacyScrubbed: false,
          migrated: false,
        }
      );
    }
    this.initialized = true;

    const canonicalActivePortal = normalizePortalUrl(activePortalUrl);
    let protectedLoaded = false;
    let failedProtectedLoad = false;
    let legacyPlaintextDetected = false;
    let legacyScrubbed = false;
    let migrated = false;
    let outcomeError: string | undefined;

    // 1. Inspect existing protected record file
    const hadProtectedFile = CredentialStore.hasStoredCredentialsFile();
    if (hadProtectedFile) {
      const stored = CredentialStore.loadCredentials();
      if (stored) {
        if (stored.portalUrl === canonicalActivePortal) {
          this.currentRecord = stored;
          this.currentUser = {
            id: stored.portalAccountId || stored.accountId,
            name: stored.portalUsername || stored.accountUsername,
            minecraftUuid: stored.minecraftUuid,
            minecraftUsername:
              stored.minecraftUsername ||
              stored.accountUsername ||
              stored.portalUsername,
            isAdmin: false,
            isTech: false,
            roles: [],
            allowedChannels: [],
          };
          protectedLoaded = true;
          this.isCurrentSessionPersisted = true;
          LauncherLogger.info("[SessionManager] Restored protected session");
        } else {
          LauncherLogger.warn(
            `[SessionManager] Stored credentials origin '${stored.portalUrl}' does not match active portal '${canonicalActivePortal}'. Purging wrong-origin credentials.`,
          );
          CredentialStore.clearCredentials();
          this.isCurrentSessionPersisted = false;
          this.advanceSessionEpoch();
        }
      } else {
        // File existed but loadCredentials returned null -> decryption failed, invalid JSON, or schema invalid!
        failedProtectedLoad = true;
        this.isCurrentSessionPersisted = false;
        LauncherLogger.warn(
          "[SessionManager] Protected credential file existed but failed to load/decrypt. Treating as corrupt and purged.",
        );
      }
    }

    // 2. ALWAYS inspect config.json for legacy plaintext (never return before cleanup!)
    if (fs.existsSync(configPath)) {
      let raw: string | null = null;
      let parsed: any = null;

      try {
        raw = fs.readFileSync(configPath, "utf-8");
        parsed = JSON.parse(raw);
      } catch (parseErr: any) {
        parsed = null;
      }

      const hasPlaintextKeys = detectPlaintextSecretKeys(parsed, raw);

      if (hasPlaintextKeys) {
        legacyPlaintextDetected = true;

        let legacySessionPortal: string | null = null;
        if (
          parsed?.sessionPortalUrl &&
          typeof parsed.sessionPortalUrl === "string"
        ) {
          try {
            legacySessionPortal = normalizePortalUrl(parsed.sessionPortalUrl);
          } catch {
            legacySessionPortal = null;
          }
        }

        // Case A: Protected record already loaded -> protected record has precedence; scrub legacy plaintext
        if (protectedLoaded) {
          LauncherLogger.info(
            "[SessionManager] Both protected record and legacy plaintext existed. Scrubbing legacy plaintext (protected record takes precedence).",
          );
          const scrubResult = this.scrubPlaintextFromConfig(
            configPath,
            parsed,
            raw,
          );
          legacyScrubbed = scrubResult.success;
          if (!scrubResult.success) outcomeError = scrubResult.error;
        }
        // Case B: Protected record failed to load -> DO NOT silently restore legacy plaintext! Fail closed.
        else if (failedProtectedLoad) {
          LauncherLogger.warn(
            "[SessionManager] Protected record load failed; refusing to silently restore legacy plaintext. Scrubbing plaintext and requiring clean reauthentication.",
          );
          const scrubResult = this.scrubPlaintextFromConfig(
            configPath,
            parsed,
            raw,
          );
          legacyScrubbed = scrubResult.success;
          if (!scrubResult.success) outcomeError = scrubResult.error;
          this.advanceSessionEpoch();
        }
        // Case C: No protected record file existed -> evaluate legacy migration eligibility
        else {
          const rawAccountId = (
            parsed?.portalAccountId ||
            parsed?.accountId ||
            ""
          )
            .toString()
            .trim();
          const rawUsername = (
            parsed?.portalUsername ||
            parsed?.accountUsername ||
            ""
          )
            .toString()
            .trim();
          const hasTrustedAccountEvidence = Boolean(
            rawAccountId &&
            rawUsername &&
            rawAccountId.toLowerCase() !== "account" &&
            rawAccountId.toLowerCase() !== "unverified-migration" &&
            rawAccountId.toLowerCase() !== "player" &&
            rawUsername.toLowerCase() !== "player" &&
            rawUsername.toLowerCase() !== "account" &&
            rawUsername.toLowerCase() !== "unverified-migration",
          );
          const hasValidToken =
            typeof parsed?.token === "string" && parsed.token.trim().length > 0;
          const originMatches =
            legacySessionPortal !== null &&
            legacySessionPortal === canonicalActivePortal;

          if (!hasValidToken || !originMatches || !hasTrustedAccountEvidence) {
            LauncherLogger.warn(
              "[SessionManager] Ineligible or unverified legacy credentials found in config.json. Scrubbing plaintext from disk and requiring clean reauthentication.",
            );
            const scrubResult = this.scrubPlaintextFromConfig(
              configPath,
              parsed,
              raw,
            );
            legacyScrubbed = scrubResult.success;
            if (!scrubResult.success) outcomeError = scrubResult.error;
            this.advanceSessionEpoch();
          } else {
            // Eligible legacy credentials with verified account evidence
            const legacyRecord: StoredCredentialRecord = {
              version: 1,
              schemaVersion: 1,
              portalUrl: canonicalActivePortal,
              portalAccountId: rawAccountId,
              portalUsername: rawUsername,
              accountId: rawAccountId,
              accountUsername: rawUsername,
              token: parsed.token,
              refreshToken:
                typeof parsed.refreshToken === "string"
                  ? parsed.refreshToken
                  : undefined,
              minecraftAccessToken:
                typeof parsed.minecraftAccessToken === "string"
                  ? parsed.minecraftAccessToken
                  : undefined,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };

            if (this.isSessionOnlyMode()) {
              LauncherLogger.info(
                "[SessionManager] Migrating legacy credentials into session-only memory; scrubbing plaintext from disk.",
              );
              this.currentRecord = legacyRecord;
              this.isCurrentSessionPersisted = false;
              migrated = true;
              const scrubResult = this.scrubPlaintextFromConfig(
                configPath,
                parsed,
                raw,
              );
              legacyScrubbed = scrubResult.success;
              if (!scrubResult.success) outcomeError = scrubResult.error;
            } else {
              const saveResult = CredentialStore.saveCredentials(legacyRecord);
              if (saveResult.success) {
                const verified = CredentialStore.loadCredentials();
                if (verified && verified.token === legacyRecord.token) {
                  this.currentRecord = verified;
                  this.isCurrentSessionPersisted = true;
                  migrated = true;
                  LauncherLogger.info(
                    "[SessionManager] Successfully migrated legacy credentials to encrypted store. Scrubbing plaintext config.",
                  );
                } else {
                  LauncherLogger.warn(
                    "[SessionManager] Migration read-back verification failed. Requiring reauthentication.",
                  );
                  CredentialStore.clearCredentials();
                  this.isCurrentSessionPersisted = false;
                  this.advanceSessionEpoch();
                }
              } else {
                LauncherLogger.warn(
                  "[SessionManager] Migration encryption failed. Requiring reauthentication.",
                );
                this.isCurrentSessionPersisted = false;
                this.advanceSessionEpoch();
              }
              const scrubResult = this.scrubPlaintextFromConfig(
                configPath,
                parsed,
                raw,
              );
              legacyScrubbed = scrubResult.success;
              if (!scrubResult.success) outcomeError = scrubResult.error;
            }
          }
        }
      }
    }

    const outcome: MigrationOutcome = {
      protectedLoaded,
      failedProtectedLoad,
      legacyPlaintextDetected,
      legacyScrubbed,
      migrated,
      error: outcomeError,
    };
    this.lastMigrationOutcome = outcome;
    return outcome;
  }

  private static scrubPlaintextFromConfig(
    configPath: string,
    parsed: any,
    raw?: string | null,
  ): { success: boolean; error?: string } {
    try {
      const extracted: Record<string, any> = {};

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (!SECRET_KEYS_SET.has(k)) {
            extracted[k] = v;
          }
        }
      }

      if (raw && typeof raw === "string") {
        try {
          const jsoncParsed = jsonc.parse(raw);
          if (
            jsoncParsed &&
            typeof jsoncParsed === "object" &&
            !Array.isArray(jsoncParsed)
          ) {
            for (const [k, v] of Object.entries(jsoncParsed)) {
              if (!SECRET_KEYS_SET.has(k)) {
                extracted[k] = v;
              }
            }
          }
        } catch {}

        const kvRegex =
          /"((?:[^"\\]|\\.)*)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null|\[[^\]]*\]|\{[^}]*\})/g;
        let match: RegExpExecArray | null;
        while ((match = kvRegex.exec(raw)) !== null) {
          const decodedKey = decodeJsonStringToken(match[1]);
          if (!SECRET_KEYS_SET.has(decodedKey)) {
            try {
              extracted[decodedKey] = JSON.parse(match[2]);
            } catch {
              if (match[2].startsWith('"') && match[2].endsWith('"')) {
                extracted[decodedKey] = match[2].slice(1, -1);
              }
            }
          }
        }
      }

      // Format output: never write ambiguous raw text! Always write valid JSON.
      const scrubbedOutput =
        Object.keys(extracted).length > 0
          ? JSON.stringify(extracted, null, 2)
          : "{}\n";

      writeAtomicFileSync(configPath, scrubbedOutput, "utf-8");

      // Read-back verification to guarantee written file is valid JSON and contains zero secret keys
      try {
        const readBack = fs.readFileSync(configPath, "utf-8");
        const readParsed = JSON.parse(readBack);
        if (detectPlaintextSecretKeys(readParsed, readBack)) {
          writeAtomicFileSync(configPath, "{}\n", "utf-8");
        }
      } catch {
        writeAtomicFileSync(configPath, "{}\n", "utf-8");
      }

      LauncherLogger.info(
        "[SessionManager] Scrubbed plaintext credentials from config.json on disk.",
      );
      return { success: true };
    } catch (err: any) {
      LauncherLogger.error(
        `[SessionManager] Failed to scrub plaintext config: ${err.message}`,
      );
      return { success: false, error: err.message };
    }
  }

  /**
   * Main-only operation to establish newly authenticated credentials for a NEW session.
   * Atomic and synchronous. NEVER inherits optional tokens or account identities from prior sessions.
   */
  static establishNewSession(
    issuingOrigin: string,
    credentials: {
      token: string;
      refreshToken?: string;
      minecraftAccessToken?: string;
      portalAccountId?: string;
      portalUsername?: string;
      minecraftUuid?: string;
      minecraftUsername?: string;
    },
    user?: UserProfile,
  ): SaveCredentialsResult {
    const writeEpoch = ++this.sessionEpoch;
    this.refreshPromises.clear();
    const canonicalOrigin = normalizePortalUrl(issuingOrigin);

    const portalAccountId = (user?.id || credentials.portalAccountId || "")
      .toString()
      .trim();
    const portalUsername = (user?.name || credentials.portalUsername || "")
      .toString()
      .trim();
    const token = (credentials.token || "").toString().trim();

    // Reject invalid authentication data before publication
    if (
      !token ||
      !portalAccountId ||
      !portalUsername ||
      portalAccountId.toLowerCase() === "account" ||
      portalAccountId.toLowerCase() === "unverified-migration" ||
      portalAccountId.toLowerCase() === "player" ||
      portalUsername.toLowerCase() === "player" ||
      portalUsername.toLowerCase() === "account" ||
      portalUsername.toLowerCase() === "unverified-migration"
    ) {
      throw new Error(
        "Invalid authentication data: token, portalAccountId, and portalUsername are required and cannot be placeholders",
      );
    }

    const minecraftUuid = user?.minecraftUuid || credentials.minecraftUuid;
    const minecraftUsername =
      user?.minecraftUsername || credentials.minecraftUsername;

    // If an older record exists for a different account, clear disk first to prevent resurrection
    if (
      this.currentRecord &&
      this.currentRecord.portalAccountId !== portalAccountId
    ) {
      CredentialStore.clearCredentials();
    }

    const record: StoredCredentialRecord = {
      version: 1,
      schemaVersion: 1,
      portalUrl: canonicalOrigin,
      portalAccountId,
      portalUsername,
      minecraftUuid,
      minecraftUsername,
      accountId: portalAccountId,
      accountUsername: portalUsername,
      token,
      refreshToken: credentials.refreshToken, // Strictly from new login, NEVER inherited!
      minecraftAccessToken:
        credentials.minecraftAccessToken || user?.minecraftAccessToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 1. Complete candidate session validation BEFORE any publication or mutation of currentUser
    const candidateValidation = this.validateCandidateSession(record, user);
    if (!candidateValidation.valid) {
      throw new Error(
        `Invalid authentication data: ${candidateValidation.error}`,
      );
    }

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn(
        "[SessionManager] Aborted credential write: session epoch advanced before write started.",
      );
      return {
        success: false,
        backend: CredentialStore.detectStorageBackend(),
        sessionOnly: false,
        error: "Session epoch invalidated before write",
      };
    }

    const saveResult = CredentialStore.saveCredentials(record);

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn(
        "[SessionManager] Discarding credential write: session epoch advanced during write. Rolling back disk store.",
      );
      CredentialStore.clearCredentials();
      this.isCurrentSessionPersisted = false;
      return {
        success: false,
        backend: saveResult.backend,
        sessionOnly: false,
        error: "Session epoch invalidated during write",
      };
    }

    if (
      !saveResult.success &&
      saveResult.error === "Invalid credential record schema"
    ) {
      throw new Error(
        "Invalid authentication data: credential store rejected schema",
      );
    }

    if (saveResult.sessionOnly || !saveResult.success) {
      // Invalidate existing disk credentials independently of currentRecord
      const clearResult = CredentialStore.clearCredentials();
      if (!clearResult.durablyInvalidated) {
        this.advanceSessionEpoch();
        throw new Error(
          `Failed to sanitize disk credentials: stale credentials could not be deleted or durably invalidated (${clearResult.error || "durable invalidation failed"})`,
        );
      }
      this.isCurrentSessionPersisted = false;
      if (!saveResult.success) {
        LauncherLogger.warn(
          `[SessionManager] Persistence failed (${saveResult.error}); operating in session-only mode for this session.`,
        );
      }
    } else {
      this.isCurrentSessionPersisted = true;
    }

    this.currentRecord = record;
    if (user) {
      this.currentUser = user;
    }
    this.notifySessionChange(this.getCredentials());
    return saveResult;
  }

  /**
   * Main-only operation to update credentials for an existing verified session from same-account token refresh.
   * Retains omitted tokens ONLY for an explicitly verified refresh of the same account and origin.
   */
  static updateSessionFromRefresh(
    issuingOrigin: string,
    refreshedTokens: {
      token: string;
      refreshToken?: string;
      minecraftAccessToken?: string;
    },
    user?: UserProfile,
  ): SaveCredentialsResult {
    const writeEpoch = ++this.sessionEpoch;
    this.refreshPromises.clear();
    const canonicalOrigin = normalizePortalUrl(issuingOrigin);

    if (!this.currentRecord) {
      throw new Error("Cannot refresh session: no active session exists");
    }

    if (this.currentRecord.portalUrl !== canonicalOrigin) {
      throw new Error(
        `Cannot refresh session: origin mismatch ('${this.currentRecord.portalUrl}' vs '${canonicalOrigin}')`,
      );
    }

    const token = (refreshedTokens.token || "").toString().trim();
    if (!token) {
      throw new Error(
        "Cannot refresh session: valid non-empty token is required",
      );
    }

    if (
      user &&
      this.currentRecord.portalAccountId &&
      this.currentRecord.portalAccountId !== "account" &&
      this.currentRecord.portalAccountId !== "unverified-migration" &&
      !this.currentRecord.portalAccountId.startsWith("config-account-") &&
      !this.currentRecord.portalAccountId.startsWith("session-account-") &&
      user.id &&
      this.currentRecord.portalAccountId !== user.id
    ) {
      throw new Error("Cannot refresh session: account identity mismatch");
    }

    if (
      user &&
      this.currentRecord.minecraftUuid &&
      this.currentRecord.minecraftUuid !==
        "00000000-0000-0000-0000-000000000000" &&
      user.minecraftUuid &&
      this.currentRecord.minecraftUuid !== user.minecraftUuid
    ) {
      throw new Error("Cannot refresh session: Minecraft UUID mismatch");
    }

    const record: StoredCredentialRecord = {
      ...this.currentRecord,
      version: 1,
      schemaVersion: 1,
      portalUrl: canonicalOrigin,
      token,
      // Retain omitted refresh token ONLY on same-account refresh
      refreshToken:
        refreshedTokens.refreshToken ?? this.currentRecord.refreshToken,
      minecraftAccessToken:
        refreshedTokens.minecraftAccessToken ??
        user?.minecraftAccessToken ??
        this.currentRecord.minecraftAccessToken,
      updatedAt: Date.now(),
    };

    if (user) {
      if (user.id) record.portalAccountId = user.id;
      if (user.name) record.portalUsername = user.name;
      if (user.minecraftUuid) record.minecraftUuid = user.minecraftUuid;
      if (user.minecraftUsername)
        record.minecraftUsername = user.minecraftUsername;
      record.accountId = record.portalAccountId || record.accountId;
      record.accountUsername = record.portalUsername || record.accountUsername;
    }

    // 1. Complete candidate session validation BEFORE any publication or mutation of currentUser
    const candidateValidation = this.validateCandidateSession(record, user);
    if (!candidateValidation.valid) {
      throw new Error(
        `Invalid authentication data on refresh: ${candidateValidation.error}`,
      );
    }

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn(
        "[SessionManager] Aborted token refresh commit: session epoch advanced before write.",
      );
      return {
        success: false,
        backend: CredentialStore.detectStorageBackend(),
        sessionOnly: false,
        error: "Session epoch invalidated before write",
      };
    }

    const saveResult = CredentialStore.saveCredentials(record);

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn(
        "[SessionManager] Discarding refreshed credentials: epoch advanced during write.",
      );
      CredentialStore.clearCredentials();
      this.isCurrentSessionPersisted = false;
      return {
        success: false,
        backend: saveResult.backend,
        sessionOnly: false,
        error: "Session epoch invalidated during write",
      };
    }

    if (
      !saveResult.success &&
      saveResult.error === "Invalid credential record schema"
    ) {
      throw new Error(
        "Invalid authentication data: credential store rejected schema",
      );
    }

    if (saveResult.sessionOnly || !saveResult.success) {
      const clearResult = CredentialStore.clearCredentials();
      if (!clearResult.durablyInvalidated) {
        this.advanceSessionEpoch();
        throw new Error(
          `Failed to sanitize disk credentials on refresh: stale credentials could not be deleted or durably invalidated (${clearResult.error || "durable invalidation failed"})`,
        );
      }
      this.isCurrentSessionPersisted = false;
      if (!saveResult.success) {
        LauncherLogger.warn(
          `[SessionManager] Failed to persist refreshed credentials (${saveResult.error}); continuing in session-only mode.`,
        );
      }
    } else {
      this.isCurrentSessionPersisted = true;
    }

    this.currentRecord = record;
    if (user) {
      this.currentUser = user;
    }
    this.notifySessionChange(this.getCredentials());
    return saveResult;
  }

  /**
   * Transitional adapter preserving backward compatibility with callers of establishSession.
   */
  static establishSession(
    issuingOrigin: string,
    credentials: {
      token: string;
      refreshToken?: string;
      minecraftAccessToken?: string;
      portalAccountId?: string;
      portalUsername?: string;
    },
    user?: UserProfile,
  ): SaveCredentialsResult {
    const canonicalOrigin = normalizePortalUrl(issuingOrigin);
    const incomingAccountId = user?.id || credentials.portalAccountId;

    if (
      this.currentRecord &&
      this.currentRecord.portalUrl === canonicalOrigin &&
      (!incomingAccountId ||
        incomingAccountId === this.currentRecord.portalAccountId)
    ) {
      return this.updateSessionFromRefresh(issuingOrigin, credentials, user);
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(credentials.token || "")
      .digest("hex")
      .slice(0, 10);
    const adaptedCreds = {
      ...credentials,
      portalAccountId:
        credentials.portalAccountId ||
        user?.id ||
        `session-account-${tokenHash}`,
      portalUsername:
        credentials.portalUsername ||
        user?.name ||
        `SessionUser-${tokenHash.slice(0, 4)}`,
    };

    return this.establishNewSession(issuingOrigin, adaptedCreds, user);
  }

  /**
   * Main-only operation to clear the active authenticated session.
   * Advances session epoch immediately to invalidate all pending network work,
   * clears in-memory state, and unlinks persistent credentials on disk.
   * Returns explicit ClearCredentialsResult.
   */
  static clearSession(): ClearCredentialsResult {
    this.advanceSessionEpoch();
    this.activeLoginEpoch++;
    this.currentRecord = null;
    this.currentUser = null;
    this.isCurrentSessionPersisted = false;

    const clearResult = CredentialStore.clearCredentials();
    this.notifySessionChange(null);
    LauncherLogger.info(
      "[SessionManager] Session cleared from memory and persistent store.",
    );
    return clearResult;
  }

  /**
   * Called when active portal origin is changed in settings.
   * Advances session epoch and invalidates active session if bound to a different origin.
   */
  static onPortalUrlChanged(newPortalUrl: string): void {
    const nextCanonical = normalizePortalUrl(newPortalUrl);
    this.advanceSessionEpoch();
    if (this.currentRecord && this.currentRecord.portalUrl !== nextCanonical) {
      LauncherLogger.info(
        `[SessionManager] Portal origin changed from '${this.currentRecord.portalUrl}' to '${nextCanonical}'. Clearing old session.`,
      );
      this.clearSession();
    }
  }

  static resetForTesting(): void {
    this.sessionEpoch = 1;
    this.currentRecord = null;
    this.currentUser = null;
    this.isCurrentSessionPersisted = false;
    this.activeLoginEpoch = 0;
    this.refreshPromises.clear();
    this.initialized = false;
    this.lastMigrationOutcome = null;
  }
}
