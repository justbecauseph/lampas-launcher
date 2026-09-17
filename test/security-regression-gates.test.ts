import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * SECURITY REGRESSION GATES (Phases 1-7)
 *
 * These tests define the TARGET security invariants required by PLAN.md.
 * In Phase 0 (Baseline), these tests are either marked `test.skip` (with runnable,
 * failing assertions against baseline) or `test.todo` (for future implementation specifications),
 * ensuring the baseline test suite remains green while establishing exact specifications.
 *
 * As each hardening phase is implemented, its corresponding gate tests will be
 * unskipped and become required passing criteria.
 */

let testRoot: string;
let userDataDir: string;
let gameDir: string;
let ConfigManager: any;
let normalizePortalUrl: any;
let validateWebUrl: any;
let LauncherAuth: any;
let isPathProtected: any;
let LauncherLogger: any;
let LauncherLoggerService: any;

beforeAll(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-sec-gates-"));
  userDataDir = path.join(testRoot, "user-data");
  gameDir = path.join(testRoot, "game");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });

  mock.module("electron", () => ({
    app: {
      getPath: (name: string) => (name === "userData" ? userDataDir : testRoot),
      getName: () => "Lampas Launcher",
      getVersion: () => "1.3.0",
    },
    shell: { openPath: async () => "", openExternal: async () => undefined },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
  }));

  const configMod = await import("../src/config");
  ConfigManager = configMod.ConfigManager;
  normalizePortalUrl = configMod.normalizePortalUrl;
  validateWebUrl = configMod.validateWebUrl;

  const authPath = path.resolve(__dirname, "../src/auth.ts").replace(/\\/g, "/");
  const authMod = await import(`file://${authPath}?sec_gates=${Date.now()}`);
  LauncherAuth = authMod.LauncherAuth;

  const syncMod = await import("../src/sync");
  isPathProtected = syncMod.isPathProtected;

  const loggerMod = await import("../src/logger");
  LauncherLogger = loggerMod.LauncherLogger;
  LauncherLoggerService = loggerMod.LauncherLoggerService;
});

beforeEach(() => {
  ConfigManager?.resetForTesting();
});

afterAll(async () => {
  try {
    await LauncherLogger?.close();
  } catch {}
  if (testRoot && path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Phase 1 Regression Gate — Portal Destinations & Web Link Sinks (SEC-01, SEC-02)", () => {
  test("[Phase 1 Gate] URL helper: normalizePortalUrl strictly enforces HTTPS and rejects HTTP lookalike bypasses", () => {
    // Target invariant:
    // Only exact loopback origins (http://localhost or http://127.0.0.1 with port) may use HTTP.
    // Lookalike hosts, embedded IPs, and scheme case tricks must be rejected or upgraded to HTTPS.
    expect(() => normalizePortalUrl("http://localhost.attacker.invalid")).toThrow();
    expect(() => normalizePortalUrl("http://attacker.invalid/foo?bar=127.0.0.1")).toThrow();
    expect(normalizePortalUrl("HTTP://portal.lampas.town")).toBe("https://portal.lampas.town");
    expect(() => normalizePortalUrl("https://attacker.invalid")).toThrow();
    expect(() => normalizePortalUrl("https://user:pass@dev.lampas.town")).toThrow();
    expect(() => normalizePortalUrl("https://dev.lampas.town/api/v1")).toThrow();
    expect(() => normalizePortalUrl("https://dev.lampas.town?query=1")).toThrow();
    expect(() => normalizePortalUrl("https://dev.lampas.town#hash")).toThrow();
    expect(normalizePortalUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizePortalUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  test("[Phase 1 Gate] Operation-level: Web link sink rejects non-HTTP protocols and never passes them to shell.openPath", () => {
    // validateWebUrl must strictly permit HTTP/HTTPS only
    expect(validateWebUrl("https://lampas.town/mods")).toBe("https://lampas.town/mods");
    expect(validateWebUrl("http://lampas.town/about")).toBe("http://lampas.town/about");
    expect(() => validateWebUrl("file:///C:/Windows/System32/calc.exe")).toThrow();
    expect(() => validateWebUrl("javascript:alert(1)")).toThrow();
    expect(() => validateWebUrl("powershell -Command calc.exe")).toThrow();
    expect(() => validateWebUrl("data:text/html,<html>")).toThrow();
    expect(() => validateWebUrl("https://user:pass@lampas.town")).toThrow();
    expect(() => validateWebUrl("   ")).toThrow();
  });

  test("[Phase 1 Gate] Session origin binding: ConfigManager binds credentials to sessionPortalUrl and wipes credentials on unapproved remote origin change", () => {
    ConfigManager.set({
      portalUrl: "https://dev.lampas.town",
      sessionPortalUrl: "https://dev.lampas.town",
      token: "syn-test-token",
      refreshToken: "syn-test-refresh",
    });
    let config = ConfigManager.get();
    expect(config.token).toBe("syn-test-token");
    expect(config.sessionPortalUrl).toBe("https://dev.lampas.town");

    // Changing to a different portal wipes credentials
    ConfigManager.set({ portalUrl: "https://portal.lampas.town" });
    config = ConfigManager.get();
    expect(config.token).toBeUndefined();
    expect(config.refreshToken).toBeUndefined();
    expect(config.sessionPortalUrl).toBeUndefined();
  });

  test("[Phase 1 Gate] Legacy migration: ConfigManager.get invalidates unbound credentials from disk", () => {
    const configPath = path.join(userDataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      portalUrl: "https://dev.lampas.town",
      token: "legacy-unbound-token",
      refreshToken: "legacy-unbound-refresh",
      minecraftAccessToken: "legacy-unbound-mc-token",
    }));

    ConfigManager.resetForTesting();
    const loaded = ConfigManager.get();

    expect(loaded.token).toBeUndefined();
    expect(loaded.refreshToken).toBeUndefined();
    expect(loaded.minecraftAccessToken).toBeUndefined();
    expect(loaded.sessionPortalUrl).toBeUndefined();
  });
});

describe("Phase 2 Regression Gate — IPC Narrowing & Renderer Lockdown (SEC-02)", () => {
  test.todo("[Phase 2 Gate] Operation-level: IPC handlers validate top-level sender frame and reject unauthorized callers");
  test.todo("[Phase 2 Gate] Operation-level: config:set enforces strict allowlist schema rejecting unapproved runtime fields");
});

describe("Phase 3 Regression Gate — Keyring / Session Store & Race-Safe Auth (SEC-03, SEC-08)", () => {
  test.skip("[Phase 3 Gate] Persistence: config.json on disk contains no plaintext tokens or credentials", () => {
    // Establish a synthetic session with sensitive tokens using actual baseline persistence API
    const written = ConfigManager.set({
      token: "syn-test-bearer-token-12345",
      refreshToken: "syn-test-refresh-token-67890",
      minecraftAccessToken: "syn-test-mc-token-abcdef",
    });
    // Prove fixture setup succeeds and returns written values
    expect(written.token).toBe("syn-test-bearer-token-12345");

    // Target invariant:
    // Stored credentials must be encrypted via OS-backed storage (DPAPI on Windows / libsecret on Linux)
    // or kept purely in-memory if a secure backend is unavailable, never persisted as plaintext JSON.
    const configPath = path.join(userDataDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const raw = fs.readFileSync(configPath, "utf-8");
    // Expected negative assertion: against baseline, ConfigManager.set writes plaintext tokens,
    // so this assertion fails directly at the plaintext-disclosure check, not a TypeError or import error.
    expect(raw).not.toContain("syn-test-bearer-token-12345");
    expect(raw).not.toContain("syn-test-refresh-token-67890");
    expect(raw).not.toContain("syn-test-mc-token-abcdef");
  });

  test.todo("[Phase 3 Gate] Operation-level: Authentication lifecycle uses session epochs and ignores late arrivals after logout");
});

describe("Phase 4 Regression Gate — Path Ownership, Containment & Safe Recovery (SEC-04, SEC-05)", () => {
  test.skip("[Phase 4 Gate] Path helper: isPathProtected normalizes dot-aliases before checking protected namespaces", () => {
    // Target invariant: Dot-alias traversal 'mods/../saves/world.txt' must resolve into protected
    // 'saves/' namespace and return true (protected).
    expect(isPathProtected("mods/../saves/world.txt")).toBe(true);
  });

  test.skip("[Phase 4 Gate] Path helper: isPathProtected performs case-insensitive comparison on Windows", () => {
    // Target invariant: On Windows, case variations of protected namespaces ('Saves/', 'SAVES/')
    // must be recognized as protected.
    expect(isPathProtected("SAVES/world.txt")).toBe(true);
    expect(isPathProtected("Saves/world.txt")).toBe(true);
  });

  test.skip("[Phase 4 Gate] Path helper: isPathProtected reserves internal launcher namespaces (.lampas)", () => {
    // Target invariant: The launcher internal state directory (.lampas/) must be protected.
    expect(isPathProtected(".lampas/installation.json")).toBe(true);
  });

  test.todo("[Phase 4 Gate] Operation-level: Client sync pipeline blocks unauthorized file mutations in protected paths");
  test.todo("[Phase 4 Gate] Operation-level: Move recovery rejects unverified staging paths outside approved launcher staging");
});

describe("Phase 5 Regression Gate — Integrity Checks Fail Closed & Fallback Policy (SEC-06, SEC-07, SEC-11)", () => {
  test.todo("[Phase 5 Gate] Operation-level: FabricMetaResolver fails closed when sidecar checksum resolution fails");
  test.todo("[Phase 5 Gate] Operation-level: syncClient does not swallow 410 REVOKED releases into local pipeline fallback");
});

describe("Phase 6 Regression Gate — Log Minimization & Redaction (SEC-09, SEC-10)", () => {
  test.skip("[Phase 6 Gate] Redaction helper: LauncherLoggerService.sanitize redacts underscore credential keys and URL query codes", () => {
    // Target invariant:
    // Underscore fields (refresh_token, access_token) and URL query secrets (?code=..., ?token=...) must be redacted.
    expect(LauncherLoggerService.sanitize('{"refresh_token": "secret123"}')).toContain("[REDACTED]");
    expect(LauncherLoggerService.sanitize('https://auth.town/callback?code=secret123')).toContain("[REDACTED]");
    expect(LauncherLoggerService.sanitize('--accessToken secret123')).toContain("[REDACTED]");
  });

  test.todo("[Phase 6 Gate] Operation-level: ProcessLogFramer sanitizes bounded records before truncation");
});

describe("Phase 7 Regression Gate — Release Pipeline, Artifact Signing & CI Controls (SEC-12)", () => {
  test.todo("[Phase 7 Gate] Operation-level: Production release workflow enforces signed checksum manifests and build provenance");
});
