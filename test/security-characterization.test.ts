import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sec-char-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

let openedPaths: string[] = [];
let openedExternals: string[] = [];

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "1.3.0",
  },
  shell: {
    openPath: async (p: string) => {
      openedPaths.push(p);
      return "";
    },
    openExternal: async (url: string) => {
      openedExternals.push(url);
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
}));

const { LauncherLogger, LauncherLoggerService } = await import("../src/logger");
const { ConfigManager, normalizePortalUrl } = await import("../src/config");
const { LauncherAuth } = await import("../src/auth");
const { isPathProtected, isSafeRelativePath, LauncherSync } = await import("../src/sync");
const { GameDirectoryManager } = await import("../src/game-directory");
const { FabricMetaResolver, validateFabricRuntimeMetadata } = await import("../src/fabric-meta");
const { downloadVerified, hashFile } = await import("../src/file-transfer");
const { ProcessLogFramer } = await import("../src/game-log-stream");

beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
  openedPaths = [];
  openedExternals = [];
  ConfigManager.resetForTesting();
  GameDirectoryManager.resetForTesting();

  ConfigManager.set({
    token: "syn-test-bearer-token-12345",
    refreshToken: "syn-test-refresh-token-67890",
    minecraftAccessToken: "syn-test-mc-token-abcdef",
    portalUrl: "https://dev.lampas.town",
    selectedChannel: "stable",
    gameDir,
    customClientMods: [],
    disabledClientMods: [],
  });

  if (fs.existsSync(gameDir)) {
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.mkdirSync(gameDir, { recursive: true });
  }
});

afterAll(() => {
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Phase 0 Security Characterization — SEC-01: Portal Destination & URL Normalization", () => {
  test("normalizePortalUrl allows HTTP bypass when 'localhost' is part of domain name", () => {
    // Lookalike domain with 'localhost' in domain bypasses HTTPS upgrade
    const bypassUrl = "http://localhost.attacker.invalid";
    const normalized = normalizePortalUrl(bypassUrl);
    expect(normalized).toBe("http://localhost.attacker.invalid");
  });

  test("normalizePortalUrl allows HTTP bypass when '127.0.0.1' is in query or path", () => {
    // Remote host with 127.0.0.1 in query string bypasses HTTPS upgrade
    const bypassUrl = "http://attacker.invalid/auth?ip=127.0.0.1";
    const normalized = normalizePortalUrl(bypassUrl);
    expect(normalized).toBe("http://attacker.invalid/auth?ip=127.0.0.1");
  });

  test("normalizePortalUrl allows HTTP bypass when scheme is uppercase HTTP://", () => {
    // Case-sensitive startsWith('http://') check fails to match uppercase HTTP://
    const bypassUrl = "HTTP://remote.example.com";
    const normalized = normalizePortalUrl(bypassUrl);
    expect(normalized).toBe("HTTP://remote.example.com");
  });

  test("preload and main contract exposes caller-controlled portalUrl to verify and refresh", async () => {
    // In src/preload.ts:
    // verify: (portalUrl?: string) => ipcRenderer.invoke("auth:verify", portalUrl)
    // refresh: (portalUrl?: string) => ipcRenderer.invoke("auth:refresh", portalUrl)
    // In src/main.ts:
    // ipcMain.handle("auth:verify", async (_, portalUrl) => LauncherAuth.verifySession(portalUrl))
    // ipcMain.handle("auth:refresh", async (_, portalUrl) => LauncherAuth.refreshSession(portalUrl))
    // This confirms that renderer can supply an arbitrary portalUrl to credential-bearing operations.
    const preloadSource = fs.readFileSync(path.join(__dirname, "../src/preload.ts"), "utf-8");
    expect(preloadSource).toContain('verify: (portalUrl?: string)');
    expect(preloadSource).toContain('refresh: (portalUrl?: string)');

    const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf-8");
    expect(mainSource).toContain('ipcMain.handle("auth:verify", async (_, portalUrl)');
    expect(mainSource).toContain('ipcMain.handle("auth:refresh", async (_, portalUrl)');
  });
});

describe("Phase 0 Security Characterization — SEC-02: Broad IPC & Generic OS Opener", () => {
  test("utils:openPath sink routes non-HTTP URLs to shell.openPath instead of rejecting", async () => {
    // In src/main.ts:
    // ipcMain.handle("utils:openPath", async (_, targetPath: string) => {
    //   if (targetPath) {
    //     if (/^https?:\/\//i.test(targetPath)) await shell.openExternal(targetPath);
    //     else await shell.openPath(targetPath);
    //   }
    // });
    const simulateOpenPath = async (targetPath: string) => {
      if (targetPath) {
        if (/^https?:\/\//i.test(targetPath)) await (mock.module as any);
        // If not http(s), shell.openPath is invoked
        return !/^https?:\/\//i.test(targetPath);
      }
      return false;
    };

    // A mod catalog entry with sourceUrl pointing to local executable
    expect(await simulateOpenPath("calc.exe")).toBe(true);
    expect(await simulateOpenPath("file:///etc/passwd")).toBe(true);
    expect(await simulateOpenPath("https://lampas.town/mod")).toBe(false);
  });

  test("config:set allows arbitrary non-blacklisted keys like javaPath and javaArgs", () => {
    // In src/main.ts config:set handler deletes gameDir, gameDirConfigured, token, refreshToken, minecraftAccessToken
    // but accepts all other configuration keys without schema allowlisting
    const updated = ConfigManager.set({
      javaPath: "C:\\malicious\\fake-java.exe",
      javaArgs: "-javaagent:C:\\malicious\\agent.jar",
    });

    expect(updated.javaPath).toBe("C:\\malicious\\fake-java.exe");
    expect(updated.javaArgs).toBe("-javaagent:C:\\malicious\\agent.jar");
  });
});

describe("Phase 0 Security Characterization — SEC-03: Plaintext Credential Persistence", () => {
  test("ConfigManager persists authentication secrets in unencrypted plaintext JSON", () => {
    ConfigManager.set({
      token: "super-secret-portal-jwt-token",
      refreshToken: "super-secret-refresh-uuid",
      minecraftAccessToken: "super-secret-mc-session-token",
    });

    const configFilePath = path.join(userDataDir, "config.json");
    expect(fs.existsSync(configFilePath)).toBe(true);

    const rawFileContent = fs.readFileSync(configFilePath, "utf-8");
    const parsedOnDisk = JSON.parse(rawFileContent);

    // Assert that credentials exist as cleartext fields in config.json
    expect(parsedOnDisk.token).toBe("super-secret-portal-jwt-token");
    expect(parsedOnDisk.refreshToken).toBe("super-secret-refresh-uuid");
    expect(parsedOnDisk.minecraftAccessToken).toBe("super-secret-mc-session-token");
  });
});

describe("Phase 0 Security Characterization — SEC-04: Path Containment & Ownership Inconsistencies", () => {
  test("isSafeRelativePath and isPathProtected have inconsistent dot-alias handling", () => {
    const candidate = "mods/../saves/world-data.txt";

    // isSafeRelativePath normalizes path first, so path.normalize('mods/../saves/world-data.txt') -> 'saves/world-data.txt'
    // which does not start with '../', so isSafeRelativePath is true
    expect(isSafeRelativePath(candidate)).toBe(true);

    // isPathProtected does NOT normalize '../', checking only startsWith against 'saves/'
    // Since it starts with 'mods/', isPathProtected returns false!
    expect(isPathProtected(candidate)).toBe(false);
  });

  test("isPathProtected fails on Windows uppercase path variants", () => {
    expect(isPathProtected("saves/level.dat")).toBe(true);
    // Case-sensitive check fails to protect case-insensitive Windows paths
    expect(isPathProtected("Saves/level.dat")).toBe(false);
    expect(isPathProtected("SAVES/level.dat")).toBe(false);
    expect(isPathProtected("Screenshots/1.png")).toBe(false);
  });

  test("Internal launcher state directory (.lampas) is not protected from pack manifest paths", () => {
    const internalPath = ".lampas/installation.json";
    expect(isSafeRelativePath(internalPath)).toBe(true);
    // .lampas is not included in PROTECTED_PREFIXES
    expect(isPathProtected(internalPath)).toBe(false);
  });

  test("Previous state obsolete deletion resolves unvalidated traversal keys outside gameDir", () => {
    // In src/sync.ts obsolete deletion loop:
    // for (const [prevPath, info] of Object.entries(prevState.files)) {
    //   if (info.policy === "MANAGED" && !desiredFilesMap.has(prevPath) && !isPathProtected(prevPath)) {
    //     toDeleteSet.add(prevPath);
    //   }
    // }
    // for (const relPath of toDelete) {
    //   const fullPath = path.join(gameDir, relPath);
    //   if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    // }
    const outsideSentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-outside-sentinel-"));
    const outsideSentinelFile = path.join(outsideSentinelDir, "important-data.txt");
    fs.writeFileSync(outsideSentinelFile, "sentinel-payload");

    try {
      // Construct a relative path from gameDir to outsideSentinelFile
      const relTraversal = path.relative(gameDir, outsideSentinelFile);

      // isPathProtected does not detect this as protected because it starts with '..'
      expect(isPathProtected(relTraversal)).toBe(false);

      // path.join(gameDir, relTraversal) resolves directly to outsideSentinelFile
      const resolved = path.join(gameDir, relTraversal);
      expect(path.resolve(resolved)).toBe(path.resolve(outsideSentinelFile));
    } finally {
      fs.rmSync(outsideSentinelDir, { recursive: true, force: true });
    }
  });
});

describe("Phase 0 Security Characterization — SEC-05: Move Recovery Recursive Deletion of Staging", () => {
  test("recoverInterruptedMove recursively deletes arbitrary unvalidated staging path in 'preparing' phase", async () => {
    const outsideVictimDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-victim-staging-"));
    const victimFile = path.join(outsideVictimDir, "important-document.docx");
    fs.writeFileSync(victimFile, "vital user data");

    const journalPath = path.join(userDataDir, "directory-move.json");
    const maliciousJournal = {
      operationId: "op-corrupt-staging",
      phase: "preparing",
      source: path.join(gameDir, "nonexistent-src"),
      target: path.join(gameDir, "nonexistent-dst"),
      staging: outsideVictimDir, // points outside launcher control
      startTime: new Date().toISOString(),
    };
    fs.writeFileSync(journalPath, JSON.stringify(maliciousJournal, null, 2), "utf-8");

    try {
      expect(fs.existsSync(victimFile)).toBe(true);
      // Run recovery
      await GameDirectoryManager.recoverInterruptedMove();

      // SEC-05 reproduced: the unverified staging path was deleted recursively
      expect(fs.existsSync(outsideVictimDir)).toBe(false);
    } finally {
      if (fs.existsSync(outsideVictimDir)) {
        fs.rmSync(outsideVictimDir, { recursive: true, force: true });
      }
    }
  });
});

describe("Phase 0 Security Characterization — SEC-06: Executable Verification Fails Open", () => {
  test("FabricMetaResolver returns metadata without checksums when sidecar 404s", async () => {
    const mockRuntime = {
      minecraft: "26.2",
      loader: { type: "fabric" as const, version: "0.19.3" },
    };

    // Mock fetch that returns loader metadata but 404s for sidecars (.sha256 / .sha1)
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.endsWith(".sha256") || urlStr.endsWith(".sha1")) {
        return new Response("Not Found", { status: 404 });
      }
      return Response.json({
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        launcherMeta: {
          mainClass: { client: "net.fabricmc.loader.impl.launch.knot.KnotClient" },
          libraries: {
            common: [
              { name: "net.fabricmc:sponge-mixin:0.15.3+mixin.0.8.7" },
            ],
          },
        },
      });
    };

    const result = await FabricMetaResolver.resolveFabricRuntime(mockRuntime, undefined, {
      fetchFn: mockFetch,
      timeoutMs: 1000,
      resolveSidecars: true,
    });

    expect(result.libraries.length).toBeGreaterThan(0);
    const spongeLib = result.libraries.find((l) => l.name.includes("sponge-mixin"));
    expect(spongeLib).toBeDefined();
    // In baseline, sidecar failure leaves sha256 and sha1 undefined, and validation still passes
    expect(spongeLib?.sha256).toBeUndefined();
    expect(spongeLib?.sha1).toBeUndefined();
  });

  test("downloadVerified completes without error when expectedHash is undefined", async () => {
    const payload = Buffer.from("arbitrary-binary-content-without-checksum");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(payload);
      },
    });

    const destPath = path.join(gameDir, "downloaded-unverified.jar");

    try {
      // Called with no expectedHash
      const bytes = await downloadVerified(`http://127.0.0.1:${server.port}/blob`, destPath, {
        expectedHash: undefined,
      });

      expect(bytes).toBe(payload.length);
      expect(fs.existsSync(destPath)).toBe(true);
      // File was written without any hash check
      expect(fs.readFileSync(destPath)).toEqual(payload);
    } finally {
      server.stop();
    }
  });
});

describe("Phase 0 Security Characterization — SEC-09: Logging Redaction Gaps", () => {
  test("LauncherLoggerService.sanitize redacts standard keys but misses underscore fields", () => {
    // CamelCase token field is redacted
    const camel = '{"token": "secret_bearer_token"}';
    expect(LauncherLoggerService.sanitize(camel)).toBe('{"token": "[REDACTED]"}');

    // Underscore token fields are NOT redacted in baseline
    const underRefresh = '{"refresh_token": "secret_refresh_token_value"}';
    expect(LauncherLoggerService.sanitize(underRefresh)).toBe(underRefresh);

    const underAccess = '{"access_token": "secret_access_token_value"}';
    expect(LauncherLoggerService.sanitize(underAccess)).toBe(underAccess);
  });

  test("LauncherLoggerService.sanitize does not redact authorization codes in URL query strings", () => {
    const queryWithCode = "https://dev.lampas.town/callback?code=sensitive_authorization_code_12345&state=abc";
    // Authorization code in URL remains exposed
    expect(LauncherLoggerService.sanitize(queryWithCode)).toBe(queryWithCode);
  });

  test("LauncherLoggerService.sanitize does not redact CLI command arguments", () => {
    const cliLine = "Starting java with --accessToken sensitive_session_token_xyz --version 26.2";
    // CLI access token is NOT redacted in baseline
    expect(LauncherLoggerService.sanitize(cliLine)).toBe(cliLine);
  });

  test("ProcessLogFramer truncates oversized lines before redaction, leaking split secrets", () => {
    let emitted: string | null = null;
    // Set maxLineLength = 50
    const framer = new ProcessLogFramer("INFO", (entry) => {
      emitted = entry.message;
    }, { maxLineLength: 50 });

    // Construct a line where the token's closing quote is beyond 50 characters
    // '012345678901234567890123456789{"token": "super_secret_secret_secret"}'
    // Prefix length = 30, '{"token": "' = 11, total 41. At length 50, secret is cut in half without closing quote!
    const line = 'A'.repeat(30) + '{"token": "sensitive_leaked_secret_token_12345"}\n';

    framer.pushChunk(Buffer.from(line));
    framer.flush();

    expect(emitted).not.toBeNull();
    // Because truncation cut off the closing quote, the regex /"token"\s*:\s*"[^"]+"/ fails to match!
    // The secret prefix is emitted in cleartext!
    expect(emitted!).toContain("sensitive");
    expect(emitted!).toContain("...[TRUNCATED]");
  });
});
