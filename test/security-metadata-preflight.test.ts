import { afterAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("electron", () => ({
  app: {
    getPath: () => testRoot,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-metadata-preflight-test-"),
);
const gameDir = path.join(testRoot, "game");
const sha256 = "a".repeat(64);

const {
  isTransientMetadataFetchFailure,
  validateChannelResponse,
  validateClientManifest,
  validateInstallationState,
  validateReleaseDescriptor,
} = await import("../src/metadata-policy");
const { HttpResponseError } = await import("../src/file-transfer");
const { ConfigManager, PortalPolicy } = await import("../src/config");
const { LauncherSync } = await import("../src/sync");

const release = {
  schemaVersion: 1,
  pack: "Lampas 2",
  version: "2.5.0",
  minecraft: "26.2",
  loader: { type: "fabric", version: "0.19.3" },
  minimumLauncherVersion: "1.0.0",
  protocol: 3,
  created: "2026-01-01T00:00:00Z",
  clientManifest: "/api/v1/releases/2.5.0/client-manifest",
  serverManifest: "/api/v1/releases/2.5.0/server-manifest",
};

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    pack: "Lampas 2",
    version: "2.5.0",
    target: "client",
    minecraft: "26.2",
    loader: { type: "fabric", version: "0.19.3" },
    protocol: 3,
    files: [
      {
        path: "mods/example.jar",
        size: 1,
        hashes: { sha256 },
        download: { url: "/api/v1/blobs/example", provider: "lampas" },
        policy: "MANAGED",
      },
    ],
    mods: [
      {
        id: "example",
        name: "Example",
        side: "both",
        filename: "example.jar",
        size: 1,
      },
    ],
    ...overrides,
  };
}

describe("Phase 4 metadata preflight", () => {
  test("accepts the published channel, release, and manifest contract", () => {
    const validatedRelease = validateReleaseDescriptor(release);
    expect(
      validateChannelResponse(
        {
          channel: "stable",
          version: "2.5.0",
          release: release.clientManifest.replace("/client-manifest", ""),
        },
        "stable",
      ).version,
    ).toBe("2.5.0");
    expect(() =>
      validateClientManifest(manifest(), validatedRelease),
    ).not.toThrow();
  });

  test("rejects a channel without its release pointer before any fallback", () => {
    expect(() =>
      validateChannelResponse(
        { channel: "stable", version: "2.5.0" },
        "stable",
      ),
    ).toThrow(/release/);
  });

  test("accepts Portal nullable provenance without accepting malformed provenance values", () => {
    expect(() =>
      validateReleaseDescriptor({
        ...release,
        gitCommit: null,
        signature: null,
      }),
    ).not.toThrow();
    for (const gitCommit of [false, 42, {}, ""]) {
      expect(() =>
        validateReleaseDescriptor({ ...release, gitCommit }),
      ).toThrow(/gitCommit/);
    }
  });

  test("rejects a non-semver minimum launcher version", () => {
    expect(() =>
      validateReleaseDescriptor({
        ...release,
        minimumLauncherVersion: "latest",
      }),
    ).toThrow(/semantic version/i);
  });

  test("rejects prototype-sensitive patch keys and cross-release manifest identities", () => {
    const validatedRelease = validateReleaseDescriptor(release);
    expect(() =>
      validateClientManifest(manifest({ version: "2.6.0" }), validatedRelease),
    ).toThrow(/does not match release/);
    const maliciousPatch = {
      id: "bad-patch",
      revision: 1,
      path: "config/options.json",
      adapter: "json",
      mode: "once",
      missingFile: "defer",
      operations: [{ op: "set", path: ["__proto__"], value: true }],
    };
    expect(() =>
      validateClientManifest(
        manifest({ configPatches: [maliciousPatch] }),
        validatedRelease,
      ),
    ).toThrow(/prototype|prohibited/i);
    expect(() =>
      validateReleaseDescriptor({
        ...release,
        serverResourcePack: { path: ".lampas/escape.zip" },
      }),
    ).toThrow(/protected namespace/i);
    expect(() =>
      validateClientManifest(
        manifest({
          files: [{ ...manifest().files[0], size: 2 * 1024 * 1024 * 1024 + 1 }],
        }),
        validatedRelease,
      ),
    ).toThrow(/integer between/i);
  });

  test("rejects malformed installation state instead of silently resetting deletion authority", () => {
    fs.mkdirSync(gameDir, { recursive: true });
    expect(() =>
      validateInstallationState(
        {
          pack: "Lampas 2",
          version: "2.5.0",
          files: {
            "mods/example.jar": { policy: "MANAGED", size: 1, sha256: "bad" },
          },
        },
        gameDir,
      ),
    ).toThrow(/digest|sha256/i);
  });

  test("only transient transport failures are eligible for validated local fallback", () => {
    expect(
      isTransientMetadataFetchFailure(
        new HttpResponseError(401, "Unauthorized", "https://portal.invalid"),
      ),
    ).toBe(false);
    expect(
      isTransientMetadataFetchFailure(
        new HttpResponseError(403, "Forbidden", "https://portal.invalid"),
      ),
    ).toBe(false);
    expect(
      isTransientMetadataFetchFailure(
        new HttpResponseError(410, "Gone", "https://portal.invalid"),
      ),
    ).toBe(false);
    expect(
      isTransientMetadataFetchFailure(
        new HttpResponseError(503, "Unavailable", "https://portal.invalid"),
      ),
    ).toBe(true);
    expect(
      isTransientMetadataFetchFailure(
        new HttpResponseError(700, "Invalid status", "https://portal.invalid"),
      ),
    ).toBe(false);
  });

  test("does not turn a malformed Portal manifest into local fallback success", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/channels/stable")
          return Response.json({
            channel: "stable",
            version: "2.5.0",
            release: "/api/v1/releases/2.5.0",
          });
        if (url.pathname === "/api/v1/releases/2.5.0")
          return Response.json(release);
        if (url.pathname === "/api/v1/releases/2.5.0/client-manifest")
          return Response.json({ ...manifest(), schemaVersion: 99 });
        return new Response("Not Found", { status: 404 });
      },
    });
    try {
      PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
      ConfigManager.resetForTesting();
      ConfigManager.set({
        portalUrl: `http://127.0.0.1:${server.port}`,
        selectedChannel: "stable",
        gameDir,
        customClientMods: [],
        disabledClientMods: [],
      });
      ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, {
        token: "metadata-test-token",
      });
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /schemaVersion|manifest/i,
      );
      expect(
        fs.existsSync(path.join(gameDir, ".lampas", "installation.json")),
      ).toBe(false);
    } finally {
      server.stop(true);
      PortalPolicy.resetForTesting();
    }
  });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
