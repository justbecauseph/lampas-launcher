import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureRequiredResourcePacks,
  reconcileRequiredResourcePacks,
  reconcileResourcePacks,
  verifyRequiredResourcePacks,
  isValidServerAddress,
} from "../src/resource-packs";
import type { RequiredResourcePack } from "../src/types";

describe("reconcileResourcePacks helper", () => {
  test("adds required pack to default vanilla list", () => {
    const existing = ["vanilla"];
    const current = ["file/Lampas-Resources-2.0.0.zip"];
    const old: string[] = [];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/Lampas-Resources-2.0.0.zip",
    ]);
  });

  test("preserves existing unrelated user packs and their ordering", () => {
    const existing = ["vanilla", "file/Faithful32.zip", "file/CustomAudio.zip"];
    const current = ["file/Lampas-Resources-2.0.0.zip"];
    const old: string[] = [];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/Faithful32.zip",
      "file/CustomAudio.zip",
      "file/Lampas-Resources-2.0.0.zip",
    ]);
  });

  test("replaces old managed version with new version and preserves user packs", () => {
    const existing = ["vanilla", "file/Faithful32.zip", "file/Lampas-Resources-2.0.0.zip", "file/CustomAudio.zip"];
    const current = ["file/Lampas-Resources-2.1.0.zip"];
    const old = ["file/Lampas-Resources-2.0.0.zip"];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/Faithful32.zip",
      "file/CustomAudio.zip",
      "file/Lampas-Resources-2.1.0.zip",
    ]);
  });

  test("removes obsolete managed packs when required set becomes empty", () => {
    const existing = ["vanilla", "file/Faithful32.zip", "file/Lampas-Resources-2.0.0.zip"];
    const current: string[] = [];
    const old = ["file/Lampas-Resources-2.0.0.zip"];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/Faithful32.zip",
    ]);
  });

  test("preserves deterministic ordering among multiple required packs", () => {
    const existing = ["vanilla", "file/UserPack.zip"];
    const current = ["file/PackA.zip", "file/PackB.zip", "file/PackC.zip"];
    const old: string[] = [];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/UserPack.zip",
      "file/PackA.zip",
      "file/PackB.zip",
      "file/PackC.zip",
    ]);
  });

  test("deduplicates multiple identical required entries", () => {
    const existing = ["vanilla"];
    const current = ["file/PackA.zip", "file/PackA.zip", "file/PackB.zip"];
    const old: string[] = [];
    expect(reconcileResourcePacks(existing, current, old)).toEqual([
      "vanilla",
      "file/PackA.zip",
      "file/PackB.zip",
    ]);
  });
});

describe("verifyRequiredResourcePacks SHA-256 verification", () => {
  function createTestEnvironment() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-rp-verify-test-"));
    const rpDir = path.join(dir, "resourcepacks");
    fs.mkdirSync(rpDir, { recursive: true });

    return {
      dir,
      rpDir,
      createPackFile: (filename: string, content = "dummy zip content") => {
        const filePath = path.join(rpDir, filename);
        fs.writeFileSync(filePath, content);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        return { filePath, hash, size: Buffer.byteLength(content) };
      },
    };
  }

  test("passes when file exists and hash matches", async () => {
    const env = createTestEnvironment();
    try {
      const { hash } = env.createPackFile("test-pack.zip", "valid pack content");
      const required: RequiredResourcePack[] = [
        {
          id: "test-pack",
          filename: "test-pack.zip",
          path: "resourcepacks/test-pack.zip",
          sha256: hash,
        },
      ];
      await expect(verifyRequiredResourcePacks(env.dir, required)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("fails when file exists but hash mismatches", async () => {
    const env = createTestEnvironment();
    try {
      env.createPackFile("test-pack.zip", "actual pack content");
      const required: RequiredResourcePack[] = [
        {
          id: "test-pack",
          filename: "test-pack.zip",
          path: "resourcepacks/test-pack.zip",
          sha256: "0".repeat(64),
        },
      ];
      await expect(verifyRequiredResourcePacks(env.dir, required)).rejects.toThrow(
        /Required resource pack 'test-pack' failed integrity verification/
      );
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("fails when file is missing", async () => {
    const env = createTestEnvironment();
    try {
      const required: RequiredResourcePack[] = [
        {
          id: "missing-pack",
          filename: "missing-pack.zip",
          path: "resourcepacks/missing-pack.zip",
          sha256: "a".repeat(64),
        },
      ];
      await expect(verifyRequiredResourcePacks(env.dir, required)).rejects.toThrow(
        /File missing at resourcepacks\/missing-pack\.zip/
      );
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });
});

describe("reconcileRequiredResourcePacks integration", () => {
  function createTestEnvironment() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-rp-test-"));
    const rpDir = path.join(dir, "resourcepacks");
    const stateDir = path.join(dir, ".lampas");
    fs.mkdirSync(rpDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    return {
      dir,
      rpDir,
      stateDir,
      optionsPath: path.join(dir, "options.txt"),
      createPackFile: (filename: string, content = "dummy zip content") => {
        const filePath = path.join(rpDir, filename);
        fs.writeFileSync(filePath, content);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        return { filePath, hash, size: Buffer.byteLength(content) };
      },
    };
  }

  test("creates options.txt when it does not exist", async () => {
    const env = createTestEnvironment();
    try {
      const { hash } = env.createPackFile("Lampas-Resources-2.0.0.zip");
      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          sha256: hash,
        },
      ];

      const result = await reconcileRequiredResourcePacks(env.dir, {
        required,
        previousManaged: [],
      });

      expect(result).toEqual(["Lampas-Resources-2.0.0.zip"]);
      expect(fs.existsSync(env.optionsPath)).toBe(true);
      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).toContain('resourcePacks:["vanilla","file/Lampas-Resources-2.0.0.zip"]');
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("cleans options.txt when required set becomes empty", async () => {
    const env = createTestEnvironment();
    try {
      const initialOptions = [
        "gamma:1.0",
        'resourcePacks:["vanilla","file/UserTexture.zip","file/Lampas-Resources-2.0.0.zip"]',
      ].join("\n");
      fs.writeFileSync(env.optionsPath, initialOptions, "utf-8");

      const result = await reconcileRequiredResourcePacks(env.dir, {
        required: [],
        previousManaged: ["Lampas-Resources-2.0.0.zip"],
      });

      expect(result).toEqual([]);
      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).not.toContain("Lampas-Resources-2.0.0.zip");
      expect(content).toContain('resourcePacks:["vanilla","file/UserTexture.zip"]');
      expect(content).toContain("gamma:1.0");
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("preserves CRLF line endings in options.txt", async () => {
    const env = createTestEnvironment();
    try {
      const { hash } = env.createPackFile("Lampas-Resources-2.1.0.zip");
      const initialOptions = "gamma:1.0\r\nresourcePacks:[\"vanilla\"]\r\nfov:70.0\r\n";
      fs.writeFileSync(env.optionsPath, initialOptions, "utf-8");

      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Resources-2.1.0.zip",
          path: "resourcepacks/Lampas-Resources-2.1.0.zip",
          sha256: hash,
        },
      ];

      await reconcileRequiredResourcePacks(env.dir, {
        required,
        previousManaged: [],
      });

      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content.includes("\r\n")).toBe(true);
      expect(content).toContain('resourcePacks:["vanilla","file/Lampas-Resources-2.1.0.zip"]');
      expect(content).toContain("fov:70.0");
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test("reconstructs malformed options.txt line and creates backup", async () => {
    const env = createTestEnvironment();
    try {
      const { hash } = env.createPackFile("Lampas-Resources-2.0.0.zip");
      const malformedOptions = "gamma:1.0\nresourcePacks:[MALFORMED_JSON{{\nfov:70.0\n";
      fs.writeFileSync(env.optionsPath, malformedOptions, "utf-8");

      const required: RequiredResourcePack[] = [
        {
          id: "lampas",
          filename: "Lampas-Resources-2.0.0.zip",
          path: "resourcepacks/Lampas-Resources-2.0.0.zip",
          sha256: hash,
        },
      ];

      await reconcileRequiredResourcePacks(env.dir, {
        required,
        previousManaged: [],
      });

      const backupPath = path.join(env.dir, "options.txt.lampas-backup");
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, "utf-8")).toBe(malformedOptions);

      const content = fs.readFileSync(env.optionsPath, "utf-8");
      expect(content).toContain('resourcePacks:["vanilla","file/Lampas-Resources-2.0.0.zip"]');
      expect(content).toContain("gamma:1.0");
      expect(content).toContain("fov:70.0");
    } finally {
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });
});

