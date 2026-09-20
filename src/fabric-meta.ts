import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicFile } from "./file-transfer";
import { runBoundedPool } from "./async-pool";
import { checkPhysicalAncestrySync, PathContainmentError } from "./path-policy";
import {
  readResponseJson,
  readResponseText,
  TRANSFER_LIMITS,
  TransferLimitError,
} from "./transfer-limits";
import { validateRuntimeDefinition } from "./runtime-definition";
import {
  fetchWithRedirectPolicy,
  TransportPolicyError,
  TransportRedirectPolicyError,
} from "./transport-policy";
import type { MinecraftRuntimeDefinition } from "./types";

export class PermanentFabricMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentFabricMetaError";
  }
}

export class TransientFabricMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientFabricMetaError";
  }
}

export interface ParsedMavenCoordinate {
  group: string;
  artifact: string;
  version: string;
  classifier?: string;
}

export function parseMavenCoordinate(name: string): ParsedMavenCoordinate {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(
      `Invalid Maven coordinate: coordinate must be a non-empty string.`,
    );
  }

  const parts = name.split(":");
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(
      `Invalid Maven coordinate '${name}': expected 3 or 4 colon-separated parts (group:artifact:version[:classifier]), got ${parts.length}.`,
    );
  }

  const group = parts[0].trim();
  const artifact = parts[1].trim();
  const version = parts[2].trim();
  const classifier = parts.length === 4 ? parts[3].trim() : undefined;

  // Validate group (e.g. net.fabricmc, org.ow2.asm)
  if (
    !group ||
    !/^[a-zA-Z0-9_.-]+$/.test(group) ||
    group.includes("..") ||
    group.startsWith(".") ||
    group.endsWith(".")
  ) {
    throw new Error(
      `Invalid Maven coordinate '${name}': malformed or unsafe group '${group}'.`,
    );
  }

  // Validate artifact (e.g. fabric-loader)
  if (
    !artifact ||
    !/^[a-zA-Z0-9_.-]+$/.test(artifact) ||
    artifact.includes("..")
  ) {
    throw new Error(
      `Invalid Maven coordinate '${name}': malformed or unsafe artifact '${artifact}'.`,
    );
  }

  // Validate version (e.g. 0.19.3, 0.15.3+mixin.0.8.7)
  if (
    !version ||
    !/^[a-zA-Z0-9_.+~-]+$/.test(version) ||
    version.includes("..")
  ) {
    throw new Error(
      `Invalid Maven coordinate '${name}': malformed or unsafe version '${version}'.`,
    );
  }

  // Validate classifier if present
  if (classifier !== undefined) {
    if (
      !classifier ||
      !/^[a-zA-Z0-9_.-]+$/.test(classifier) ||
      classifier.includes("..")
    ) {
      throw new Error(
        `Invalid Maven coordinate '${name}': malformed or unsafe classifier '${classifier}'.`,
      );
    }
  }

  return { group, artifact, version, classifier };
}

export function mavenToPath(coord: ParsedMavenCoordinate): string {
  const groupPath = coord.group.replace(/\./g, "/");
  const fileSuffix = coord.classifier ? `-${coord.classifier}` : "";
  const relPath = `${groupPath}/${coord.artifact}/${coord.version}/${coord.artifact}-${coord.version}${fileSuffix}.jar`;

  if (
    relPath.includes("..") ||
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    relPath.includes("\0")
  ) {
    throw new Error(`Unsafe Maven path derived from coordinate: '${relPath}'`);
  }

  return relPath;
}

export interface FabricLibraryDefinition {
  name: string;
  url?: string;
  sha256?: string;
  sha1?: string;
}

export interface FabricRuntimeMetadata {
  loader: {
    version: string;
    maven: string;
  };
  intermediary: {
    version: string;
    maven: string;
  };
  libraries: FabricLibraryDefinition[];
  mainClass: string;
}

export function validateFabricRuntimeMetadata(
  data: unknown,
  runtime: MinecraftRuntimeDefinition,
): FabricRuntimeMetadata {
  if (!data || typeof data !== "object") {
    throw new Error(
      `[FabricMeta] Malformed metadata: expected an object, got ${typeof data}.`,
    );
  }

  const raw = data as Record<string, any>;

  // Validate loader
  if (!raw.loader || typeof raw.loader !== "object") {
    throw new Error(`[FabricMeta] Metadata is missing 'loader' object.`);
  }
  if (raw.loader.version !== runtime.loader.version) {
    throw new Error(
      `[FabricMeta] Loader version mismatch: expected '${runtime.loader.version}', got '${raw.loader.version}'.`,
    );
  }
  parseMavenCoordinate(raw.loader.maven);

  // Validate intermediary
  if (!raw.intermediary || typeof raw.intermediary !== "object") {
    throw new Error(`[FabricMeta] Metadata is missing 'intermediary' object.`);
  }
  if (
    typeof raw.intermediary.version !== "string" ||
    !raw.intermediary.version.trim()
  ) {
    throw new Error(
      `[FabricMeta] Intermediary mapping version is missing or empty.`,
    );
  }
  parseMavenCoordinate(raw.intermediary.maven);

  // Validate mainClass
  if (typeof raw.mainClass !== "string" || !raw.mainClass.trim()) {
    throw new Error(
      `[FabricMeta] Metadata is missing a valid 'mainClass' string.`,
    );
  }

  // Validate libraries
  if (!Array.isArray(raw.libraries) || raw.libraries.length === 0) {
    throw new Error(
      `[FabricMeta] Metadata has missing or empty libraries array.`,
    );
  }

  const validatedLibraries: FabricLibraryDefinition[] = [];
  for (let i = 0; i < raw.libraries.length; i++) {
    const lib = raw.libraries[i];
    if (!lib || typeof lib !== "object") {
      throw new Error(
        `[FabricMeta] Library at index ${i} is not a valid object.`,
      );
    }
    if (typeof lib.name !== "string" || !lib.name.trim()) {
      throw new Error(
        `[FabricMeta] Library at index ${i} has missing or empty name.`,
      );
    }
    parseMavenCoordinate(lib.name);

    if (lib.url !== undefined) {
      if (typeof lib.url !== "string" || !lib.url.trim()) {
        throw new Error(`[FabricMeta] Library '${lib.name}' has invalid url.`);
      }
      try {
        const parsedUrl = new URL(lib.url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          throw new Error(
            `[FabricMeta] Library '${lib.name}' url must be HTTP or HTTPS.`,
          );
        }
      } catch (err: any) {
        throw new Error(
          `[FabricMeta] Library '${lib.name}' has malformed url '${lib.url}': ${err.message}`,
        );
      }
    }

    if (lib.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(lib.sha256)) {
      throw new Error(
        `[FabricMeta] Library '${lib.name}' has invalid sha256 checksum: '${lib.sha256}'.`,
      );
    }

    if (lib.sha1 !== undefined && !/^[0-9a-f]{40}$/i.test(lib.sha1)) {
      throw new Error(
        `[FabricMeta] Library '${lib.name}' has invalid sha1 checksum: '${lib.sha1}'.`,
      );
    }

    // Every library is a managed executable artifact.  A metadata response or
    // cache entry without a usable digest cannot establish the identity of the
    // bytes that Minecraft will load, so it must fail closed.
    if (lib.sha256 === undefined && lib.sha1 === undefined) {
      throw new Error(
        `[FabricMeta] Library '${lib.name}' is missing an expected SHA-1 or SHA-256 checksum.`,
      );
    }

    validatedLibraries.push({
      name: lib.name.trim(),
      url: lib.url?.trim(),
      sha256: lib.sha256 ? lib.sha256.toLowerCase() : undefined,
      sha1: lib.sha1 ? lib.sha1.toLowerCase() : undefined,
    });
  }

  return {
    loader: {
      version: raw.loader.version,
      maven: raw.loader.maven,
    },
    intermediary: {
      version: raw.intermediary.version,
      maven: raw.intermediary.maven,
    },
    libraries: validatedLibraries,
    mainClass: raw.mainClass.trim(),
  };
}

export interface FabricMetaResolverOptions {
  metaBaseUrl?: string;
  fetchFn?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  timeoutMs?: number;
  resolveSidecars?: boolean;
}

function checkCachePathOwnership(cacheDir: string, cachePath: string): void {
  // Check the cache root itself from its parent so a caller cannot substitute the
  // cache root with a junction/symlink before the child path check runs.
  checkPhysicalAncestrySync(path.dirname(path.resolve(cacheDir)), cacheDir, {
    disallowSymlinks: true,
  });
  checkPhysicalAncestrySync(cacheDir, cachePath, { disallowSymlinks: true });
}

function prepareCacheDirectory(cacheDir: string, cachePath: string): void {
  checkCachePathOwnership(cacheDir, cachePath);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  // Validate all newly-created cache components immediately before publication.
  checkCachePathOwnership(cacheDir, cachePath);
}

export class FabricMetaResolver {
  static getCachePath(
    cacheDir: string,
    minecraft: string,
    loaderVersion: string,
  ): string {
    return path.join(
      cacheDir,
      "fabric-meta",
      encodeURIComponent(minecraft),
      `${encodeURIComponent(loaderVersion)}.json`,
    );
  }

  static async resolveFabricRuntime(
    runtimeInput: MinecraftRuntimeDefinition,
    cacheDir?: string,
    options?: FabricMetaResolverOptions,
  ): Promise<FabricRuntimeMetadata> {
    const runtime = validateRuntimeDefinition(runtimeInput);
    const metaBaseUrl = options?.metaBaseUrl || "https://meta.fabricmc.net";
    const customFetch =
      options?.fetchFn ||
      ((input: string | URL | Request, init?: RequestInit) =>
        fetchWithRedirectPolicy(String(input), init, {
          kind: "public-metadata",
        }));
    const timeoutMs = options?.timeoutMs ?? 5000;
    const resolveSidecars = options?.resolveSidecars ?? true;

    const url = `${metaBaseUrl.replace(/\/+$/, "")}/v2/versions/loader/${encodeURIComponent(runtime.minecraft)}/${encodeURIComponent(runtime.loader.version)}`;
    const cachePath = cacheDir
      ? this.getCachePath(cacheDir, runtime.minecraft, runtime.loader.version)
      : null;

    let networkError: Error | null = null;
    let data: any = null;
    let metadataReceived = false;

    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await customFetch(url, { signal });

      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        await response.body?.cancel().catch(() => undefined);
        // Permanent 4xx error (404 Not Found, 400 Bad Request, etc.)
        throw new PermanentFabricMetaError(
          `[FabricMeta] Fabric Loader ${runtime.loader.version} is not available for Minecraft ${runtime.minecraft} (Fabric Meta returned HTTP ${response.status} ${response.statusText}).`,
        );
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // Transient error (429 Rate Limit, 500, 502, 503, 504)
        throw new TransientFabricMetaError(
          `[FabricMeta] Fabric Meta query failed with HTTP ${response.status} ${response.statusText} (${url}).`,
        );
      }

      try {
        data = await readResponseJson(
          response,
          TRANSFER_LIMITS.jsonBytes,
          signal,
        );
        metadataReceived = true;
      } catch (bodyError: any) {
        // A malformed or oversized metadata body is an integrity/schema
        // failure. It must not be converted into a successful cache fallback.
        if (bodyError instanceof TransferLimitError) throw bodyError;
        throw new PermanentFabricMetaError(
          `[FabricMeta] Fabric Meta returned an invalid JSON body for Minecraft ${runtime.minecraft}.`,
        );
      }
    } catch (err: any) {
      networkError = err;
      if (
        err instanceof PermanentFabricMetaError ||
        err instanceof TransferLimitError ||
        err instanceof TransportPolicyError ||
        err instanceof TransportRedirectPolicyError
      ) {
        throw err;
      }
    }

    // If network succeeded, validate and resolve sidecar hashes
    if (metadataReceived) {
      const rawMetadata = this.transformRawResponse(data, runtime);

      // Resolve sidecar checksums (SHA-256 / SHA-1) from Maven repository with bounded concurrency
      if (resolveSidecars) {
        const sidecarLibs = rawMetadata.libraries.filter(
          (lib) => !lib.sha256 && !lib.sha1,
        );
        await runBoundedPool(
          sidecarLibs,
          async (lib, _index, signal) => {
            const checksums = await this.fetchSidecarChecksum(
              lib,
              customFetch,
              timeoutMs,
              signal,
            );
            if (checksums.sha256) lib.sha256 = checksums.sha256;
            if (checksums.sha1) lib.sha1 = checksums.sha1;
            return lib;
          },
          { concurrency: 6 },
        );
      }

      // Strictly validate transformed metadata before caching
      const metadata = validateFabricRuntimeMetadata(rawMetadata, runtime);

      // Atomically persist to disk cache
      if (cachePath) {
        checkCachePathOwnership(cacheDir!, cachePath);
        try {
          prepareCacheDirectory(cacheDir!, cachePath);
          await writeAtomicFile(cachePath, JSON.stringify(metadata, null, 2), {
            encoding: "utf-8",
          });
        } catch (cacheErr) {
          // A containment or ownership failure must fail closed. Only ordinary
          // cache I/O failures remain non-fatal to a successful network response.
          if (cacheErr instanceof PathContainmentError) throw cacheErr;
          // Non-fatal cache write error
        }
      }

      return metadata;
    }

    // Network failed or offline: check exact cache
    if (cachePath) {
      // Validate before exists/read so an unsafe cache cannot become a fallback
      // success through a symlink or junction.
      checkCachePathOwnership(cacheDir!, cachePath);
    }
    if (cachePath && fs.existsSync(cachePath)) {
      try {
        const cacheStat = fs.lstatSync(cachePath);
        if (!cacheStat.isFile() || cacheStat.size > TRANSFER_LIMITS.jsonBytes) {
          throw new TransferLimitError(
            "Fabric metadata cache",
            TRANSFER_LIMITS.jsonBytes,
            cacheStat.size,
          );
        }
        const cachedRaw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        return validateFabricRuntimeMetadata(cachedRaw, runtime);
      } catch (cacheErr: any) {
        throw new Error(
          `[FabricMeta] Network query failed (${networkError?.message}) and cached metadata at '${cachePath}' is corrupted: ${cacheErr.message}`,
        );
      }
    }

    throw new Error(
      `[FabricMeta] Failed to resolve Fabric runtime for Minecraft ${runtime.minecraft} + Loader ${runtime.loader.version} and no offline cache exists: ${networkError?.message}`,
    );
  }

  private static transformRawResponse(
    data: any,
    runtime: MinecraftRuntimeDefinition,
  ): {
    loader: { version: string; maven: string };
    intermediary: { version: string; maven: string };
    libraries: FabricLibraryDefinition[];
    mainClass: string;
  } {
    if (!data || typeof data !== "object") {
      throw new Error(
        `[FabricMeta] Malformed Fabric Meta response for Minecraft ${runtime.minecraft} and Loader ${runtime.loader.version}.`,
      );
    }

    if (
      !data.loader ||
      typeof data.loader !== "object" ||
      typeof data.loader.version !== "string" ||
      typeof data.loader.maven !== "string"
    ) {
      throw new Error(
        `[FabricMeta] Fabric Meta response has missing or invalid loader metadata.`,
      );
    }

    if (data.loader.version !== runtime.loader.version) {
      throw new Error(
        `[FabricMeta] Fabric Meta returned loader version '${data.loader.version}', but '${runtime.loader.version}' was requested.`,
      );
    }
    parseMavenCoordinate(data.loader.maven);

    if (
      !data.intermediary ||
      typeof data.intermediary !== "object" ||
      typeof data.intermediary.version !== "string" ||
      typeof data.intermediary.maven !== "string"
    ) {
      throw new Error(
        `[FabricMeta] Fabric Meta response is missing valid intermediary mappings for Minecraft ${runtime.minecraft}.`,
      );
    }
    parseMavenCoordinate(data.intermediary.maven);

    if (!data.launcherMeta || typeof data.launcherMeta !== "object") {
      throw new Error(
        `[FabricMeta] Fabric Meta response is missing launcherMeta.`,
      );
    }

    const clientMainClass = data.launcherMeta.mainClass?.client;
    if (typeof clientMainClass !== "string" || !clientMainClass.trim()) {
      throw new Error(
        `[FabricMeta] Fabric Meta response is missing launcherMeta.mainClass.client.`,
      );
    }

    const commonLibs = data.launcherMeta.libraries?.common;
    if (!Array.isArray(commonLibs) || commonLibs.length === 0) {
      throw new Error(
        `[FabricMeta] Fabric Meta response has malformed or empty required library metadata.`,
      );
    }

    // Build deduplicated library list
    const seenNames = new Set<string>();
    const libraries: FabricLibraryDefinition[] = [];

    function addLib(lib: {
      name: string;
      url?: string;
      sha256?: string;
      sha1?: string;
    }) {
      if (!lib || typeof lib.name !== "string" || !lib.name.trim()) {
        throw new Error(`[FabricMeta] Invalid library entry in launcherMeta.`);
      }
      parseMavenCoordinate(lib.name);

      if (!seenNames.has(lib.name)) {
        seenNames.add(lib.name);
        libraries.push({
          name: lib.name.trim(),
          url: lib.url || "https://maven.fabricmc.net/",
          sha256: lib.sha256,
          sha1: lib.sha1,
        });
      }
    }

    // 1. Loader artifact
    addLib({
      name: data.loader.maven,
      url: "https://maven.fabricmc.net/",
      sha256: data.loader.sha256,
      sha1: data.loader.sha1,
    });

    // 2. Intermediary artifact
    addLib({
      name: data.intermediary.maven,
      url: "https://maven.fabricmc.net/",
      sha256: data.intermediary.sha256,
      sha1: data.intermediary.sha1,
    });

    // 3. Common libraries (ASM, Mixin, etc.)
    for (const lib of commonLibs) {
      addLib(lib);
    }

    // 4. Client-specific libraries if any
    const clientLibs = data.launcherMeta.libraries?.client;
    if (Array.isArray(clientLibs)) {
      for (const lib of clientLibs) {
        addLib(lib);
      }
    }

    return {
      loader: {
        version: data.loader.version,
        maven: data.loader.maven,
      },
      intermediary: {
        version: data.intermediary.version,
        maven: data.intermediary.maven,
      },
      libraries,
      mainClass: clientMainClass.trim(),
    };
  }

  private static async fetchSidecarChecksum(
    lib: FabricLibraryDefinition,
    fetchFn: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<{ sha256?: string; sha1?: string }> {
    try {
      const coord = parseMavenCoordinate(lib.name);
      const relPath = mavenToPath(coord);
      const repoUrl = lib.url || "https://maven.fabricmc.net/";
      const artifactUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;

      const makeSignal = () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          Math.min(3000, timeoutMs),
        );
        const onAbort = () => controller.abort(parentSignal?.reason);
        parentSignal?.addEventListener("abort", onAbort, { once: true });
        return {
          signal: controller.signal,
          dispose: () => {
            clearTimeout(timer);
            parentSignal?.removeEventListener("abort", onAbort);
          },
        };
      };

      // Try .sha256
      let request = makeSignal();
      try {
        const res256 = await fetchFn(`${artifactUrl}.sha256`, {
          signal: request.signal,
        });
        if (res256.ok) {
          const text = (
            await readResponseText(
              res256,
              TRANSFER_LIMITS.checksumBytes,
              request.signal,
            )
          )
            .trim()
            .split(/\s+/)[0]
            .toLowerCase();
          if (/^[0-9a-f]{64}$/.test(text)) {
            return { sha256: text };
          }
          throw new PermanentFabricMetaError(
            "Fabric SHA-256 sidecar is malformed.",
          );
        } else {
          await res256.body?.cancel().catch(() => undefined);
          if ([401, 403, 410].includes(res256.status))
            throw new PermanentFabricMetaError(
              `Fabric sidecar denied (${res256.status}).`,
            );
        }
      } catch (error) {
        if (
          error instanceof PermanentFabricMetaError ||
          error instanceof TransferLimitError ||
          error instanceof TransportPolicyError ||
          error instanceof TransportRedirectPolicyError
        )
          throw error;
      } finally {
        request.dispose();
      }

      // Try .sha1
      request = makeSignal();
      try {
        const res1 = await fetchFn(`${artifactUrl}.sha1`, {
          signal: request.signal,
        });
        if (res1.ok) {
          const text = (
            await readResponseText(
              res1,
              TRANSFER_LIMITS.checksumBytes,
              request.signal,
            )
          )
            .trim()
            .split(/\s+/)[0]
            .toLowerCase();
          if (/^[0-9a-f]{40}$/.test(text)) {
            return { sha1: text };
          }
          throw new PermanentFabricMetaError(
            "Fabric SHA-1 sidecar is malformed.",
          );
        } else {
          await res1.body?.cancel().catch(() => undefined);
          if ([401, 403, 410].includes(res1.status))
            throw new PermanentFabricMetaError(
              `Fabric sidecar denied (${res1.status}).`,
            );
        }
      } catch (error) {
        if (
          error instanceof PermanentFabricMetaError ||
          error instanceof TransferLimitError ||
          error instanceof TransportPolicyError ||
          error instanceof TransportRedirectPolicyError
        )
          throw error;
      } finally {
        request.dispose();
      }
    } catch (error) {
      if (
        error instanceof PermanentFabricMetaError ||
        error instanceof TransferLimitError ||
        error instanceof TransportPolicyError ||
        error instanceof TransportRedirectPolicyError
      )
        throw error;
    }

    return {};
  }
}
