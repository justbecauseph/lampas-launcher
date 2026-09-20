import { afterEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { zipSync } from "fflate";

mock.module("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  shell: { openExternal: async () => undefined },
}));

const { MinecraftBootstrap } = await import("../src/minecraft-bootstrap");
const { FabricMetaResolver } = await import("../src/fabric-meta");

const runtime = {
  minecraft: "26.2",
  loader: { type: "fabric" as const, version: "0.19.3" },
};

const rawFabricMetadata = {
  loader: {
    version: "0.19.3",
    maven: "net.fabricmc:fabric-loader:0.19.3",
    sha1: "0".repeat(40),
  },
  intermediary: {
    version: "26.2",
    maven: "net.fabricmc:intermediary:26.2",
    sha1: "1".repeat(40),
  },
  launcherMeta: {
    mainClass: { client: "net.fabricmc.loader.impl.launch.knot.KnotClient" },
    libraries: {
      common: [
        { name: "net.fabricmc:fabric-loader:0.19.3", sha1: "0".repeat(40) },
      ],
      client: [],
    },
  },
};

const validCachedMetadata = {
  loader: rawFabricMetadata.loader,
  intermediary: rawFabricMetadata.intermediary,
  mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
  libraries: [
    { name: "net.fabricmc:fabric-loader:0.19.3", sha1: "0".repeat(40) },
  ],
};

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function directoryLink(target: string, linkPath: string): void {
  fs.symlinkSync(
    target,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("bootstrap and Fabric metadata path ownership regressions", () => {
  test("requires a base for ensureFile before a nested library alias can create directories", async () => {
    const root = tempRoot("lampas-bootstrap-path-1-");
    const libraries = path.join(root, "libraries");
    const outside = tempRoot("lampas-bootstrap-outside-1-");
    fs.mkdirSync(libraries, { recursive: true });
    directoryLink(outside, path.join(libraries, "alias"));
    const outsideSentinel = path.join(outside, "library.jar");
    fs.writeFileSync(outsideSentinel, "keep-me");

    await expect(
      (MinecraftBootstrap as any).ensureFile(
        "data:text/plain,payload",
        path.join(libraries, "alias", "library.jar"),
        undefined,
        undefined,
        "full",
        "sha1",
      ),
    ).rejects.toThrow(/approved base directory/);

    expect(fs.readFileSync(outsideSentinel, "utf-8")).toBe("keep-me");
    expect(fs.existsSync(path.join(outside, "library.jar.partial"))).toBe(
      false,
    );
  });

  test("checks nested library and asset index aliases before mkdir and download", async () => {
    const root = tempRoot("lampas-bootstrap-path-2-");
    const outside = tempRoot("lampas-bootstrap-outside-2-");
    const libraries = path.join(root, "libraries");
    const assets = path.join(root, "assets");
    fs.mkdirSync(libraries, { recursive: true });
    fs.mkdirSync(assets, { recursive: true });
    directoryLink(outside, path.join(libraries, "net"));
    directoryLink(outside, path.join(assets, "indexes"));
    const sentinel = path.join(outside, "sentinel");
    fs.writeFileSync(sentinel, "untouched");

    await expect(
      (MinecraftBootstrap as any).ensureFile(
        "data:text/plain,library",
        path.join(libraries, "net", "fabricmc", "loader.jar"),
        undefined,
        undefined,
        "full",
        "sha1",
        libraries,
      ),
    ).rejects.toThrow(/symbolic link|containment/i);

    await expect(
      (MinecraftBootstrap as any).ensureFile(
        "data:text/plain,index",
        path.join(assets, "indexes", "26.2.json"),
        undefined,
        undefined,
        "full",
        "sha1",
        assets,
      ),
    ).rejects.toThrow(/symbolic link|containment/i);

    expect(fs.readFileSync(sentinel, "utf-8")).toBe("untouched");
  });

  test("native marker publication replaces a hardlink atomically", async () => {
    const root = tempRoot("lampas-bootstrap-native-");
    const gameDir = path.join(root, "game");
    const nativesDir = path.join(gameDir, "natives");
    const markerDir = path.join(gameDir, ".lampas");
    const outside = tempRoot("lampas-bootstrap-native-outside-");
    fs.mkdirSync(nativesDir, { recursive: true });
    fs.mkdirSync(markerDir, { recursive: true });

    const nativeExt =
      process.platform === "win32"
        ? ".dll"
        : process.platform === "darwin"
          ? ".dylib"
          : ".so";
    const archivePath = path.join(root, "native.jar");
    fs.writeFileSync(
      archivePath,
      Buffer.from(
        zipSync({ [`native${nativeExt}`]: new Uint8Array([1, 2, 3]) }),
      ),
    );

    const markerPath = path.join(
      markerDir,
      `natives-26.2-${process.platform}-${process.arch}.json`,
    );
    const outsideAlias = path.join(outside, "marker-alias.json");
    fs.writeFileSync(outsideAlias, "outside-marker");
    fs.linkSync(outsideAlias, markerPath);

    await (MinecraftBootstrap as any).ensureNatives(
      gameDir,
      "26.2",
      [{ path: archivePath, changed: true }],
      () => {},
      "full",
    );

    expect(JSON.parse(fs.readFileSync(markerPath, "utf-8")).version).toBe(
      "26.2",
    );
    expect(fs.readFileSync(outsideAlias, "utf-8")).toBe("outside-marker");
  });

  test("native extraction rejects duplicate basenames and declared expansion before publication", async () => {
    const root = tempRoot("lampas-bootstrap-native-bounds-");
    const gameDir = path.join(root, "game");
    fs.mkdirSync(path.join(gameDir, "natives"), { recursive: true });
    const nativeExt =
      process.platform === "win32"
        ? ".dll"
        : process.platform === "darwin"
          ? ".dylib"
          : ".so";

    const duplicateArchive = path.join(root, "duplicate.jar");
    fs.writeFileSync(
      duplicateArchive,
      Buffer.from(
        zipSync({
          [`first/libdup${nativeExt}`]: new Uint8Array([1]),
          [`second/libdup${nativeExt}`]: new Uint8Array([2]),
        }),
      ),
    );
    await expect(
      (MinecraftBootstrap as any).ensureNatives(
        gameDir,
        "26.2",
        [{ path: duplicateArchive, changed: true }],
        () => {},
        "full",
      ),
    ).rejects.toThrow(/duplicate output basename/i);
    expect(fs.readdirSync(path.join(gameDir, "natives"))).toEqual([]);

    const oversizedArchive = path.join(root, "oversized.jar");
    fs.writeFileSync(
      oversizedArchive,
      Buffer.from(
        zipSync({ [`huge${nativeExt}`]: new Uint8Array(16 * 1024 * 1024 + 1) }),
      ),
    );
    await expect(
      (MinecraftBootstrap as any).ensureNatives(
        gameDir,
        "26.2",
        [{ path: oversizedArchive, changed: true }],
        () => {},
        "full",
      ),
    ).rejects.toThrow(/entry limit|expansion budget/i);
    expect(fs.readdirSync(path.join(gameDir, "natives"))).toEqual([]);
  });

  test("native repair preserves stale output when its receipt ownership hash no longer matches", async () => {
    const root = tempRoot("lampas-bootstrap-native-stale-");
    const gameDir = path.join(root, "game");
    fs.mkdirSync(path.join(gameDir, "natives"), { recursive: true });
    const nativeExt =
      process.platform === "win32"
        ? ".dll"
        : process.platform === "darwin"
          ? ".dylib"
          : ".so";
    const oldName = `old-native${nativeExt}`;
    const newName = `new-native${nativeExt}`;
    const oldArchive = path.join(root, "old.jar");
    const newArchive = path.join(root, "new.jar");
    fs.writeFileSync(
      oldArchive,
      Buffer.from(zipSync({ [oldName]: new Uint8Array([1, 2, 3]) })),
    );
    fs.writeFileSync(
      newArchive,
      Buffer.from(zipSync({ [newName]: new Uint8Array([4, 5, 6]) })),
    );

    await (MinecraftBootstrap as any).ensureNatives(
      gameDir,
      "26.2",
      [{ path: oldArchive, changed: true }],
      () => {},
      "full",
    );
    fs.writeFileSync(path.join(gameDir, "natives", oldName), "user-change");

    await (MinecraftBootstrap as any).ensureNatives(
      gameDir,
      "26.2",
      [{ path: newArchive, changed: true }],
      () => {},
      "full",
    );
    expect(
      fs.readFileSync(path.join(gameDir, "natives", oldName), "utf-8"),
    ).toBe("user-change");
    expect(fs.existsSync(path.join(gameDir, "natives", newName))).toBe(true);
  });

  test("asset marker publication replaces a hardlink atomically", async () => {
    const root = tempRoot("lampas-bootstrap-assets-");
    const assetsDir = path.join(root, "assets");
    const outside = tempRoot("lampas-bootstrap-assets-outside-");
    fs.mkdirSync(assetsDir, { recursive: true });

    const objectBody = Buffer.from("asset-object");
    const objectHash = crypto
      .createHash("sha1")
      .update(objectBody)
      .digest("hex");
    const objectPath = path.join(
      assetsDir,
      "objects",
      objectHash.slice(0, 2),
      objectHash,
    );
    fs.mkdirSync(path.dirname(objectPath), { recursive: true });
    fs.writeFileSync(objectPath, objectBody);

    const indexBody = JSON.stringify({
      objects: { "example.txt": { hash: objectHash, size: objectBody.length } },
    });
    const indexHash = crypto.createHash("sha1").update(indexBody).digest("hex");
    const indexPath = path.join(assetsDir, "indexes", "26.2.json");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, indexBody, "utf-8");
    const markerPath = path.join(assetsDir, `.verified-26.2-${indexHash}`);
    const outsideAlias = path.join(outside, "marker-alias");
    fs.writeFileSync(outsideAlias, "outside-asset-marker");
    fs.linkSync(outsideAlias, markerPath);

    await (MinecraftBootstrap as any).ensureAssets(
      assetsDir,
      {
        id: "26.2",
        sha1: indexHash,
        url: "https://unused.invalid/index.json",
        size: Buffer.byteLength(indexBody),
      },
      () => {},
      "full",
    );

    expect(fs.readFileSync(markerPath, "utf-8")).not.toBe(
      "outside-asset-marker",
    );
    expect(fs.readFileSync(outsideAlias, "utf-8")).toBe("outside-asset-marker");
  });

  test("rejects unsafe Fabric cache fallback before reading through a junction", async () => {
    const root = tempRoot("lampas-fabric-cache-fallback-");
    const cacheDir = path.join(root, "cache");
    const outside = tempRoot("lampas-fabric-cache-outside-");
    const outsideMeta = path.join(outside, "fabric-meta");
    const cachePathOutside = FabricMetaResolver.getCachePath(
      outside,
      "26.2",
      "0.19.3",
    );
    fs.mkdirSync(path.dirname(cachePathOutside), { recursive: true });
    fs.writeFileSync(
      cachePathOutside,
      JSON.stringify(validCachedMetadata),
      "utf-8",
    );
    fs.mkdirSync(cacheDir, { recursive: true });
    directoryLink(outsideMeta, path.join(cacheDir, "fabric-meta"));

    await expect(
      FabricMetaResolver.resolveFabricRuntime(runtime, cacheDir, {
        timeoutMs: 1,
        fetchFn: async (_input, init) => {
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else
              init?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow(/symbolic link|containment/i);
  });

  test("rejects unsafe Fabric cache publication before replacing an outside sentinel", async () => {
    const root = tempRoot("lampas-fabric-cache-write-");
    const cacheDir = path.join(root, "cache");
    const outside = tempRoot("lampas-fabric-cache-write-outside-");
    const outsideMeta = path.join(outside, "fabric-meta");
    const cachePathOutside = FabricMetaResolver.getCachePath(
      outside,
      "26.2",
      "0.19.3",
    );
    fs.mkdirSync(path.dirname(cachePathOutside), { recursive: true });
    fs.writeFileSync(cachePathOutside, "outside-sentinel", "utf-8");
    fs.mkdirSync(cacheDir, { recursive: true });
    directoryLink(outsideMeta, path.join(cacheDir, "fabric-meta"));

    await expect(
      FabricMetaResolver.resolveFabricRuntime(runtime, cacheDir, {
        resolveSidecars: false,
        fetchFn: async () =>
          new Response(JSON.stringify(rawFabricMetadata), { status: 200 }),
      }),
    ).rejects.toThrow(/symbolic link|containment/i);

    expect(fs.readFileSync(cachePathOutside, "utf-8")).toBe("outside-sentinel");
  });

  test("does not turn malformed Fabric metadata into a cache fallback success", async () => {
    const root = tempRoot("lampas-fabric-cache-schema-");
    const cacheDir = path.join(root, "cache");
    const cachePath = FabricMetaResolver.getCachePath(
      cacheDir,
      "26.2",
      "0.19.3",
    );
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(validCachedMetadata), "utf-8");

    await expect(
      FabricMetaResolver.resolveFabricRuntime(runtime, cacheDir, {
        fetchFn: async () => new Response("{ malformed", { status: 200 }),
      }),
    ).rejects.toThrow(/invalid JSON body/i);
  });
});
