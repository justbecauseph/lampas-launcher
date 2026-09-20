import { describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("electron", () => ({
  app: { getPath: () => "C:\\DummyAppData" },
  shell: { openExternal: async () => undefined },
}));

const {
  MinecraftBootstrap,
  parseMavenCoordinate,
  mavenToPath,
  isLibraryAllowed,
} = await import("../src/minecraft-bootstrap");
import versionMetadata from "../src/version-meta-26.2.json";
import type { MavenCoordinate } from "../src/minecraft-bootstrap";
const { PortalPolicy } = await import("../src/config");
import type { MinecraftRuntimeDefinition } from "../src/types";

describe("MinecraftBootstrap Coordinate Parsing & Scope Guard (PLAN.md Part D)", () => {
  test("selects one FreeType native for each architecture from the actual pinned metadata", () => {
    const libraries = versionMetadata.libraries as MavenCoordinate[];
    for (const [platform, arch, artifact] of [
      ["win32", "x64", "lwjgl-freetype-natives-windows"],
      ["win32", "ia32", "lwjgl-freetype-natives-windows-x86"],
      ["win32", "arm64", "lwjgl-freetype-natives-windows-arm64"],
      ["linux", "x64", "lwjgl-freetype-natives-linux"],
      ["linux", "arm64", "lwjgl-freetype-natives-linux-arm64"],
      ["darwin", "x64", "lwjgl-freetype-natives-macos"],
      ["darwin", "arm64", "lwjgl-freetype-natives-macos-arm64"],
    ] as const) {
      const selected = libraries.filter((lib) =>
        isLibraryAllowed(lib, platform, arch),
      );
      expect(
        selected
          .filter((lib) => lib.name.includes("lwjgl-freetype-natives-"))
          .map((lib) => parseMavenCoordinate(lib.name).artifact),
      ).toEqual([artifact]);
      expect(
        selected.some((lib) => lib.name === "org.lwjgl:lwjgl-freetype:3.4.1"),
      ).toBe(true);
    }
  });

  test("filters native classifiers even when OS rules are generic or absent", () => {
    expect(
      isLibraryAllowed(
        { name: "org.lwjgl:lwjgl:3.4.1:natives-windows-arm64" },
        "win32",
        "x64",
      ),
    ).toBe(false);
    expect(
      isLibraryAllowed(
        { name: "org.lwjgl:lwjgl:3.4.1:natives-windows" },
        "win32",
        "x64",
      ),
    ).toBe(true);
    expect(
      isLibraryAllowed(
        { name: "org.lwjgl:lwjgl:3.4.1:natives-linux" },
        "win32",
        "x64",
      ),
    ).toBe(false);
    expect(
      isLibraryAllowed(
        { name: "org.lwjgl:lwjgl:3.4.1:natives-windows-unknown" },
        "win32",
        "x64",
      ),
    ).toBe(false);
  });

  test("parseMavenCoordinate correctly parses 3-part and 4-part coordinates", () => {
    const standard = parseMavenCoordinate("net.fabricmc:fabric-loader:0.19.3");
    expect(standard).toEqual({
      group: "net.fabricmc",
      artifact: "fabric-loader",
      version: "0.19.3",
      classifier: undefined,
    });

    const withClassifier = parseMavenCoordinate(
      "org.lwjgl:lwjgl:3.4.1:natives-windows",
    );
    expect(withClassifier).toEqual({
      group: "org.lwjgl",
      artifact: "lwjgl",
      version: "3.4.1",
      classifier: "natives-windows",
    });
  });

  test("mavenToPath generates standard Maven relative repository paths", () => {
    const coord1 = parseMavenCoordinate("net.fabricmc:fabric-loader:0.19.3");
    expect(mavenToPath(coord1)).toBe(
      "net/fabricmc/fabric-loader/0.19.3/fabric-loader-0.19.3.jar",
    );

    const coord2 = parseMavenCoordinate(
      "org.lwjgl:lwjgl:3.4.1:natives-windows",
    );
    expect(mavenToPath(coord2)).toBe(
      "org/lwjgl/lwjgl/3.4.1/lwjgl-3.4.1-natives-windows.jar",
    );
  });

  test("prepareGameEnvironment rejects non-26.2 Minecraft versions at scope boundary", async () => {
    const non262Runtime: MinecraftRuntimeDefinition = {
      minecraft: "26.3",
      loader: {
        type: "fabric",
        version: "0.19.3",
      },
    };

    await expect(
      MinecraftBootstrap.prepareGameEnvironment(
        "C:\\DummyGameDir",
        non262Runtime,
        () => {},
      ),
    ).rejects.toThrow(
      "Unsupported Minecraft version '26.3'. Lampas Launcher currently only supports Minecraft 26.2.",
    );
  });

  test("prepareGameEnvironment rejects invalid runtime definition before file operations", async () => {
    const invalidRuntime: any = {
      minecraft: "26.2",
      loader: {
        type: "neoforge",
        version: "20.4.0",
      },
    };

    await expect(
      MinecraftBootstrap.prepareGameEnvironment(
        "C:\\DummyGameDir",
        invalidRuntime,
        () => {},
      ),
    ).rejects.toThrow("unsupported loader type 'neoforge'");
  });

  test("ensureFile in full mode redownloads corrupt files and rejects missing hashes", async () => {
    const testFileDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "lampas-ensure-test-"),
    );
    const destPath = path.join(testFileDir, "test-lib.jar");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("healthy-content");
      },
    });
    PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });

    try {
      // 1. Write corrupt content to destPath
      fs.writeFileSync(destPath, "corrupted-content");

      // Compute healthy sha256
      const healthyHash = crypto
        .createHash("sha256")
        .update("healthy-content")
        .digest("hex");

      // In full mode, corrupt file should be detected and re-downloaded
      const changed = await (MinecraftBootstrap as any).ensureFile(
        `http://127.0.0.1:${server.port}/test-lib.jar`,
        destPath,
        healthyHash,
        undefined,
        "full",
        "sha256",
        testFileDir,
      );

      expect(changed).toBe(true);
      expect(fs.readFileSync(destPath, "utf-8")).toBe("healthy-content");

      // 2. Running again with healthy content should return false (no re-download)
      const unchanged = await (MinecraftBootstrap as any).ensureFile(
        `http://127.0.0.1:${server.port}/test-lib.jar`,
        destPath,
        healthyHash,
        undefined,
        "full",
        "sha256",
        testFileDir,
      );
      expect(unchanged).toBe(false);

      // 3. In full mode with NO expected hash, must re-download rather than assume verified
      await expect(
        (MinecraftBootstrap as any).ensureFile(
          `http://127.0.0.1:${server.port}/test-lib.jar`,
          destPath,
          undefined,
          undefined,
          "full",
          "sha256",
          testFileDir,
        ),
      ).rejects.toThrow(/missing an expected SHA256 digest/i);
    } finally {
      server.stop(true);
      PortalPolicy.resetForTesting();
      fs.rmSync(testFileDir, { recursive: true, force: true });
    }
  });
});
