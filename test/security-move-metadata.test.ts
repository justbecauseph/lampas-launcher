import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

const testRoot = fs
  .mkdtempSync(path.join(os.tmpdir(), "lampas-move-metadata-"))
  .replace(/[\\/]$/, "");
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : testRoot),
    getName: () => "Lampas Launcher",
    getVersion: () => "1.3.0",
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
}));

const { ConfigManager } = await import("../src/config");
const gameDirectory = await import("../src/game-directory");
const {
  GameDirectoryManager,
  MOVE_RECEIPT_FILENAME,
  RECOVERY_HOLD_FILENAME,
  STAGING_MARKER_FILENAME,
  classifyMoveMetadata,
  quarantineJournal,
} = gameDirectory;

function forceCrossDeviceMove(): void {
  GameDirectoryManager._renameFn = () => {
    const error: any = new Error("EXDEV: cross-device link not permitted");
    error.code = "EXDEV";
    throw error;
  };
}

function foreignMarker(sourceRoot: string): Record<string, string> {
  const operationId = "foreign-op-123";
  return {
    operationId,
    source: path.join(sourceRoot, "unrelated-source"),
    target: path.join(sourceRoot, "unrelated-target"),
    staging: path.join(sourceRoot, `.lampas-moving-${operationId}`),
    timestamp: new Date().toISOString(),
  };
}

function writeReceipt(
  source: string,
  target: string,
  staging: string,
  operationId: string,
  payloadName: string,
  payload: string,
): void {
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  fs.writeFileSync(
    path.join(target, MOVE_RECEIPT_FILENAME),
    JSON.stringify({
      version: 2,
      operationId,
      source,
      target,
      staging,
      fileCount: 1,
      totalBytes: Buffer.byteLength(payload),
      directories: [],
      files: [
        {
          relativePath: payloadName,
          size: Buffer.byteLength(payload),
          sha256: digest,
        },
      ],
      stagingVerified: true,
      timestamp: new Date().toISOString(),
    }),
  );
}

beforeEach(() => {
  ConfigManager.resetForTesting();
  GameDirectoryManager.resetForTesting();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("move metadata fail-closed regressions", () => {
  test("source drift rejects a foreign reserved-name file before source cleanup", async () => {
    const root = fs
      .mkdtempSync(path.join(testRoot, "drift-"))
      .replace(/[\\/]$/, "");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "world.dat"), "world-payload");
    ConfigManager.set({ gameDir: source, gameDirConfigured: true });
    forceCrossDeviceMove();

    let injected = false;
    GameDirectoryManager._copyFn = (from: string, to: string) => {
      fs.copyFileSync(from, to);
      if (!injected) {
        injected = true;
        fs.writeFileSync(
          path.join(source, STAGING_MARKER_FILENAME),
          JSON.stringify(foreignMarker(root)),
        );
      }
    };

    try {
      await expect(
        GameDirectoryManager.moveInstallation(target),
      ).rejects.toThrow(/source drift detected/i);
      expect(fs.existsSync(path.join(source, "world.dat"))).toBe(true);
      expect(fs.existsSync(path.join(source, STAGING_MARKER_FILENAME))).toBe(
        true,
      );
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      GameDirectoryManager.resetForTesting();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovery rejects foreign metadata in the target before deleting source", async () => {
    const root = fs
      .mkdtempSync(path.join(testRoot, "target-foreign-"))
      .replace(/[\\/]$/, "");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const operationId = "target-foreign-op";
    const staging = path.join(root, `.lampas-moving-${operationId}`);
    const payload = "target-payload";
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, "world.dat"), payload);
    fs.writeFileSync(path.join(target, "world.dat"), payload);
    writeReceipt(source, target, staging, operationId, "world.dat", payload);
    fs.writeFileSync(
      path.join(target, STAGING_MARKER_FILENAME),
      JSON.stringify(foreignMarker(root)),
    );
    fs.writeFileSync(
      path.join(userDataDir, "directory-move.json"),
      JSON.stringify({
        version: 2,
        operationId,
        source,
        target,
        staging,
        phase: "cleaning",
      }),
    );
    ConfigManager.set({ gameDir: source, gameDirConfigured: true });

    try {
      await expect(
        GameDirectoryManager.recoverInterruptedMove(),
      ).rejects.toThrow(
        /target directory contains malformed or foreign move metadata/i,
      );
      expect(fs.existsSync(path.join(source, "world.dat"))).toBe(true);
      expect(fs.existsSync(path.join(target, STAGING_MARKER_FILENAME))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(userDataDir, "directory-move.json"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovery rejects foreign metadata in the source before source cleanup", async () => {
    const root = fs
      .mkdtempSync(path.join(testRoot, "source-foreign-"))
      .replace(/[\\/]$/, "");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const operationId = "source-foreign-op";
    const staging = path.join(root, `.lampas-moving-${operationId}`);
    const payload = "source-payload";
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, "world.dat"), payload);
    fs.writeFileSync(path.join(target, "world.dat"), payload);
    writeReceipt(source, target, staging, operationId, "world.dat", payload);
    fs.writeFileSync(
      path.join(source, STAGING_MARKER_FILENAME),
      JSON.stringify(foreignMarker(root)),
    );
    fs.writeFileSync(
      path.join(userDataDir, "directory-move.json"),
      JSON.stringify({
        version: 2,
        operationId,
        source,
        target,
        staging,
        phase: "cleaning",
      }),
    );
    ConfigManager.set({ gameDir: source, gameDirConfigured: true });

    try {
      await expect(
        GameDirectoryManager.recoverInterruptedMove(),
      ).rejects.toThrow(
        /source directory contains malformed or foreign move metadata/i,
      );
      expect(fs.existsSync(path.join(source, "world.dat"))).toBe(true);
      expect(fs.existsSync(path.join(source, STAGING_MARKER_FILENAME))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(userDataDir, "directory-move.json"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifier rejects a reserved marker whose operation identity is inconsistent", () => {
    const root = fs
      .mkdtempSync(path.join(testRoot, "classifier-"))
      .replace(/[\\/]$/, "");
    const markerPath = path.join(root, STAGING_MARKER_FILENAME);
    const operationId = "marker-op-123";
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        operationId,
        source: root,
        target: path.join(testRoot, "target"),
        staging: path.join(testRoot, "not-the-operation-staging"),
        timestamp: new Date().toISOString(),
      }),
    );

    try {
      const scanned = {
        relativePath: STAGING_MARKER_FILENAME,
        absolutePath: markerPath,
        size: fs.statSync(markerPath).size,
        mode: 0o644,
        atimeMs: 0,
        mtimeMs: 0,
      };
      expect(classifyMoveMetadata(scanned, root)).toBe("MALFORMED_OR_FOREIGN");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("hold persistence failure preserves the journal for the next startup", async () => {
    const journalPath = path.join(userDataDir, "directory-move.json");
    const holdPath = path.join(userDataDir, RECOVERY_HOLD_FILENAME);
    fs.writeFileSync(journalPath, "corrupt-journal");

    const originalOpenSync = fs.openSync;
    const openSpy = spyOn(fs, "openSync").mockImplementation(
      (filePath: any, flags: any, mode?: any) => {
        if (String(filePath).startsWith(holdPath)) {
          throw new Error("injected hold persistence failure");
        }
        return originalOpenSync(filePath, flags, mode as any);
      },
    );
    const originalRenameSync = fs.renameSync;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(
      (from: any, to: any) => {
        if (String(to).startsWith(holdPath)) {
          throw new Error("injected hold promotion failure");
        }
        return originalRenameSync(from, to);
      },
    );

    try {
      expect(() =>
        quarantineJournal(journalPath, "injected hold failure"),
      ).toThrow(/failed to persist durable recovery hold/i);
      expect(fs.existsSync(journalPath)).toBe(true);
      expect(fs.existsSync(holdPath)).toBe(false);
      expect(
        fs
          .readdirSync(userDataDir)
          .some((entry) => entry.includes(".quarantine.")),
      ).toBe(false);
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }

    // With the injection removed, the retained journal is still discovered and
    // quarantined on the next startup, leaving a durable hold behind.
    await expect(GameDirectoryManager.recoverInterruptedMove()).rejects.toThrow(
      /quarantined/i,
    );
    expect(fs.existsSync(holdPath)).toBe(true);
  });
});
