import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-java-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

afterAll(() => {
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

let execFileCalls: Array<{ file: string; args: string[]; options: any }> = [];
let mockExecFileHandler:
  | ((file: string, args: string[], options: any, cb: (err: any, stdout: string, stderr: string) => void) => void)
  | null = null;

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

mock.module("node:child_process", () => ({
  execFile: (file: string, args: string[], options: any, cb: any) => {
    execFileCalls.push({ file, args, options });
    if (mockExecFileHandler) {
      mockExecFileHandler(file, args, options, cb);
    } else {
      cb(new Error("Command failed"), "", "");
    }
  },
}));

const { JavaRuntimeManager } = await import("../src/java-runtime");
const { ConfigManager, PortalPolicy } = await import("../src/config");

describe("JavaRuntimeManager Async Probing (Phase 3A)", () => {
  beforeEach(() => {
    execFileCalls = [];
    mockExecFileHandler = null;
    JavaRuntimeManager.clearProbeCache();
    PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
    ConfigManager.resetForTesting();
    ConfigManager.set({
      portalUrl: "http://localhost:3000",
      selectedChannel: "stable",
      gameDir,
      customClientMods: [],
      disabledClientMods: [],
    });
    ConfigManager.establishSession("http://localhost:3000", {
      token: "mock-token",
    });
  });

  afterAll(() => {
    PortalPolicy.resetForTesting();
    if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("returns null for empty or whitespace-only java paths", async () => {
    expect(await JavaRuntimeManager.checkJavaVersion("")).toBeNull();
    expect(await JavaRuntimeManager.checkJavaVersion("   ")).toBeNull();
    expect(execFileCalls.length).toBe(0);
  });

  test("returns null without executing if file path does not exist on disk", async () => {
    const fakePath = path.join(testRoot, "does-not-exist", "java.exe");
    expect(await JavaRuntimeManager.checkJavaVersion(fakePath)).toBeNull();
    expect(execFileCalls.length).toBe(0);
  });

  test("safely handles paths with spaces, unicode characters, and shell metacharacters without shell execution", async () => {
    // Non-existent path with spaces and shell metacharacters
    const injectionPath = path.join(testRoot, "folder with space & ; calc.exe", "java.exe");
    expect(await JavaRuntimeManager.checkJavaVersion(injectionPath)).toBeNull();
    expect(execFileCalls.length).toBe(0);

    // Existing file with unicode and spaces
    const unicodeDir = path.join(testRoot, "répertoire avec espaces 日本語");
    fs.mkdirSync(unicodeDir, { recursive: true });
    const unicodeJava = path.join(unicodeDir, "java.exe");
    fs.writeFileSync(unicodeJava, "dummy binary");

    mockExecFileHandler = (file, args, options, cb) => {
      expect(file).toBe(unicodeJava);
      expect(args).toEqual(["-version"]);
      expect(options.shell).toBe(false);
      expect(options.timeout).toBe(4000);
      expect(options.maxBuffer).toBe(64 * 1024);
      cb(null, "", 'openjdk version "25.0.1" 2025-10-14\nOpenJDK Runtime Environment');
    };

    const ver = await JavaRuntimeManager.checkJavaVersion(unicodeJava);
    expect(ver).toBe(25);
    expect(execFileCalls.length).toBe(1);
  });

  test("bare 'java' commands resolve via PATH without requiring local file existence", async () => {
    mockExecFileHandler = (file, args, options, cb) => {
      expect(file).toBe("java");
      expect(options.shell).toBe(false);
      cb(null, "", 'openjdk version "25" 2025-09-16');
    };

    const ver = await JavaRuntimeManager.checkJavaVersion("java");
    expect(ver).toBe(25);
    expect(execFileCalls.length).toBe(1);
    expect(execFileCalls[0].file).toBe("java");
  });

  test("handles execution timeout or failure gracefully by returning null without throwing", async () => {
    const dummyJava = path.join(testRoot, "slow-java.exe");
    fs.writeFileSync(dummyJava, "dummy binary");

    mockExecFileHandler = (_file, _args, _options, cb) => {
      const err = new Error("Command timed out");
      (err as any).killed = true;
      cb(err, "", "");
    };

    const ver = await JavaRuntimeManager.checkJavaVersion(dummyJava);
    expect(ver).toBeNull();
  });

  test("uses operation-local probe cache to avoid redundant process spawning", async () => {
    const dummyJava = path.join(testRoot, "cached-java.exe");
    fs.writeFileSync(dummyJava, "dummy binary");

    mockExecFileHandler = (_file, _args, _options, cb) => {
      cb(null, "", 'openjdk version "25.0.2" 2026-01-15');
    };

    // First call: executes execFile
    const ver1 = await JavaRuntimeManager.checkJavaVersion(dummyJava);
    expect(ver1).toBe(25);
    expect(execFileCalls.length).toBe(1);

    // Second call: served from cache
    const ver2 = await JavaRuntimeManager.checkJavaVersion(dummyJava);
    expect(ver2).toBe(25);
    expect(execFileCalls.length).toBe(1);

    // After clearProbeCache: probes again
    JavaRuntimeManager.clearProbeCache();
    const ver3 = await JavaRuntimeManager.checkJavaVersion(dummyJava);
    expect(ver3).toBe(25);
    expect(execFileCalls.length).toBe(2);
  });

  test("parses various Java version formats correctly from stderr or stdout", async () => {
    const dummyJava = path.join(testRoot, "format-test-java.exe");
    fs.writeFileSync(dummyJava, "dummy");

    // Standard OpenJDK format on stderr
    mockExecFileHandler = (_f, _a, _o, cb) => {
      cb(null, "", 'openjdk 25.0.1 2025-10-14\nOpenJDK 64-Bit Server VM');
    };
    expect(await JavaRuntimeManager.checkJavaVersion(dummyJava)).toBe(25);

    JavaRuntimeManager.clearProbeCache();
    // Build number format on stdout
    mockExecFileHandler = (_f, _a, _o, cb) => {
      cb(null, "Runtime Environment build 25+36", "");
    };
    expect(await JavaRuntimeManager.checkJavaVersion(dummyJava)).toBe(25);

    JavaRuntimeManager.clearProbeCache();
    // Legacy Java 8 format
    mockExecFileHandler = (_f, _a, _o, cb) => {
      cb(null, "", 'java version "1.8.0_351"\nJava(TM) SE Runtime Environment');
    };
    expect(await JavaRuntimeManager.checkJavaVersion(dummyJava)).toBe(8);
  });

  test("on Windows, javaw.exe probing checks sibling java.exe for console output", async () => {
    if (process.platform !== "win32") return;

    const binDir = path.join(testRoot, "jdk-test", "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const javawPath = path.join(binDir, "javaw.exe");
    const javaPath = path.join(binDir, "java.exe");
    fs.writeFileSync(javawPath, "javaw binary");
    fs.writeFileSync(javaPath, "java binary");

    mockExecFileHandler = (file, args, options, cb) => {
      // Must probe the sibling java.exe to capture stdout/stderr
      expect(file).toBe(javaPath);
      cb(null, "", 'openjdk version "25" 2025-09-16');
    };

    const ver = await JavaRuntimeManager.checkJavaVersion(javawPath);
    expect(ver).toBe(25);
    expect(execFileCalls.length).toBe(1);
    expect(execFileCalls[0].file).toBe(javaPath);
  });

  test("ensureJava25 selects user configured javaPath when version >= 25", async () => {
    const customJava = path.join(testRoot, "custom-jdk", "bin", "java.exe");
    fs.mkdirSync(path.dirname(customJava), { recursive: true });
    fs.writeFileSync(customJava, "dummy");

    ConfigManager.set({ javaPath: customJava });

    mockExecFileHandler = (_f, _a, _o, cb) => {
      cb(null, "", 'openjdk version "25.0.1" 2025-10-14');
    };

    const logs: string[] = [];
    const selected = await JavaRuntimeManager.ensureJava25(gameDir, (m) => logs.push(m));
    expect(selected).toBe(customJava);
    expect(logs.some((l) => l.includes("Using configured Java 25"))).toBe(true);
  });

  test("ensureJava25 ignores user configured javaPath when version < 25 and falls back to local runtime", async () => {
    const oldJava = path.join(testRoot, "old-jdk", "bin", "java.exe");
    fs.mkdirSync(path.dirname(oldJava), { recursive: true });
    fs.writeFileSync(oldJava, "dummy");

    const localJava = path.join(
      gameDir,
      "runtime",
      "java-runtime-epsilon",
      "bin",
      process.platform === "win32" ? "javaw.exe" : "java"
    );
    fs.mkdirSync(path.dirname(localJava), { recursive: true });
    fs.writeFileSync(localJava, "dummy");

    ConfigManager.set({ javaPath: oldJava });

    mockExecFileHandler = (file, _a, _o, cb) => {
      if (file === oldJava) {
        cb(null, "", 'openjdk version "17.0.1" 2021-10-19');
      } else {
        cb(null, "", 'openjdk version "25.0.1" 2025-10-14');
      }
    };

    const logs: string[] = [];
    const selected = await JavaRuntimeManager.ensureJava25(gameDir, (m) => logs.push(m));
    expect(selected).toBe(localJava);
    expect(logs.some((l) => l.includes("Found local Java 25"))).toBe(true);
  });
});
