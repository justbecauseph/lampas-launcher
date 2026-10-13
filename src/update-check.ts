import { LauncherLogger } from "./logger";
import { fetchWithRedirectPolicy } from "./transport-policy";
import { readResponseBytes } from "./transfer-limits";
import type { LauncherUpdateInfo } from "./types";

const RELEASES_API =
  "https://api.github.com/repos/justbecauseph/lampas-launcher/releases/latest";
const RELEASE_PAGE_PREFIX =
  "https://github.com/justbecauseph/lampas-launcher/releases/";
const DOWNLOAD_PREFIX =
  "https://github.com/justbecauseph/lampas-launcher/releases/download/";

/** GitHub allows 60 anonymous requests an hour; one every few hours is plenty. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type Semver = [number, number, number];

export function parseSemver(raw: unknown): Semver | null {
  if (typeof raw !== "string") return null;
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(raw.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(candidate: Semver, current: Semver): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i];
  }
  return false;
}

/** The build a player on this platform should download, if published. */
function pickAssetPattern(
  platform: NodeJS.Platform,
  portable: boolean,
): RegExp | null {
  if (platform === "win32")
    return portable
      ? /^LampasLauncher-[\d.]+-Windows\.exe$/
      : /^LampasLauncher-Setup-[\d.]+\.exe$/;
  if (platform === "linux") return /^LampasLauncher-[\d.]+-Linux\.AppImage$/;
  return null;
}

/**
 * Turns an untrusted GitHub "latest release" payload into update info. Only
 * URLs under this repository's releases are ever returned, so the renderer
 * can open them without being able to point the launcher elsewhere.
 */
export function interpretLatestRelease(
  payload: unknown,
  currentVersion: string,
  platform: NodeJS.Platform = process.platform,
  // electron-builder sets this when running the portable Windows build.
  portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
): LauncherUpdateInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const release = payload as Record<string, unknown>;
  if (release.draft === true || release.prerelease === true) return null;

  const latest = parseSemver(release.tag_name);
  const current = parseSemver(currentVersion);
  if (!latest || !current || !isNewer(latest, current)) return null;

  const releaseUrl =
    typeof release.html_url === "string" &&
    release.html_url.startsWith(RELEASE_PAGE_PREFIX)
      ? release.html_url
      : `${RELEASE_PAGE_PREFIX}latest`;

  let downloadUrl = releaseUrl;
  const pattern = pickAssetPattern(platform, portable);
  if (pattern && Array.isArray(release.assets)) {
    for (const asset of release.assets) {
      if (!asset || typeof asset !== "object") continue;
      const { name, browser_download_url: url } = asset as Record<
        string,
        unknown
      >;
      if (
        typeof name === "string" &&
        pattern.test(name) &&
        typeof url === "string" &&
        url.startsWith(DOWNLOAD_PREFIX)
      ) {
        downloadUrl = url;
        break;
      }
    }
  }

  return { version: latest.join("."), releaseUrl, downloadUrl };
}

export class LauncherUpdateChecker {
  private lastCheckedAt = 0;
  private lastResult: LauncherUpdateInfo | null = null;
  private inFlight: Promise<LauncherUpdateInfo | null> | null = null;

  constructor(
    private readonly currentVersion: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns the newer release, or null when up to date or unreachable. Results
   * are reused for a few hours so repeated calls never hit the rate limit.
   */
  check(): Promise<LauncherUpdateInfo | null> {
    if (
      this.lastCheckedAt &&
      this.now() - this.lastCheckedAt < CHECK_INTERVAL_MS
    ) {
      return Promise.resolve(this.lastResult);
    }
    if (!this.inFlight) {
      this.inFlight = this.fetchLatest().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async fetchLatest(): Promise<LauncherUpdateInfo | null> {
    try {
      const response = await fetchWithRedirectPolicy(
        RELEASES_API,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Lampas-Launcher",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
        { kind: "release-check", maxRedirects: 0 },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`GitHub responded with HTTP ${response.status}`);
      }
      const bytes = await readResponseBytes(
        response,
        MAX_RESPONSE_BYTES,
        undefined,
        "latest release metadata",
      );
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      this.lastResult = interpretLatestRelease(payload, this.currentVersion());
      this.lastCheckedAt = this.now();
      if (this.lastResult) {
        LauncherLogger.info(
          `[Updates] Lampas Launcher ${this.lastResult.version} is available (running ${this.currentVersion()}).`,
        );
      }
      return this.lastResult;
    } catch (error: any) {
      // Failures are retried on the next check; they never block the launcher.
      LauncherLogger.warn(
        `[Updates] Could not check for launcher updates: ${error?.message || error}`,
      );
      return null;
    }
  }
}
