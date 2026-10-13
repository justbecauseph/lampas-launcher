import { Buffer } from "node:buffer";
import { fetchWithRedirectPolicy } from "./transport-policy";
import { readResponseBytes } from "./transfer-limits";
import type { ModCatalogEntry, UserProfile } from "./types";

export const COSMETIC_IMAGE_LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxWidth: 2048,
  maxHeight: 2048,
  maxPixels: 4 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  maxConcurrentRequests: 4,
  // Sized to hold a full modpack's icons so re-rendering the Mods tab
  // never re-downloads them; maxCacheBytes still bounds total memory.
  maxCacheEntries: 256,
  maxPendingRequests: 64,
  maxCacheBytes: 16 * 1024 * 1024,
  ttlMs: 10 * 60 * 1000,
} as const);

export interface CosmeticImageResult {
  dataUrl: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

export interface CosmeticImageBrokerOptions {
  isEnabled: () => boolean;
  getUser?: () => UserProfile | null;
  resolveModIcon?: (id: string) => Promise<string | undefined>;
  requestTimeoutMs?: number;
  now?: () => number;
}

interface CachedImage {
  result: CosmeticImageResult;
  bytes: number;
  expiresAt: number;
  lastUsed: number;
}

interface PendingFetch {
  url: string;
  controller: AbortController;
  resolve: (result: CosmeticImageResult | null) => void;
  reject: (error: unknown) => void;
}

interface InFlightImage {
  generation: number;
  controller: AbortController;
  promise: Promise<CosmeticImageResult | null>;
}

type SupportedMime = CosmeticImageResult["mimeType"];

export class CosmeticImagePolicyError extends Error {
  constructor(message: string) {
    super(`[CosmeticImagePolicy] ${message}`);
    this.name = "CosmeticImagePolicyError";
  }
}

function isSupportedMime(value: string | null): value is SupportedMime {
  return (
    value === "image/png" || value === "image/jpeg" || value === "image/webp"
  );
}

function readPngDimensions(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.length < 24 ||
    !bytes
      .subarray(0, 8)
      .every(
        (value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index],
      )
  )
    return null;
  if (
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

function readJpegDimensions(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && segmentLength >= 7) {
      return [
        (bytes[offset + 5] << 8) | bytes[offset + 6],
        (bytes[offset + 3] << 8) | bytes[offset + 4],
      ];
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.length < 30 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP"
  )
    return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return [width, height];
  }
  // VP8L stores dimensions in a compact bit field. Decode only this bounded
  // header and reject malformed/unsupported variants before native decoding.
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
  }
  return null;
}

function imageShape(
  bytes: Uint8Array,
): { mimeType: SupportedMime; width: number; height: number } | null {
  const png = readPngDimensions(bytes);
  if (png) return { mimeType: "image/png", width: png[0], height: png[1] };
  const jpeg = readJpegDimensions(bytes);
  if (jpeg) return { mimeType: "image/jpeg", width: jpeg[0], height: jpeg[1] };
  const webp = readWebpDimensions(bytes);
  if (webp) return { mimeType: "image/webp", width: webp[0], height: webp[1] };
  return null;
}

function validateIdentity(user: UserProfile | null): string | null {
  if (!user) return null;
  const uuid = user.minecraftUuid?.replace(/-/g, "");
  if (uuid && /^[a-f0-9]{32}$/i.test(uuid) && !/^0{32}$/.test(uuid))
    return uuid;
  const username = user.minecraftUsername?.trim() || user.name?.trim();
  return username && /^[A-Za-z0-9_]{1,16}$/.test(username) ? username : null;
}

export class CosmeticImageBroker {
  private readonly cache = new Map<string, CachedImage>();
  private readonly inFlight = new Map<string, InFlightImage>();
  private readonly pendingFetches: PendingFetch[] = [];
  private activeFetches = 0;
  private readonly now: () => number;
  private generation = 0;
  private cacheBytes = 0;
  constructor(private readonly options: CosmeticImageBrokerOptions) {
    this.now = options.now || (() => Date.now());
  }

  dispose(): void {
    this.clear();
  }

  clear(): void {
    this.generation++;
    this.cache.clear();
    this.cacheBytes = 0;
    for (const entry of this.inFlight.values()) {
      entry.controller.abort(new Error("Cosmetic image request invalidated"));
    }
    this.inFlight.clear();
    const pending = this.pendingFetches.splice(0);
    for (const entry of pending) {
      entry.controller.abort(new Error("Cosmetic image request invalidated"));
      entry.reject(new Error("Cosmetic image request invalidated"));
    }
  }

  getCacheStats(): { entries: number; bytes: number } {
    return { entries: this.cache.size, bytes: this.cacheBytes };
  }

  async getAvatar(): Promise<CosmeticImageResult | null> {
    if (!this.options.isEnabled()) return null;
    const identity = validateIdentity(this.options.getUser?.() || null);
    if (!identity) return null;
    const key = `avatar:${identity}`;
    return this.getOrFetch(
      key,
      `https://mc-heads.net/avatar/${encodeURIComponent(identity)}/64`,
    );
  }

  async getModIcon(id: string): Promise<CosmeticImageResult | null> {
    if (!this.options.isEnabled() || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      return null;
    const generation = this.generation;
    const url = await this.options.resolveModIcon?.(id);
    if (!url || generation !== this.generation || !this.options.isEnabled())
      return null;
    const key = `mod:${id}:${url}`;
    return this.getOrFetch(key, url);
  }

  private getCached(key: string): CosmeticImageResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
      return null;
    }
    entry.lastUsed = this.now();
    return entry.result;
  }

  private getOrFetch(
    key: string,
    url: string,
  ): Promise<CosmeticImageResult | null> {
    const cached = this.getCached(key);
    if (cached) return Promise.resolve(cached);
    const generation = this.generation;
    const existing = this.inFlight.get(key);
    if (existing?.generation === generation) return existing.promise;
    if (this.inFlight.size >= COSMETIC_IMAGE_LIMITS.maxPendingRequests)
      return Promise.resolve(null);

    const controller = new AbortController();
    const operation = this.enqueueFetch(url, controller)
      .then((result) => {
        if (!result) return null;
        if (generation !== this.generation || !this.options.isEnabled())
          return null;
        this.insertCache(key, result);
        return result;
      })
      .catch(() => null);
    this.inFlight.set(key, { generation, controller, promise: operation });
    operation.then(
      () => {
        if (this.inFlight.get(key)?.promise === operation)
          this.inFlight.delete(key);
      },
      () => {
        if (this.inFlight.get(key)?.promise === operation)
          this.inFlight.delete(key);
      },
    );
    return operation;
  }

  private enqueueFetch(
    url: string,
    controller: AbortController,
  ): Promise<CosmeticImageResult | null> {
    return new Promise<CosmeticImageResult | null>((resolve, reject) => {
      this.pendingFetches.push({ url, controller, resolve, reject });
      this.pumpFetches();
    });
  }

  private pumpFetches(): void {
    while (
      this.activeFetches < COSMETIC_IMAGE_LIMITS.maxConcurrentRequests &&
      this.pendingFetches.length > 0
    ) {
      const pending = this.pendingFetches.shift()!;
      if (pending.controller.signal.aborted) {
        pending.reject(
          pending.controller.signal.reason ||
            new Error("Cosmetic image request aborted"),
        );
        continue;
      }
      this.activeFetches++;
      void this.fetchImage(pending.url, pending.controller.signal)
        .then(
          (result) => pending.resolve(result),
          (error) => pending.reject(error),
        )
        .then(
          () => {
            this.activeFetches--;
            this.pumpFetches();
          },
          () => {
            this.activeFetches--;
            this.pumpFetches();
          },
        );
    }
  }

  private async fetchImage(
    url: string,
    signal: AbortSignal,
  ): Promise<CosmeticImageResult | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Cosmetic image request timed out")),
      this.options.requestTimeoutMs ?? COSMETIC_IMAGE_LIMITS.requestTimeoutMs,
    );
    try {
      let response: Response;
      try {
        response = await fetchWithRedirectPolicy(
          url,
          {
            method: "GET",
            credentials: "omit",
            signal: controller.signal,
            headers: { Accept: "image/png,image/jpeg,image/webp" },
          },
          { kind: "cosmetic", maxRedirects: 2 },
        );
      } catch (error) {
        if (error instanceof CosmeticImagePolicyError) throw error;
        return null;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      let bytes: Uint8Array;
      try {
        bytes = await readResponseBytes(
          response,
          COSMETIC_IMAGE_LIMITS.maxBytes,
          controller.signal,
          "cosmetic image",
        );
      } catch {
        return null;
      }
      const shape = imageShape(bytes);
      if (
        !shape ||
        shape.width < 1 ||
        shape.height < 1 ||
        shape.width > COSMETIC_IMAGE_LIMITS.maxWidth ||
        shape.height > COSMETIC_IMAGE_LIMITS.maxHeight ||
        shape.width * shape.height > COSMETIC_IMAGE_LIMITS.maxPixels
      ) {
        return null;
      }
      const declaredMime =
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() || null;
      if (
        declaredMime &&
        isSupportedMime(declaredMime) &&
        declaredMime !== shape.mimeType
      )
        return null;
      if (declaredMime && !isSupportedMime(declaredMime)) return null;
      return {
        dataUrl: `data:${shape.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
        mimeType: shape.mimeType,
        width: shape.width,
        height: shape.height,
      };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private insertCache(key: string, result: CosmeticImageResult): void {
    const bytes = Math.ceil(result.dataUrl.length * 0.75);
    const prior = this.cache.get(key);
    if (prior) this.cacheBytes -= prior.bytes;
    this.cache.set(key, {
      result,
      bytes,
      expiresAt: this.now() + COSMETIC_IMAGE_LIMITS.ttlMs,
      lastUsed: this.now(),
    });
    this.cacheBytes += bytes;
    while (
      this.cache.size > COSMETIC_IMAGE_LIMITS.maxCacheEntries ||
      this.cacheBytes > COSMETIC_IMAGE_LIMITS.maxCacheBytes
    ) {
      const oldest = [...this.cache.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      )[0];
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].bytes;
    }
  }
}

export function createModIconResolver(
  catalogProvider: () => Promise<ModCatalogEntry[]>,
): (id: string) => Promise<string | undefined> {
  return async (id) =>
    (await catalogProvider()).find((mod) => mod.id === id)?.iconUrl;
}
