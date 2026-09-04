import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FabricMetaResolver,
  parseMavenCoordinate,
  mavenToPath,
  validateFabricRuntimeMetadata,
  PermanentFabricMetaError,
  TransientFabricMetaError,
} from "../src/fabric-meta";
import type { MinecraftRuntimeDefinition } from "../src/types";

describe("FabricMetaResolver & Maven Coordinate Validation (PLAN.md Part D & Hardening)", () => {
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

  describe("Maven Coordinate & Path Validation", () => {
    test("parses valid 3-part and 4-part Maven coordinates", () => {
      const coord3 = parseMavenCoordinate("net.fabricmc:fabric-loader:0.19.3");
      expect(coord3).toEqual({
        group: "net.fabricmc",
        artifact: "fabric-loader",
        version: "0.19.3",
        classifier: undefined,
      });

      const coord4 = parseMavenCoordinate("org.lwjgl:lwjgl:3.4.1:natives-windows");
      expect(coord4).toEqual({
        group: "org.lwjgl",
        artifact: "lwjgl",
        version: "3.4.1",
        classifier: "natives-windows",
      });

      const coordPlus = parseMavenCoordinate("net.fabricmc:sponge-mixin:0.15.3+mixin.0.8.7");
      expect(coordPlus.version).toBe("0.15.3+mixin.0.8.7");
    });

    test("rejects malformed or incomplete Maven coordinates", () => {
      expect(() => parseMavenCoordinate("")).toThrow("coordinate must be a non-empty string");
      expect(() => parseMavenCoordinate("only-one-part")).toThrow("expected 3 or 4 colon-separated parts");
      expect(() => parseMavenCoordinate("group:artifact")).toThrow("expected 3 or 4 colon-separated parts");
      expect(() => parseMavenCoordinate("g:a:v:c:extra")).toThrow("expected 3 or 4 colon-separated parts");
      expect(() => parseMavenCoordinate("  :artifact:version")).toThrow("malformed or unsafe group");
      expect(() => parseMavenCoordinate("group:  :version")).toThrow("malformed or unsafe artifact");
      expect(() => parseMavenCoordinate("group:artifact:  ")).toThrow("malformed or unsafe version");
    });

    test("rejects path traversal, separators, and illegal characters in Maven coordinates", () => {
      expect(() => parseMavenCoordinate("../malicious:artifact:1.0")).toThrow("malformed or unsafe group");
      expect(() => parseMavenCoordinate("group/sub:artifact:1.0")).toThrow("malformed or unsafe group");
      expect(() => parseMavenCoordinate("group\\sub:artifact:1.0")).toThrow("malformed or unsafe group");
      expect(() => parseMavenCoordinate("group:../artifact:1.0")).toThrow("malformed or unsafe artifact");
      expect(() => parseMavenCoordinate("group:artifact:1.0/../../bin")).toThrow("malformed or unsafe version");
      expect(() => parseMavenCoordinate("group:artifact:1.0:nat/ives")).toThrow("malformed or unsafe classifier");
      expect(() => parseMavenCoordinate("group\0:artifact:1.0")).toThrow("malformed or unsafe group");
      expect(() => parseMavenCoordinate("group:artifact:1.0*")).toThrow("malformed or unsafe version");
    });

    test("mavenToPath generates safe normalized paths and prevents escape", () => {
      const path1 = mavenToPath({
        group: "net.fabricmc",
        artifact: "fabric-loader",
        version: "0.19.3",
      });
      expect(path1).toBe("net/fabricmc/fabric-loader/0.19.3/fabric-loader-0.19.3.jar");

      const path2 = mavenToPath({
        group: "org.lwjgl",
        artifact: "lwjgl",
        version: "3.4.1",
        classifier: "natives-windows",
      });
      expect(path2).toBe("org/lwjgl/lwjgl/3.4.1/lwjgl-3.4.1-natives-windows.jar");
    });
  });

  describe("Unified Strict Metadata Validation", () => {
    test("validates complete well-formed metadata structure", () => {
      const validData = {
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: [
          {
            name: "net.fabricmc:fabric-loader:0.19.3",
            url: "https://maven.fabricmc.net/",
            sha256: "73eed8c34bbad0320a2a3cba5346351e822f74f82b3f3c060574068474132958",
          },
        ],
      };

      const result = validateFabricRuntimeMetadata(validData, validRuntime);
      expect(result.loader.version).toBe("0.19.3");
      expect(result.mainClass).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");
      expect(result.libraries[0].sha256).toBe(
        "73eed8c34bbad0320a2a3cba5346351e822f74f82b3f3c060574068474132958"
      );
    });

    test("rejects missing or empty mainClass", () => {
      const badData = {
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        mainClass: "   ",
        libraries: [{ name: "net.fabricmc:fabric-loader:0.19.3" }],
      };
      expect(() => validateFabricRuntimeMetadata(badData, validRuntime)).toThrow(
        "Metadata is missing a valid 'mainClass' string"
      );
    });

    test("rejects malformed library URLs and coordinates", () => {
      const badLibCoord = {
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: [{ name: "not-a-maven-coord" }],
      };
      expect(() => validateFabricRuntimeMetadata(badLibCoord, validRuntime)).toThrow(
        "expected 3 or 4 colon-separated parts"
      );

      const badLibUrl = {
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: [{ name: "group:artifact:1.0", url: "ftp://unsafe.repo.net" }],
      };
      expect(() => validateFabricRuntimeMetadata(badLibUrl, validRuntime)).toThrow(
        "url must be HTTP or HTTPS"
      );
    });

    test("rejects invalid sha256 or sha1 checksum strings", () => {
      const badHash = {
        loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
        intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: [{ name: "group:artifact:1.0", sha256: "not-64-hex-characters" }],
      };
      expect(() => validateFabricRuntimeMetadata(badHash, validRuntime)).toThrow(
        "invalid sha256 checksum"
      );
    });
  });

  describe("HTTP Fallback Semantics & Error Classification", () => {
    test("permanent 4xx errors fail immediately without cache fallback", async () => {
      // Seed cache
      const cachePath = FabricMetaResolver.getCachePath(cacheDir, "26.2", "0.19.3");
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
          intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
          mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
          libraries: [{ name: "net.fabricmc:fabric-loader:0.19.3" }],
        }),
        "utf-8"
      );

      // 404
      const fetch404 = async () => new Response("Not Found", { status: 404 });
      await expect(
        FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, { fetchFn: fetch404 })
      ).rejects.toThrow("Fabric Meta returned HTTP 404");

      // 400 Bad Request
      const fetch400 = async () => new Response("Bad Request", { status: 400 });
      await expect(
        FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, { fetchFn: fetch400 })
      ).rejects.toThrow("Fabric Meta returned HTTP 400");
    });

    test("transient errors (500, 429, timeout) fall back to exact cache", async () => {
      // Seed valid cache
      const cachePath = FabricMetaResolver.getCachePath(cacheDir, "26.2", "0.19.3");
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          loader: { version: "0.19.3", maven: "net.fabricmc:fabric-loader:0.19.3" },
          intermediary: { version: "26.2", maven: "net.fabricmc:intermediary:26.2" },
          mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
          libraries: [{ name: "net.fabricmc:fabric-loader:0.19.3" }],
        }),
        "utf-8"
      );

      // HTTP 500
      const fetch500 = async () => new Response("Internal Server Error", { status: 500 });
      const res500 = await FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
        fetchFn: fetch500,
      });
      expect(res500.loader.version).toBe("0.19.3");

      // HTTP 429 Too Many Requests
      const fetch429 = async () => new Response("Rate Limited", { status: 429 });
      const res429 = await FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
        fetchFn: fetch429,
      });
      expect(res429.loader.version).toBe("0.19.3");

      // Network connection error
      const fetchConnErr = async () => {
        throw new Error("Connection reset by peer");
      };
      const resConn = await FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
        fetchFn: fetchConnErr,
      });
      expect(resConn.loader.version).toBe("0.19.3");
    });
  });

  describe("Atomic Cache Writes & Sidecar Checksums", () => {
    test("resolves sidecar checksums and writes cache atomically", async () => {
      const mockFetch = async (input: string | URL | Request) => {
        const urlStr = input.toString();
        if (urlStr.endsWith(".sha256")) {
          return new Response(
            "73eed8c34bbad0320a2a3cba5346351e822f74f82b3f3c060574068474132958\n",
            { status: 200 }
          );
        }
        if (urlStr.endsWith(".sha1")) {
          return new Response("354dfaa02d0552e11867f85dff7cdbfaf813ba3e\n", { status: 200 });
        }
        return new Response(JSON.stringify(sampleMetaPayload), { status: 200 });
      };

      const metadata = await FabricMetaResolver.resolveFabricRuntime(validRuntime, cacheDir, {
        fetchFn: mockFetch,
      });

      // Assert sidecar was resolved
      const loaderLib = metadata.libraries.find((l) => l.name === "net.fabricmc:fabric-loader:0.19.3");
      expect(loaderLib?.sha256).toBe(
        "73eed8c34bbad0320a2a3cba5346351e822f74f82b3f3c060574068474132958"
      );

      // Assert cache file exists and contains valid JSON with sha256
      const cachePath = FabricMetaResolver.getCachePath(cacheDir, "26.2", "0.19.3");
      expect(fs.existsSync(cachePath)).toBe(true);

      const cachedJson = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      expect(cachedJson.loader.version).toBe("0.19.3");
      expect(cachedJson.libraries[0].sha256).toBe(
        "73eed8c34bbad0320a2a3cba5346351e822f74f82b3f3c060574068474132958"
      );
    });
  });
});
