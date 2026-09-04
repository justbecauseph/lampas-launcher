import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FabricMetaResolver } from "../src/fabric-meta";
import type { MinecraftRuntimeDefinition } from "../src/types";

describe("FabricMetaResolver (PLAN.md Part D & Section 46)", () => {
  let tempDir: string;
  let cacheDir: string;

  const validRuntime: MinecraftRuntimeDefinition = {
    minecraft: "26.2",
    loader: {
      type: "fabric",
      version: "0.19.3",
    },
  };

  const sampleMetaPayload = {
    loader: {
      separator: ".",
      build: 1,
      maven: "net.fabricmc:fabric-loader:0.19.3",
      version: "0.19.3",
      stable: true,
    },
    intermediary: {
      maven: "net.fabricmc:intermediary:26.2",
      version: "26.2",
      stable: true,
    },
    launcherMeta: {
      version: 1,
      min_java_version: 21,
      libraries: {
        client: [
          {
            name: "net.fabricmc:client-lib:1.0.0",
            url: "https://custom.repo.net/",
          },
        ],
        common: [
          {
            name: "org.ow2.asm:asm:9.9",
            url: "https://maven.fabricmc.net/",
          },
          {
            name: "net.fabricmc:sponge-mixin:0.15.3+mixin.0.8.7",
          },
          {
            // Duplicate library to verify deduplication
            name: "net.fabricmc:fabric-loader:0.19.3",
          },
        ],
        server: [],
      },
      mainClass: {
        client: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        server: "net.fabricmc.loader.impl.launch.knot.KnotServer",
      },
    },
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-meta-test-"));
    cacheDir = path.join(tempDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves exact Minecraft and Loader version using correct URL and URL encoding", async () => {
    let capturedUrl = "";
    const mockFetch = async (input: string | URL | Request) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify(sampleMetaPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const runtime: MinecraftRuntimeDefinition = {
      minecraft: "26.2+build.1",
      loader: {
        type: "fabric",
        version: "0.99.123-test/alpha",
      },
    };

    const payloadWithSentinel = {
      ...sampleMetaPayload,
      loader: {
        ...sampleMetaPayload.loader,
        version: "0.99.123-test/alpha",
        maven: "net.fabricmc:fabric-loader:0.99.123-test/alpha",
      },
      intermediary: {
        ...sampleMetaPayload.intermediary,
        version: "26.2+build.1",
        maven: "net.fabricmc:intermediary:26.2+build.1",
      },
    };

    const mockFetchSentinel = async (input: string | URL | Request) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify(payloadWithSentinel), { status: 200 });
    };

    const metadata = await FabricMetaResolver.resolveFabricRuntime(runtime, cacheDir, {
      fetchFn: mockFetchSentinel,
    });

    expect(capturedUrl).toBe(
      "https://meta.fabricmc.net/v2/versions/loader/26.2%2Bbuild.1/0.99.123-test%2Falpha"
    );
    expect(metadata.loader.version).toBe("0.99.123-test/alpha");
    expect(metadata.loader.maven).toBe("net.fabricmc:fabric-loader:0.99.123-test/alpha");
    expect(metadata.intermediary.version).toBe("26.2+build.1");
    expect(metadata.intermediary.maven).toBe("net.fabricmc:intermediary:26.2+build.1");
  });

  test("extracts client main class and deduplicated libraries with repository preservation", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify(sampleMetaPayload), { status: 200 });

    const metadata = await FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
      fetchFn: mockFetch,
    });

    expect(metadata.mainClass).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");

    // Libraries should include loader, intermediary, common, and client libraries
    const libNames = metadata.libraries.map((l) => l.name);
    expect(libNames).toContain("net.fabricmc:fabric-loader:0.19.3");
    expect(libNames).toContain("net.fabricmc:intermediary:26.2");
    expect(libNames).toContain("org.ow2.asm:asm:9.9");
    expect(libNames).toContain("net.fabricmc:sponge-mixin:0.15.3+mixin.0.8.7");
    expect(libNames).toContain("net.fabricmc:client-lib:1.0.0");

    // Deduplication check: fabric-loader was in common libs AND top-level loader, should appear exactly once
    const loaderMatches = libNames.filter((n) => n === "net.fabricmc:fabric-loader:0.19.3");
    expect(loaderMatches.length).toBe(1);

    // Repository preservation check
    const customRepoLib = metadata.libraries.find((l) => l.name === "net.fabricmc:client-lib:1.0.0");
    expect(customRepoLib?.url).toBe("https://custom.repo.net/");

    const defaultRepoLib = metadata.libraries.find((l) => l.name === "net.fabricmc:sponge-mixin:0.15.3+mixin.0.8.7");
    expect(defaultRepoLib?.url).toBe("https://maven.fabricmc.net/");
  });

  test("persists metadata cache to disk keyed by Minecraft and Loader version", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify(sampleMetaPayload), { status: 200 });

    await FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
      fetchFn: mockFetch,
    });

    const expectedCachePath = FabricMetaResolver.getCachePath(
      cacheDir,
      validRuntime.minecraft,
      validRuntime.loader.version
    );
    expect(fs.existsSync(expectedCachePath)).toBe(true);

    const cachedData = JSON.parse(fs.readFileSync(expectedCachePath, "utf-8"));
    expect(cachedData.loader.version).toBe("0.19.3");
    expect(cachedData.mainClass).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");
  });

  test("falls back to cached metadata when network request fails", async () => {
    // Seed cache
    const cachePath = FabricMetaResolver.getCachePath(
      cacheDir,
      validRuntime.minecraft,
      validRuntime.loader.version
    );
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const cachedMetadata = {
      loader: {
        version: "0.19.3",
        maven: "net.fabricmc:fabric-loader:0.19.3",
      },
      intermediary: {
        version: "26.2",
        maven: "net.fabricmc:intermediary:26.2",
      },
      libraries: [
        { name: "net.fabricmc:fabric-loader:0.19.3", url: "https://maven.fabricmc.net/" },
      ],
      mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
    };
    fs.writeFileSync(cachePath, JSON.stringify(cachedMetadata), "utf-8");

    // Network failure mock
    const failingFetch = async () => {
      throw new Error("Network connection refused");
    };

    const result = await FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
      fetchFn: failingFetch,
    });

    expect(result.loader.version).toBe("0.19.3");
    expect(result.mainClass).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");
  });

  test("throws immediately on HTTP 404 without falling back to cache", async () => {
    // Seed cache to prove 404 does NOT fall back
    const cachePath = FabricMetaResolver.getCachePath(
      cacheDir,
      validRuntime.minecraft,
      validRuntime.loader.version
    );
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ loader: { version: "0.19.3" } }), "utf-8");

    const notFoundFetch = async () => new Response("Not Found", { status: 404 });

    await expect(
      FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
        fetchFn: notFoundFetch,
      })
    ).rejects.toThrow("Fabric Loader 0.19.3 is not available for Minecraft 26.2 (Fabric Meta returned 404 Not Found)");
  });

  test("fails when network fails and no offline cache exists", async () => {
    const failingFetch = async () => {
      throw new Error("DNS lookup failed");
    };

    await expect(
      FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
        fetchFn: failingFetch,
      })
    ).rejects.toThrow("Failed to resolve Fabric runtime for Minecraft 26.2 + Loader 0.19.3 and no offline cache exists");
  });

  test("rejects response when returned loader version does not match requested", async () => {
    const mismatchedPayload = {
      ...sampleMetaPayload,
      loader: {
        ...sampleMetaPayload.loader,
        version: "0.19.4", // requested 0.19.3
      },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify(mismatchedPayload), { status: 200 });

    await expect(
      FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
        fetchFn: mockFetch,
      })
    ).rejects.toThrow("Fabric Meta returned loader version '0.19.4', but '0.19.3' was requested");
  });

  test("rejects response missing launcherMeta.mainClass.client", async () => {
    const invalidPayload = {
      ...sampleMetaPayload,
      launcherMeta: {
        ...sampleMetaPayload.launcherMeta,
        mainClass: {},
      },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify(invalidPayload), { status: 200 });

    await expect(
      FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
        fetchFn: mockFetch,
      })
    ).rejects.toThrow("Fabric Meta response is missing launcherMeta.mainClass.client");
  });

  test("cache isolation: different loader or minecraft version does not hit cache", () => {
    const pathA = FabricMetaResolver.getCachePath(cacheDir, "26.2", "0.19.3");
    const pathB = FabricMetaResolver.getCachePath(cacheDir, "26.2", "0.19.4");
    const pathC = FabricMetaResolver.getCachePath(cacheDir, "26.3", "0.19.3");

    expect(pathA).not.toBe(pathB);
    expect(pathA).not.toBe(pathC);
    expect(pathB).not.toBe(pathC);
  });
});
