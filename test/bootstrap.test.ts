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
} = await import("../src/minecraft-bootstrap");
import type { MinecraftRuntimeDefinition } from "../src/types";

describe("MinecraftBootstrap Coordinate Parsing & Scope Guard (PLAN.md Part D)", () => {
  test("parseMavenCoordinate correctly parses 3-part and 4-part coordinates", () => {
    const standard = parseMavenCoordinate("net.fabricmc:fabric-loader:0.19.3");
    expect(standard).toEqual({
      group: "net.fabricmc",
      artifact: "fabric-loader",
      version: "0.19.3",
      classifier: undefined,
    });

    const withClassifier = parseMavenCoordinate("org.lwjgl:lwjgl:3.4.1:natives-windows");
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
      "net/fabricmc/fabric-loader/0.19.3/fabric-loader-0.19.3.jar"
    );

    const coord2 = parseMavenCoordinate("org.lwjgl:lwjgl:3.4.1:natives-windows");
    expect(mavenToPath(coord2)).toBe(
      "org/lwjgl/lwjgl/3.4.1/lwjgl-3.4.1-natives-windows.jar"
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
      MinecraftBootstrap.prepareGameEnvironment("C:\\DummyGameDir", non262Runtime, () => {})
    ).rejects.toThrow(
      "Unsupported Minecraft version '26.3'. Lampas Launcher currently only supports Minecraft 26.2."
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
      MinecraftBootstrap.prepareGameEnvironment("C:\\DummyGameDir", invalidRuntime, () => {})
    ).rejects.toThrow("unsupported loader type 'neoforge'");
  });

  test("ensureFile in full mode redownloads corrupt file when hash mismatches, verifies clean file, and redownloads when no hash is present", async () => {
    const testFileDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-ensure-test-"));
    const destPath = path.join(testFileDir, "test-lib.jar");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("healthy-content");
      },
    });

    try {
      // 1. Write corrupt content to destPath
      fs.writeFileSync(destPath, "corrupted-content");

      // Compute healthy sha256
      const healthyHash = crypto.createHash("sha256").update("healthy-content").digest("hex");

      // In full mode, corrupt file should be detected and re-downloaded
      const changed = await (MinecraftBootstrap as any).ensureFile(
        `http://127.0.0.1:${server.port}/test-lib.jar`,
        destPath,
        healthyHash,
        undefined,
        "full",
        "sha256"
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
        "sha256"
      );
      expect(unchanged).toBe(false);

      // 3. In full mode with NO expected hash, must re-download rather than assume verified
      const redownloadedWithoutHash = await (MinecraftBootstrap as any).ensureFile(
        `http://127.0.0.1:${server.port}/test-lib.jar`,
        destPath,
        undefined,
        undefined,
        "full",
        "sha256"
      );
      expect(redownloadedWithoutHash).toBe(true);
    } finally {
      server.stop(true);
      fs.rmSync(testFileDir, { recursive: true, force: true });
    }
  });
});
