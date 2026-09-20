import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-sync-safety-test-"),
);

mock.module("electron", () => ({
  app: {
    getPath: () => testRoot,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
}));

const { ConfigManager, PortalPolicy } = await import("../src/config");
const { MinecraftBootstrap } = await import("../src/minecraft-bootstrap");
const { JavaRuntimeManager } = await import("../src/java-runtime");
const { LauncherSync } = await import("../src/sync");
const {
  SyncSafetyPersistenceError,
  assertSyncSafetyAdmission,
  persistSyncSafetyBlock,
} = await import("../src/sync-safety");

const release = {
  schemaVersion: 1,
  pack: "Lampas 2",
  version: "2.5.0",
  minecraft: "26.2",
  loader: { type: "fabric", version: "0.19.3" },
  minimumLauncherVersion: "1.0.0",
  protocol: 3,
  created: "2026-01-01T00:00:00.000Z",
  clientManifest: "/api/v1/releases/2.5.0/client-manifest",
  serverManifest: "/api/v1/releases/2.5.0/server-manifest",
};

const manifest = {
  schemaVersion: 2,
  pack: "Lampas 2",
  version: "2.5.0",
  target: "client",
  minecraft: "26.2",
  loader: { type: "fabric", version: "0.19.3" },
  protocol: 3,
  files: [],
  mods: [],
};

describe("Phase 5 sync safety latch", () => {
  test("persists a denial block, rejects launch admission, and clears after validated sync", async () => {
    const gameDir = path.join(testRoot, "denial-game");
    PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
    let revoked = true;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/api/v1/channels/stable")
          return Response.json({
            channel: "stable",
            version: "2.5.0",
            release: "/api/v1/releases/2.5.0",
          });
        if (pathname === "/api/v1/releases/2.5.0" && revoked)
          return new Response(
            JSON.stringify({ error: "revoked", status: "REVOKED" }),
            { status: 410 },
          );
        if (pathname === "/api/v1/releases/2.5.0")
          return Response.json(release);
        if (pathname === "/api/v1/releases/2.5.0/client-manifest")
          return Response.json(manifest);
        return new Response("Not Found", { status: 404 });
      },
    });
    try {
      const deniedOrigin = `http://127.0.0.1:${server.port}`;
      ConfigManager.resetForTesting();
      ConfigManager.set({
        portalUrl: deniedOrigin,
        selectedChannel: "stable",
        gameDir,
      });
      ConfigManager.establishSession(deniedOrigin, {
        token: "safety-denial-token",
      });
      await expect(LauncherSync.syncClient(() => {})).rejects.toThrow(
        /REVOKED/,
      );

      const markerPath = path.join(gameDir, ".lampas", "sync-safety.json");
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toMatchObject({
        reason: "DENIAL",
        channel: "stable",
      });
      expect(() =>
        assertSyncSafetyAdmission({
          origin: deniedOrigin,
          channel: "stable",
          gameDir,
        }),
      ).toThrow(/blocked/);
      revoked = false;
      const validOrigin = deniedOrigin;
      ConfigManager.set({
        portalUrl: validOrigin,
        selectedChannel: "stable",
        gameDir,
      });
      ConfigManager.establishSession(validOrigin, {
        token: "safety-valid-token",
      });
      await expect(LauncherSync.syncClient(() => {})).resolves.toMatchObject({
        success: true,
        version: "2.5.0",
      });
      expect(
        fs.existsSync(path.join(gameDir, ".lampas", "sync-safety.json")),
      ).toBe(false);
      expect(() =>
        assertSyncSafetyAdmission({
          origin: validOrigin,
          channel: "stable",
          gameDir,
        }),
      ).not.toThrow();

      // A pack-only full pass does not validate bootstrap and Java. An
      // existing runtime integrity block must therefore survive it.
      await persistSyncSafetyBlock(
        { origin: validOrigin, channel: "stable", gameDir },
        "INTEGRITY",
        new Error("runtime receipt mismatch"),
      );
      await expect(
        LauncherSync.syncClient(() => {}, "full"),
      ).resolves.toMatchObject({ success: true, version: "2.5.0" });
      expect(() =>
        assertSyncSafetyAdmission({
          origin: validOrigin,
          channel: "stable",
          gameDir,
        }),
      ).toThrow(/blocked/);
    } finally {
      server.stop();
      PortalPolicy.resetForTesting();
    }
  });

  test("keeps a prior block fail-closed across a channel context change", async () => {
    const gameDir = path.join(testRoot, "context-game");
    const origin = "https://dev.lampas.town";
    await persistSyncSafetyBlock(
      { origin, channel: "stable", gameDir },
      "SCHEMA",
      new Error("invalid release metadata"),
    );
    expect(() =>
      assertSyncSafetyAdmission({ origin, channel: "stable", gameDir }),
    ).toThrow(/blocked/);
    expect(() =>
      assertSyncSafetyAdmission({ origin, channel: "beta", gameDir }),
    ).toThrow(/blocked/);
    expect(
      fs.existsSync(path.join(gameDir, ".lampas", "sync-safety.json")),
    ).toBe(true);
  });

  test("keeps an in-memory block across persistence failure and context changes", async () => {
    const gameDir = path.join(testRoot, "persistence-failure-game");
    fs.mkdirSync(gameDir, { recursive: true });
    // A file where .lampas must be prevents the durable write. The process
    // latch is still required to block this physical instance.
    fs.writeFileSync(path.join(gameDir, ".lampas"), "occupied");
    await expect(
      persistSyncSafetyBlock(
        { origin: "https://portal-a.example", channel: "stable", gameDir },
        "DENIAL",
        new Error("403 denied"),
      ),
    ).rejects.toBeInstanceOf(SyncSafetyPersistenceError);
    fs.rmSync(path.join(gameDir, ".lampas"), { force: true });
    expect(() =>
      assertSyncSafetyAdmission({
        origin: "https://portal-a.example",
        channel: "stable",
        gameDir,
      }),
    ).toThrow(/blocked/);
    expect(() =>
      assertSyncSafetyAdmission({
        origin: "https://portal-b.example",
        channel: "beta",
        gameDir,
      }),
    ).toThrow(/blocked/);
  });

  test("preserves integrity severity through later denial and fast clear", async () => {
    const gameDir = path.join(testRoot, "integrity-severity-game");
    await persistSyncSafetyBlock(
      { origin: "https://dev.lampas.town", channel: "stable", gameDir },
      "INTEGRITY",
      new Error("runtime receipt mismatch"),
    );
    await persistSyncSafetyBlock(
      { origin: "https://dev.lampas.town", channel: "stable", gameDir },
      "DENIAL",
      new Error("403 denied"),
    );
    const marker = JSON.parse(
      fs.readFileSync(
        path.join(gameDir, ".lampas", "sync-safety.json"),
        "utf8",
      ),
    );
    expect(marker.reason).toBe("INTEGRITY");
    const { clearSyncSafetyBlock } = await import("../src/sync-safety");
    clearSyncSafetyBlock(gameDir);
    expect(() =>
      assertSyncSafetyAdmission({
        origin: "https://dev.lampas.town",
        channel: "stable",
        gameDir,
      }),
    ).toThrow(/blocked/);
    clearSyncSafetyBlock(gameDir, { requireFullValidation: true });
    expect(() =>
      assertSyncSafetyAdmission({
        origin: "https://dev.lampas.town",
        channel: "stable",
        gameDir,
      }),
    ).not.toThrow();
  });

  test("preserves an in-memory integrity block when a stronger marker write fails", async () => {
    const gameDir = path.join(testRoot, "stronger-write-failure-game");
    const origin = "https://dev.lampas.town";
    await persistSyncSafetyBlock(
      { origin, channel: "stable", gameDir },
      "DENIAL",
      new Error("403 denied"),
    );
    const originalRename = fs.promises.rename.bind(fs.promises);
    let renameCalls = 0;
    const renameSpy = spyOn(fs.promises, "rename").mockImplementation(
      async (source, target) => {
        renameCalls++;
        if (renameCalls === 1) {
          const error: any = new Error("destination occupied");
          error.code = "EEXIST";
          throw error;
        }
        if (renameCalls === 3) throw new Error("injected hold write failure");
        return originalRename(source, target);
      },
    );
    try {
      await expect(
        persistSyncSafetyBlock(
          { origin, channel: "stable", gameDir },
          "INTEGRITY",
          new Error("runtime receipt mismatch"),
        ),
      ).rejects.toBeInstanceOf(SyncSafetyPersistenceError);
    } finally {
      renameSpy.mockRestore();
    }
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(gameDir, ".lampas", "sync-safety.json"),
          "utf8",
        ),
      ).reason,
    ).toBe("DENIAL");
    // A later denial must not downgrade the in-memory integrity requirement
    // left behind by the failed stronger write.
    await persistSyncSafetyBlock(
      { origin, channel: "stable", gameDir },
      "DENIAL",
      new Error("403 denied again"),
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(gameDir, ".lampas", "sync-safety.json"),
          "utf8",
        ),
      ).reason,
    ).toBe("INTEGRITY");
    const { clearSyncSafetyBlock } = await import("../src/sync-safety");
    clearSyncSafetyBlock(gameDir);
    expect(() =>
      assertSyncSafetyAdmission({ origin, channel: "stable", gameDir }),
    ).toThrow(/blocked/);
    clearSyncSafetyBlock(gameDir, { requireFullValidation: true });
  });

  test("sanitizes complete failure text before applying the marker bound", async () => {
    const gameDir = path.join(testRoot, "sanitization-game");
    const secret = "secret-after-the-marker-prefix-" + "x".repeat(600);
    const failure = `request https://user:password@portal.example/api?access_token=${secret}&signature=signed-value#fragment`;
    await persistSyncSafetyBlock(
      { origin: "https://dev.lampas.town", channel: "stable", gameDir },
      "DENIAL",
      new Error(failure),
    );
    const markerText = fs.readFileSync(
      path.join(gameDir, ".lampas", "sync-safety.json"),
      "utf8",
    );
    expect(markerText).not.toContain("user:password@");
    expect(markerText).not.toContain(secret);
    expect(markerText).not.toContain("signature=signed-value");
    expect(markerText.length).toBeLessThan(2_000);
  });

  test("rejects an oversized marker before parsing it", async () => {
    const gameDir = path.join(testRoot, "oversized-marker-game");
    const stateDir = path.join(gameDir, ".lampas");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "sync-safety.json"),
      "{" + "x".repeat(70 * 1024) + "}",
    );
    expect(() =>
      assertSyncSafetyAdmission({
        origin: "https://dev.lampas.town",
        channel: "stable",
        gameDir,
      }),
    ).toThrow(/contained|Malformed/);
  });

  test("rejects a .lampas junction before touching the outside marker", async () => {
    const gameDir = path.join(testRoot, "junction-marker-game");
    const outside = path.join(testRoot, "junction-marker-outside");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const outsideMarker = path.join(outside, "sync-safety.json");
    fs.writeFileSync(outsideMarker, "outside-sentinel");
    fs.symlinkSync(outside, path.join(gameDir, ".lampas"), "junction");
    expect(() =>
      assertSyncSafetyAdmission({
        origin: "https://dev.lampas.town",
        channel: "stable",
        gameDir,
      }),
    ).toThrow(/contained/);
    expect(fs.readFileSync(outsideMarker, "utf8")).toBe("outside-sentinel");
  });

  test("retains the latch when full repair fails after pack synchronization", async () => {
    const gameDir = path.join(testRoot, "repair-failure-game");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/api/v1/channels/stable")
          return Response.json({
            channel: "stable",
            version: "2.5.0",
            release: "/api/v1/releases/2.5.0",
          });
        if (pathname === "/api/v1/releases/2.5.0")
          return Response.json(release);
        if (pathname === "/api/v1/releases/2.5.0/client-manifest")
          return Response.json(manifest);
        return new Response("Not Found", { status: 404 });
      },
    });
    const bootstrapSpy = spyOn(
      MinecraftBootstrap,
      "prepareGameEnvironment",
    ).mockImplementation(async () => {
      // This is persisted before bootstrap, so abrupt process termination at
      // this boundary cannot bypass admission on the next launcher process.
      const marker = JSON.parse(
        fs.readFileSync(
          path.join(gameDir, ".lampas", "sync-safety.json"),
          "utf8",
        ),
      );
      expect(marker.reason).toBe("INTEGRITY");
      throw new Error("bootstrap receipt verification failed");
    });
    const javaSpy = spyOn(
      JavaRuntimeManager,
      "ensureJava25",
    ).mockImplementation(async () => "C:\\Java25\\bin\\java.exe");
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
      ConfigManager.resetForTesting();
      ConfigManager.set({
        portalUrl: origin,
        selectedChannel: "stable",
        gameDir,
      });
      ConfigManager.establishSession(origin, { token: "repair-failure-token" });
      await expect(LauncherSync.repairInstallation(() => {})).rejects.toThrow(
        /bootstrap receipt/,
      );
      // A later pack-only sync must not clear the incomplete runtime repair.
      await expect(LauncherSync.syncClient(() => {})).resolves.toMatchObject({
        success: true,
        version: "2.5.0",
      });
      expect(() =>
        assertSyncSafetyAdmission({ origin, channel: "stable", gameDir }),
      ).toThrow(/blocked/);
    } finally {
      bootstrapSpy.mockRestore();
      javaSpy.mockRestore();
      server.stop();
      PortalPolicy.resetForTesting();
    }
  });

  test("does not begin repair when its crash recovery marker cannot be persisted", async () => {
    const gameDir = path.join(testRoot, "repair-intent-write-failure");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, ".lampas"), "occupied-sentinel");
    PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
    ConfigManager.resetForTesting();
    ConfigManager.set({
      portalUrl: "https://dev.lampas.town",
      selectedChannel: "stable",
      gameDir,
    });
    const repairSpy = spyOn(
      LauncherSync as any,
      "repairInstallationInternal",
    ).mockImplementation(async () => {
      throw new Error("repair must not start");
    });
    try {
      await expect(
        LauncherSync.repairInstallation(() => {}),
      ).rejects.toBeInstanceOf(SyncSafetyPersistenceError);
      expect(repairSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(gameDir, ".lampas"), "utf8")).toBe(
        "occupied-sentinel",
      );
    } finally {
      repairSpy.mockRestore();
      PortalPolicy.resetForTesting();
    }
  });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
