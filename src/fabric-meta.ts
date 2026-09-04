import * as fs from "node:fs";
import * as path from "node:path";
import { validateRuntimeDefinition } from "./runtime-definition";
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
    throw new Error(`Invalid Maven coordinate: coordinate must be a non-empty string.`);
  }

  const parts = name.split(":");
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(
      `Invalid Maven coordinate '${name}': expected 3 or 4 colon-separated parts (group:artifact:version[:classifier]), got ${parts.length}.`
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
    throw new Error(`Invalid Maven coordinate '${name}': malformed or unsafe group '${group}'.`);
  }

  // Validate artifact (e.g. fabric-loader)
  if (!artifact || !/^[a-zA-Z0-9_.-]+$/.test(artifact) || artifact.includes("..")) {
    throw new Error(`Invalid Maven coordinate '${name}': malformed or unsafe artifact '${artifact}'.`);
  }

  // Validate version (e.g. 0.19.3, 0.15.3+mixin.0.8.7)
  if (!version || !/^[a-zA-Z0-9_.+~-]+$/.test(version) || version.includes("..")) {
    throw new Error(`Invalid Maven coordinate '${name}': malformed or unsafe version '${version}'.`);
  }

  // Validate classifier if present
  if (classifier !== undefined) {
    if (!classifier || !/^[a-zA-Z0-9_.-]+$/.test(classifier) || classifier.includes("..")) {
      throw new Error(`Invalid Maven coordinate '${name}': malformed or unsafe classifier '${classifier}'.`);
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
  runtime: MinecraftRuntimeDefinition
): FabricRuntimeMetadata {
  if (!data || typeof data !== "object") {
    throw new Error(
      `[FabricMeta] Malformed metadata: expected an object, got ${typeof data}.`
    );
  }

  const raw = data as Record<string, any>;

  // Validate loader
  if (!raw.loader || typeof raw.loader !== "object") {
    throw new Error(`[FabricMeta] Metadata is missing 'loader' object.`);
  }
  if (raw.loader.version !== runtime.loader.version) {
    throw new Error(
      `[FabricMeta] Loader version mismatch: expected '${runtime.loader.version}', got '${raw.loader.version}'.`
    );
  }
  parseMavenCoordinate(raw.loader.maven);

  // Validate intermediary
  if (!raw.intermediary || typeof raw.intermediary !== "object") {
    throw new Error(`[FabricMeta] Metadata is missing 'intermediary' object.`);
  }
  if (typeof raw.intermediary.version !== "string" || !raw.intermediary.version.trim()) {
    throw new Error(`[FabricMeta] Intermediary mapping version is missing or empty.`);
  }
  parseMavenCoordinate(raw.intermediary.maven);

  // Validate mainClass
  if (typeof raw.mainClass !== "string" || !raw.mainClass.trim()) {
    throw new Error(`[FabricMeta] Metadata is missing a valid 'mainClass' string.`);
  }

  // Validate libraries
  if (!Array.isArray(raw.libraries) || raw.libraries.length === 0) {
    throw new Error(`[FabricMeta] Metadata has missing or empty libraries array.`);
  }

  const validatedLibraries: FabricLibraryDefinition[] = [];
  for (let i = 0; i < raw.libraries.length; i++) {
    const lib = raw.libraries[i];
    if (!lib || typeof lib !== "object") {
      throw new Error(`[FabricMeta] Library at index ${i} is not a valid object.`);
    }
    if (typeof lib.name !== "string" || !lib.name.trim()) {
      throw new Error(`[FabricMeta] Library at index ${i} has missing or empty name.`);
    }
    parseMavenCoordinate(lib.name);

    if (lib.url !== undefined) {
      if (typeof lib.url !== "string" || !lib.url.trim()) {
        throw new Error(`[FabricMeta] Library '${lib.name}' has invalid url.`);
      }
      try {
        const parsedUrl = new URL(lib.url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          throw new Error(`[FabricMeta] Library '${lib.name}' url must be HTTP or HTTPS.`);
        }
      } catch (err: any) {
        throw new Error(`[FabricMeta] Library '${lib.name}' has malformed url '${lib.url}': ${err.message}`);
      }
    }

    if (lib.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(lib.sha256)) {
      throw new Error(`[FabricMeta] Library '${lib.name}' has invalid sha256 checksum: '${lib.sha256}'.`);
    }

    if (lib.sha1 !== undefined && !/^[0-9a-f]{40}$/i.test(lib.sha1)) {
      throw new Error(`[FabricMeta] Library '${lib.name}' has invalid sha1 checksum: '${lib.sha1}'.`);
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
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  resolveSidecars?: boolean;
}

export class FabricMetaResolver {
  static getCachePath(cacheDir: string, minecraft: string, loaderVersion: string): string {
    return path.join(
      cacheDir,
      "fabric-meta",
      encodeURIComponent(minecraft),
      `${encodeURIComponent(loaderVersion)}.json`
    );
  }

  static async resolveFabricRuntime(
    runtimeInput: MinecraftRuntimeDefinition,
    cacheDir?: string,
    options?: FabricMetaResolverOptions
  ): Promise<FabricRuntimeMetadata> {
    const runtime = validateRuntimeDefinition(runtimeInput);
    const metaBaseUrl = options?.metaBaseUrl || "https://meta.fabricmc.net";
    const customFetch = options?.fetchFn || fetch;
    const timeoutMs = options?.timeoutMs ?? 5000;
    const resolveSidecars = options?.resolveSidecars ?? true;

    const url = `${metaBaseUrl.replace(/\/+$/, "")}/v2/versions/loader/${encodeURIComponent(runtime.minecraft)}/${encodeURIComponent(runtime.loader.version)}`;
    const cachePath = cacheDir
      ? this.getCachePath(cacheDir, runtime.minecraft, runtime.loader.version)
      : null;

    let networkError: Error | null = null;
    let data: any = null;

    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await customFetch(url, { signal });

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // Permanent 4xx error (404 Not Found, 400 Bad Request, etc.)
        throw new PermanentFabricMetaError(
          `[FabricMeta] Fabric Loader ${runtime.loader.version} is not available for Minecraft ${runtime.minecraft} (Fabric Meta returned HTTP ${response.status} ${response.statusText}).`
        );
      }

      if (!response.ok) {
        // Transient error (429 Rate Limit, 500, 502, 503, 504)
        throw new TransientFabricMetaError(
          `[FabricMeta] Fabric Meta query failed with HTTP ${response.status} ${response.statusText} (${url}).`
        );
      }

      data = await response.json();
    } catch (err: any) {
      networkError = err;
      if (err instanceof PermanentFabricMetaError) {
        throw err;
      }
    }

    // If network succeeded, validate and resolve sidecar hashes
    if (data) {
      const rawMetadata = this.transformRawResponse(data, runtime);

      // Resolve sidecar checksums (SHA-256 / SHA-1) from Maven repository
      if (resolveSidecars) {
        await Promise.all(
          rawMetadata.libraries.map(async (lib) => {
            if (!lib.sha256 && !lib.sha1) {
              const checksums = await this.fetchSidecarChecksum(lib, customFetch, timeoutMs);
              if (checksums.sha256) lib.sha256 = checksums.sha256;
              if (checksums.sha1) lib.sha1 = checksums.sha1;
            }
          })
        );
      }

      // Strictly validate transformed metadata before caching
      const metadata = validateFabricRuntimeMetadata(rawMetadata, runtime);

      // Atomically persist to disk cache
      if (cachePath) {
        try {
          const dir = path.dirname(cachePath);
          fs.mkdirSync(dir, { recursive: true });
          const tempPath = path.join(
            dir,
            `.tmp-${path.basename(cachePath)}-${Date.now()}-${Math.random().toString(36).slice(2)}`
          );
          fs.writeFileSync(tempPath, JSON.stringify(metadata, null, 2), "utf-8");
          fs.renameSync(tempPath, cachePath);
        } catch {
          // Non-fatal cache write error
        }
      }

      return metadata;
    }

    // Network failed or offline: check exact cache
    if (cachePath && fs.existsSync(cachePath)) {
      try {
        const cachedRaw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        return validateFabricRuntimeMetadata(cachedRaw, runtime);
      } catch (cacheErr: any) {
        throw new Error(
          `[FabricMeta] Network query failed (${networkError?.message}) and cached metadata at '${cachePath}' is corrupted: ${cacheErr.message}`
        );
      }
    }

    throw new Error(
      `[FabricMeta] Failed to resolve Fabric runtime for Minecraft ${runtime.minecraft} + Loader ${runtime.loader.version} and no offline cache exists: ${networkError?.message}`
    );
  }

  private static transformRawResponse(
    data: any,
    runtime: MinecraftRuntimeDefinition
  ): {
    loader: { version: string; maven: string };
    intermediary: { version: string; maven: string };
    libraries: FabricLibraryDefinition[];
    mainClass: string;
  } {
    if (!data || typeof data !== "object") {
      throw new Error(
        `[FabricMeta] Malformed Fabric Meta response for Minecraft ${runtime.minecraft} and Loader ${runtime.loader.version}.`
      );
    }

    if (
      !data.loader ||
      typeof data.loader !== "object" ||
      typeof data.loader.version !== "string" ||
      typeof data.loader.maven !== "string"
    ) {
      throw new Error(
        `[FabricMeta] Fabric Meta response has missing or invalid loader metadata.`
      );
    }

    if (data.loader.version !== runtime.loader.version) {
      throw new Error(
        `[FabricMeta] Fabric Meta returned loader version '${data.loader.version}', but '${runtime.loader.version}' was requested.`
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
        `[FabricMeta] Fabric Meta response is missing valid intermediary mappings for Minecraft ${runtime.minecraft}.`
      );
    }
    parseMavenCoordinate(data.intermediary.maven);

    if (!data.launcherMeta || typeof data.launcherMeta !== "object") {
      throw new Error(`[FabricMeta] Fabric Meta response is missing launcherMeta.`);
    }

    const clientMainClass = data.launcherMeta.mainClass?.client;
    if (typeof clientMainClass !== "string" || !clientMainClass.trim()) {
      throw new Error(`[FabricMeta] Fabric Meta response is missing launcherMeta.mainClass.client.`);
    }

    const commonLibs = data.launcherMeta.libraries?.common;
    if (!Array.isArray(commonLibs) || commonLibs.length === 0) {
      throw new Error(
        `[FabricMeta] Fabric Meta response has malformed or empty required library metadata.`
      );
    }

    // Build deduplicated library list
    const seenNames = new Set<string>();
    const libraries: FabricLibraryDefinition[] = [];

    function addLib(lib: { name: string; url?: string; sha256?: string; sha1?: string }) {
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
    addLib({ name: data.loader.maven, url: "https://maven.fabricmc.net/" });

    // 2. Intermediary artifact
    addLib({ name: data.intermediary.maven, url: "https://maven.fabricmc.net/" });

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
    fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    timeoutMs: number
  ): Promise<{ sha256?: string; sha1?: string }> {
    try {
      const coord = parseMavenCoordinate(lib.name);
      const relPath = mavenToPath(coord);
      const repoUrl = lib.url || "https://maven.fabricmc.net/";
      const artifactUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;

      // Try .sha256
      try {
        const signal = AbortSignal.timeout(Math.min(3000, timeoutMs));
        const res256 = await fetchFn(`${artifactUrl}.sha256`, { signal });
        if (res256.ok) {
          const text = (await res256.text()).trim().split(/\s+/)[0].toLowerCase();
          if (/^[0-9a-f]{64}$/.test(text)) {
            return { sha256: text };
          }
        }
      } catch {}

      // Try .sha1
      try {
        const signal = AbortSignal.timeout(Math.min(3000, timeoutMs));
        const res1 = await fetchFn(`${artifactUrl}.sha1`, { signal });
        if (res1.ok) {
          const text = (await res1.text()).trim().split(/\s+/)[0].toLowerCase();
          if (/^[0-9a-f]{40}$/.test(text)) {
            return { sha1: text };
          }
        }
      } catch {}
    } catch {}

    return {};
  }
}
