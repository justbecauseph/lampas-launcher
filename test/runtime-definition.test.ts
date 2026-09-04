import { describe, expect, test } from "bun:test";
import { resolveRuntimeDefinition, validateRuntimeDefinition } from "../src/runtime-definition";

describe("RuntimeDefinition validation", () => {
  test("validates a valid runtime definition passed as 2 arguments", () => {
    const runtime = validateRuntimeDefinition("26.2", {
      type: "fabric",
      version: "0.19.3",
    });
    expect(runtime).toEqual({
      minecraft: "26.2",
      loader: {
        type: "fabric",
        version: "0.19.3",
      },
    });
  });

  test("validates a valid runtime definition passed as a single object", () => {
    const runtime = validateRuntimeDefinition({
      minecraft: "26.2",
      loader: {
        type: "fabric",
        version: "0.99.123-test",
      },
    });
    expect(runtime).toEqual({
      minecraft: "26.2",
      loader: {
        type: "fabric",
        version: "0.99.123-test",
      },
    });
  });

  test("trims leading and trailing whitespace from versions", () => {
    const runtime = validateRuntimeDefinition("  26.2  ", {
      type: "fabric",
      version: "  0.19.3  ",
    });
    expect(runtime.minecraft).toBe("26.2");
    expect(runtime.loader.version).toBe("0.19.3");
  });

  test("rejects missing, empty, or non-string minecraft version", () => {
    expect(() => validateRuntimeDefinition("", { type: "fabric", version: "0.19.3" })).toThrow(
      /missing or empty 'minecraft' version/
    );
    expect(() => validateRuntimeDefinition("   ", { type: "fabric", version: "0.19.3" })).toThrow(
      /missing or empty 'minecraft' version/
    );
    expect(() => validateRuntimeDefinition(null, { type: "fabric", version: "0.19.3" })).toThrow(
      /missing or empty 'minecraft' version/
    );
    expect(() => validateRuntimeDefinition(123 as any, { type: "fabric", version: "0.19.3" })).toThrow(
      /missing or empty 'minecraft' version/
    );
  });

  test("rejects missing or invalid loader object", () => {
    expect(() => validateRuntimeDefinition("26.2", null)).toThrow(
      /missing or invalid 'loader' object/
    );
    expect(() => validateRuntimeDefinition("26.2", "fabric")).toThrow(
      /missing or invalid 'loader' object/
    );
    expect(() => validateRuntimeDefinition("26.2", [])).toThrow(
      /missing or invalid 'loader' object/
    );
  });

  test("rejects unsupported loader types (neoforge, forge, quilt) with explicit error", () => {
    expect(() =>
      validateRuntimeDefinition("26.2", { type: "neoforge", version: "20.4.0" })
    ).toThrow(/unsupported loader type 'neoforge'. Only 'fabric' is supported/);

    expect(() =>
      validateRuntimeDefinition("26.2", { type: "forge", version: "47.2.0" })
    ).toThrow(/unsupported loader type 'forge'. Only 'fabric' is supported/);

    expect(() =>
      validateRuntimeDefinition("26.2", { type: "quilt", version: "0.25.0" })
    ).toThrow(/unsupported loader type 'quilt'. Only 'fabric' is supported/);
  });

  test("rejects missing, empty, or non-string loader version", () => {
    expect(() => validateRuntimeDefinition("26.2", { type: "fabric" })).toThrow(
      /missing or empty loader 'version'/
    );
    expect(() => validateRuntimeDefinition("26.2", { type: "fabric", version: "" })).toThrow(
      /missing or empty loader 'version'/
    );
    expect(() => validateRuntimeDefinition("26.2", { type: "fabric", version: "   " })).toThrow(
      /missing or empty loader 'version'/
    );
    expect(() => validateRuntimeDefinition("26.2", { type: "fabric", version: 19 as any })).toThrow(
      /missing or empty loader 'version'/
    );
  });
});

describe("RuntimeDefinition resolution and release/manifest cross-checking", () => {
  test("resolves runtime definition when release and manifest match exactly", () => {
    const release = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
    };
    const manifest = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
    };

    const runtime = resolveRuntimeDefinition(release, manifest);
    expect(runtime).toEqual({
      minecraft: "26.2",
      loader: {
        type: "fabric",
        version: "0.19.3",
      },
    });
  });

  test("resolves sentinel non-default loader version (0.99.123-test)", () => {
    const release = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.99.123-test" },
    };
    const manifest = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.99.123-test" },
    };

    const runtime = resolveRuntimeDefinition(release, manifest);
    expect(runtime.loader.version).toBe("0.99.123-test");
  });

  test("rejects when release descriptor requires different Fabric version than manifest", () => {
    const release = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
    };
    const manifest = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.4" },
    };

    expect(() => resolveRuntimeDefinition(release, manifest)).toThrow(
      "Invalid Lampas release: release descriptor requires Fabric 0.19.3, client manifest requires Fabric 0.19.4."
    );
  });

  test("rejects when release descriptor requires different Minecraft version than manifest", () => {
    const release = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
    };
    const manifest = {
      minecraft: "26.3",
      loader: { type: "fabric", version: "0.19.3" },
    };

    expect(() => resolveRuntimeDefinition(release, manifest)).toThrow(
      "Invalid Lampas release: release descriptor requires Minecraft 26.2, client manifest requires Minecraft 26.3."
    );
  });

  test("rejects when release or manifest is missing or not an object", () => {
    expect(() => resolveRuntimeDefinition(null, {})).toThrow(
      /Invalid release descriptor: missing or not an object/
    );
    expect(() => resolveRuntimeDefinition({}, null)).toThrow(
      /Invalid client manifest: missing or not an object/
    );
  });

  test("rejects when release descriptor has missing loader", () => {
    const release = { minecraft: "26.2" };
    const manifest = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
    };
    expect(() => resolveRuntimeDefinition(release, manifest)).toThrow(
      /Invalid release descriptor: missing or invalid 'loader' object/
    );
  });

  test("rejects when client manifest has missing loader", () => {
    const release = {
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.19.3" },
    };
    const manifest = { minecraft: "26.2" };
    expect(() => resolveRuntimeDefinition(release, manifest)).toThrow(
      /Invalid client manifest: missing or invalid 'loader' object/
    );
  });
});
