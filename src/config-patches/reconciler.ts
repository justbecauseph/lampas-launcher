import * as fs from "node:fs";
import type {
  AppliedConfigPatchState,
  ConfigPatch,
  InstallationState,
} from "../types";
import { AdapterRegistry } from "./registry";
import { LauncherLogger } from "../logger";

export interface ReconcileOptions {
  gameDir: string;
  patches: ConfigPatch[];
  prevState: InstallationState;
}

export interface ReconcileResult {
  appliedState: Record<string, AppliedConfigPatchState>;
  appliedCount: number;
  unchangedCount: number;
  deferredCount: number;
}

import {
  canonicalizeRelativePath,
  isPathProtected,
  resolveAndContainPath,
  checkPhysicalAncestry,
} from "../path-policy";
import { writeAtomicFile } from "../file-transfer";

export function isSafeConfigPatchPath(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== "string") return false;
  try {
    const canonical = canonicalizeRelativePath(targetPath);
    if (isPathProtected(canonical)) return false;
    if (canonical === ".lampas" || canonical.startsWith(".lampas/"))
      return false;
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteConfig(
  destination: string,
  content: string,
): Promise<void> {
  await writeAtomicFile(destination, content, { encoding: "utf-8" });
}

export async function reconcileConfigPatches(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const { gameDir, patches, prevState } = options;
  const appliedState: Record<string, AppliedConfigPatchState> = {
    ...(prevState.appliedConfigPatches || {}),
  };

  let appliedCount = 0;
  let unchangedCount = 0;
  let deferredCount = 0;

  for (const patch of patches) {
    if (!isSafeConfigPatchPath(patch.path)) {
      LauncherLogger.error(
        `[Config Patch] ✗ ${patch.id}\n  unsafe target path '${patch.path}'; file was left unchanged`,
      );
      throw new Error(
        `[Config Patch] ✗ ${patch.id}: unsafe target path '${patch.path}'`,
      );
    }

    // Handle 'once' patches
    if (patch.mode === "once") {
      const existing = appliedState[patch.id];
      if (existing && existing.revision >= patch.revision) {
        unchangedCount++;
        continue;
      }
    }

    const targetFullPath = resolveAndContainPath(gameDir, patch.path);
    await checkPhysicalAncestry(gameDir, targetFullPath, {
      enforceOwnership: true,
      disallowSymlinks: true,
    });

    for (const op of patch.operations || []) {
      if (op && typeof op === "object") {
        const key = (op as any).key;
        const opPath = (op as any).path;
        if (
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype" ||
          (typeof opPath === "string" &&
            (opPath.includes("__proto__") ||
              opPath.includes("constructor") ||
              opPath.includes("prototype")))
        ) {
          throw new Error(
            `[Config Patch] ✗ ${patch.id}: Prototype-sensitive operation rejected.`,
          );
        }
      }
    }

    const fileExists = fs.existsSync(targetFullPath);

    if (!fileExists) {
      if (patch.missingFile === "defer") {
        deferredCount++;
        LauncherLogger.info(
          `[Config Patch] ↪ ${patch.id} deferred; target missing`,
        );
        continue;
      }

      // missingFile === "create"
      let adapter;
      try {
        adapter = AdapterRegistry.get(patch.adapter);
      } catch (err: any) {
        LauncherLogger.error(
          `[Config Patch] ✗ ${patch.id}\n  ${err.message}; file was left unchanged`,
        );
        throw err;
      }

      if (!adapter.canCreate) {
        const msg = `adapter '${patch.adapter}' does not support creating new files`;
        LauncherLogger.error(
          `[Config Patch] ✗ ${patch.id}\n  ${msg}; file was left unchanged`,
        );
        throw new Error(`[Config Patch] ✗ ${patch.id}: ${msg}`);
      }

      try {
        const patchResult = adapter.apply("", patch.operations);
        adapter.validate(patchResult.output);

        await atomicWriteConfig(targetFullPath, patchResult.output);

        appliedCount++;
        if (patch.mode === "once") {
          appliedState[patch.id] = {
            revision: patch.revision,
            appliedAt: new Date().toISOString(),
          };
        }

        const details =
          patchResult.details && patchResult.details.length > 0
            ? `\n${patchResult.details.map((d) => `  ${d}`).join("\n")}`
            : "";
        LauncherLogger.info(
          `[Config Patch] ✓ ${patch.id}\n  ${patch.path}${details}`,
        );
      } catch (err: any) {
        LauncherLogger.error(
          `[Config Patch] ✗ ${patch.id}\n  ${err.message}; file was left unchanged`,
        );
        throw new Error(`[Config Patch] ✗ ${patch.id}: ${err.message}`);
      }
      continue;
    }

    // Target file exists
    let adapter;
    try {
      adapter = AdapterRegistry.get(patch.adapter);
    } catch (err: any) {
      LauncherLogger.error(
        `[Config Patch] ✗ ${patch.id}\n  ${err.message}; file was left unchanged`,
      );
      throw err;
    }

    let source = "";
    try {
      source = await fs.promises.readFile(targetFullPath, "utf-8");
    } catch (readErr: any) {
      LauncherLogger.error(
        `[Config Patch] ✗ ${patch.id}\n  failed to read target: ${readErr.message}; file was left unchanged`,
      );
      throw new Error(
        `[Config Patch] ✗ ${patch.id}: failed to read target: ${readErr.message}`,
      );
    }

    // Validate original syntax
    try {
      adapter.validate(source);
    } catch (valErr: any) {
      LauncherLogger.error(
        `[Config Patch] ✗ ${patch.id}\n  target contained invalid syntax (${valErr.message}); file was left unchanged`,
      );
      throw new Error(
        `[Config Patch] ✗ ${patch.id}: target contained invalid syntax: ${valErr.message}`,
      );
    }

    // Apply operations in memory
    let patchResult;
    try {
      patchResult = adapter.apply(source, patch.operations);
    } catch (applyErr: any) {
      LauncherLogger.error(
        `[Config Patch] ✗ ${patch.id}\n  failed to apply operations (${applyErr.message}); file was left unchanged`,
      );
      throw new Error(
        `[Config Patch] ✗ ${patch.id}: failed to apply operations: ${applyErr.message}`,
      );
    }

    // Validate resulting syntax
    try {
      adapter.validate(patchResult.output);
    } catch (outValErr: any) {
      LauncherLogger.error(
        `[Config Patch] ✗ ${patch.id}\n  resulting syntax invalid (${outValErr.message}); file was left unchanged`,
      );
      throw new Error(
        `[Config Patch] ✗ ${patch.id}: resulting syntax invalid: ${outValErr.message}`,
      );
    }

    if (!patchResult.changed) {
      unchangedCount++;
      if (patch.mode === "once") {
        appliedState[patch.id] = {
          revision: patch.revision,
          appliedAt: new Date().toISOString(),
        };
      }
      LauncherLogger.info(`[Config Patch] ✓ ${patch.id} already satisfied`);
      continue;
    }

    // Atomic write through the shared exclusive-staging helper.
    try {
      await atomicWriteConfig(targetFullPath, patchResult.output);
    } catch (writeErr: any) {
      LauncherLogger.error(
        `[Config Patch] ✗ ${patch.id}\n  failed to atomically write target: ${writeErr.message}; file was left unchanged`,
      );
      throw writeErr;
    }

    // Step 9: Post-patch verification pass
    try {
      const written = await fs.promises.readFile(targetFullPath, "utf-8");
      adapter.validate(written);
      const reapply = adapter.apply(written, patch.operations);
      if (reapply.changed) {
        throw new Error("reconciliation was not idempotent");
      }
    } catch (verifyErr: any) {
      LauncherLogger.error(
        `[Config Patch] ✗ ${patch.id}\n  post-patch verification failed: ${verifyErr.message}`,
      );
      throw new Error(
        `[Config Patch] ✗ ${patch.id}: post-patch verification failed: ${verifyErr.message}`,
      );
    }

    appliedCount++;
    if (patch.mode === "once") {
      appliedState[patch.id] = {
        revision: patch.revision,
        appliedAt: new Date().toISOString(),
      };
    }

    const details =
      patchResult.details && patchResult.details.length > 0
        ? `\n${patchResult.details.map((d) => `  ${d}`).join("\n")}`
        : "";
    LauncherLogger.info(
      `[Config Patch] ✓ ${patch.id}\n  ${patch.path}${details}`,
    );
  }

  return {
    appliedState,
    appliedCount,
    unchangedCount,
    deferredCount,
  };
}
