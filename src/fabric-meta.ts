import * as fs from "node:fs";
import * as path from "node:path";
import { validateRuntimeDefinition } from "./runtime-definition";
import type { MinecraftRuntimeDefinition } from "./types";

export interface FabricLibraryDefinition {
  name: string;
  url?: string;
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

export interface FabricMetaResolverOptions {
  metaBaseUrl?: string;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
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

    const url = `${metaBaseUrl.replace(/\/+$/, "")}/v2/versions/loader/${encodeURIComponent(runtime.minecraft)}/${encodeURIComponent(runtime.loader.version)}`;
    const cachePath = cacheDir
      ? this.getCachePath(cacheDir, runtime.minecraft, runtime.loader.version)
      : null;

    let networkError: Error | null = null;
    let data: any = null;

    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await customFetch(url, { signal });

      if (response.status === 404) {
        throw new Error(
          `[FabricMeta] Fabric Loader ${runtime.loader.version} is not available for Minecraft ${runtime.minecraft} (Fabric Meta returned 404 Not Found).`
        );
      }

      if (!response.ok) {
        throw new Error(
          `[FabricMeta] Fabric Meta query failed with HTTP ${response.status} ${response.statusText} (${url}).`
        );
      }

      data = await response.json();
    } catch (err: any) {
      networkError = err;
      // If 404, fail immediately without cache fallback
      if (err.message && err.message.includes("404 Not Found")) {
        throw err;
      }
    }

    // If network succeeded, validate and parse response
    if (data) {
      const metadata = this.validateAndTransform(data, runtime);

      // Save to cache if cache directory provided
      if (cachePath) {
        try {
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, JSON.stringify(metadata, null, 2), "utf-8");
        } catch {
          // Non-fatal cache write error
        }
      }

      return metadata;
    }

    // Network failed or offline: check cache
    if (cachePath && fs.existsSync(cachePath)) {
      try {
        const cachedRaw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        return this.validateCachedMetadata(cachedRaw, runtime);
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

  private static validateAndTransform(
    data: any,
    runtime: MinecraftRuntimeDefinition
  ): FabricRuntimeMetadata {
    if (!data || typeof data !== "object") {
      throw new Error(
        `[FabricMeta] Malformed Fabric Meta response for Minecraft ${runtime.minecraft} and Loader ${runtime.loader.version}.`
      );
    }

    if (
      !data.loader ||
      typeof data.loader !== "object" ||
      data.loader.version !== runtime.loader.version ||
      typeof data.loader.maven !== "string" ||
      !data.loader.maven.trim()
    ) {
      if (data?.loader?.version && data.loader.version !== runtime.loader.version) {
        throw new Error(
          `[FabricMeta] Fabric Meta returned loader version '${data?.loader?.version}', but '${runtime.loader.version}' was requested.`
        );
      }
      throw new Error(
        `[FabricMeta] Fabric Meta response has missing or invalid loader metadata (expected valid 'version' and 'maven' coordinates).`
      );
    }

    if (
      !data.intermediary ||
      typeof data.intermediary !== "object" ||
      typeof data.intermediary.maven !== "string" ||
      !data.intermediary.maven.trim() ||
      typeof data.intermediary.version !== "string" ||
      !data.intermediary.version.trim()
    ) {
      throw new Error(
        `[FabricMeta] Fabric Meta response is missing valid intermediary mappings for Minecraft ${runtime.minecraft}.`
      );
    }

    if (!data.launcherMeta || typeof data.launcherMeta !== "object") {
      throw new Error(`[FabricMeta] Fabric Meta response is missing launcherMeta.`);
    }

    if (!data.launcherMeta.mainClass || !data.launcherMeta.mainClass.client) {
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

    function addLib(lib: { name: string; url?: string }) {
      if (!lib || typeof lib.name !== "string" || !lib.name.trim()) return;
      if (!seenNames.has(lib.name)) {
        seenNames.add(lib.name);
        libraries.push({
          name: lib.name.trim(),
          url: lib.url || "https://maven.fabricmc.net/",
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
      mainClass: data.launcherMeta.mainClass.client,
    };
  }

  private static validateCachedMetadata(
    cached: any,
    runtime: MinecraftRuntimeDefinition
  ): FabricRuntimeMetadata {
    if (!cached || typeof cached !== "object") {
      throw new Error("Cached metadata is not an object.");
    }

    if (cached.loader?.version !== runtime.loader.version) {
      throw new Error(
        `Cached loader version '${cached.loader?.version}' does not match requested '${runtime.loader.version}'.`
      );
    }

    if (!cached.loader?.maven || !cached.intermediary?.maven || !cached.intermediary?.version) {
      throw new Error("Cached metadata is missing loader or intermediary maven coordinates.");
    }

    if (!cached.mainClass || typeof cached.mainClass !== "string") {
      throw new Error("Cached metadata is missing mainClass.");
    }

    if (!Array.isArray(cached.libraries) || cached.libraries.length === 0) {
      throw new Error("Cached metadata has empty or invalid library list.");
    }

    return cached as FabricRuntimeMetadata;
  }
}
