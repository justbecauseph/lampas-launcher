import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse, type ParseError } from "jsonc-parser";

const errors: ParseError[] = [];
const lock = parse(fs.readFileSync("bun.lock", "utf8"), errors, {
  allowTrailingComma: true,
});
if (errors.length || !lock.packages)
  throw new Error("Cannot parse resolved lockfile for SBOM");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
    .length > 0;
const tag =
  process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : undefined;
if (tag && tag !== `v${pkg.version}`)
  throw new Error(
    `Release tag ${tag} does not match package version ${pkg.version}`,
  );
if (process.env.GITHUB_SHA && commit !== process.env.GITHUB_SHA)
  throw new Error("Build checkout does not match workflow SHA");
const components = new Map<string, any>();
for (const entry of Object.values(lock.packages) as any[][]) {
  const descriptor = entry[0];
  if (typeof descriptor !== "string")
    throw new Error("Invalid resolved package entry");
  const split = descriptor.lastIndexOf("@");
  if (split <= 0)
    throw new Error(`Unrecognized package descriptor ${descriptor}`);
  const name = descriptor.slice(0, split);
  const version = descriptor.slice(split + 1);
  const purl = `pkg:npm/${name.replace(/^@/, "%40")}@${encodeURIComponent(version)}`;
  const integrity = entry.find(
    (value) => typeof value === "string" && /^sha(?:256|512)-/.test(value),
  );
  components.set(purl, {
    type: "library",
    name,
    version,
    purl,
    "bom-ref": purl,
    ...(integrity
      ? {
          hashes: [
            {
              alg: integrity.startsWith("sha512-") ? "SHA-512" : "SHA-256",
              content: Buffer.from(integrity.split("-")[1], "base64").toString(
                "hex",
              ),
            },
          ],
        }
      : {}),
  });
}
const artifactDir = path.resolve(
  process.argv
    .find((arg) => arg.startsWith("--artifact-dir="))
    ?.slice("--artifact-dir=".length) || "release",
);
fs.mkdirSync(artifactDir, { recursive: true });
const platform = process.platform;
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: { type: "application", name: pkg.name, version: pkg.version },
    properties: [
      { name: "lampas:commit", value: commit },
      { name: "lampas:dirty", value: String(dirty) },
      {
        name: "lampas:scope",
        value: "All resolved runtime and build dependencies in bun.lock",
      },
    ],
  },
  components: [...components.values()].sort((a, b) =>
    a.purl.localeCompare(b.purl),
  ),
};
fs.writeFileSync(
  path.join(artifactDir, `launcher-${platform}.cdx.json`),
  JSON.stringify(bom, null, 2) + "\n",
);
const names = fs
  .readdirSync(artifactDir)
  .filter((name) => /\.(?:exe|AppImage|tar\.gz)$/.test(name))
  .sort();
if (!names.length)
  throw new Error("No distributable artifacts found for checksum generation");
const lines: string[] = [];
for (const name of [...names, `launcher-${platform}.cdx.json`]) {
  if (
    /\.(?:exe|AppImage|tar\.gz)$/.test(name) &&
    !name.includes(`-${pkg.version}-`) &&
    name !== `LampasLauncher-Setup-${pkg.version}.exe`
  )
    throw new Error(`Unexpected artifact version: ${name}`);
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(path.join(artifactDir, name)))
    digest.update(chunk);
  lines.push(`${digest.digest("hex")}  ${name}`);
}
fs.writeFileSync(
  path.join(artifactDir, `SHA256SUMS-${platform}.txt`),
  lines.join("\n") + "\n",
);
console.log(
  `Generated ${components.size} SBOM components and ${lines.length} SHA-256 checksums at commit ${commit}${dirty ? " (dirty working tree)" : ""}.`,
);
