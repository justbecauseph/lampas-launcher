import { describe, expect, mock, test } from "bun:test";
import * as os from "node:os";

mock.module("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  shell: { openExternal: async () => undefined },
}));

const { interpretLatestRelease, parseSemver, LauncherUpdateChecker } =
  await import("../src/update-check");
const { validateTransportUrl } = await import("../src/transport-policy");

const DOWNLOAD =
  "https://github.com/justbecauseph/lampas-launcher/releases/download/v1.6.0";

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.6.0",
    draft: false,
    prerelease: false,
    html_url:
      "https://github.com/justbecauseph/lampas-launcher/releases/tag/v1.6.0",
    assets: [
      {
        name: "LampasLauncher-1.6.0-Linux.AppImage",
        browser_download_url: `${DOWNLOAD}/LampasLauncher-1.6.0-Linux.AppImage`,
      },
      {
        name: "LampasLauncher-1.6.0-Windows.exe",
        browser_download_url: `${DOWNLOAD}/LampasLauncher-1.6.0-Windows.exe`,
      },
      {
        name: "LampasLauncher-Setup-1.6.0.exe",
        browser_download_url: `${DOWNLOAD}/LampasLauncher-Setup-1.6.0.exe`,
      },
    ],
    ...overrides,
  };
}

describe("launcher update check", () => {
  test("parses plain and v-prefixed versions only", () => {
    expect(parseSemver("v1.5.2")).toEqual([1, 5, 2]);
    expect(parseSemver("1.10.0")).toEqual([1, 10, 0]);
    expect(parseSemver("v1.6.0-beta.1")).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
  });

  test("offers the platform's build when a newer release exists", () => {
    expect(interpretLatestRelease(release(), "1.5.2", "win32", false)).toEqual({
      version: "1.6.0",
      releaseUrl:
        "https://github.com/justbecauseph/lampas-launcher/releases/tag/v1.6.0",
      downloadUrl: `${DOWNLOAD}/LampasLauncher-Setup-1.6.0.exe`,
    });
    expect(
      interpretLatestRelease(release(), "1.5.2", "win32", true)?.downloadUrl,
    ).toBe(`${DOWNLOAD}/LampasLauncher-1.6.0-Windows.exe`);
    expect(
      interpretLatestRelease(release(), "1.5.2", "linux", false)?.downloadUrl,
    ).toBe(`${DOWNLOAD}/LampasLauncher-1.6.0-Linux.AppImage`);
    // No matching build (e.g. macOS) falls back to the release page.
    expect(
      interpretLatestRelease(release(), "1.5.2", "darwin", false)?.downloadUrl,
    ).toBe(
      "https://github.com/justbecauseph/lampas-launcher/releases/tag/v1.6.0",
    );
  });

  test("stays quiet when current, ahead, or the release is not final", () => {
    expect(interpretLatestRelease(release(), "1.6.0", "win32")).toBeNull();
    expect(interpretLatestRelease(release(), "1.7.0", "win32")).toBeNull();
    expect(
      interpretLatestRelease(release({ prerelease: true }), "1.5.2", "win32"),
    ).toBeNull();
    expect(
      interpretLatestRelease(release({ draft: true }), "1.5.2", "win32"),
    ).toBeNull();
    expect(interpretLatestRelease(null, "1.5.2", "win32")).toBeNull();
  });

  test("never returns URLs outside this repository's releases", () => {
    const hostile = release({
      html_url: "https://evil.example/releases/tag/v1.6.0",
      assets: [
        {
          name: "LampasLauncher-Setup-1.6.0.exe",
          browser_download_url: "https://evil.example/LampasLauncher.exe",
        },
      ],
    });
    const info = interpretLatestRelease(hostile, "1.5.2", "win32", false);
    expect(info?.releaseUrl).toBe(
      "https://github.com/justbecauseph/lampas-launcher/releases/latest",
    );
    expect(info?.downloadUrl).toBe(info?.releaseUrl);
  });

  test("release checks may only reach api.github.com", () => {
    expect(() =>
      validateTransportUrl(
        "https://api.github.com/repos/justbecauseph/lampas-launcher/releases/latest",
        { kind: "release-check" },
      ),
    ).not.toThrow();
    for (const url of [
      "https://github.com/justbecauseph/lampas-launcher",
      "https://objects.githubusercontent.com/x",
      "https://dev.lampas.town/api/v1/channels/stable",
      "http://api.github.com/repos/x",
    ]) {
      expect(() =>
        validateTransportUrl(url, { kind: "release-check" }),
      ).toThrow();
    }
  });

  test("checks GitHub at most once per interval and survives failures", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let fail = true;
    globalThis.fetch = (async () => {
      calls++;
      if (fail) throw new Error("offline");
      return Response.json(release());
    }) as unknown as typeof fetch;

    let now = 1_000_000;
    const checker = new LauncherUpdateChecker(
      () => "1.5.2",
      () => now,
    );
    try {
      // Offline: no result, and the next call tries again.
      expect(await checker.check()).toBeNull();
      fail = false;
      const [a, b] = await Promise.all([checker.check(), checker.check()]);
      expect(a?.version).toBe("1.6.0");
      expect(b).toBe(a);
      expect(calls).toBe(2);

      now += 60 * 60 * 1000;
      await checker.check();
      expect(calls).toBe(2);

      now += 6 * 60 * 60 * 1000;
      await checker.check();
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
