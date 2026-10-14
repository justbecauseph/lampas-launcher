import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-callback-"));
const userDataDir = path.join(testRoot, "user-data");
fs.mkdirSync(userDataDir, { recursive: true });

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : testRoot),
    getName: () => "Lampas Launcher",
    getVersion: () => "1.4.0",
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
}));

const { LauncherAuth } = (await import("../src/auth")) as any;
const { ConfigManager } = await import("../src/config");
const { CredentialStore } = await import("../src/credential-store");
const { PortalPolicy } = await import("../src/portal-policy");
const { SessionManager } = await import("../src/session-manager");
const callbackPage = await import("../src/callback-page");

beforeEach(() => {
  PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
  CredentialStore.resetForTesting();
  SessionManager.resetForTesting();
  ConfigManager.resetForTesting();
});

afterAll(() => {
  CredentialStore.resetForTesting();
  SessionManager.resetForTesting();
  ConfigManager.resetForTesting();
  PortalPolicy.resetForTesting();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("loopback sign-in callback", () => {
  test("delivers the whole success page before the listener closes", async () => {
    // Larger than the loopback socket buffers, so the page is still sending
    // when the login settles. Bun's node:http cut it off when the server
    // closed at that point (Windows CI, with the ~220 KB inlined-font page).
    const page = `<!DOCTYPE html><p>${"x".repeat(8_000_000)}</p>`;
    const pageSpy = spyOn(callbackPage, "renderSuccessHtml").mockReturnValue(
      page,
    );
    const origFetch = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      url: any,
      init: any,
    ) => {
      if (url.toString().includes("/api/v1/auth/exchange")) {
        return new Response(
          JSON.stringify({
            token: "token-callback-delivery",
            user: {
              id: "user-callback-delivery",
              name: "Steve",
              minecraftUuid: "22222222-2222-4222-8222-222222222222",
              minecraftUsername: "SteveMC",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return origFetch(url, init);
    }) as any);

    try {
      const loginPromise = LauncherAuth.loginWithPortal();
      const context = LauncherAuth.activeLoginContext;
      while (!context?.authUrl) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const port = Number(context.authUrl.match(/port=(\d+)/)![1]);
      const state = decodeURIComponent(
        context.authUrl.match(/state=([^&]+)/)![1],
      );

      const res = await origFetch(
        `http://127.0.0.1:${port}/callback?code=good-code&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(200);
      // Read after the login has settled, as a slow browser would.
      await loginPromise;
      const body = await res.text();
      expect(body.length).toBe(page.length);
    } finally {
      LauncherAuth.cancelLogin();
      fetchSpy.mockRestore();
      pageSpy.mockRestore();
    }
  });
});
