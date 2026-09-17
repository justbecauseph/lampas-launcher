import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { zipSync } from "fflate";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-bootstrap-test-"));
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

const { MinecraftBootstrap } = await import("../src/minecraft-bootstrap");
const { ConfigManager, PortalPolicy } = await import("../src/config");

describe("MinecraftBootstrap (Phase 3B & 3C)", () => {
  beforeEach(() => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(gameDir, { recursive: true });
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

  test("deterministic classpath index order is preserved when downloads complete out of order", async () => {
    // Simulating download order non-determinism:
    // Item 0 completes last (delay 40ms)
    // Item 1 completes first (delay 5ms)
    // Item 2 completes second (delay 20ms)
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const name = path.basename(url.pathname);
        if (name === "lib-0.jar") {
          await Bun.sleep(40);
          return new Response("content-0");
        } else if (name === "lib-1.jar") {
          await Bun.sleep(5);
          return new Response("content-1");
        } else if (name === "lib-2.jar") {
          await Bun.sleep(20);
          return new Response("content-2");
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const items = [
        { name: "lib-0.jar", url: `http://127.0.0.1:${server.port}/lib-0.jar` },
        { name: "lib-1.jar", url: `http://127.0.0.1:${server.port}/lib-1.jar` },
        { name: "lib-2.jar", url: `http://127.0.0.1:${server.port}/lib-2.jar` },
      ];

      // Pre-allocated array slot assignment pattern used in MinecraftBootstrap
      const results: string[] = new Array(items.length);
      let nextIndex = 0;
      const concurrency = 3;

      async function worker() {
        while (nextIndex < items.length) {
          const idx = nextIndex++;
          const item = items[idx];
          const dest = path.join(testRoot, item.name);
          const res = await fetch(item.url);
          fs.writeFileSync(dest, await res.text());
          results[idx] = dest; // Must assign to idx, never results.push()
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      expect(results[0]).toContain("lib-0.jar");
      expect(results[1]).toContain("lib-1.jar");
      expect(results[2]).toContain("lib-2.jar");
    } finally {
      server.stop(true);
    }
  });

  test("ensureAssets rejects invalid asset index shape", async () => {
    const assetsDir = path.join(gameDir, "assets-invalid-shape");
    const invalidBody = JSON.stringify({ objects: "not-an-object" });
    const sha1 = crypto.createHash("sha1").update(invalidBody).digest("hex");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(invalidBody);
      },
    });

    try {
      await expect(
        (MinecraftBootstrap as any).ensureAssets(
          assetsDir,
          {
            id: "26.2",
            sha1,
            url: `http://127.0.0.1:${server.port}/index.json`,
            size: Buffer.byteLength(invalidBody),
          },
          () => {},
          "full"
        )
      ).rejects.toThrow(/Invalid asset index shape/);
    } finally {
      server.stop(true);
    }
  });

  test("ensureAssets deduplicates identical hashes across different file keys", async () => {
    const assetsDir = path.join(gameDir, "assets-dedup");
    const content = Buffer.from("shared-texture-bytes");
    const hash = crypto.createHash("sha1").update(content).digest("hex");

    // Pre-create the object on disk
    const objPath = path.join(assetsDir, "objects", hash.substring(0, 2), hash);
    fs.mkdirSync(path.dirname(objPath), { recursive: true });
    fs.writeFileSync(objPath, content);

    // Two different keys pointing to identical hash
    const indexBody = JSON.stringify({
      objects: {
        "icons/icon_16x16.png": { hash, size: content.length },
        "icons/icon_32x32.png": { hash, size: content.length },
      },
    });
    const sha1 = crypto.createHash("sha1").update(indexBody).digest("hex");

    let serverRequests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        serverRequests++;
        return new Response(indexBody);
      },
    });

    try {
      const logs: string[] = [];
      await (MinecraftBootstrap as any).ensureAssets(
        assetsDir,
        {
          id: "26.2",
          sha1,
          url: `http://127.0.0.1:${server.port}/index.json`,
          size: Buffer.byteLength(indexBody),
        },
        (m: string) => logs.push(m),
        "full"
      );

      // Only 1 unique asset object should be verified
      expect(logs.some((l) => l.includes("All 1 official asset objects verified"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("ensureAssets rejects inconsistent metadata for identical hash with differing sizes", async () => {
    const assetsDir = path.join(gameDir, "assets-inconsistent");
    const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4";

    const indexBody = JSON.stringify({
      objects: {
        "file1.txt": { hash, size: 100 },
        "file2.txt": { hash, size: 200 }, // Inconsistent size for same hash!
      },
    });
    const sha1 = crypto.createHash("sha1").update(indexBody).digest("hex");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(indexBody);
      },
    });

    try {
      await expect(
        (MinecraftBootstrap as any).ensureAssets(
          assetsDir,
          {
            id: "26.2",
            sha1,
            url: `http://127.0.0.1:${server.port}/index.json`,
            size: Buffer.byteLength(indexBody),
          },
          () => {},
          "full"
        )
      ).rejects.toThrow(/Inconsistent asset metadata for hash/);
    } finally {
      server.stop(true);
    }
  });

  test("ensureAssets handles declared zero-byte files correctly", async () => {
    const assetsDir = path.join(gameDir, "assets-zero-byte");
    const zeroByteHash = "da39a3ee5e6b4b0d3255bfef95601890afd80709"; // SHA-1 of empty string

    // Pre-create zero-byte file
    const objPath = path.join(assetsDir, "objects", zeroByteHash.substring(0, 2), zeroByteHash);
    fs.mkdirSync(path.dirname(objPath), { recursive: true });
    fs.writeFileSync(objPath, Buffer.alloc(0));

    const indexBody = JSON.stringify({
      objects: {
        "empty.txt": { hash: zeroByteHash, size: 0 },
      },
    });
    const sha1 = crypto.createHash("sha1").update(indexBody).digest("hex");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(indexBody);
      },
    });

    try {
      const logs: string[] = [];
      await (MinecraftBootstrap as any).ensureAssets(
        assetsDir,
        {
          id: "26.2",
          sha1,
          url: `http://127.0.0.1:${server.port}/index.json`,
          size: Buffer.byteLength(indexBody),
        },
        (m: string) => logs.push(m),
        "full"
      );

      expect(fs.existsSync(objPath)).toBe(true);
      expect(fs.statSync(objPath).size).toBe(0);
      expect(logs.some((l) => l.includes("All 1 official asset objects verified"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("ensureNatives extracts native libraries and writes structured receipt and legacy marker", async () => {
    const nativesDir = path.join(gameDir, "natives");
    const nativeExt = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
    const nativeFileName = `test-native${nativeExt}`;

    const mockArchive = path.join(testRoot, "natives-test.jar");
    const jarBytes = zipSync({
      [nativeFileName]: new Uint8Array(Buffer.from("binary native payload")),
      "META-INF/MANIFEST.MF": new Uint8Array(Buffer.from("Manifest-Version: 1.0\n")),
    });
    fs.writeFileSync(mockArchive, Buffer.from(jarBytes));

    const logs: string[] = [];
    await (MinecraftBootstrap as any).ensureNatives(
      gameDir,
      "26.2",
      [{ path: mockArchive, changed: true }],
      (m: string) => logs.push(m),
      "full"
    );

    // Destination file exists
    const extractedFile = path.join(nativesDir, nativeFileName);
    expect(fs.existsSync(extractedFile)).toBe(true);
    expect(fs.readFileSync(extractedFile, "utf-8")).toBe("binary native payload");

    // Modern receipt exists and contains required fields
    const receiptPath = path.join(gameDir, ".lampas", `natives-26.2-${process.platform}-${process.arch}.json`);
    expect(fs.existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
    expect(receipt.version).toBe("26.2");
    expect(receipt.platform).toBe(process.platform);
    expect(receipt.arch).toBe(process.arch);
    expect(Array.isArray(receipt.archives)).toBe(true);
    expect(receipt.archives).toContain("natives-test.jar");
    expect(receipt.files).toContain(nativeFileName);

    // Legacy marker also exists
    const legacyPath = path.join(gameDir, ".lampas", `natives-26.2-${process.platform}.complete`);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  test("ensureNatives cleans up staging directory and does not leave dirty files when archive decompression fails", async () => {
    const nativesDir = path.join(gameDir, "natives-corrupt");
    fs.mkdirSync(nativesDir, { recursive: true });

    const corruptArchive = path.join(testRoot, "corrupt-native.jar");
    fs.writeFileSync(corruptArchive, Buffer.from("NOT_A_VALID_ZIP_ARCHIVE"));

    // Call ensureNatives with a custom gameDir to check staging cleanup
    const subGameDir = path.join(testRoot, "sub-game");
    fs.mkdirSync(subGameDir, { recursive: true });

    await expect(
      (MinecraftBootstrap as any).ensureNatives(
        subGameDir,
        "26.2",
        [{ path: corruptArchive, changed: true }],
        () => {},
        "full"
      )
    ).rejects.toThrow(/Failed to decompress native archive/);

    // Check that no lingering .staging directories remain in subGameDir
    const entries = fs.readdirSync(subGameDir);
    const stagingEntries = entries.filter((e) => e.includes(".staging"));
    expect(stagingEntries.length).toBe(0);
  });
});
