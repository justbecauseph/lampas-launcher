import {
  PathContainmentError,
  canonicalizeRelativePath,
  isPathProtected,
  sanitizeInstallationState,
  validateDigestString,
  validateManifestMetadata,
} from "./path-policy";
import type {
  ConfigPatch,
  InstallationState,
  RequiredResourcePack,
} from "./types";

/**
 * The Portal and pipeline publish two deliberately small JSON contracts:
 * release descriptors (schema 1) and pack manifests (schema 2).  Keep this
 * validator independent of Electron and of the download code so callers can
 * validate the complete response before creating a directory or touching an
 * installed file.
 */
export const MAX_SUPPORTED_PROTOCOL = 3;
export const RELEASE_SCHEMA_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 2;

const MAX_STRING = 4096;
const MAX_ID = 128;
const MAX_ARRAY = 100_000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 64 * 1024 * 1024 * 1024;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class MetadataValidationError extends Error {
  readonly kind = "schema" as const;
  readonly isMetadataValidationError = true;

  constructor(message: string) {
    super(message);
    this.name = "MetadataValidationError";
  }
}

export class MetadataIntegrityError extends Error {
  readonly kind = "integrity" as const;
  readonly isMetadataIntegrityError = true;

  constructor(message: string) {
    super(message);
    this.name = "MetadataIntegrityError";
  }
}

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new MetadataValidationError(message);
}

function record(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object.`);
  }
  const object = value as JsonRecord;
  for (const key of Object.keys(object)) {
    if (PROTOTYPE_KEYS.has(key))
      fail(`${context} contains a prohibited property key '${key}'.`);
  }
  return object;
}

function keys(
  value: JsonRecord,
  allowed: readonly string[],
  context: string,
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key))
      fail(`${context} contains an unknown property '${key}'.`);
  }
}

function stringValue(
  value: unknown,
  context: string,
  max = MAX_STRING,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    fail(`${context} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function textValue(value: unknown, context: string, max = MAX_STRING): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  ) {
    fail(`${context} must be text of at most ${max} characters.`);
  }
  return value;
}

function version(value: unknown, context: string): string {
  const text = stringValue(value, context, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(text)) {
    fail(`${context} has an invalid version format.`);
  }
  return text;
}

function numericVersion(value: unknown, context: string): string {
  const text = version(value, context);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text)) {
    fail(`${context} must be a numeric semantic version.`);
  }
  return text;
}

function integer(
  value: unknown,
  context: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${context} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY)
    fail(`${context} must be an array of at most ${MAX_ARRAY} items.`);
  return value;
}

function urlValue(value: unknown, context: string): string {
  const text = stringValue(value, context, 2048);
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(`${context} must be an HTTP(S) URL or a root-relative path.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(`${context} must use HTTP or HTTPS.`);
  }
  return text;
}

function validateJsonValue(value: unknown, context: string, depth = 0): void {
  if (depth > 20) fail(`${context} is nested too deeply.`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "string" && value.length > MAX_STRING)
      fail(`${context} string is too long.`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail(`${context} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) fail(`${context} array is too large.`);
    value.forEach((item, index) =>
      validateJsonValue(item, `${context}[${index}]`, depth + 1),
    );
    return;
  }
  if (typeof value === "object") {
    const object = record(value, context);
    if (Object.keys(object).length > 256)
      fail(`${context} has too many properties.`);
    for (const [key, item] of Object.entries(object))
      validateJsonValue(item, `${context}.${key}`, depth + 1);
    return;
  }
  fail(`${context} contains an unsupported JSON value.`);
}

function validateLoader(value: unknown, context: string): void {
  const loader = record(value, context);
  keys(loader, ["type", "version"], context);
  if (loader.type !== "fabric") fail(`${context}.type must be 'fabric'.`);
  stringValue(loader.version, `${context}.version`, 128);
}

function validateManifestUrlIdentity(
  url: string,
  releaseVersion: string,
  context: string,
): void {
  // Portal emits /api/v1/releases/<version>/..., while pipeline release.json
  // emits an absolute Portal URL.  Bind the endpoint to the release identity.
  let parsed: URL | undefined;
  if (!url.startsWith("/")) parsed = new URL(url);
  const pathname = parsed?.pathname ?? url;
  const match = pathname.match(
    /^\/api\/v1\/releases\/([^/]+)\/(?:client|server)-manifest$/,
  );
  if (!match) fail(`${context} must target the release manifest route.`);
  let routeVersion: string;
  try {
    routeVersion = decodeURIComponent(match[1]);
  } catch {
    fail(`${context} contains an invalid encoded release version.`);
  }
  if (routeVersion !== releaseVersion) {
    fail(`${context} does not belong to release ${releaseVersion}.`);
  }
}

function validateLaunch(value: unknown): void {
  if (value === undefined) return;
  const launch = record(value, "release.launch");
  keys(
    launch,
    ["autoConnect", "server", "requiredResourcePacks"],
    "release.launch",
  );
  if (
    launch.autoConnect !== undefined &&
    typeof launch.autoConnect !== "boolean"
  )
    fail("release.launch.autoConnect must be boolean.");
  if (launch.server !== undefined)
    stringValue(launch.server, "release.launch.server", 512);
  if (launch.requiredResourcePacks !== undefined) {
    boundedArray(
      launch.requiredResourcePacks,
      "release.launch.requiredResourcePacks",
    );
    for (const [index, item] of (
      launch.requiredResourcePacks as unknown[]
    ).entries())
      validateRequiredResourcePack(item, index);
  }
}

export function validateRequiredResourcePack(
  value: unknown,
  index = 0,
): RequiredResourcePack {
  const context = `release.launch.requiredResourcePacks[${index}]`;
  const pack = record(value, context);
  keys(pack, ["id", "filename", "path", "sha256", "sha1"], context);
  stringValue(pack.id, `${context}.id`, MAX_ID);
  const filename = stringValue(pack.filename, `${context}.filename`, 512);
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename !== filename.trim()
  )
    fail(`${context}.filename must be a basename.`);
  const relativePath = canonicalizeRelativePath(
    stringValue(pack.path, `${context}.path`, 1024),
  );
  if (isPathProtected(relativePath))
    fail(`${context}.path targets a protected namespace.`);
  const sha256 = validateDigestString(
    stringValue(pack.sha256, `${context}.sha256`, 128),
    "sha256",
  );
  const sha1 =
    pack.sha1 === undefined
      ? undefined
      : validateDigestString(
          stringValue(pack.sha1, `${context}.sha1`, 128),
          "sha1",
        );
  return {
    id: pack.id as string,
    filename,
    path: relativePath,
    sha256,
    ...(sha1 ? { sha1 } : {}),
  };
}

export function validateChannelResponse(
  value: unknown,
  expectedChannel: string,
): { channel: string; version: string; release: string } {
  const channel = record(value, "channel response");
  keys(channel, ["channel", "version", "release"], "channel response");
  if (channel.channel !== expectedChannel)
    fail(`channel response.channel does not match '${expectedChannel}'.`);
  const name = stringValue(
    channel.channel,
    "channel response.channel",
    16,
  ).toLowerCase();
  if (!/^(stable|beta|dev)$/.test(name))
    fail("channel response.channel is unsupported.");
  const targetVersion = version(channel.version, "channel response.version");
  const release = urlValue(channel.release, "channel response.release");
  const releasePath = new URL(release, "https://metadata.invalid/").pathname;
  const releaseMatch = releasePath.match(/^\/api\/v1\/releases\/([^/]+)$/);
  let releaseVersion: string | undefined;
  try {
    releaseVersion = releaseMatch
      ? decodeURIComponent(releaseMatch[1])
      : undefined;
  } catch {
    releaseVersion = undefined;
  }
  if (!releaseMatch || releaseVersion !== targetVersion) {
    fail(
      "channel response.release must target the channel version release route.",
    );
  }
  return { channel: name, version: targetVersion, release };
}

export interface ValidatedReleaseDescriptor extends JsonRecord {
  schemaVersion: 1;
  pack: string;
  version: string;
  minecraft: string;
  loader: { type: "fabric"; version: string };
  minimumLauncherVersion: string;
  protocol: number;
  created: string;
  clientManifest: string;
  serverManifest: string;
}

export function validateReleaseDescriptor(
  value: unknown,
): ValidatedReleaseDescriptor {
  const release = record(value, "release descriptor");
  keys(
    release,
    [
      "$schema",
      "schemaVersion",
      "pack",
      "version",
      "minecraft",
      "loader",
      "minimumLauncherVersion",
      "protocol",
      "status",
      "gitCommit",
      "created",
      "clientManifest",
      "serverManifest",
      "totalMods",
      "totalFiles",
      "launch",
      "signature",
      "serverResourcePack",
    ],
    "release descriptor",
  );
  if (release.schemaVersion !== RELEASE_SCHEMA_VERSION)
    fail(`release descriptor.schemaVersion must be ${RELEASE_SCHEMA_VERSION}.`);
  if (release.$schema !== undefined)
    stringValue(release.$schema, "release descriptor.$schema", 2048);
  const releaseVersion = version(release.version, "release descriptor.version");
  stringValue(release.pack, "release descriptor.pack", 256);
  stringValue(release.minecraft, "release descriptor.minecraft", 128);
  validateLoader(release.loader, "release descriptor.loader");
  numericVersion(
    release.minimumLauncherVersion,
    "release descriptor.minimumLauncherVersion",
  );
  const protocol = integer(
    release.protocol,
    "release descriptor.protocol",
    0,
    255,
  );
  const created = stringValue(
    release.created,
    "release descriptor.created",
    128,
  );
  if (!Number.isFinite(Date.parse(created)))
    fail("release descriptor.created must be an ISO date-time.");
  const clientManifest = urlValue(
    release.clientManifest,
    "release descriptor.clientManifest",
  );
  const serverManifest = urlValue(
    release.serverManifest,
    "release descriptor.serverManifest",
  );
  validateManifestUrlIdentity(
    clientManifest,
    releaseVersion,
    "release descriptor.clientManifest",
  );
  validateManifestUrlIdentity(
    serverManifest,
    releaseVersion,
    "release descriptor.serverManifest",
  );
  if (release.status !== undefined)
    stringValue(release.status, "release descriptor.status", 32);
  // Portal serializes an absent optional provenance field as SQL/JSON null.
  if (release.gitCommit !== undefined && release.gitCommit !== null)
    stringValue(release.gitCommit, "release descriptor.gitCommit", 128);
  if (release.signature !== undefined && release.signature !== null)
    stringValue(release.signature, "release descriptor.signature", 4096);
  if (release.totalMods !== undefined)
    integer(release.totalMods, "release descriptor.totalMods");
  if (release.totalFiles !== undefined)
    integer(release.totalFiles, "release descriptor.totalFiles");
  validateLaunch(release.launch);
  if (release.serverResourcePack !== undefined)
    validateResourcePack(release.serverResourcePack);
  return release as ValidatedReleaseDescriptor;
}

function validateMod(value: unknown, index: number): void {
  const context = `manifest.mods[${index}]`;
  const mod = record(value, context);
  keys(
    mod,
    [
      "id",
      "name",
      "side",
      "filename",
      "size",
      "description",
      "iconUrl",
      "categories",
      "sourceUrl",
    ],
    context,
  );
  stringValue(mod.id, `${context}.id`, MAX_ID);
  stringValue(mod.name, `${context}.name`, 512);
  if (mod.side !== "client" && mod.side !== "server" && mod.side !== "both")
    fail(`${context}.side is unsupported.`);
  const filename = stringValue(mod.filename, `${context}.filename`, 512);
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename !== filename.trim()
  )
    fail(`${context}.filename must be a basename.`);
  integer(mod.size, `${context}.size`);
  for (const field of ["description", "iconUrl", "sourceUrl"] as const) {
    if (mod[field] !== undefined)
      field.endsWith("Url")
        ? urlValue(mod[field], `${context}.${field}`)
        : textValue(mod[field], `${context}.${field}`, 4096);
  }
  if (mod.categories !== undefined) {
    boundedArray(mod.categories, `${context}.categories`);
    for (const [categoryIndex, category] of (
      mod.categories as unknown[]
    ).entries())
      stringValue(category, `${context}.categories[${categoryIndex}]`, 128);
  }
}

function validateFile(value: unknown, index: number): number {
  const context = `manifest.files[${index}]`;
  const file = record(value, context);
  keys(file, ["path", "size", "hashes", "download", "policy"], context);
  let relativePath: string;
  try {
    relativePath = canonicalizeRelativePath(
      stringValue(file.path, `${context}.path`, 1024),
    );
  } catch (error) {
    throw new PathContainmentError(
      `Unsafe relative path in manifest: '${String(file.path)}': ${String(error)}`,
    );
  }
  if (isPathProtected(relativePath))
    fail(`${context}.path targets a protected namespace.`);
  const size = integer(file.size, `${context}.size`, 0, MAX_FILE_SIZE);
  const hashes = record(file.hashes, `${context}.hashes`);
  keys(hashes, ["sha256", "sha512"], `${context}.hashes`);
  validateDigestString(
    stringValue(hashes.sha256, `${context}.hashes.sha256`, 128),
    "sha256",
  );
  if (hashes.sha512 !== undefined) {
    const sha512 = stringValue(hashes.sha512, `${context}.hashes.sha512`, 256);
    if (!/^[0-9a-fA-F]{128}$/.test(sha512))
      fail(`${context}.hashes.sha512 must be 128 hexadecimal characters.`);
  }
  const download = record(file.download, `${context}.download`);
  keys(download, ["url", "provider"], `${context}.download`);
  urlValue(download.url, `${context}.download.url`);
  if (
    download.provider !== "modrinth" &&
    download.provider !== "curseforge" &&
    download.provider !== "lampas" &&
    download.provider !== "direct"
  )
    fail(`${context}.download.provider is unsupported.`);
  if (
    file.policy !== "MANAGED" &&
    file.policy !== "PRESERVE" &&
    file.policy !== "OPTIONAL" &&
    file.policy !== "GENERATED"
  )
    fail(`${context}.policy is unsupported.`);
  return size;
}

function validateConfigPatch(value: unknown, index: number): ConfigPatch {
  const context = `manifest.configPatches[${index}]`;
  const patch = record(value, context);
  keys(
    patch,
    ["id", "revision", "path", "adapter", "mode", "missingFile", "operations"],
    context,
  );
  const id = stringValue(patch.id, `${context}.id`, MAX_ID);
  const revision = integer(patch.revision, `${context}.revision`, 1);
  const patchPath = canonicalizeRelativePath(
    stringValue(patch.path, `${context}.path`, 1024),
  );
  if (isPathProtected(patchPath))
    fail(`${context}.path targets a protected namespace.`);
  const adapter = stringValue(patch.adapter, `${context}.adapter`, 32);
  if (
    !["json", "jsonc", "yaml", "toml", "properties", "ini", "text"].includes(
      adapter,
    )
  )
    fail(`${context}.adapter is unsupported.`);
  if (patch.mode !== "enforce" && patch.mode !== "once")
    fail(`${context}.mode is unsupported.`);
  if (patch.missingFile !== "defer" && patch.missingFile !== "create")
    fail(`${context}.missingFile is unsupported.`);
  if (adapter === "text" && patch.missingFile === "create")
    fail(`${context}.text patches cannot create missing files.`);
  const operations = boundedArray(patch.operations, `${context}.operations`);
  if (operations.length < 1) fail(`${context}.operations must not be empty.`);
  for (const [operationIndex, operationValue] of operations.entries()) {
    const operationContext = `${context}.operations[${operationIndex}]`;
    const operation = record(operationValue, operationContext);
    if (operation.op === "set" || operation.op === "remove") {
      keys(
        operation,
        operation.op === "set" ? ["op", "path", "value"] : ["op", "path"],
        operationContext,
      );
      const operationPath = boundedArray(
        operation.path,
        `${operationContext}.path`,
      );
      if (operationPath.length < 1 || operationPath.length > 64)
        fail(`${operationContext}.path has an invalid length.`);
      operationPath.forEach((part, partIndex) => {
        if (typeof part === "string") {
          stringValue(part, `${operationContext}.path[${partIndex}]`, 256);
          if (PROTOTYPE_KEYS.has(part))
            fail(
              `${operationContext}.path contains a prohibited property key '${part}'.`,
            );
        } else integer(part, `${operationContext}.path[${partIndex}]`, 0);
      });
      if (operation.op === "set")
        validateJsonValue(operation.value, `${operationContext}.value`);
    } else if (operation.op === "replaceLiteral") {
      keys(
        operation,
        ["op", "search", "replacement", "expectedMatches"],
        operationContext,
      );
      textValue(operation.search, `${operationContext}.search`, 64 * 1024);
      textValue(
        operation.replacement,
        `${operationContext}.replacement`,
        64 * 1024,
      );
      integer(
        operation.expectedMatches,
        `${operationContext}.expectedMatches`,
        1,
        100_000,
      );
    } else {
      fail(`${operationContext}.op is unsupported.`);
    }
  }
  return {
    id,
    revision,
    path: patchPath,
    adapter,
    mode: patch.mode as ConfigPatch["mode"],
    missingFile: patch.missingFile as ConfigPatch["missingFile"],
    operations: operations as ConfigPatch["operations"],
  };
}

function validateResourcePack(value: unknown): void {
  const resource = record(value, "manifest.resourcePack");
  keys(
    resource,
    [
      "artifact",
      "required",
      "filename",
      "path",
      "size",
      "url",
      "sha1",
      "sha256",
      "prompt",
      "id",
      "uuid",
      "provider",
    ],
    "manifest.resourcePack",
  );
  for (const field of [
    "artifact",
    "filename",
    "prompt",
    "id",
    "uuid",
    "provider",
  ] as const)
    if (resource[field] !== undefined)
      textValue(resource[field], `manifest.resourcePack.${field}`, 1024);
  if (resource.required !== undefined && typeof resource.required !== "boolean")
    fail("manifest.resourcePack.required must be boolean.");
  if (resource.filename !== undefined) {
    const filename = stringValue(
      resource.filename,
      "manifest.resourcePack.filename",
      512,
    );
    if (
      filename.includes("/") ||
      filename.includes("\\") ||
      filename !== filename.trim()
    )
      fail("manifest.resourcePack.filename must be a basename.");
  }
  if (resource.path !== undefined) {
    const relativePath = canonicalizeRelativePath(
      stringValue(resource.path, "manifest.resourcePack.path", 1024),
    );
    if (isPathProtected(relativePath))
      fail("manifest.resourcePack.path targets a protected namespace.");
  }
  if (resource.size !== undefined)
    integer(resource.size, "manifest.resourcePack.size", 0, MAX_FILE_SIZE);
  if (resource.url !== undefined)
    urlValue(resource.url, "manifest.resourcePack.url");
  if (resource.sha1 !== undefined)
    validateDigestString(
      stringValue(resource.sha1, "manifest.resourcePack.sha1", 128),
      "sha1",
    );
  if (resource.sha256 !== undefined)
    validateDigestString(
      stringValue(resource.sha256, "manifest.resourcePack.sha256", 128),
      "sha256",
    );
}

export function validateClientManifest(
  value: unknown,
  release: ValidatedReleaseDescriptor,
): void {
  const manifest = record(value, "client manifest");
  keys(
    manifest,
    [
      "$schema",
      "schemaVersion",
      "pack",
      "version",
      "target",
      "minecraft",
      "loader",
      "protocol",
      "mods",
      "files",
      "configPatches",
      "resourcePack",
    ],
    "client manifest",
  );
  if (manifest.$schema !== undefined)
    stringValue(manifest.$schema, "client manifest.$schema", 2048);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION)
    fail(`client manifest.schemaVersion must be ${MANIFEST_SCHEMA_VERSION}.`);
  if (manifest.pack !== release.pack)
    fail("client manifest.pack does not match release descriptor.");
  if (manifest.version !== release.version)
    fail(`client manifest.version does not match release ${release.version}.`);
  if (manifest.target !== "client")
    fail("client manifest.target must be 'client'.");
  if (manifest.minecraft !== release.minecraft)
    fail("client manifest.minecraft does not match release descriptor.");
  validateLoader(manifest.loader, "client manifest.loader");
  if (
    (manifest.loader as JsonRecord).version !==
    (release.loader as JsonRecord).version
  )
    fail("client manifest.loader.version does not match release descriptor.");
  if (manifest.protocol !== release.protocol)
    fail("client manifest.protocol does not match release descriptor.");
  const files = boundedArray(manifest.files, "client manifest.files");
  const mods =
    manifest.mods === undefined
      ? []
      : boundedArray(manifest.mods, "client manifest.mods");
  mods.forEach(validateMod);
  const fileSizes = files.map((item, index) => validateFile(item, index));
  const totalFileBytes = fileSizes.reduce((sum, size) => sum + size, 0);
  if (totalFileBytes > MAX_TOTAL_FILE_BYTES)
    fail(
      `client manifest.files total size exceeds ${MAX_TOTAL_FILE_BYTES} bytes.`,
    );
  if (manifest.configPatches !== undefined) {
    const patches = boundedArray(
      manifest.configPatches,
      "client manifest.configPatches",
    );
    const ids = new Set<string>();
    for (const [index, patch] of patches.entries()) {
      const parsed = validateConfigPatch(patch, index);
      if (ids.has(parsed.id))
        fail(
          `client manifest.configPatches contains duplicate id '${parsed.id}'.`,
        );
      ids.add(parsed.id);
    }
  }
  if (manifest.resourcePack !== undefined)
    validateResourcePack(manifest.resourcePack);
  // Existing path-policy checks duplicate destinations, protected ownership,
  // and file/patch collisions.  Run it only after the complete shape checks.
  try {
    validateManifestMetadata(manifest, release);
  } catch (error) {
    if (error instanceof PathContainmentError) throw error;
    throw new MetadataIntegrityError(
      `Client manifest integrity validation failed: ${String(error)}`,
    );
  }
}

export function validateInstallationState(
  value: unknown,
  gameDir: string,
): InstallationState {
  const state = record(value, "installation state");
  keys(
    state,
    [
      "pack",
      "version",
      "installedAt",
      "syncGeneration",
      "releaseVersion",
      "managedResourcePacks",
      "appliedConfigPatches",
      "files",
    ],
    "installation state",
  );
  stringValue(state.pack, "installation state.pack", 256);
  version(state.version, "installation state.version");
  // Older launcher states may omit installedAt; it is informational and does
  // not grant deletion authority.  All fields that grant file authority are
  // still required and validated below.
  if (state.installedAt !== undefined)
    stringValue(state.installedAt, "installation state.installedAt", 128);
  if (state.syncGeneration !== undefined)
    stringValue(state.syncGeneration, "installation state.syncGeneration", 128);
  if (state.releaseVersion !== undefined)
    version(state.releaseVersion, "installation state.releaseVersion");
  if (state.managedResourcePacks !== undefined) {
    const packs = boundedArray(
      state.managedResourcePacks,
      "installation state.managedResourcePacks",
    );
    packs.forEach((item, index) =>
      stringValue(
        item,
        `installation state.managedResourcePacks[${index}]`,
        1024,
      ),
    );
  }
  if (state.appliedConfigPatches !== undefined) {
    const patches = record(
      state.appliedConfigPatches,
      "installation state.appliedConfigPatches",
    );
    for (const [id, item] of Object.entries(patches)) {
      if (PROTOTYPE_KEYS.has(id))
        fail(
          `installation state.appliedConfigPatches contains prohibited key '${id}'.`,
        );
      const applied = record(
        item,
        `installation state.appliedConfigPatches.${id}`,
      );
      keys(
        applied,
        ["revision", "appliedAt"],
        `installation state.appliedConfigPatches.${id}`,
      );
      integer(
        applied.revision,
        `installation state.appliedConfigPatches.${id}.revision`,
        1,
      );
      stringValue(
        applied.appliedAt,
        `installation state.appliedConfigPatches.${id}.appliedAt`,
        128,
      );
    }
  }
  const files = record(state.files, "installation state.files");
  for (const [key, item] of Object.entries(files)) {
    const relativePath = canonicalizeRelativePath(key);
    if (isPathProtected(relativePath))
      fail(`installation state.files.${key} targets a protected namespace.`);
    const info = record(item, `installation state.files.${key}`);
    keys(
      info,
      ["sha256", "size", "policy", "mtimeMs", "verifiedAt", "path"],
      `installation state.files.${key}`,
    );
    validateDigestString(
      stringValue(info.sha256, `installation state.files.${key}.sha256`, 128),
      "sha256",
    );
    integer(info.size, `installation state.files.${key}.size`);
    if (
      info.policy !== "MANAGED" &&
      info.policy !== "PRESERVE" &&
      info.policy !== "OPTIONAL" &&
      info.policy !== "GENERATED"
    )
      fail(`installation state.files.${key}.policy is unsupported.`);
    if (
      info.mtimeMs !== undefined &&
      (typeof info.mtimeMs !== "number" ||
        !Number.isFinite(info.mtimeMs) ||
        info.mtimeMs < 0)
    )
      fail(`installation state.files.${key}.mtimeMs is invalid.`);
    if (info.verifiedAt !== undefined)
      stringValue(
        info.verifiedAt,
        `installation state.files.${key}.verifiedAt`,
        128,
      );
    if (info.path !== undefined && info.path !== relativePath)
      fail(`installation state.files.${key}.path does not match its key.`);
  }
  const sanitized = {
    ...state,
    files: Object.fromEntries(
      Object.entries(files).map(([key, item]) => [
        canonicalizeRelativePath(key),
        item,
      ]),
    ),
  };
  // The existing sanitizer additionally checks physical containment against the
  // active game directory.  Keep that check in this validation boundary.
  const result = sanitizeInstallationState(sanitized, gameDir).files;
  return { ...sanitized, files: result } as InstallationState;
}

export function isTransientMetadataFetchFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    status?: number;
    message?: string;
    cause?: unknown;
  };
  if (
    candidate.name === "PortalRedirectPolicyError" ||
    candidate.name === "MetadataValidationError" ||
    candidate.name === "MetadataIntegrityError"
  )
    return false;
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : candidate.cause &&
          typeof candidate.cause === "object" &&
          typeof (candidate.cause as any).status === "number"
        ? (candidate.cause as any).status
        : undefined;
  if (status !== undefined)
    return (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      (status >= 500 && status <= 599)
    );
  const cause = candidate.cause as
    { name?: string; message?: string } | undefined;
  if (
    cause?.name === "SyntaxError" ||
    cause?.name === "MetadataValidationError" ||
    cause?.name === "MetadataIntegrityError"
  )
    return false;
  // fetch() reports connection and timeout failures as TypeError/AbortError;
  // the retry helper preserves that cause.  Other application errors are
  // treated as schema failures so they cannot silently select local metadata.
  return (
    candidate.name === "TypeError" ||
    candidate.name === "AbortError" ||
    cause?.name === "TypeError" ||
    cause?.name === "AbortError"
  );
}
