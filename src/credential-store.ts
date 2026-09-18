import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as electron from "electron";
const electronSafeStorage = (electron as any)?.safeStorage;
import { getUserDataDir } from "./config";
import { normalizePortalUrl } from "./portal-policy";
import { LauncherLogger } from "./logger";

export interface StoredCredentialRecord {
  version: 1;
  schemaVersion?: 1;
  portalUrl: string;
  portalAccountId?: string;
  portalUsername?: string;
  minecraftUuid?: string;
  minecraftUsername?: string;
  // Aliases for compatibility
  accountId: string;
  accountUsername: string;
  token: string;
  refreshToken?: string;
  minecraftAccessToken?: string;
  createdAt: number;
  updatedAt: number;
}

export type StorageBackendType = "windows_dpapi" | "linux_keyring" | "session_only";

export interface SaveCredentialsResult {
  success: boolean;
  backend: StorageBackendType;
  sessionOnly: boolean;
  error?: string;
}

export interface ClearCredentialsResult {
  success: boolean;
  error?: string;
  deletedTarget: boolean;
  deletedTemp: boolean;
}

export class CredentialStore {
  private static mockSafeStorage: Electron.SafeStorage | null = null;
  private static customUserDataDir: string | null = null;
  private static lastPersistenceError: string | null = null;
  private static lastCleanupError: string | null = null;

  static setSafeStorageMockForTesting(mock: Electron.SafeStorage | null): void {
    this.mockSafeStorage = mock;
  }

  static setCustomUserDataDirForTesting(customDir: string | null): void {
    this.customUserDataDir = customDir;
  }

  static resetForTesting(): void {
    this.mockSafeStorage = null;
    this.customUserDataDir = null;
    this.lastPersistenceError = null;
    this.lastCleanupError = null;
  }

  static getLastPersistenceError(): string | null {
    return this.lastPersistenceError;
  }

  static getLastCleanupError(): string | null {
    return this.lastCleanupError;
  }

  private static getActiveSafeStorage(): Electron.SafeStorage | null {
    if (this.mockSafeStorage) {
      return this.mockSafeStorage;
    }
    const currentElectron = electron as any;
    if (currentElectron?.safeStorage) {
      return currentElectron.safeStorage;
    }
    if (electronSafeStorage) {
      return electronSafeStorage;
    }
    return null;
  }

  private static getCredentialsDir(): string {
    return this.customUserDataDir || getUserDataDir();
  }

  static getCredentialsFilePath(): string {
    return path.join(this.getCredentialsDir(), "credentials.enc");
  }

  static getTempFilePath(): string {
    return path.join(this.getCredentialsDir(), "credentials.enc.tmp");
  }

  static getInvalidationMarkerPath(): string {
    return path.join(this.getCredentialsDir(), "credentials.invalidated");
  }

  static hasStoredCredentialsFile(): boolean {
    return fs.existsSync(this.getCredentialsFilePath());
  }

  /**
   * Determine the active OS-backed storage provider.
   * Locked, unavailable, or insecure fallback providers (such as Linux basic_text)
   * strictly resolve to "session_only" mode.
   */
  static detectStorageBackend(): StorageBackendType {
    const storage = this.getActiveSafeStorage();
    if (!storage) {
      return "session_only";
    }

    try {
      if (!storage.isEncryptionAvailable()) {
        return "session_only";
      }

      if (process.platform === "win32") {
        return "windows_dpapi";
      }

      if (process.platform === "linux") {
        const backend = typeof storage.getSelectedStorageBackend === "function"
          ? storage.getSelectedStorageBackend()
          : "unknown";

        const approvedLinuxBackends = ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"];
        if (approvedLinuxBackends.includes(backend)) {
          return "linux_keyring";
        }
        // Insecure fallback (e.g. "basic_text" or "unknown") MUST NOT persist secrets!
        return "session_only";
      }

      // Other OS (macOS keychain)
      return "windows_dpapi";
    } catch {
      return "session_only";
    }
  }

  static isPersistenceAvailable(): boolean {
    return this.detectStorageBackend() !== "session_only";
  }

  /**
   * Validates that a stored credential record satisfies schema version 1
   * and contains all required non-empty string fields.
   * Supports both 'version' and 'schemaVersion' field conventions.
   */
  static validateRecord(record: any): record is StoredCredentialRecord {
    if (!record || typeof record !== "object") return false;
    const v = record.version ?? record.schemaVersion;
    if (v !== 1) return false;
    if (typeof record.portalUrl !== "string" || !record.portalUrl.trim()) return false;
    const accountId = record.portalAccountId || record.accountId;
    if (typeof accountId !== "string" || !accountId.trim()) return false;
    const username = record.portalUsername || record.accountUsername;
    if (typeof username !== "string" || !username.trim()) return false;
    if (typeof record.token !== "string" || !record.token.trim()) return false;
    if (record.refreshToken !== undefined && typeof record.refreshToken !== "string") return false;
    if (record.minecraftAccessToken !== undefined && typeof record.minecraftAccessToken !== "string") return false;
    if (record.minecraftUuid !== undefined && typeof record.minecraftUuid !== "string") return false;
    if (record.minecraftUsername !== undefined && typeof record.minecraftUsername !== "string") return false;
    return true;
  }

  /**
   * Atomically encrypts and persists credentials to disk.
   * If the detected storage provider is "session_only", disk persistence is skipped.
   */
  static saveCredentials(record: StoredCredentialRecord): SaveCredentialsResult {
    if (!this.validateRecord(record)) {
      const err = "Invalid credential record schema";
      this.lastPersistenceError = err;
      return {
        success: false,
        backend: this.detectStorageBackend(),
        sessionOnly: false,
        error: err,
      };
    }

    const backend = this.detectStorageBackend();
    if (backend === "session_only") {
      LauncherLogger.info("[CredentialStore] Operating in session-only mode; secrets held in memory only.");
      this.lastPersistenceError = null;
      return { success: true, backend: "session_only", sessionOnly: true };
    }

    const storage = this.getActiveSafeStorage();
    if (!storage) {
      this.lastPersistenceError = null;
      return { success: true, backend: "session_only", sessionOnly: true };
    }

    try {
      const portalAccountId = record.portalAccountId || record.accountId;
      const portalUsername = record.portalUsername || record.accountUsername;

      const canonicalRecord: StoredCredentialRecord = {
        ...record,
        version: 1,
        schemaVersion: 1,
        portalUrl: normalizePortalUrl(record.portalUrl),
        portalAccountId,
        portalUsername,
        accountId: portalAccountId,
        accountUsername: portalUsername,
      };

      const plainJson = JSON.stringify(canonicalRecord);
      let encryptedBuffer: Buffer;
      try {
        encryptedBuffer = storage.encryptString(plainJson);
      } catch (encErr: any) {
        throw new Error(sanitizeProviderError(encErr, "encrypt"));
      }

      const targetFile = this.getCredentialsFilePath();
      const dir = path.dirname(targetFile);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } else {
        try {
          fs.chmodSync(dir, 0o700);
        } catch {}
      }

      // Hardening: exclusive unique temporary file with O_CREAT | O_EXCL and 0o600 mode
      const uniqueTemp = path.join(
        dir,
        `credentials.enc.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}`
      );

      const fd = fs.openSync(
        uniqueTemp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600
      );

      try {
        fs.writeSync(fd, encryptedBuffer);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // Verify created temporary file: regular file, no symlink, and no pre-existing hardlinks
      const stats = fs.lstatSync(uniqueTemp);
      if (!stats.isFile() || stats.isSymbolicLink() || (typeof stats.nlink === "number" && stats.nlink > 1)) {
        try { fs.unlinkSync(uniqueTemp); } catch {}
        throw new Error("Temporary credential file verification failed: irregular file or hardlink detected");
      }

      // Atomic rename to destination
      fs.renameSync(uniqueTemp, targetFile);
      try {
        fs.chmodSync(targetFile, 0o600);
      } catch {}

      // Clear any invalidation marker on successful write
      try {
        const marker = this.getInvalidationMarkerPath();
        if (fs.existsSync(marker)) {
          fs.unlinkSync(marker);
        }
      } catch {}

      this.lastPersistenceError = null;
      LauncherLogger.info(`[CredentialStore] Credentials protected and persisted via ${backend}`);
      return { success: true, backend, sessionOnly: false };
    } catch (err: any) {
      const sanitizedMsg = sanitizeProviderError(err, "encrypt");
      this.lastPersistenceError = sanitizedMsg;
      LauncherLogger.error(`[CredentialStore] Failed to persist protected credentials: ${sanitizedMsg}`);
      // Clean up any temporary files matching credentials.enc.tmp* in directory
      try {
        const dir = this.getCredentialsDir();
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          for (const f of files) {
            if (f.startsWith("credentials.enc.tmp")) {
              try { fs.unlinkSync(path.join(dir, f)); } catch {}
            }
          }
        }
      } catch {}
      return { success: false, backend, sessionOnly: false, error: sanitizedMsg };
    }
  }

  /**
   * Loads and decrypts credentials from disk.
   * Returns null if missing, corrupted, wrong schema, or if backend is session-only.
   * If corrupted or wrong schema, safely purges the invalid file and logs warning.
   */
  static loadCredentials(): StoredCredentialRecord | null {
    const targetFile = this.getCredentialsFilePath();
    if (!fs.existsSync(targetFile)) {
      return null;
    }

    const markerFile = this.getInvalidationMarkerPath();
    if (fs.existsSync(markerFile)) {
      LauncherLogger.warn("[CredentialStore] Durable invalidation marker exists; refusing to load stale credentials.");
      try {
        if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
        fs.unlinkSync(markerFile);
      } catch {}
      return null;
    }

    const backend = this.detectStorageBackend();
    if (backend === "session_only") {
      LauncherLogger.warn("[CredentialStore] Encrypted credentials exist on disk but current backend is session-only; refusing to load.");
      return null;
    }

    const storage = this.getActiveSafeStorage();
    if (!storage) {
      return null;
    }

    try {
      const encryptedBuffer = fs.readFileSync(targetFile);
      if (encryptedBuffer.length === 0) {
        LauncherLogger.warn("[CredentialStore] Zero-byte credential file found on disk. Purging.");
        this.clearCredentials();
        return null;
      }

      let plainJson: string;
      try {
        plainJson = storage.decryptString(encryptedBuffer);
      } catch (decryptErr: any) {
        const sanitized = sanitizeProviderError(decryptErr, "decrypt");
        LauncherLogger.warn(`[CredentialStore] Decryption failed (${sanitized})`);
        this.clearCredentials();
        return null;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(plainJson);
      } catch (parseErr: any) {
        LauncherLogger.warn(`[CredentialStore] Decrypted credentials contained invalid JSON: ${parseErr.message}`);
        this.clearCredentials();
        return null;
      }

      if (!this.validateRecord(parsed)) {
        LauncherLogger.warn("[CredentialStore] Stored credential record failed schema validation.");
        this.clearCredentials();
        return null;
      }

      // Reconcile and normalize record
      const portalAccountId = parsed.portalAccountId || parsed.accountId;
      const portalUsername = parsed.portalUsername || parsed.accountUsername;

      const normalized: StoredCredentialRecord = {
        ...parsed,
        version: 1,
        schemaVersion: 1,
        portalAccountId,
        portalUsername,
        accountId: portalAccountId,
        accountUsername: portalUsername,
      };

      return normalized;
    } catch (err: any) {
      LauncherLogger.error(`[CredentialStore] Failed to load credentials: ${err.message}`);
      return null;
    }
  }

  /**
   * Cleans up the on-disk credentials file.
   * Returns explicit deletion outcomes.
   */
  static clearCredentials(): ClearCredentialsResult {
    const targetFile = this.getCredentialsFilePath();
    const markerFile = this.getInvalidationMarkerPath();
    const dir = this.getCredentialsDir();
    let deletedTarget = false;
    let deletedTemp = false;
    let error: string | undefined;

    try {
      if (fs.existsSync(targetFile)) {
        fs.unlinkSync(targetFile);
        deletedTarget = true;
      }
    } catch (err: any) {
      error = `Could not delete ${targetFile}: ${err.message}`;
      this.lastCleanupError = error;
      LauncherLogger.warn(`[CredentialStore] ${error}`);
      // Attempt overwrite with empty buffer so corrupt bytes cannot decrypt
      try {
        fs.writeFileSync(targetFile, Buffer.alloc(0));
      } catch {}
      // Write durable invalidation marker so restart cannot resurrect old credentials
      try {
        fs.writeFileSync(markerFile, JSON.stringify({ invalidatedAt: Date.now(), error: err.message }), { mode: 0o600 });
      } catch {}
    }

    // Clean up temporary files in credential directory
    try {
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (entry.startsWith("credentials.enc.tmp")) {
            try {
              fs.unlinkSync(path.join(dir, entry));
              deletedTemp = true;
            } catch {}
          }
        }
      }
    } catch {}

    const fixedTemp = this.getTempFilePath();
    try {
      if (fs.existsSync(fixedTemp)) {
        fs.unlinkSync(fixedTemp);
        deletedTemp = true;
      }
    } catch {}

    if (deletedTarget && !error) {
      try {
        if (fs.existsSync(markerFile)) {
          fs.unlinkSync(markerFile);
        }
      } catch {}
      this.lastCleanupError = null;
    }

    const success = !error;
    return { success, error, deletedTarget, deletedTemp };
  }
}

function sanitizeProviderError(err: any, operation: "encrypt" | "decrypt"): string {
  if (!err) return `${operation} operation failed`;
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes("revoked") || msg.includes("denied") || msg.includes("permission") || msg.includes("eacces") || msg.includes("eperm")) {
    return "Secure storage access denied by system policy";
  }
  if (msg.includes("locked") || msg.includes("unavailable") || msg.includes("daemon") || msg.includes("keyring")) {
    return "Secure storage provider is locked or unavailable";
  }
  if (msg.includes("ciphertext") || msg.includes("corrupt") || msg.includes("payload") || msg.includes("invalid")) {
    return "Stored credentials failed integrity or decryption check";
  }
  if (msg.includes("full") || msg.includes("space") || msg.includes("enospc")) {
    return "Disk full: unable to persist credentials";
  }
  return `Failed to ${operation} credentials in secure storage provider`;
}
