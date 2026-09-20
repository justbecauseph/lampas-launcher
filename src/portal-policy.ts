/**
 * Lampas Portal Origin & Web Opening Policy (Phase 1)
 *
 * Defines the main-owned canonical destination policy for Portal authentication,
 * sync, and status endpoints, as well as safe web URL opening.
 *
 * Invariants:
 * 1. Origin-only contract: Portal destinations specify only canonical origin (scheme + host + port).
 *    No path components, query parameters, hash fragments, or userinfo credentials are permitted.
 * 2. Remote destinations require HTTPS. HTTP remote destinations are rejected or upgraded for approved hosts.
 * 3. HTTP is permitted ONLY for exact loopback development endpoints (127.0.0.1, localhost, [::1]).
 *    Substring matches or lookalike hosts are strictly rejected.
 * 4. Approved remote hosts are derived from the application contract (*.lampas.town, lampas.town, and RFC 2606 .test in tests).
 * 5. Web link opening accepts validated http/https URLs only, never falling back to shell.openPath.
 */

const DEFAULT_PORTAL = "https://dev.lampas.town";

export class PortalPolicyError extends Error {
  constructor(message: string) {
    super(`[PortalPolicy] ${message}`);
    this.name = "PortalPolicyError";
  }
}

export class PortalRedirectPolicyError extends Error {
  readonly status: number;
  readonly location: string | null;
  readonly endpointUrl: string;

  constructor(status: number, location: string | null, endpointUrl: string) {
    super(
      `[PortalRedirectPolicy] Authenticated metadata endpoint '${endpointUrl}' rejected redirect (${status}) to '${location || "unknown"}'`,
    );
    this.name = "PortalRedirectPolicyError";
    this.status = status;
    this.location = location;
    this.endpointUrl = endpointUrl;
  }
}

export class WebOpeningPolicyError extends Error {
  constructor(message: string) {
    super(`[WebOpeningPolicy] ${message}`);
    this.name = "WebOpeningPolicyError";
  }
}

export interface DevelopmentPortalPolicy {
  allowLoopback?: boolean;
  allowedRemoteHosts?: string[];
}

let developmentPolicy: DevelopmentPortalPolicy | null = null;
let productionOverride: boolean | null = null;

export const PortalPolicy = {
  /**
   * Main-only test/development construction to supply fixture policy.
   */
  configureDevelopmentPolicy(policy: DevelopmentPortalPolicy | null): void {
    developmentPolicy = policy;
  },

  /**
   * Override production state for testing.
   */
  setProductionOverride(isProd: boolean | null): void {
    productionOverride = isProd;
  },

  resetForTesting(): void {
    developmentPolicy = null;
    productionOverride = null;
  },

  isPackagedProduction(): boolean {
    if (productionOverride !== null) {
      return productionOverride;
    }
    try {
      const electron = require("electron");
      return Boolean(electron.app?.isPackaged);
    } catch {
      return false;
    }
  },

  isLoopbackAllowed(): boolean {
    if (this.isPackagedProduction()) {
      return false;
    }
    return Boolean(developmentPolicy?.allowLoopback);
  },

  isApprovedRemoteHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    // Approved Lampas domain contract trusted in all modes
    if (lower === "lampas.town" || lower.endsWith(".lampas.town")) {
      return true;
    }
    // Packaged production must NOT expand Portal trust from LAMPAS_ALLOWED_PORTAL_HOSTS or NODE_ENV
    if (this.isPackagedProduction()) {
      return false;
    }
    // Explicit development portal hosts configured via development policy
    if (
      developmentPolicy?.allowedRemoteHosts
        ?.map((h) => h.toLowerCase())
        .includes(lower)
    ) {
      return true;
    }
    const envHosts =
      process.env.LAMPAS_ALLOWED_PORTAL_HOSTS?.split(",").map((h) =>
        h.trim().toLowerCase(),
      ) || [];
    if (envHosts.includes(lower)) {
      return true;
    }
    return false;
  },
};

/**
 * Checks if a hostname represents an exact local loopback endpoint.
 */
export function isExactLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "127.0.0.1" ||
    lower === "localhost" ||
    lower === "::1" ||
    lower === "[::1]"
  );
}

/**
 * Checks if a remote hostname is approved according to the application contract.
 * Approved remote hosts: lampas.town and *.lampas.town.
 * Packaged production does not expand trust from environment variables.
 */
export function isApprovedRemoteHost(hostname: string): boolean {
  return PortalPolicy.isApprovedRemoteHost(hostname);
}

/**
 * Restricted Portal transport path for authenticated metadata requests.
 * Enforces manual redirect policy (redirect: "manual") and rejects any redirect status (301, 302, 307, 308).
 */
export async function portalFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Portal request timed out")),
    30_000,
  );
  const abort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) abort();
  init?.signal?.addEventListener("abort", abort, { once: true });
  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "manual",
    });
    if (
      (resp.status >= 300 && resp.status < 400) ||
      resp.type === "opaqueredirect"
    ) {
      await resp.body?.cancel().catch(() => undefined);
      throw new PortalRedirectPolicyError(
        resp.status,
        resp.headers.get("location"),
        url,
      );
    }
    // Auth replies are small; bound the body before any caller can parse it.
    const { readResponseBytes } = await import("./transfer-limits");
    const bytes = await readResponseBytes(
      resp,
      1024 * 1024,
      controller.signal,
      "Portal auth response",
    );
    return new Response(
      resp.status === 204 || resp.status === 205 ? null : Buffer.from(bytes),
      {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      },
    );
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Normalizes and validates a Portal URL according to the canonical origin contract.
 *
 * @param url Raw input string or undefined (falls back to DEFAULT_PORTAL)
 * @returns Canonical origin string without trailing slash (e.g. "https://dev.lampas.town")
 * @throws PortalPolicyError if the URL violates scheme, host, userinfo, query, or path rules.
 */
export function normalizePortalUrl(url?: string): string {
  let raw = (url || DEFAULT_PORTAL).trim();
  if (!raw) {
    raw = DEFAULT_PORTAL;
  }

  // Reject control characters immediately
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw new PortalPolicyError(
      "Portal URL contains invalid control characters.",
    );
  }

  // Prepend scheme if absent
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    const isLoopbackCandidate =
      raw.startsWith("127.0.0.1") ||
      raw.startsWith("localhost") ||
      raw.startsWith("[::1]");
    raw = isLoopbackCandidate ? `http://${raw}` : `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err: any) {
    throw new PortalPolicyError(`Malformed URL: ${err?.message || raw}`);
  }

  // Enforce supported schemes
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    throw new PortalPolicyError(
      `Unsupported protocol '${scheme}'. Portal endpoints require HTTP or HTTPS.`,
    );
  }

  // Reject userinfo
  if (parsed.username || parsed.password) {
    throw new PortalPolicyError(
      "Portal URL must not contain embedded user credentials.",
    );
  }

  // Reject query parameters
  if (parsed.search && parsed.search !== "?") {
    throw new PortalPolicyError(
      "Portal URL must not contain query parameters.",
    );
  }

  // Reject hash fragments
  if (parsed.hash && parsed.hash !== "#") {
    throw new PortalPolicyError("Portal URL must not contain hash fragments.");
  }

  // Enforce origin-only base path contract: path must be empty or "/"
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new PortalPolicyError(
      `Portal URL must not contain path components ('${parsed.pathname}').`,
    );
  }

  const hostname = parsed.hostname;
  const isLoopback = isExactLoopbackHost(hostname);

  if (isLoopback) {
    if (!PortalPolicy.isLoopbackAllowed()) {
      throw new PortalPolicyError(
        `Loopback portal destination '${hostname}' is not permitted without explicit development policy.`,
      );
    }
    // Loopback development endpoints may use HTTP or HTTPS
    return parsed.origin;
  }

  // Remote destination validation
  if (scheme === "http:") {
    // Auto-upgrade remote HTTP to HTTPS for recognized Lampas hosts
    if (isApprovedRemoteHost(hostname)) {
      parsed.protocol = "https:";
      return parsed.origin;
    }
    // Remote HTTP to any unapproved host or lookalike is forbidden
    throw new PortalPolicyError(
      `Remote portal destination '${hostname}' must use HTTPS.`,
    );
  }

  if (!isApprovedRemoteHost(hostname)) {
    throw new PortalPolicyError(
      `Remote portal host '${hostname}' is not an approved Lampas Portal destination.`,
    );
  }

  return parsed.origin;
}

/**
 * Validates a web URL for external browser opening.
 *
 * @param urlStr Raw URL string
 * @returns Validated URL href
 * @throws WebOpeningPolicyError if URL is malformed, uses unsupported schemes, or contains control characters/userinfo
 */
export function validateWebUrl(urlStr: string): string {
  if (typeof urlStr !== "string" || !urlStr.trim()) {
    throw new WebOpeningPolicyError("Web URL must be a non-empty string.");
  }

  const trimmed = urlStr.trim();

  // Reject control characters
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new WebOpeningPolicyError(
      "Web URL contains invalid control characters.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err: any) {
    throw new WebOpeningPolicyError(
      `Malformed web URL: ${err?.message || trimmed}`,
    );
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    throw new WebOpeningPolicyError(
      `Unsupported web protocol '${scheme}'. Only HTTP and HTTPS web URLs are permitted.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new WebOpeningPolicyError(
      "Web URL must not contain embedded user credentials.",
    );
  }

  return parsed.href;
}
