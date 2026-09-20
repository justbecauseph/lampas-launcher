import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

test("release inventory hashes actual artifact bytes and rejects mismatched tag or artifact versions", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "lampas-release-inventory-"),
  );
  const script = path.resolve(__dirname, "../scripts/security-artifacts.ts");
  const env = {
    ...process.env,
    GITHUB_SHA: "",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v1.3.0",
  };
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Security Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "--no-verify",
        "-m",
        "fixture",
      ],
      { cwd: fixture, stdio: "pipe" },
    );
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.3.0" }),
    );
    fs.writeFileSync(
      path.join(fixture, "bun.lock"),
      JSON.stringify({
        packages: {
          example: [
            "example@1.0.0",
            "",
            {},
            "sha512-" + Buffer.alloc(64).toString("base64"),
          ],
        },
      }),
    );
    fs.mkdirSync(path.join(fixture, "release"));
    const artifact = "LampasLauncher-1.3.0-Windows.exe";
    fs.writeFileSync(
      path.join(fixture, "release", artifact),
      "synthetic-distributable-bytes",
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: fixture,
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const sums = fs.readFileSync(
      path.join(fixture, "release", `SHA256SUMS-${process.platform}.txt`),
      "utf8",
    );
    const digest = createHash("sha256")
      .update("synthetic-distributable-bytes")
      .digest("hex");
    expect(sums).toContain(`${digest}  ${artifact}`);
    const bom = JSON.parse(
      fs.readFileSync(
        path.join(fixture, "release", `launcher-${process.platform}.cdx.json`),
        "utf8",
      ),
    );
    expect(bom.components[0].purl).toBe("pkg:npm/example@1.0.0");
    const mismatch = spawnSync(process.execPath, [script], {
      cwd: fixture,
      env: { ...env, GITHUB_REF_NAME: "v2.0.0" },
      encoding: "utf8",
    });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("does not match package version");
    fs.writeFileSync(
      path.join(fixture, "release", "LampasLauncher-9.9.9-Windows.exe"),
      "stale",
    );
    const stale = spawnSync(process.execPath, [script], {
      cwd: fixture,
      env,
      encoding: "utf8",
    });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("Unexpected artifact version");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
