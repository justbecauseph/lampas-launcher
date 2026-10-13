import {
  isExactLoopbackHost,
  isApprovedRemoteHost,
  PortalPolicy,
  PortalRedirectPolicyError,
} from "./portal-policy";
import { TRANSFER_LIMITS } from "./transfer-limits";

export type TransportKind =
  "portal-auth" | "public-metadata" | "artifact" | "cosmetic" | "release-check";

export interface TransportPolicyOptions {
  kind: TransportKind;
  /** Exact origins added by a caller-owned test or development contract. */
  approvedOrigins?: readonly string[];
  maxRedirects?: number;
}

export class TransportPolicyError extends Error {
  constructor(message: string) {
    super(`[TransportPolicy] ${message}`);
    this.name = "TransportPolicyError";
  }
}

export class TransportRedirectPolicyError extends Error {
  constructor(
    public readonly status: number,
    public readonly from: string,
    public readonly location: string | null,
  ) {
    super(
      `[TransportPolicy] Redirect from '${from}' to '${location || "unknown"}' is not permitted.`,
    );
    this.name = "TransportRedirectPolicyError";
  }
}

const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

const PUBLIC_METADATA_HOSTS = new Set([
  "launchermeta.mojang.com",
  "piston-meta.mojang.com",
  "resources.download.minecraft.net",
  "libraries.minecraft.net",
  "meta.fabricmc.net",
  "maven.fabricmc.net",
  "api.modrinth.com",
]);

const ARTIFACT_HOSTS = new Set([
  // Portal's verified public blob redirect targets.
  "storage.railway.app",
  "t3.storageapi.dev",
  "cdn.modrinth.com",
  "api.modrinth.com",
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "libraries.minecraft.net",
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "resources.download.minecraft.net",
  "maven.fabricmc.net",
]);

function normalizedOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TransportPolicyError(`Invalid approved origin '${raw}'.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TransportPolicyError(
      `Approved origin '${raw}' must use HTTP or HTTPS.`,
    );
  }
  if (parsed.protocol === "http:" && !isExactLoopbackHost(parsed.hostname)) {
    throw new TransportPolicyError(
      `HTTP approved origins are limited to exact loopback fixtures.`,
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TransportPolicyError(
      `Approved origin '${raw}' must contain only scheme, host and port.`,
    );
  }
  return parsed.origin.toLowerCase();
}

function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  // IPv4 literals in loopback, unspecified, private and link-local ranges.
  const octets = host.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  // IPv6 loopback, unspecified, unique-local and link-local literals.
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  );
}

function hostMatchesSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isApprovedHost(url: URL, kind: TransportKind): boolean {
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  // Launcher update checks read one public GitHub API endpoint and nothing else.
  if (kind === "release-check") return hostname === "api.github.com";
  if (isApprovedRemoteHost(hostname)) return true;
  if (kind === "portal-auth") return false;
  if (kind === "public-metadata") return PUBLIC_METADATA_HOSTS.has(hostname);
  if (kind === "artifact") {
    if (ARTIFACT_HOSTS.has(hostname)) return true;
    return (
      hostMatchesSuffix(hostname, "modrinth.com") ||
      hostMatchesSuffix(hostname, "forgecdn.net")
    );
  }
  // Cosmetic assets use the same explicitly approved distribution hosts as
  // artifacts. A future provider must be added to this list deliberately.
  return (
    ARTIFACT_HOSTS.has(hostname) ||
    hostMatchesSuffix(hostname, "lampas.town") ||
    hostMatchesSuffix(hostname, "modrinth.com") ||
    hostMatchesSuffix(hostname, "forgecdn.net") ||
    hostMatchesSuffix(hostname, "mc-heads.net")
  );
}

function isAllowedUrl(
  url: URL,
  options: TransportPolicyOptions,
  approvedOrigins: Set<string>,
): boolean {
  const origin = url.origin.toLowerCase();
  const loopback = isExactLoopbackHost(url.hostname);
  if (loopback) {
    // HTTP loopback is a fixture/development exception only. Other private
    // destinations do not become trusted merely because their DNS name looks
    // harmless. Hostname validation cannot pin DNS answers against rebinding;
    // the production guarantee here is the explicit approved-domain model.
    return PortalPolicy.isLoopbackAllowed();
  }
  if (isPrivateIpLiteral(url.hostname)) return false;
  if (approvedOrigins.has(origin)) return true;
  return isApprovedHost(url, options.kind);
}

export function validateTransportUrl(
  rawUrl: string,
  options: TransportPolicyOptions,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new TransportPolicyError(
      `Malformed ${options.kind} URL '${rawUrl}'.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new TransportPolicyError(
      `${options.kind} URL must not contain embedded credentials.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TransportPolicyError(
      `${options.kind} URL must use HTTP or HTTPS.`,
    );
  }
  const approvedOrigins = new Set(
    (options.approvedOrigins || []).map(normalizedOrigin),
  );
  if (!isAllowedUrl(parsed, options, approvedOrigins)) {
    throw new TransportPolicyError(
      `${options.kind} destination '${parsed.origin}' is not approved.`,
    );
  }
  return parsed;
}

function withoutSensitiveHeaders(headers: HeadersInit | undefined): Headers {
  const output = new Headers(headers);
  for (const header of SENSITIVE_REQUEST_HEADERS) output.delete(header);
  return output;
}

/**
 * Fetch a GET-style request while inspecting each redirect. Artifact requests
 * are credential-free for every hop, including the initial Portal blob URL.
 */
export async function fetchWithRedirectPolicy(
  rawUrl: string,
  init: RequestInit = {},
  options: TransportPolicyOptions,
): Promise<Response> {
  const approvedOrigins = new Set(
    (options.approvedOrigins || []).map(normalizedOrigin),
  );
  let current = validateTransportUrl(rawUrl, options);
  let headers =
    options.kind === "portal-auth"
      ? new Headers(init.headers)
      : withoutSensitiveHeaders(init.headers);
  const maxRedirects = options.maxRedirects ?? TRANSFER_LIMITS.maxRedirects;

  for (let redirectCount = 0; ; redirectCount++) {
    const response = await fetch(current.href, {
      ...init,
      headers,
      redirect: "manual",
      ...(options.kind === "portal-auth"
        ? {}
        : { credentials: "omit" as RequestCredentials }),
    });
    const isRedirect =
      (response.status >= 300 && response.status < 400) ||
      response.type === "opaqueredirect";
    if (!isRedirect) return response;

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (options.kind === "portal-auth") {
      throw new PortalRedirectPolicyError(
        response.status,
        location,
        current.href,
      );
    }
    if (!location)
      throw new TransportRedirectPolicyError(
        response.status,
        current.href,
        null,
      );
    if (redirectCount >= maxRedirects) {
      throw new TransportPolicyError(`Redirect limit exceeded for ${rawUrl}.`);
    }

    let next: URL;
    try {
      next = validateTransportUrl(
        new URL(location, current.href).href,
        options,
      );
    } catch (error) {
      if (error instanceof TransportPolicyError) throw error;
      throw new TransportRedirectPolicyError(
        response.status,
        current.href,
        location,
      );
    }
    if (!isAllowedUrl(next, options, approvedOrigins)) {
      throw new TransportRedirectPolicyError(
        response.status,
        current.href,
        next.href,
      );
    }
    // A redirect may change origin. Artifact requests always remain
    // credential-free; metadata requests drop credentials across origins too.
    if (next.origin !== current.origin || options.kind === "artifact") {
      headers = withoutSensitiveHeaders(headers);
    }
    current = next;
  }
}

export function isSensitiveRequestHeader(name: string): boolean {
  return SENSITIVE_REQUEST_HEADERS.has(name.toLowerCase());
}
