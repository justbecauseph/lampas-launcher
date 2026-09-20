import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const {
  copyAtomic,
  copyVerified,
  downloadVerified,
  replaceFile,
  replaceFileSync,
  writeAtomicFile,
  writeAtomicFileSync,
} = await import("../src/file-transfer");
const { reconcileConfigPatches } =
  await import("../src/config-patches/reconciler");

const FIXED_TIME = 1_700_000_000_000;
const FIXED_RANDOM = 0.25;

async function withFixedTempName<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => FIXED_TIME;
  Math.random = () => FIXED_RANDOM;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
}

function partialPath(destination: string): string {
  return `${destination}.partial.${process.pid}.${FIXED_TIME}.${FIXED_RANDOM.toString(16).slice(2)}`;
}

function syncTempPath(destination: string): string {
  return `${destination}.tmp.${process.pid}.${FIXED_TIME}.${FIXED_RANDOM.toString(16).slice(2)}`;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-atomic-staging-"));
  tempRoots.push(root);
  return root;
}

describe("Phase 4 exclusive atomic staging", () => {
  test("copyAtomic collision preserves an unowned staging sentinel", async () => {
    const root = newRoot();
    const source = path.join(root, "source.bin");
    const destination = path.join(root, "destination.bin");
    fs.writeFileSync(source, "new bytes");
    const staging = partialPath(destination);
    fs.writeFileSync(staging, "unowned sentinel");

    await withFixedTempName(async () => {
      await expect(copyAtomic(source, destination)).rejects.toThrow();
    });

    expect(fs.readFileSync(staging, "utf8")).toBe("unowned sentinel");
    expect(fs.existsSync(destination)).toBe(false);
  });

  test("writeAtomicFile collision preserves an unowned staging sentinel", async () => {
    const root = newRoot();
    const destination = path.join(root, "settings.json");
    const staging = partialPath(destination);
    fs.writeFileSync(staging, "unowned sentinel");

    await withFixedTempName(async () => {
      await expect(
        writeAtomicFile(destination, "new settings"),
      ).rejects.toThrow();
    });

    expect(fs.readFileSync(staging, "utf8")).toBe("unowned sentinel");
    expect(fs.existsSync(destination)).toBe(false);
  });

  test("writeAtomicFileSync collision preserves an unowned staging sentinel", async () => {
    const root = newRoot();
    const destination = path.join(root, "settings.json");
    const staging = syncTempPath(destination);
    fs.writeFileSync(staging, "unowned sentinel");

    await withFixedTempName(() => {
      expect(() => writeAtomicFileSync(destination, "new settings")).toThrow();
    });
    expect(fs.readFileSync(staging, "utf8")).toBe("unowned sentinel");
    expect(fs.existsSync(destination)).toBe(false);
  });

  test("verified stream collision preserves an unowned staging sentinel", async () => {
    const root = newRoot();
    const source = path.join(root, "source.bin");
    const destination = path.join(root, "download.bin");
    const payload = Buffer.from("verified payload");
    fs.writeFileSync(source, payload);
    const staging = partialPath(destination);
    fs.writeFileSync(staging, "unowned sentinel");

    await withFixedTempName(async () => {
      await expect(
        copyVerified(source, destination, {
          expectedHash: crypto
            .createHash("sha256")
            .update(payload)
            .digest("hex"),
          expectedSize: payload.length,
        }),
      ).rejects.toThrow();
    });

    expect(fs.readFileSync(staging, "utf8")).toBe("unowned sentinel");
    expect(fs.existsSync(destination)).toBe(false);
  });

  test("missing source with a staging collision preserves the sentinel without an uncaught source error", async () => {
    const root = newRoot();
    const source = path.join(root, "missing-source.bin");
    const destination = path.join(root, "download.bin");
    const staging = partialPath(destination);
    fs.writeFileSync(staging, "unowned sentinel");

    await withFixedTempName(async () => {
      await expect(
        copyVerified(source, destination, {
          expectedHash: "0".repeat(64),
          expectedSize: 1,
        }),
      ).rejects.toThrow();
    });

    expect(fs.readFileSync(staging, "utf8")).toBe("unowned sentinel");
    expect(fs.existsSync(destination)).toBe(false);
  });

  test("missing source errors are observed through the verified transfer promise", async () => {
    const root = newRoot();
    const source = path.join(root, "missing-source.bin");
    const destination = path.join(root, "download.bin");

    await expect(
      copyVerified(source, destination, {
        expectedHash: "0".repeat(64),
        expectedSize: 1,
      }),
    ).rejects.toThrow(/ENOENT|no such file/i);

    expect(fs.existsSync(destination)).toBe(false);
  });

  test("download collision cancels an untouched response body and preserves the staging sentinel", async () => {
    const root = newRoot();
    const destination = path.join(root, "download.bin");
    const staging = partialPath(destination);
    fs.writeFileSync(staging, "unowned sentinel");

    let bodyCancelled = false;
    const originalFetch = globalThis.fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("payload"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body,
    })) as typeof fetch;

    try {
      await withFixedTempName(async () => {
        await expect(
          downloadVerified(
            "https://storage.railway.app/artifact",
            destination,
            {
              expectedHash: crypto
                .createHash("sha256")
                .update("payload")
                .digest("hex"),
              expectedSize: "payload".length,
              attempts: 1,
            },
          ),
        ).rejects.toThrow();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(bodyCancelled).toBe(true);
    expect(fs.readFileSync(staging, "utf8")).toBe("unowned sentinel");
    expect(fs.existsSync(destination)).toBe(false);
  });

  test("config patch staging collision preserves the original config and sentinel", async () => {
    const root = newRoot();
    const destination = path.join(root, "config.properties");
    fs.writeFileSync(destination, "setting=true\n");
    const staging = partialPath(destination);
    fs.writeFileSync(staging, "unowned sentinel");

    await withFixedTempName(async () => {
      await expect(
        reconcileConfigPatches({
          gameDir: root,
          patches: [
            {
              id: "collision-patch",
              revision: 1,
              path: "config.properties",
              adapter: "properties",
              mode: "enforce",
              missingFile: "defer",
              operations: [{ op: "set", path: ["setting"], value: false }],
            },
          ],
          prevState: {
            pack: "Lampas 2",
            version: "1.0.0",
            installedAt: new Date(0).toISOString(),
            files: {},
          },
        }),
      ).rejects.toThrow();
    });

    expect(fs.readFileSync(destination, "utf8")).toBe("setting=true\n");
    expect(fs.readFileSync(staging, "utf8")).toBe("unowned sentinel");
  });

  test("sync replacement rejects a directory without moving its contents", () => {
    const root = newRoot();
    const destination = path.join(root, "destination");
    const staged = path.join(root, "staged.tmp");
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "sentinel.txt"), "preserve me");
    fs.writeFileSync(staged, "new content");

    expect(() => replaceFileSync(staged, destination)).toThrow();
    expect(fs.existsSync(destination)).toBe(true);
    expect(
      fs.readFileSync(path.join(destination, "sentinel.txt"), "utf8"),
    ).toBe("preserve me");
    expect(fs.existsSync(staged)).toBe(true);
  });

  test("async replacement rejects a directory without moving its contents", async () => {
    const root = newRoot();
    const destination = path.join(root, "destination");
    const staged = path.join(root, "staged.tmp");
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "sentinel.txt"), "preserve me");
    fs.writeFileSync(staged, "new content");

    await expect(replaceFile(staged, destination)).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(true);
    expect(
      fs.readFileSync(path.join(destination, "sentinel.txt"), "utf8"),
    ).toBe("preserve me");
    expect(fs.existsSync(staged)).toBe(true);
  });

  test("failed async promotion restores the original destination", async () => {
    const root = newRoot();
    const destination = path.join(root, "destination.txt");
    const staged = path.join(root, "staged.tmp");
    fs.writeFileSync(destination, "original");
    fs.writeFileSync(staged, "replacement");

    const realRename = fs.promises.rename.bind(fs.promises);
    let renameCalls = 0;
    const renameSpy = spyOn(fs.promises, "rename").mockImplementation(
      async (source, target) => {
        renameCalls++;
        if (renameCalls === 1) {
          const error: any = new Error("destination occupied");
          error.code = "EEXIST";
          throw error;
        }
        if (renameCalls === 3) throw new Error("promotion failed");
        return realRename(source, target);
      },
    );

    try {
      await expect(replaceFile(staged, destination)).rejects.toThrow(
        "promotion failed",
      );
      expect(fs.readFileSync(destination, "utf8")).toBe("original");
      expect(fs.readFileSync(staged, "utf8")).toBe("replacement");
    } finally {
      renameSpy.mockRestore();
    }
  });

  test("successful async promotion is not rolled back when backup cleanup fails", async () => {
    const root = newRoot();
    const destination = path.join(root, "destination.txt");
    const staged = path.join(root, "staged.tmp");
    fs.writeFileSync(destination, "original");
    fs.writeFileSync(staged, "replacement");

    const realRename = fs.promises.rename.bind(fs.promises);
    let renameCalls = 0;
    const renameSpy = spyOn(fs.promises, "rename").mockImplementation(
      async (source, target) => {
        renameCalls++;
        if (renameCalls === 1) {
          const error: any = new Error("destination occupied");
          error.code = "EEXIST";
          throw error;
        }
        return realRename(source, target);
      },
    );
    const rmSpy = spyOn(fs.promises, "rm").mockImplementation(async () => {
      throw new Error("backup cleanup failed");
    });

    try {
      await replaceFile(staged, destination);
      expect(fs.readFileSync(destination, "utf8")).toBe("replacement");
    } finally {
      rmSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });
});
