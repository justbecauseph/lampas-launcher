import type { MinecraftRuntimeDefinition } from "./types";

export type { MinecraftRuntimeDefinition };

/**
 * Validates that a runtime definition has a non-empty Minecraft version,
 * a valid loader object, type === "fabric", and a non-empty loader version.
 * Never substitutes a fallback loader or Minecraft version.
 */
export function validateRuntimeDefinition(
  minecraftOrObj: unknown,
  loaderArg?: unknown,
  context: string = "runtime definition"
): MinecraftRuntimeDefinition {
  let minecraft: unknown = minecraftOrObj;
  let loader: unknown = loaderArg;

  if (
    loaderArg === undefined &&
    minecraftOrObj !== null &&
    typeof minecraftOrObj === "object" &&
    !Array.isArray(minecraftOrObj)
  ) {
    const obj = minecraftOrObj as Record<string, unknown>;
    minecraft = obj.minecraft;
    loader = obj.loader;
  }

  if (typeof minecraft !== "string" || !minecraft.trim()) {
    throw new Error(`Invalid ${context}: missing or empty 'minecraft' version.`);
  }

  if (!loader || typeof loader !== "object" || Array.isArray(loader)) {
    throw new Error(`Invalid ${context}: missing or invalid 'loader' object.`);
  }

  const loaderObj = loader as Record<string, unknown>;

  if (loaderObj.type !== "fabric") {
    if (typeof loaderObj.type === "string" && loaderObj.type.trim()) {
      throw new Error(
        `Invalid ${context}: unsupported loader type '${loaderObj.type}'. Only 'fabric' is supported.`
      );
    }
    throw new Error(`Invalid ${context}: missing or invalid loader 'type' (expected 'fabric').`);
  }

  if (typeof loaderObj.version !== "string" || !loaderObj.version.trim()) {
    throw new Error(`Invalid ${context}: missing or empty loader 'version'.`);
  }

  return {
    minecraft: minecraft.trim(),
    loader: {
      type: "fabric",
      version: loaderObj.version.trim(),
    },
  };
}

/**
 * Resolves and cross-checks the runtime definition between the release descriptor
 * and client manifest. Both must match on Minecraft version, loader type, and loader version.
 * Fails hard before any pack mutation if there is a mismatch.
 */
export function resolveRuntimeDefinition(
  release: unknown,
  manifest: unknown
): MinecraftRuntimeDefinition {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("Invalid release descriptor: missing or not an object.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid client manifest: missing or not an object.");
  }

  const rel = release as Record<string, unknown>;
  const man = manifest as Record<string, unknown>;

  const releaseRuntime = validateRuntimeDefinition(rel.minecraft, rel.loader, "release descriptor");
  const manifestRuntime = validateRuntimeDefinition(man.minecraft, man.loader, "client manifest");

  if (releaseRuntime.minecraft !== manifestRuntime.minecraft) {
    throw new Error(
      `Invalid Lampas release: release descriptor requires Minecraft ${releaseRuntime.minecraft}, client manifest requires Minecraft ${manifestRuntime.minecraft}.`
    );
  }

  if (releaseRuntime.loader.type !== manifestRuntime.loader.type) {
    throw new Error(
      `Invalid Lampas release: release descriptor requires loader type '${releaseRuntime.loader.type}', client manifest requires loader type '${manifestRuntime.loader.type}'.`
    );
  }

  if (releaseRuntime.loader.version !== manifestRuntime.loader.version) {
    throw new Error(
      `Invalid Lampas release: release descriptor requires Fabric ${releaseRuntime.loader.version}, client manifest requires Fabric ${manifestRuntime.loader.version}.`
    );
  }

  return releaseRuntime;
}
