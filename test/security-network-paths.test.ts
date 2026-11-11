import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolated userData and a minimal Electron mock, matching the other security
// tests, so importing ipc-boundary does not read the real launcher config.
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-net-path-"));

mock.module("electron", () => ({
  app: {
    getPath: () => tempUserData,
    getName: () => "Lampas Launcher",
    getVersion: () => "1.4.0",
    isPackaged: false,
  },
  dialog: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
}));

const {
  isNetworkOrDevicePath,
  validateGameDirTarget,
  validateModPaths,
  validateOptionalPath,
  validateShaderPackPaths,
} = await import("../src/ipc-boundary");

// \\evil.example\share\x, //evil.example/share/x, \\?\C:\x, \\.\pipe\x,
// leading spaces before a UNC prefix, and mixed separators.
const WIN32_NETWORK_OR_DEVICE_PATHS = [
  "\\\\evil.example\\share\\x",
  "//evil.example/share/x",
  "\\\\?\\C:\\x",
  "\\\\.\\pipe\\x",
  "  \\\\host\\s",
  "\\/host/share",
  "\\\\?\\UNC\\evil.example\\share",
  "\\??\\UNC\\evil.example\\share",
  "\\??\\C:\\Windows",
];

const WIN32_LOCAL_PATHS = ["C:\\Games\\Lampas", "D:/Games", "relative\\dir"];

const onWindows = process.platform === "win32";

afterAll(() => {
  fs.rmSync(tempUserData, { recursive: true, force: true });
});

describe("isNetworkOrDevicePath", () => {
  test.each(WIN32_NETWORK_OR_DEVICE_PATHS)(
    "flags %j as a network or device path on win32",
    (raw) => {
      expect(isNetworkOrDevicePath(raw, "win32")).toBe(true);
    },
  );

  test.each(WIN32_LOCAL_PATHS)("accepts %j on win32", (raw) => {
    expect(isNetworkOrDevicePath(raw, "win32")).toBe(false);
  });

  test("does not flag UNC-shaped strings on linux", () => {
    expect(isNetworkOrDevicePath("//host/share", "linux")).toBe(false);
    expect(isNetworkOrDevicePath("\\\\host\\share", "linux")).toBe(false);
  });
});

describe("IPC validators reject network and device paths", () => {
  test.skipIf(!onWindows)("validateGameDirTarget rejects a UNC path", () => {
    expect(() => validateGameDirTarget("\\\\evil.example\\share\\x")).toThrow(
      /Network and device paths/,
    );
  });

  // An optional path is a hint, so a network one is dropped, not refused:
  // a player whose saved game folder is on a share must still be able to
  // browse and move.
  test.skipIf(!onWindows)(
    "validateOptionalPath drops network and device paths",
    () => {
      expect(validateOptionalPath("//evil.example/share")).toBeUndefined();
      expect(
        validateOptionalPath("\\??\\UNC\\evil.example\\share"),
      ).toBeUndefined();
    },
  );

  test("validateOptionalPath returns a resolved absolute path", () => {
    const result = validateOptionalPath("file://evil.example/share");
    expect(result).toBe(path.resolve("file://evil.example/share"));
    expect(path.isAbsolute(result!)).toBe(true);
    expect(isNetworkOrDevicePath(result!)).toBe(false);
  });

  test.skipIf(!onWindows)("validateModPaths rejects a UNC .jar path", () => {
    expect(() => validateModPaths(["\\\\evil.example\\share\\a.jar"])).toThrow(
      /Network and device paths/,
    );
  });

  test.skipIf(!onWindows)(
    "validateShaderPackPaths rejects a UNC .zip path",
    () => {
      expect(() =>
        validateShaderPackPaths(["\\\\evil.example\\share\\a.zip"]),
      ).toThrow(/Network and device paths/);
    },
  );

  test.skipIf(!onWindows)(
    "rejects UNC paths before any existsSync or statSync call",
    () => {
      const existsSpy = spyOn(fs, "existsSync");
      const statSpy = spyOn(fs, "statSync");
      try {
        expect(() =>
          validateGameDirTarget("\\\\evil.example\\share\\x"),
        ).toThrow(/Network and device paths/);
        expect(validateOptionalPath("//evil.example/share")).toBeUndefined();
        expect(() =>
          validateModPaths(["\\\\evil.example\\share\\a.jar"]),
        ).toThrow(/Network and device paths/);
        expect(() =>
          validateShaderPackPaths(["\\\\evil.example\\share\\a.zip"]),
        ).toThrow(/Network and device paths/);
        expect(existsSpy).not.toHaveBeenCalled();
        expect(statSpy).not.toHaveBeenCalled();
        // The spy does see the validator's fs calls: a local path reaches it.
        expect(() =>
          validateModPaths([path.join(tempUserData, "missing.jar")]),
        ).toThrow(/does not exist/);
        expect(existsSpy).toHaveBeenCalled();
      } finally {
        existsSpy.mockRestore();
        statSpy.mockRestore();
      }
    },
  );
});

describe("IPC validators still accept local paths", () => {
  test("validateGameDirTarget returns the resolved local absolute path", () => {
    const local = os.tmpdir();
    expect(validateGameDirTarget(local)).toBe(path.resolve(local));
  });

  test("validateOptionalPath returns undefined when no path is given", () => {
    expect(validateOptionalPath(undefined)).toBeUndefined();
  });
});
