import * as fs from "node:fs";
import * as path from "node:path";
import * as electron from "electron";
const electronSafeStorage = (electron as any)?.safeStorage;
import { getUserDataDir } from "./config";
import { normalizePortalUrl } from "./portal-policy";
import { LauncherLogger } from "./logger";

export interface StoredCredentialRecord {
  version: 1;
  portalUrl: string;
  accountId: string;
  accountUsername: string;
  token: string;
  refreshToken?: string;
  minecraftAccessToken?: string;
  createdAt: number;
  updatedAt: number;
}

export type StorageBackendType = "windows_dpapi" | "linux_keyring" | "session_only";

export class CredentialStore {
  private static mockSafeStorage: Electron.SafeStorage | null = null;
  private static customUserDataDir: string | null = null;

  static setSafeStorageMockForTesting(mock: Electron.SafeStorage | null): void {
    this.mockSafeStorage = mock;
  }

  static setCustomUserDataDirForTesting(customDir: string | null): void {
    this.customUserDataDir = customDir;
  }

  static resetForTesting(): void {
    this.mockSafeStorage = null;
    this.customUserDataDir = null;
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

  private static getTempFilePath(): string {
    return path.join(this.getCredentialsDir(), "credentials.enc.tmp");
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
   */
  static validateRecord(record: any): record is StoredCredentialRecord {
    if (!record || typeof record !== "object") return false;
    if (record.version !== 1) return false;
    if (typeof record.portalUrl !== "string" || !record.portalUrl.trim()) return false;
    if (typeof record.accountId !== "string" || !record.accountId.trim()) return false;
    if (typeof record.accountUsername !== "string" || !record.accountUsername.trim()) return false;
    if (typeof record.token !== "string" || !record.token.trim()) return false;
    if (record.refreshToken !== undefined && typeof record.refreshToken !== "string") return false;
    if (record.minecraftAccessToken !== undefined && typeof record.minecraftAccessToken !== "string") return false;
    return true;
  }

  /**
   * Atomically encrypts and persists credentials to disk.
   * If the detected storage provider is "session_only", disk persistence is skipped.
   */
  static saveCredentials(record: StoredCredentialRecord): { success: boolean; sessionOnly: boolean } {
    if (!this.validateRecord(record)) {
      throw new Error("Invalid credential record schema");
    }

    const backend = this.detectStorageBackend();
    if (backend === "session_only") {
      LauncherLogger.info("[CredentialStore] Operating in session-only mode; secrets held in memory only.");
      return { success: true, sessionOnly: true };
    }

    const storage = this.getActiveSafeStorage();
    if (!storage) {
      return { success: true, sessionOnly: true };
    }

    try {
      const canonicalRecord: StoredCredentialRecord = {
        ...record,
        portalUrl: normalizePortalUrl(record.portalUrl),
      };

      const plainJson = JSON.stringify(canonicalRecord);
      const encryptedBuffer = storage.encryptString(plainJson);

      const targetFile = this.getCredentialsFilePath();
      const tempFile = this.getTempFilePath();
      const dir = path.dirname(targetFile);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Write atomically via temporary file with owner-only permissions (0o600)
      fs.writeFileSync(tempFile, encryptedBuffer, { mode: 0o600 });
      try {
        fs.chmodSync(tempFile, 0o600);
      } catch {}

      fs.renameSync(tempFile, targetFile);
      try {
        fs.chmodSync(targetFile, 0o600);
      } catch {}

      LauncherLogger.info(`[CredentialStore] Credentials protected and persisted via ${backend}`);
      return { success: true, sessionOnly: false };
    } catch (err: any) {
      LauncherLogger.error(`[CredentialStore] Failed to persist protected credentials: ${err.message}`);
      // Clean up temp file on failure
      try {
        if (fs.existsSync(this.getTempFilePath())) {
          fs.unlinkSync(this.getTempFilePath());
        }
      } catch {}
      return { success: false, sessionOnly: false };
    }
  }

  /**
   * Loads and decrypts credentials from disk.
   * Returns null if missing, corrupted, wrong schema, or if backend is session-only.
   */
  static loadCredentials(): StoredCredentialRecord | null {
    const targetFile = this.getCredentialsFilePath();
    if (!fs.existsSync(targetFile)) {
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
        this.clearCredentials();
        return null;
      }

      let plainJson: string;
      try {
        plainJson = storage.decryptString(encryptedBuffer);
      } catch (decryptErr: any) {
        LauncherLogger.warn(`[CredentialStore] Decryption failed (corrupt ciphertext or provider locked): ${decryptErr.message}`);
        // Do not resurrect plaintext or crash; clear corrupted record
        this.clearCredentials();
        return null;
      }

      const parsed = JSON.parse(plainJson);
      if (!this.validateRecord(parsed)) {
        LauncherLogger.warn("[CredentialStore] Stored credential record failed schema validation.");
        this.clearCredentials();
        return null;
      }

      return parsed;
    } catch (err: any) {
      LauncherLogger.error(`[CredentialStore] Failed to load credentials: ${err.message}`);
      return null;
    }
  }

  /**
   * Cleans up the on-disk credentials file.
   */
  static clearCredentials(): void {
    const targetFile = this.getCredentialsFilePath();
    const tempFile = this.getTempFilePath();

    try {
      if (fs.existsSync(targetFile)) {
        fs.unlinkSync(targetFile);
      }
    } catch (err: any) {
      LauncherLogger.warn(`[CredentialStore] Could not delete ${targetFile}: ${err.message}`);
    }

    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {}
  }
}
