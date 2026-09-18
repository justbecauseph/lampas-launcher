import * as fs from "node:fs";
import { CredentialStore, type StoredCredentialRecord, type SaveCredentialsResult, type ClearCredentialsResult, type StorageBackendType } from "./credential-store";
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

export class SessionManager {
  private static sessionEpoch: number = 1;
  private static currentRecord: StoredCredentialRecord | null = null;
  private static currentUser: UserProfile | null = null;
  private static activeLoginEpoch: number = 0;
  private static refreshPromises = new Map<string, Promise<{ valid: boolean; user?: UserProfile; token?: string }>>();
  private static initialized: boolean = false;
  private static lastMigrationOutcome: MigrationOutcome | null = null;
  private static sessionListeners: Array<(creds: SessionCredentials | null) => void> = [];

  static addSessionListener(listener: (creds: SessionCredentials | null) => void): () => void {
    this.sessionListeners.push(listener);
    return () => {
      this.sessionListeners = this.sessionListeners.filter((l) => l !== listener);
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
    if (user && this.currentRecord) {
      const existingPortalId = this.currentRecord.portalAccountId;
      const existingMcUuid = this.currentRecord.minecraftUuid;

      if (
        existingPortalId &&
        existingPortalId !== "account" &&
        existingPortalId !== "unverified-migration" &&
        user.id &&
        existingPortalId !== user.id
      ) {
        throw new Error(
          `Cannot relabel credentials: active session belongs to portal user ${existingPortalId}, not ${user.id}`
        );
      }

      if (
        existingMcUuid &&
        existingMcUuid !== "00000000-0000-0000-0000-000000000000" &&
        user.minecraftUuid &&
        existingMcUuid !== user.minecraftUuid
      ) {
        throw new Error(
          `Cannot relabel credentials: active session belongs to Minecraft UUID ${existingMcUuid}, not ${user.minecraftUuid}`
        );
      }

      this.currentUser = user;
      if (user.id) this.currentRecord.portalAccountId = user.id;
      if (user.name) this.currentRecord.portalUsername = user.name;
      if (user.minecraftUuid) this.currentRecord.minecraftUuid = user.minecraftUuid;
      if (user.minecraftUsername) this.currentRecord.minecraftUsername = user.minecraftUsername;
      this.currentRecord.accountId = this.currentRecord.portalAccountId || this.currentRecord.accountId;
      this.currentRecord.accountUsername = this.currentRecord.portalUsername || this.currentRecord.accountUsername;
    } else {
      this.currentUser = user;
    }
  }

  static isSessionOnlyMode(): boolean {
    return CredentialStore.detectStorageBackend() === "session_only";
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
    return {
      backend: CredentialStore.detectStorageBackend(),
      sessionOnly: this.isSessionOnlyMode(),
      persistenceAvailable: CredentialStore.isPersistenceAvailable(),
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
    factory: () => Promise<{ valid: boolean; user?: UserProfile; token?: string }>
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
  static initialize(configPath: string, activePortalUrl: string): MigrationOutcome {
    if (this.initialized) {
      return this.lastMigrationOutcome || {
        protectedLoaded: Boolean(this.currentRecord),
        failedProtectedLoad: false,
        legacyPlaintextDetected: false,
        legacyScrubbed: false,
        migrated: false,
      };
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
            minecraftUuid: stored.minecraftUuid || stored.accountId,
            minecraftUsername: stored.minecraftUsername || stored.accountUsername,
            isAdmin: false,
            isTech: false,
            roles: [],
            allowedChannels: [],
          };
          protectedLoaded = true;
          LauncherLogger.info(`[SessionManager] Restored protected session for ${stored.accountUsername} on ${stored.portalUrl}`);
        } else {
          LauncherLogger.warn(`[SessionManager] Stored credentials origin '${stored.portalUrl}' does not match active portal '${canonicalActivePortal}'. Purging wrong-origin credentials.`);
          CredentialStore.clearCredentials();
          this.advanceSessionEpoch();
        }
      } else {
        // File existed but loadCredentials returned null -> decryption failed, invalid JSON, or schema invalid!
        failedProtectedLoad = true;
        LauncherLogger.warn("[SessionManager] Protected credential file existed but failed to load/decrypt. Treating as corrupt and purged.");
      }
    }

    // 2. ALWAYS inspect config.json for legacy plaintext (never return before cleanup!)
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);

        if (parsed.token || parsed.refreshToken || parsed.minecraftAccessToken || parsed.sessionPortalUrl) {
          legacyPlaintextDetected = true;
          const legacySessionPortal = parsed.sessionPortalUrl ? normalizePortalUrl(parsed.sessionPortalUrl) : null;

          // Case A: Protected record already loaded -> protected record has precedence; scrub legacy plaintext
          if (protectedLoaded) {
            LauncherLogger.info("[SessionManager] Both protected record and legacy plaintext existed. Scrubbing legacy plaintext (protected record takes precedence).");
            const scrubResult = this.scrubPlaintextFromConfig(configPath, parsed);
            legacyScrubbed = scrubResult.success;
            if (!scrubResult.success) outcomeError = scrubResult.error;
          }
          // Case B: Protected record failed to load -> DO NOT silently restore legacy plaintext! Fail closed.
          else if (failedProtectedLoad) {
            LauncherLogger.warn("[SessionManager] Protected record load failed; refusing to silently restore legacy plaintext. Scrubbing plaintext and requiring clean reauthentication.");
            const scrubResult = this.scrubPlaintextFromConfig(configPath, parsed);
            legacyScrubbed = scrubResult.success;
            if (!scrubResult.success) outcomeError = scrubResult.error;
            this.advanceSessionEpoch();
          }
          // Case C: No protected record file existed -> evaluate legacy migration eligibility
          else {
            const rawAccountId = (parsed.portalAccountId || parsed.accountId || "").toString().trim();
            const rawUsername = (parsed.portalUsername || parsed.accountUsername || "").toString().trim();
            const hasTrustedAccountEvidence = Boolean(rawAccountId && rawUsername);
            const hasValidToken = typeof parsed.token === "string" && parsed.token.trim().length > 0;
            const originMatches = legacySessionPortal === canonicalActivePortal;

            if (!hasValidToken || !originMatches || !hasTrustedAccountEvidence) {
              LauncherLogger.warn("[SessionManager] Ineligible or unverified legacy credentials found in config.json. Scrubbing plaintext from disk and requiring clean reauthentication.");
              const scrubResult = this.scrubPlaintextFromConfig(configPath, parsed);
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
                refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
                minecraftAccessToken: typeof parsed.minecraftAccessToken === "string" ? parsed.minecraftAccessToken : undefined,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };

              if (this.isSessionOnlyMode()) {
                LauncherLogger.info("[SessionManager] Migrating legacy credentials into session-only memory; scrubbing plaintext from disk.");
                this.currentRecord = legacyRecord;
                migrated = true;
                const scrubResult = this.scrubPlaintextFromConfig(configPath, parsed);
                legacyScrubbed = scrubResult.success;
                if (!scrubResult.success) outcomeError = scrubResult.error;
              } else {
                const saveResult = CredentialStore.saveCredentials(legacyRecord);
                if (saveResult.success) {
                  const verified = CredentialStore.loadCredentials();
                  if (verified && verified.token === legacyRecord.token) {
                    this.currentRecord = verified;
                    migrated = true;
                    LauncherLogger.info("[SessionManager] Successfully migrated legacy credentials to encrypted store. Scrubbing plaintext config.");
                  } else {
                    LauncherLogger.warn("[SessionManager] Migration read-back verification failed. Requiring reauthentication.");
                    CredentialStore.clearCredentials();
                    this.advanceSessionEpoch();
                  }
                } else {
                  LauncherLogger.warn("[SessionManager] Migration encryption failed. Requiring reauthentication.");
                  this.advanceSessionEpoch();
                }
                const scrubResult = this.scrubPlaintextFromConfig(configPath, parsed);
                legacyScrubbed = scrubResult.success;
                if (!scrubResult.success) outcomeError = scrubResult.error;
              }
            }
          }
        }
      } catch (err: any) {
        LauncherLogger.error(`[SessionManager] Error during legacy config inspection: ${err.message}`);
        outcomeError = err.message;
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

  private static scrubPlaintextFromConfig(configPath: string, parsed: any): { success: boolean; error?: string } {
    try {
      const scrubbed = { ...parsed };
      delete scrubbed.token;
      delete scrubbed.refreshToken;
      delete scrubbed.minecraftAccessToken;
      delete scrubbed.sessionPortalUrl;
      writeAtomicFileSync(configPath, JSON.stringify(scrubbed, null, 2), "utf-8");
      LauncherLogger.info("[SessionManager] Scrubbed plaintext credentials from config.json on disk.");
      return { success: true };
    } catch (err: any) {
      LauncherLogger.error(`[SessionManager] Failed to scrub plaintext config: ${err.message}`);
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
    user?: UserProfile
  ): SaveCredentialsResult {
    const writeEpoch = ++this.sessionEpoch;
    this.refreshPromises.clear();
    const canonicalOrigin = normalizePortalUrl(issuingOrigin);

    const portalAccountId = (user?.id || credentials.portalAccountId || "account").toString().trim();
    const portalUsername = (user?.name || credentials.portalUsername || "player").toString().trim();
    const minecraftUuid = user?.minecraftUuid || credentials.minecraftUuid;
    const minecraftUsername = user?.minecraftUsername || credentials.minecraftUsername;

    // If an older record exists for a different account, clear disk first to prevent resurrection
    if (this.currentRecord && this.currentRecord.portalAccountId !== portalAccountId) {
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
      token: credentials.token,
      refreshToken: credentials.refreshToken, // Strictly from new login, NEVER inherited!
      minecraftAccessToken: credentials.minecraftAccessToken || user?.minecraftAccessToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn("[SessionManager] Aborted credential write: session epoch advanced before write started.");
      return {
        success: false,
        backend: CredentialStore.detectStorageBackend(),
        sessionOnly: false,
        error: "Session epoch invalidated before write",
      };
    }

    const saveResult = CredentialStore.saveCredentials(record);

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn("[SessionManager] Discarding credential write: session epoch advanced during write. Rolling back disk store.");
      CredentialStore.clearCredentials();
      return {
        success: false,
        backend: saveResult.backend,
        sessionOnly: false,
        error: "Session epoch invalidated during write",
      };
    }

    if (!saveResult.success) {
      // Persistence failed when persistence was expected:
      // Clear disk credentials immediately to prevent stale record resurrecting
      const clearResult = CredentialStore.clearCredentials();
      if (!clearResult.success) {
        // Disk cleanup failed: fail login completely because old record would resurrect on restart!
        throw new Error(`Persistence failure and could not sanitize disk credentials: ${saveResult.error}`);
      }
      // Disk was safely sanitized; downgrade this session to in-memory session_only
      LauncherLogger.warn(`[SessionManager] Persistence failed (${saveResult.error}); operating in session-only mode for this session.`);
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
    user?: UserProfile
  ): SaveCredentialsResult {
    const writeEpoch = ++this.sessionEpoch;
    this.refreshPromises.clear();
    const canonicalOrigin = normalizePortalUrl(issuingOrigin);

    if (!this.currentRecord) {
      throw new Error("Cannot refresh session: no active session exists");
    }

    if (this.currentRecord.portalUrl !== canonicalOrigin) {
      throw new Error(`Cannot refresh session: origin mismatch ('${this.currentRecord.portalUrl}' vs '${canonicalOrigin}')`);
    }

    if (
      user &&
      this.currentRecord.portalAccountId &&
      this.currentRecord.portalAccountId !== "account" &&
      this.currentRecord.portalAccountId !== "unverified-migration" &&
      user.id &&
      this.currentRecord.portalAccountId !== user.id
    ) {
      throw new Error("Cannot refresh session: account identity mismatch");
    }

    if (
      user &&
      this.currentRecord.minecraftUuid &&
      this.currentRecord.minecraftUuid !== "00000000-0000-0000-0000-000000000000" &&
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
      token: refreshedTokens.token,
      // Retain omitted refresh token ONLY on same-account refresh
      refreshToken: refreshedTokens.refreshToken ?? this.currentRecord.refreshToken,
      minecraftAccessToken: refreshedTokens.minecraftAccessToken ?? user?.minecraftAccessToken ?? this.currentRecord.minecraftAccessToken,
      updatedAt: Date.now(),
    };

    if (user) {
      if (user.id) record.portalAccountId = user.id;
      if (user.name) record.portalUsername = user.name;
      if (user.minecraftUuid) record.minecraftUuid = user.minecraftUuid;
      if (user.minecraftUsername) record.minecraftUsername = user.minecraftUsername;
      record.accountId = record.portalAccountId || record.accountId;
      record.accountUsername = record.portalUsername || record.accountUsername;
      this.currentUser = user;
    }

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn("[SessionManager] Aborted refresh write: session epoch advanced before write started.");
      return {
        success: false,
        backend: CredentialStore.detectStorageBackend(),
        sessionOnly: false,
        error: "Session epoch invalidated before refresh write",
      };
    }

    const saveResult = CredentialStore.saveCredentials(record);

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn("[SessionManager] Discarding refresh write: session epoch advanced during write. Rolling back disk store.");
      CredentialStore.clearCredentials();
      return {
        success: false,
        backend: saveResult.backend,
        sessionOnly: false,
        error: "Session epoch invalidated during refresh write",
      };
    }

    if (!saveResult.success) {
      CredentialStore.clearCredentials();
      LauncherLogger.warn(`[SessionManager] Refresh persistence failed (${saveResult.error}); operating in session-only mode for this session.`);
    }

    this.currentRecord = record;
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
    user?: UserProfile
  ): SaveCredentialsResult {
    const canonicalOrigin = normalizePortalUrl(issuingOrigin);
    const incomingAccountId = user?.id || credentials.portalAccountId;

    if (
      this.currentRecord &&
      this.currentRecord.portalUrl === canonicalOrigin &&
      (!incomingAccountId || incomingAccountId === this.currentRecord.portalAccountId)
    ) {
      return this.updateSessionFromRefresh(issuingOrigin, credentials, user);
    }

    return this.establishNewSession(issuingOrigin, credentials, user);
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

    const clearResult = CredentialStore.clearCredentials();
    this.notifySessionChange(null);
    LauncherLogger.info("[SessionManager] Session cleared from memory and persistent store.");
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
      LauncherLogger.info(`[SessionManager] Portal origin changed from '${this.currentRecord.portalUrl}' to '${nextCanonical}'. Clearing old session.`);
      this.clearSession();
    }
  }

  static resetForTesting(): void {
    this.sessionEpoch = 1;
    this.currentRecord = null;
    this.currentUser = null;
    this.activeLoginEpoch = 0;
    this.refreshPromises.clear();
    this.initialized = false;
    this.lastMigrationOutcome = null;
  }
}
