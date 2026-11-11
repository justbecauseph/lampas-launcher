import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lampas-mod-catalog-auth-test-"),
);
const userDataDir = path.join(testRoot, "user-data");
const gameDir = path.join(testRoot, "game");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const { ConfigManager, PortalPolicy } = await import("../src/config");
const { SessionManager } = await import("../src/session-manager");
const { LauncherSync, modCatalogAccessError } = await import("../src/sync");
const { isTransientMetadataFetchFailure } =
  await import("../src/metadata-policy");
const { sanitizeIpcError } = await import("../src/ipc-boundary");

/** Launcher session tokens the fake Portal knows, and the channels each may read. */
const TESTER_TOKEN = "tester-session-token";
const MEMBER_TOKEN = "member-session-token";
const ROTATED_TESTER_TOKEN = "tester-session-token-rotated";
const SESSIONS: Record<string, string[]> = {
  [TESTER_TOKEN]: ["stable", "dev"],
  [ROTATED_TESTER_TOKEN]: ["stable", "dev"],
  [MEMBER_TOKEN]: ["stable"],
};

/** Each channel's release; only the stable release is public. */
const CHANNEL_VERSIONS: Record<string, string> = {
  stable: "3.0.0",
  dev: "3.1.0",
};

interface SeenRequest {
  path: string;
  authorization: string | null;
  userAgent: string | null;
}

interface FakePortal {
  url: string;
  seen: SeenRequest[];
  /** When set, the channel pointer's release URL points at this origin. */
  releaseOrigin: string | null;
  /** When set, the release's client manifest URL points at this origin. */
  manifestOrigin: string | null;
  stop: () => void;
}

/**
 * A Portal with the read gate enforced: the stable channel and its release
 * are public; any other channel, and the descriptor and client manifest of
 * its release, answer 401 without an Authorization header and 403 for a
 * session that may not read that channel.
 */
function startPortal(): FakePortal {
  const portal: FakePortal = {
    url: "",
    seen: [],
    releaseOrigin: null,
    manifestOrigin: null,
    stop: () => {},
  };

  const denial = (req: Request, channel: string): Response | null => {
    if (channel === "stable") return null;
    const header = req.headers.get("authorization");
    if (!header) return new Response("Unauthorized", { status: 401 });
    const allowed = SESSIONS[header.replace(/^Bearer /, "")] || [];
    if (!allowed.includes(channel))
      return new Response("Forbidden", { status: 403 });
    return null;
  };
  const channelOfVersion = (version: string): string | undefined =>
    Object.keys(CHANNEL_VERSIONS).find(
      (channel) => CHANNEL_VERSIONS[channel] === version,
    );

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      portal.seen.push({
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        userAgent: req.headers.get("user-agent"),
      });

      const channelMatch = /^\/api\/v1\/channels\/([^/]+)$/.exec(url.pathname);
      if (channelMatch) {
        const channel = channelMatch[1];
        const version = CHANNEL_VERSIONS[channel];
        if (!version) return new Response("Not Found", { status: 404 });
        const denied = denial(req, channel);
        if (denied) return denied;
        return Response.json({
          channel,
          version,
          release: `${portal.releaseOrigin ?? ""}/api/v1/releases/${version}`,
        });
      }

      const releaseMatch =
        /^\/api\/v1\/releases\/([^/]+)(\/client-manifest)?$/.exec(url.pathname);
      if (releaseMatch) {
        const version = releaseMatch[1];
        const channel = channelOfVersion(version);
        if (!channel) return new Response("Not Found", { status: 404 });
        const denied = denial(req, channel);
        if (denied) return denied;
        if (!releaseMatch[2]) {
          return Response.json({
            schemaVersion: 1,
            pack: "Lampas 2",
            version,
            minecraft: "26.2",
            loader: { type: "fabric", version: "0.19.3" },
            minimumLauncherVersion: "1.0.0",
            protocol: 3,
            created: "2026-01-01T00:00:00Z",
            clientManifest: `${portal.manifestOrigin ?? ""}/api/v1/releases/${version}/client-manifest`,
            serverManifest: `/api/v1/releases/${version}/server-manifest`,
          });
        }
        return Response.json({
          schemaVersion: 2,
          pack: "Lampas 2",
          version,
          target: "client",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          protocol: 3,
          files: [],
          mods: [
            {
              id: `${channel}-mod`,
              name: `${channel} mod`,
              side: "client",
              filename: `${channel}-mod.jar`,
              size: 1024,
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  portal.url = `http://127.0.0.1:${server.port}`;
  portal.stop = () => server.stop(true);
  return portal;
}

const portal = startPortal();
const otherPortal = startPortal();

/** The channel pointer, release descriptor and client manifest of a version. */
function metadataPaths(channel: string): string[] {
  const version = CHANNEL_VERSIONS[channel];
  return [
    `/api/v1/channels/${channel}`,
    `/api/v1/releases/${version}`,
    `/api/v1/releases/${version}/client-manifest`,
  ];
}

function officialIds(mods: any[]): string[] {
  return mods.filter((mod) => mod.source === "official").map((mod) => mod.id);
}

const previousRetryBaseMs = process.env.LAMPAS_TRANSFER_RETRY_BASE_MS;

beforeAll(() => {
  process.env.LAMPAS_TRANSFER_RETRY_BASE_MS = "1";
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gameDir, { recursive: true });
});

beforeEach(() => {
  PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
  ConfigManager.resetForTesting();
  ConfigManager.set({
    portalUrl: portal.url,
    selectedChannel: "stable",
    gameDir,
    customClientMods: [],
    disabledClientMods: [],
  });
  // A session saved by an earlier test must not be restored.
  ConfigManager.clearSession();
  LauncherSync.invalidateModCatalog();
  portal.seen.length = 0;
  portal.releaseOrigin = null;
  portal.manifestOrigin = null;
  otherPortal.seen.length = 0;
});

afterAll(() => {
  portal.stop();
  otherPortal.stop();
  if (previousRetryBaseMs === undefined)
    delete process.env.LAMPAS_TRANSFER_RETRY_BASE_MS;
  else process.env.LAMPAS_TRANSFER_RETRY_BASE_MS = previousRetryBaseMs;
  PortalPolicy.resetForTesting();
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("mod catalog session token", () => {
  test("signed in to this Portal: channel, release and client manifest each carry the session token", async () => {
    ConfigManager.establishSession(portal.url, { token: TESTER_TOKEN });
    ConfigManager.set({ selectedChannel: "dev" });

    const mods = await LauncherSync.getModCatalog();

    // The gated Portal only serves the dev release to a session that may read it.
    expect(officialIds(mods)).toEqual(["dev-mod"]);
    expect(portal.seen.map((request) => request.path)).toEqual(
      metadataPaths("dev"),
    );
    for (const request of portal.seen) {
      expect(request.authorization).toBe(`Bearer ${TESTER_TOKEN}`);
      expect(request.userAgent).toBe("Lampas-Launcher/1.0");
    }
  });

  test("signed in: the public stable channel is also requested with the session token", async () => {
    ConfigManager.establishSession(portal.url, { token: MEMBER_TOKEN });

    const mods = await LauncherSync.getModCatalog();

    expect(officialIds(mods)).toEqual(["stable-mod"]);
    expect(portal.seen.map((request) => request.path)).toEqual(
      metadataPaths("stable"),
    );
    for (const request of portal.seen) {
      expect(request.authorization).toBe(`Bearer ${MEMBER_TOKEN}`);
    }
  });

  test("signed out: no request carries an Authorization header and the stable catalog loads", async () => {
    expect(ConfigManager.get().token).toBeUndefined();

    const mods = await LauncherSync.getModCatalog();

    expect(officialIds(mods)).toEqual(["stable-mod"]);
    expect(portal.seen.map((request) => request.path)).toEqual(
      metadataPaths("stable"),
    );
    for (const request of portal.seen) {
      expect(request.authorization).toBeNull();
      expect(request.userAgent).toBe("Lampas-Launcher/1.0");
    }
  });

  test("a session issued by another Portal is not sent to the configured Portal", async () => {
    ConfigManager.establishSession(portal.url, { token: TESTER_TOKEN });
    // ConfigManager.set() clears the session when portalUrl changes. Change
    // the cached value directly to reach the state the launcher guards
    // against: a token whose sessionPortalUrl is not the configured Portal.
    const config = ConfigManager.get();
    config.portalUrl = otherPortal.url;
    expect(config.token).toBe(TESTER_TOKEN);
    expect(config.sessionPortalUrl).toBe(portal.url);

    const mods = await LauncherSync.getModCatalog();

    expect(officialIds(mods)).toEqual(["stable-mod"]);
    expect(otherPortal.seen.map((request) => request.path)).toEqual(
      metadataPaths("stable"),
    );
    for (const request of otherPortal.seen) {
      expect(request.authorization).toBeNull();
    }
    expect(portal.seen).toEqual([]);
  });

  test("changing portalUrl in settings sends the new Portal no Authorization header", async () => {
    ConfigManager.establishSession(portal.url, { token: TESTER_TOKEN });
    ConfigManager.set({ portalUrl: otherPortal.url });

    await LauncherSync.getModCatalog();

    expect(otherPortal.seen).toHaveLength(3);
    for (const request of otherPortal.seen) {
      expect(request.authorization).toBeNull();
    }
    expect(portal.seen).toEqual([]);
  });

  test("a release pointer on another origin is refused before any request reaches it", async () => {
    ConfigManager.establishSession(portal.url, { token: TESTER_TOKEN });
    portal.releaseOrigin = otherPortal.url;

    await expect(LauncherSync.getModCatalog()).rejects.toThrow(
      /outside the configured Portal/,
    );
    expect(otherPortal.seen).toEqual([]);
  });

  test("a client manifest pointer on another origin is refused before any request reaches it", async () => {
    ConfigManager.establishSession(portal.url, { token: TESTER_TOKEN });
    portal.manifestOrigin = otherPortal.url;

    await expect(LauncherSync.getModCatalog()).rejects.toThrow(
      /outside the configured Portal/,
    );
    expect(otherPortal.seen).toEqual([]);
  });
});

describe("mod catalog cache and session changes", () => {
  test("signing in refetches with the token instead of reusing the signed-out catalog", async () => {
    await LauncherSync.getModCatalog();
    expect(portal.seen).toHaveLength(3);

    ConfigManager.establishSession(portal.url, { token: MEMBER_TOKEN });
    await LauncherSync.getModCatalog();

    expect(portal.seen).toHaveLength(6);
    for (const request of portal.seen.slice(3)) {
      expect(request.authorization).toBe(`Bearer ${MEMBER_TOKEN}`);
    }
  });

  test("signing out refetches without the token instead of reusing the signed-in catalog", async () => {
    ConfigManager.establishSession(portal.url, { token: MEMBER_TOKEN });
    await LauncherSync.getModCatalog();
    expect(portal.seen).toHaveLength(3);

    ConfigManager.clearSession();
    await LauncherSync.getModCatalog();

    expect(portal.seen).toHaveLength(6);
    for (const request of portal.seen.slice(3)) {
      expect(request.authorization).toBeNull();
    }
  });

  test("an unchanged session reuses the cached catalog", async () => {
    ConfigManager.establishSession(portal.url, { token: MEMBER_TOKEN });
    await LauncherSync.getModCatalog();
    await LauncherSync.getModCatalog();
    expect(portal.seen).toHaveLength(3);
  });

  test("invalidating on a session change refetches with a refreshed token", async () => {
    // main.ts registers this listener for the running launcher.
    const unsubscribe = SessionManager.addSessionListener(() =>
      LauncherSync.invalidateModCatalog(),
    );
    try {
      ConfigManager.establishSession(portal.url, { token: TESTER_TOKEN });
      await LauncherSync.getModCatalog();
      expect(portal.seen).toHaveLength(3);

      // Same account, new token: a refresh.
      ConfigManager.establishSession(portal.url, {
        token: ROTATED_TESTER_TOKEN,
      });
      await LauncherSync.getModCatalog();

      expect(portal.seen).toHaveLength(6);
      for (const request of portal.seen.slice(3)) {
        expect(request.authorization).toBe(`Bearer ${ROTATED_TESTER_TOKEN}`);
      }
    } finally {
      unsubscribe();
    }
  });

  test("main.ts invalidates the mod catalog from its session listener", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "main.ts"),
      "utf-8",
    );
    const listeners = source
      .split("SessionManager.addSessionListener(")
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf("\n});")));
    expect(
      listeners.some((body) =>
        /^\s*LauncherSync\.invalidateModCatalog\(\);$/m.test(body),
      ),
    ).toBe(true);
  });

  test("main.ts maps a Portal denial on the sync:getModCatalog handler", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "main.ts"),
      "utf-8",
    );
    const start = source.indexOf('registerSecureHandler("sync:getModCatalog"');
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("\n  );", start));
    expect(handler).toContain("LauncherSync.getModCatalog()");
    expect(handler).toContain("throw modCatalogAccessError(error);");
  });
});

describe("mod catalog Portal denials", () => {
  test("a 401 on the channel request rejects instead of returning a catalog", async () => {
    ConfigManager.set({ selectedChannel: "dev" });

    const error = await LauncherSync.getModCatalog().then(
      () => null,
      (rejection) => rejection,
    );

    expect(error).not.toBeNull();
    expect(error.status).toBe(401);
    expect(isTransientMetadataFetchFailure(error)).toBe(false);
    // Denied on the channel pointer: nothing further is requested.
    expect(portal.seen).toEqual([
      {
        path: "/api/v1/channels/dev",
        authorization: null,
        userAgent: "Lampas-Launcher/1.0",
      },
    ]);
  });

  test("a 403 for a session without access to the channel rejects", async () => {
    ConfigManager.establishSession(portal.url, { token: MEMBER_TOKEN });
    ConfigManager.set({ selectedChannel: "dev" });

    const error = await LauncherSync.getModCatalog().then(
      () => null,
      (rejection) => rejection,
    );

    expect(error).not.toBeNull();
    expect(error.status).toBe(403);
    expect(isTransientMetadataFetchFailure(error)).toBe(false);
    expect(portal.seen).toEqual([
      {
        path: "/api/v1/channels/dev",
        authorization: `Bearer ${MEMBER_TOKEN}`,
        userAgent: "Lampas-Launcher/1.0",
      },
    ]);
  });

  test("a denial is not cached: signing in afterwards loads the channel", async () => {
    ConfigManager.set({ selectedChannel: "dev" });
    await expect(LauncherSync.getModCatalog()).rejects.toMatchObject({
      status: 401,
    });

    ConfigManager.establishSession(portal.url, { token: TESTER_TOKEN });
    const mods = await LauncherSync.getModCatalog();
    expect(officialIds(mods)).toEqual(["dev-mod"]);
  });

  test("the renderer is told to sign in on a 401", async () => {
    ConfigManager.set({ selectedChannel: "dev" });
    const error = await LauncherSync.getModCatalog().catch((e) => e);

    const shown = sanitizeIpcError(modCatalogAccessError(error)).message;

    expect(shown).toMatch(/sign in/i);
    expect(shown).not.toMatch(/unexpected internal error/i);
    expect(shown).not.toContain(portal.url);
  });

  test("the renderer is told the account has no access to the channel on a 403", async () => {
    ConfigManager.establishSession(portal.url, { token: MEMBER_TOKEN });
    ConfigManager.set({ selectedChannel: "dev" });
    const error = await LauncherSync.getModCatalog().catch((e) => e);

    const shown = sanitizeIpcError(modCatalogAccessError(error)).message;

    expect(shown).toMatch(/account/i);
    expect(shown).toMatch(/access to this channel/i);
    expect(shown).not.toMatch(/unexpected internal error/i);
    expect(shown).not.toContain(MEMBER_TOKEN);
  });

  test("other failures are passed through unchanged", () => {
    const notFound = Object.assign(new Error("HTTP 404"), { status: 404 });
    const plain = new Error("boom");
    expect(modCatalogAccessError(notFound)).toBe(notFound);
    expect(modCatalogAccessError(plain)).toBe(plain);
  });
});
