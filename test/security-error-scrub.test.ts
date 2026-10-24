import { afterAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolated userData so ConfigManager.get() resolves a predictable game
// directory without touching the real launcher configuration.
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-scrub-"));

mock.module("electron", () => ({
  app: { getPath: () => tempUserData, isPackaged: false },
  dialog: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
}));

const {
  scrubErrorText,
  sanitizeIpcError,
  IpcValidationError,
  AuthRequiredError,
} = await import("../src/ipc-boundary");
const { ConfigManager } = await import("../src/config");

const isWindows = process.platform === "win32";
const sep = path.sep;
const gameDir = isWindows ? "C:\\Lampas\\game" : "/opt/lampas/game";
const root = path.parse(gameDir).root;
const foreign = isWindows
  ? "C:\\Users\\Administrator\\secret\\config.json"
  : "/home/markj/lampas-launcher/secret/file.txt";

afterAll(() => {
  fs.rmSync(tempUserData, { recursive: true, force: true });
});

describe("scrubErrorText with launcher-owned path prefixes", () => {
  test("keeps a path under a preserved prefix and still scrubs other paths", () => {
    const own = `${gameDir}${sep}mods${sep}example.jar`;
    const out = scrubErrorText(`Missing ${own} while reading ${foreign}`, [
      gameDir,
    ]);
    expect(out).toContain(own);
    expect(out).not.toContain(foreign);
    expect(out).toContain("<path>");
  });

  test("does not treat a sibling directory with the prefix as a prefix match", () => {
    for (const sibling of [`${gameDir}2`, `${gameDir}-old`, `${gameDir}.bak`]) {
      const out = scrubErrorText(
        `Cannot access ${sibling}${sep}mods${sep}x.jar`,
        [gameDir],
      );
      expect(out).not.toContain(sibling);
      expect(out).toContain("<path>");
    }
  });

  test("scrubs a preserved-prefix path that traverses upward", () => {
    const traversal = `${gameDir}${sep}..${sep}..${sep}secret.txt`;
    const out = scrubErrorText(`Cannot access ${traversal}`, [gameDir]);
    expect(out).not.toContain("secret.txt");
    expect(out).toContain("<path>");
  });

  test("ignores filesystem-root and relative prefixes", () => {
    const underRoot = `${root}etc${sep}passwd`;
    expect(scrubErrorText(`Cannot access ${underRoot}`, [root])).not.toContain(
      "passwd",
    );
    const own = `${gameDir}${sep}mods${sep}example.jar`;
    expect(scrubErrorText(`Cannot access ${own}`, ["game", ""])).not.toContain(
      "example.jar",
    );
  });

  test("strips forged markers instead of restoring attacker-chosen text", () => {
    const own = `${gameDir}${sep}mods${sep}example.jar`;
    const out = scrubErrorText(
      `\u0001P0\u0001 then ${foreign} and \u0001P1\u0001 near ${own}`,
      [gameDir],
    );
    expect(out).not.toContain("\u0001");
    expect(out).not.toContain(foreign);
    expect(out).toContain(own);
  });

  test("still redacts credential values next to a preserved path", () => {
    const own = `${gameDir}${sep}mods${sep}example.jar`;
    const out = scrubErrorText(`token=abc123secret at ${own}`, [gameDir]);
    expect(out).not.toContain("abc123secret");
    expect(out).toContain(own);
  });

  test("matches prefixes case-insensitively only on Windows", () => {
    const own = `${gameDir.toUpperCase()}${sep}mods${sep}example.jar`;
    const out = scrubErrorText(`Cannot access ${own}`, [gameDir]);
    if (isWindows) {
      expect(out).toContain(own);
    } else {
      expect(out).not.toContain("example.jar");
    }
  });

  test("behaves exactly as before when no prefixes are given", () => {
    const own = `${gameDir}${sep}mods${sep}example.jar`;
    expect(scrubErrorText(`Cannot access ${own}`)).not.toContain("example.jar");
    expect(scrubErrorText(`Cannot access ${own}`, [])).not.toContain(
      "example.jar",
    );
  });
});

describe("sanitizeIpcError preserves the configured game directory", () => {
  test("a validation error naming a file under gameDir stays readable", () => {
    const configuredGameDir = ConfigManager.get().gameDir;
    expect(path.isAbsolute(configuredGameDir)).toBe(true);
    const own = path.join(configuredGameDir, "mods", "example.jar");
    const out = sanitizeIpcError(
      new IpcValidationError(`Mod file does not exist: ${own}`),
    );
    expect(out.message).toContain(own);
  });

  test("a validation error naming an unrelated path is still scrubbed", () => {
    const out = sanitizeIpcError(
      new IpcValidationError(`Cannot access file at ${foreign}: denied`),
    );
    expect(out.message).not.toContain(foreign);
    expect(out.message).toContain("<path>");
  });
});

describe("sanitizeIpcError shows sign-in errors", () => {
  test("an AuthRequiredError reaches the renderer with its message", () => {
    const message =
      "Link the Microsoft account that owns Minecraft on the Lampas website, then sign in again.";
    expect(sanitizeIpcError(new AuthRequiredError(message)).message).toBe(
      message,
    );
  });

  test("a plain Error still becomes the generic message", () => {
    expect(
      sanitizeIpcError(new Error("Sign in with your Lampas account to play."))
        .message,
    ).toBe("Operation failed: An unexpected internal error occurred.");
  });
});
