import * as fs from "node:fs";
import * as path from "node:path";
import { CredentialStore, type StoredCredentialRecord } from "./credential-store";
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

export class SessionManager {
  private static sessionEpoch: number = 1;
  private static currentRecord: StoredCredentialRecord | null = null;
  private static currentUser: UserProfile | null = null;
  private static activeLoginEpoch: number = 0;
  private static activeRefreshPromise: Promise<{ valid: boolean; user?: UserProfile; token?: string }> | null = null;
  private static initialized: boolean = false;
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

  static getCurrentUser(): UserProfile | null {
    return this.currentUser;
  }

  static setCurrentUser(user: UserProfile | null): void {
    this.currentUser = user;
    if (user && this.currentRecord) {
      this.currentRecord.accountId = user.minecraftUuid || user.id || this.currentRecord.accountId;
      this.currentRecord.accountUsername = user.minecraftUsername || user.name || this.currentRecord.accountUsername;
    }
  }

  static isSessionOnlyMode(): boolean {
    return CredentialStore.detectStorageBackend() === "session_only";
  }

  static getActiveRefreshPromise(): Promise<{ valid: boolean; user?: UserProfile; token?: string }> | null {
    return this.activeRefreshPromise;
  }

  static setActiveRefreshPromise(promise: Promise<{ valid: boolean; user?: UserProfile; token?: string }> | null): void {
    this.activeRefreshPromise = promise;
  }

  /**
   * Initializes session manager and performs migration of legacy plaintext credentials from config.json.
   * State Machine:
   * 1. Try to load OS-encrypted credentials from CredentialStore.
   *    - If valid and portal matches: establish session.
   *    - If wrong origin: clear on-disk store, leave logged out.
   * 2. Inspect config.json for legacy plaintext tokens.
   *    - If missing or unassigned origin: scrub from disk immediately (fail closed, require reauth).
   *    - If origin matches active portal:
   *      - If storage is session_only: load into memory for this session, scrub plaintext from disk.
   *      - If storage is secure: encrypt and write to CredentialStore, verify round-trip, then scrub plaintext from disk.
   */
  static initialize(configPath: string, activePortalUrl: string): void {
    if (this.initialized) return;
    this.initialized = true;

    const canonicalActivePortal = normalizePortalUrl(activePortalUrl);

    // 1. Try loading existing protected credentials
    const stored = CredentialStore.loadCredentials();
    if (stored) {
      if (stored.portalUrl === canonicalActivePortal) {
        this.currentRecord = stored;
        this.currentUser = {
          id: stored.accountId,
          name: stored.accountUsername,
          minecraftUuid: stored.accountId,
          minecraftUsername: stored.accountUsername,
          isAdmin: false,
          isTech: false,
          roles: [],
          allowedChannels: [],
        };
        LauncherLogger.info(`[SessionManager] Restored protected session for ${stored.accountUsername} on ${stored.portalUrl}`);
        return;
      } else {
        LauncherLogger.warn(`[SessionManager] Stored credentials origin '${stored.portalUrl}' does not match active portal '${canonicalActivePortal}'. Purging wrong-origin credentials.`);
        CredentialStore.clearCredentials();
        this.advanceSessionEpoch();
      }
    }

    // 2. Check for legacy plaintext credentials in config.json
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);

        if (parsed.token || parsed.refreshToken || parsed.minecraftAccessToken) {
          const legacySessionPortal = parsed.sessionPortalUrl ? normalizePortalUrl(parsed.sessionPortalUrl) : null;

          // Unknown-origin legacy credentials remain ineligible and require reauthentication
          if (!legacySessionPortal || legacySessionPortal !== canonicalActivePortal) {
            LauncherLogger.warn("[SessionManager] Ineligible legacy credentials found in config.json (unknown or mismatched origin). Scrubbing plaintext from disk.");
            this.scrubPlaintextFromConfig(configPath, parsed);
            this.advanceSessionEpoch();
            return;
          }

          // Legacy credentials have matching origin binding
          if (this.isSessionOnlyMode()) {
            LauncherLogger.info("[SessionManager] Migrating legacy credentials into session-only memory; scrubbing plaintext from disk.");
            this.currentRecord = {
              version: 1,
              portalUrl: canonicalActivePortal,
              accountId: "migrated-account",
              accountUsername: "migrated-user",
              token: parsed.token,
              refreshToken: parsed.refreshToken,
              minecraftAccessToken: parsed.minecraftAccessToken,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            this.scrubPlaintextFromConfig(configPath, parsed);
          } else {
            // Attempt secure persistence
            const record: StoredCredentialRecord = {
              version: 1,
              portalUrl: canonicalActivePortal,
              accountId: "migrated-account",
              accountUsername: "migrated-user",
              token: parsed.token,
              refreshToken: parsed.refreshToken,
              minecraftAccessToken: parsed.minecraftAccessToken,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };

            const saveResult = CredentialStore.saveCredentials(record);
            if (saveResult.success) {
              // Verify read back
              const verified = CredentialStore.loadCredentials();
              if (verified && verified.token === record.token) {
                this.currentRecord = verified;
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

            // Always scrub plaintext from disk regardless of migration outcome
            this.scrubPlaintextFromConfig(configPath, parsed);
          }
        }
      } catch (err: any) {
        LauncherLogger.error(`[SessionManager] Error during legacy config inspection: ${err.message}`);
      }
    }
  }

  private static scrubPlaintextFromConfig(configPath: string, parsed: any): void {
    try {
      const scrubbed = { ...parsed };
      delete scrubbed.token;
      delete scrubbed.refreshToken;
      delete scrubbed.minecraftAccessToken;
      delete scrubbed.sessionPortalUrl;
      writeAtomicFileSync(configPath, JSON.stringify(scrubbed, null, 2), "utf-8");
      LauncherLogger.info("[SessionManager] Scrubbed plaintext credentials from config.json on disk.");
    } catch (err: any) {
      LauncherLogger.error(`[SessionManager] Failed to scrub plaintext config: ${err.message}`);
    }
  }

  /**
   * Main-only operation to establish newly authenticated credentials.
   * Atomic and synchronous to guarantee that callers immediately observe established state.
   */
  static establishSession(
    issuingOrigin: string,
    credentials: { token: string; refreshToken?: string; minecraftAccessToken?: string },
    user?: UserProfile
  ): void {
    const writeEpoch = ++this.sessionEpoch;
    const canonicalOrigin = normalizePortalUrl(issuingOrigin);

    const record: StoredCredentialRecord = {
      version: 1,
      portalUrl: canonicalOrigin,
      accountId: user?.minecraftUuid || user?.id || (this.currentRecord?.accountId || "account"),
      accountUsername: user?.minecraftUsername || user?.name || (this.currentRecord?.accountUsername || "player"),
      token: credentials.token,
      refreshToken: credentials.refreshToken || this.currentRecord?.refreshToken,
      minecraftAccessToken: credentials.minecraftAccessToken || user?.minecraftAccessToken || this.currentRecord?.minecraftAccessToken,
      createdAt: this.currentRecord?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn("[SessionManager] Aborted credential write: session epoch advanced before write started.");
      return;
    }

    CredentialStore.saveCredentials(record);

    if (this.sessionEpoch !== writeEpoch) {
      LauncherLogger.warn("[SessionManager] Discarding credential write: session epoch advanced during write. Rolling back disk store.");
      CredentialStore.clearCredentials();
      return;
    }

    this.currentRecord = record;
    if (user) {
      this.currentUser = user;
    }
    this.notifySessionChange(this.getCredentials());
  }

  /**
   * Main-only operation to clear the active authenticated session.
   * Advances session epoch immediately to invalidate all pending network work,
   * clears in-memory state, and unlinks persistent credentials on disk.
   */
  static clearSession(): void {
    this.advanceSessionEpoch();
    this.activeLoginEpoch++;
    this.currentRecord = null;
    this.currentUser = null;
    this.activeRefreshPromise = null;

    CredentialStore.clearCredentials();
    this.notifySessionChange(null);
    LauncherLogger.info("[SessionManager] Session cleared from memory and persistent store.");
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
    this.activeRefreshPromise = null;
    this.initialized = false;
  }
}
