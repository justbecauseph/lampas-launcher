import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { LauncherLogger } from "./logger";
import {
  fetchWithRedirectPolicy,
  TransportPolicyError,
  TransportRedirectPolicyError,
  type TransportKind,
} from "./transport-policy";
import {
  readResponseJson,
  TRANSFER_LIMITS,
  TransferLimitError,
} from "./transfer-limits";

export type HashAlgorithm = "sha1" | "sha256";

export interface VerifiedTransferOptions {
  expectedHash?: string;
  algorithm?: HashAlgorithm;
  expectedSize?: number;
  headers?: Record<string, string>;
  attempts?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  maxRedirects?: number;
  approvedOrigins?: readonly string[];
  transport?: TransportKind;
}

export class HttpResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    url: string,
  ) {
    super(`HTTP ${status} ${statusText} for ${url}`);
  }
}

export const DEFAULT_TRANSFER_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 10_000;

// Tests shorten the backoff so exhausted-retry paths stay fast. The override
// can only lower the delay, never lengthen it.
function retryBaseDelayMs(): number {
  const override = Number(process.env.LAMPAS_TRANSFER_RETRY_BASE_MS);
  return Number.isFinite(override) && override >= 0
    ? Math.min(override, RETRY_BASE_DELAY_MS)
    : RETRY_BASE_DELAY_MS;
}

/**
 * Exponential backoff with equal jitter: 1s, 2s, 4s, 8s (capped at 10s), each
 * randomized into [delay/2, delay] so parallel asset downloads that fail
 * together do not retry against the CDN in lockstep.
 */
export function retryDelayMs(attempt: number): number {
  const delay = Math.min(
    retryBaseDelayMs() * 2 ** (attempt - 1),
    RETRY_MAX_DELAY_MS,
  );
  return Math.round(delay / 2 + Math.random() * (delay / 2));
}

function describeLastError(error: unknown): string {
  const message = (error as any)?.message;
  return typeof message === "string" && message
    ? ` (last error: ${message})`
    : "";
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error("Operation aborted"));
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason || new Error("Operation aborted"));
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

import { PortalRedirectPolicyError } from "./portal-policy";
export { PortalRedirectPolicyError } from "./portal-policy";
export {
  TransportPolicyError,
  TransportRedirectPolicyError,
} from "./transport-policy";
export {
  readResponseBytes,
  readResponseJson,
  readResponseText,
  TRANSFER_LIMITS,
  TransferLimitError,
} from "./transfer-limits";

export interface FetchJsonOptions {
  maxBytes?: number;
  maxRedirects?: number;
  approvedOrigins?: readonly string[];
  transport?: TransportKind;
}

function safeTransferLogUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "[invalid-url]";
  }
}

export async function fetchJsonWithRetry<T>(
  url: string,
  headers?: Record<string, string>,
  attempts = DEFAULT_TRANSFER_ATTEMPTS,
  timeoutMs = 60_000,
  signal?: AbortSignal,
  redirect: RequestRedirect = "follow",
  fetchOptions: FetchJsonOptions = {},
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason || new Error(`Request to ${url} was aborted.`);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason || new Error(`Request to ${url} was aborted.`);
    }

    const startTime = Date.now();
    const safeUrl = safeTransferLogUrl(url);
    LauncherLogger.logApiRequest(
      "GET",
      safeUrl,
      attempt > 1 ? { attempt, maxAttempts: attempts } : undefined,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
      const transport =
        fetchOptions.transport ||
        (redirect === "manual" ? "portal-auth" : "public-metadata");
      const response = await fetchWithRedirectPolicy(
        url,
        { signal: controller.signal, headers },
        {
          kind: transport,
          approvedOrigins: fetchOptions.approvedOrigins,
          maxRedirects: fetchOptions.maxRedirects,
        },
      );

      const durationMs = Date.now() - startTime;
      if (!response.ok) {
        LauncherLogger.logApiResponse(
          "GET",
          safeUrl,
          response.status,
          durationMs,
          response.statusText,
        );
        throw new HttpResponseError(response.status, response.statusText, url);
      }
      const data = await readResponseJson<T>(
        response,
        fetchOptions.maxBytes ?? TRANSFER_LIMITS.jsonBytes,
        controller.signal,
      );
      LauncherLogger.logApiResponse(
        "GET",
        safeUrl,
        response.status,
        durationMs,
        data,
      );
      return data;
    } catch (error: any) {
      if (signal?.aborted) {
        throw signal.reason || error;
      }
      if (
        error instanceof PortalRedirectPolicyError ||
        error?.name === "PortalRedirectPolicyError"
      ) {
        throw error;
      }
      if (
        error instanceof TransportPolicyError ||
        error instanceof TransportRedirectPolicyError ||
        error instanceof TransferLimitError
      ) {
        throw error;
      }
      const durationMs = Date.now() - startTime;
      lastError = error;
      LauncherLogger.logApiError("GET", safeUrl, error, durationMs);
      if (
        error instanceof HttpResponseError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      )
        throw error;
      if (attempt < attempts)
        await sleepWithSignal(retryDelayMs(attempt), signal);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(
    `Failed to fetch ${url} after ${attempts} attempts${describeLastError(lastError)}`,
    {
      cause: lastError,
    },
  );
}

export async function fetchPortalJsonWithRetry<T>(
  url: string,
  headers?: Record<string, string>,
  attempts = DEFAULT_TRANSFER_ATTEMPTS,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<T> {
  return fetchJsonWithRetry<T>(
    url,
    headers,
    attempts,
    timeoutMs,
    signal,
    "manual",
  );
}

function tempSibling(filePath: string): string {
  return `${filePath}.partial.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

function isReplaceableDestination(stat: fs.Stats): boolean {
  // A symbolic link is replaced by renaming over the link itself. Regular files,
  // including hard-linked files, are also safe to replace without mutating an
  // alias. Directories and special files must never be moved aside as part of
  // the fallback because they may be unrelated user data or device endpoints.
  return stat.isFile() || stat.isSymbolicLink();
}

function destinationTypeError(destination: string): Error {
  const error = new Error(
    `Atomic destination is not a regular file or symbolic link: ${destination}`,
  ) as NodeJS.ErrnoException;
  error.code = "EISDIR";
  return error;
}

async function assertReplaceableDestination(
  destination: string,
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(destination);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!isReplaceableDestination(stat)) throw destinationTypeError(destination);
}

function assertReplaceableDestinationSync(destination: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(destination);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!isReplaceableDestination(stat)) throw destinationTypeError(destination);
}

export async function replaceFile(
  tempPath: string,
  destination: string,
): Promise<void> {
  await assertReplaceableDestination(destination);
  try {
    await fs.promises.rename(tempPath, destination);
  } catch (error: any) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    // Re-check after the failed promotion to avoid moving a destination that
    // appeared during the rename attempt, and to reject directories/special
    // files before the fallback changes their location.
    await assertReplaceableDestination(destination);
    const backupPath = tempSibling(`${destination}.previous`);
    await fs.promises.rename(destination, backupPath);
    try {
      await fs.promises.rename(tempPath, destination);
    } catch (replacementError) {
      await fs.promises.rename(backupPath, destination).catch(() => undefined);
      throw replacementError;
    }
    // Promotion already succeeded. A cleanup failure must not roll back the
    // published destination; a leftover backup is recoverable and preserves
    // the old bytes until a later cleanup pass.
    await fs.promises.rm(backupPath, { force: true }).catch(() => undefined);
  }
}

export function replaceFileSync(tempPath: string, destination: string): void {
  assertReplaceableDestinationSync(destination);
  try {
    fs.renameSync(tempPath, destination);
  } catch (error: any) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    assertReplaceableDestinationSync(destination);
    const backupPath = tempSibling(`${destination}.previous`);
    fs.renameSync(destination, backupPath);
    try {
      fs.renameSync(tempPath, destination);
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {}
    } catch (replacementError) {
      try {
        fs.renameSync(backupPath, destination);
      } catch {}
      throw replacementError;
    }
  }
}

export async function hashFile(
  filePath: string,
  algorithm: HashAlgorithm,
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class TransferIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferIntegrityError";
  }
}

function normalizeExpectedDigest(options: VerifiedTransferOptions): string {
  const algorithm = options.algorithm || "sha256";
  const expected = options.expectedHash?.trim().toLowerCase();
  const expectedLength = algorithm === "sha1" ? 40 : 64;
  if (
    !expected ||
    !new RegExp(`^[a-f0-9]{${expectedLength}}$`).test(expected)
  ) {
    throw new TransferIntegrityError(
      `A valid expected ${algorithm.toUpperCase()} digest is required for a managed transfer.`,
    );
  }
  if (
    options.expectedSize !== undefined &&
    (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 0)
  ) {
    throw new TransferIntegrityError(
      `Expected transfer size must be a non-negative safe integer.`,
    );
  }
  const maxBytes = options.maxBytes ?? TRANSFER_LIMITS.artifactBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TransferIntegrityError(`Transfer byte limit is invalid.`);
  }
  if (options.expectedSize !== undefined && options.expectedSize > maxBytes) {
    throw new TransferLimitError("artifact", maxBytes, options.expectedSize);
  }
  return expected;
}

function mergeAbortSignals(
  primary: AbortSignal | undefined,
  timeoutController: AbortController,
): { signal: AbortSignal; dispose: () => void } {
  const onAbort = () => timeoutController.abort(primary?.reason);
  if (primary) primary.addEventListener("abort", onAbort, { once: true });
  return {
    signal: timeoutController.signal,
    dispose: () => primary?.removeEventListener("abort", onAbort),
  };
}

async function streamVerified(
  sourceFactory: () => NodeJS.ReadableStream,
  destination: string,
  options: VerifiedTransferOptions,
  cancelSource?: () => Promise<void>,
): Promise<number> {
  if (options.signal?.aborted) {
    throw options.signal.reason || new Error("Transfer aborted before start");
  }

  const expectedHash = normalizeExpectedDigest(options);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = tempSibling(destination);
  const algorithm = options.algorithm || "sha256";
  const hash = createHash(algorithm);
  let size = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const maxBytes = options.maxBytes ?? TRANSFER_LIMITS.artifactBytes;
      const nextSize = size + chunk.length;
      if (nextSize > maxBytes) {
        callback(new TransferLimitError("artifact", maxBytes, nextSize));
        return;
      }
      size = nextSize;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  // Acquire the staging pathname before the source is piped. This makes the
  // ownership decision unambiguous: an EEXIST open failure leaves the foreign
  // entry untouched, while every later failure can clean the file we created.
  let ownsTempPath = false;
  const tempStream = fs.createWriteStream(tempPath, { flags: "wx" });

  const closeTempStream = async (): Promise<void> => {
    if (tempStream.closed) return;
    await new Promise<void>((resolve) => {
      tempStream.once("close", resolve);
      tempStream.destroy();
    });
  };

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      tempStream.removeListener("error", onError);
      ownsTempPath = true;
      resolve();
    };
    const onError = (error: Error) => {
      tempStream.removeListener("open", onOpen);
      reject(error);
    };
    tempStream.once("open", onOpen);
    tempStream.once("error", onError);
  }).catch(async (error) => {
    await cancelSource?.().catch(() => undefined);
    await closeTempStream();
    throw error;
  });

  let pipelineStarted = false;
  try {
    // A source is created only after the exclusive destination staging path
    // has been acquired. This prevents an eager source from emitting an
    // unhandled error while a collision is still being handled.
    const input = sourceFactory();
    pipelineStarted = true;
    await pipeline(input, verifier, tempStream, {
      signal: options.signal,
    });
    const actualHash = hash.digest("hex");
    if (actualHash !== expectedHash) {
      throw new TransferIntegrityError(
        `${algorithm.toUpperCase()} mismatch: expected ${expectedHash}, got ${actualHash}`,
      );
    }
    if (options.expectedSize !== undefined && size !== options.expectedSize) {
      throw new Error(
        `Size mismatch: expected ${options.expectedSize} bytes, got ${size}`,
      );
    }
    await replaceFile(tempPath, destination);
    ownsTempPath = false;
    return size;
  } catch (error) {
    if (!pipelineStarted) {
      await cancelSource?.().catch(() => undefined);
      await closeTempStream();
    }
    if (ownsTempPath)
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function copyVerified(
  sourcePath: string,
  destination: string,
  options: VerifiedTransferOptions,
): Promise<number> {
  return streamVerified(
    () => fs.createReadStream(sourcePath),
    destination,
    options,
  );
}

export async function downloadVerified(
  url: string,
  destination: string,
  options: VerifiedTransferOptions = {},
): Promise<number> {
  const attempts = options.attempts || DEFAULT_TRANSFER_ATTEMPTS;
  let lastError: unknown;
  const signal = options.signal;

  if (signal?.aborted) {
    throw signal.reason || new Error(`Download of ${url} was aborted.`);
  }

  // Reject missing or malformed digests before any network or filesystem side
  // effect. SHA-1 remains valid for Mojang's official runtime metadata; pack
  // artifacts use SHA-256.
  normalizeExpectedDigest(options);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason || new Error(`Download of ${url} was aborted.`);
    }

    const startTime = Date.now();
    const destName = path.basename(destination);
    const safeUrl = safeTransferLogUrl(url);
    LauncherLogger.log(
      "INFO",
      `[Download Request] GET ${safeUrl} -> ${destName} (attempt ${attempt}/${attempts})`,
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs || 60_000,
    );
    const merged = mergeAbortSignals(signal, controller);

    try {
      const response = await fetchWithRedirectPolicy(
        url,
        { signal: merged.signal, headers: options.headers },
        {
          kind: options.transport || "artifact",
          approvedOrigins: options.approvedOrigins,
          maxRedirects: options.maxRedirects,
        },
      );
      if (!response.ok || !response.body) {
        const durationMs = Date.now() - startTime;
        LauncherLogger.log(
          "ERROR",
          `[Download Error] HTTP ${response.status} ${response.statusText} for ${safeUrl} (${durationMs}ms)`,
        );
        await response.body?.cancel().catch(() => undefined);
        throw new HttpResponseError(response.status, response.statusText, url);
      }
      const responseBody = response.body;
      const bytes = await streamVerified(
        () => Readable.fromWeb(responseBody as any),
        destination,
        { ...options, signal: merged.signal },
        async () => {
          await responseBody?.cancel().catch(() => undefined);
        },
      );
      const durationMs = Date.now() - startTime;
      LauncherLogger.log(
        "INFO",
        `[Download Complete] ${destName} (${bytes} bytes in ${durationMs}ms) from ${safeUrl}`,
      );
      return bytes;
    } catch (error: any) {
      if (signal?.aborted) {
        throw signal.reason || error;
      }
      if (
        error instanceof TransportPolicyError ||
        error instanceof TransportRedirectPolicyError ||
        (error instanceof HttpResponseError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429)
      ) {
        throw error;
      }
      if (
        error instanceof TransferIntegrityError ||
        error instanceof TransferLimitError
      ) {
        lastError = error;
        break;
      }
      const durationMs = Date.now() - startTime;
      lastError = error;
      LauncherLogger.log(
        "WARN",
        `[Download Retry] Failed ${destName} from ${safeUrl}: ${error?.message || error} (${durationMs}ms)`,
      );
      if (attempt < attempts)
        await sleepWithSignal(retryDelayMs(attempt), signal);
    } finally {
      clearTimeout(timer);
      merged.dispose();
    }
  }

  throw new Error(
    `Failed to download ${url} after ${attempts} attempts${describeLastError(lastError)}`,
    {
      cause: lastError,
    },
  );
}

export async function copyAtomic(
  sourcePath: string,
  destination: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (options?.signal?.aborted) {
    throw options.signal.reason || new Error("Copy aborted before start");
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = tempSibling(destination);
  let ownsTempPath = false;
  try {
    await fs.promises.copyFile(
      sourcePath,
      tempPath,
      fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL,
    );
    ownsTempPath = true;
    if (options?.signal?.aborted) {
      throw options.signal.reason || new Error("Copy aborted after write");
    }
    await replaceFile(tempPath, destination);
    ownsTempPath = false;
  } catch (error) {
    if (ownsTempPath)
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeAtomicFile(
  destination: string,
  content: string | Buffer,
  options?: { encoding?: BufferEncoding; signal?: AbortSignal },
): Promise<void> {
  if (options?.signal?.aborted) {
    throw options.signal.reason || new Error("Write aborted before start");
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = tempSibling(destination);
  let ownsTempPath = false;
  let handle: fs.promises.FileHandle | undefined;
  let handleCloseAttempted = false;
  try {
    handle = await fs.promises.open(tempPath, "wx");
    ownsTempPath = true;
    if (typeof content === "string") {
      await handle.writeFile(content, options?.encoding || "utf-8");
    } else {
      await handle.writeFile(content);
    }
    handleCloseAttempted = true;
    try {
      await handle.close();
    } finally {
      // Do not attempt to close a handle a second time if close() itself
      // reports an error after beginning the platform close operation.
      handle = undefined;
    }
    if (options?.signal?.aborted) {
      throw options.signal.reason || new Error("Write aborted after write");
    }
    await replaceFile(tempPath, destination);
    ownsTempPath = false;
  } catch (error) {
    if (handle && !handleCloseAttempted)
      await handle.close().catch(() => undefined);
    if (ownsTempPath)
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function writeAtomicFileSync(
  destination: string,
  content: string | Buffer,
  encoding: BufferEncoding = "utf-8",
): void {
  const dir = path.dirname(destination);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${destination}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  let ownsTempPath = false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx");
    ownsTempPath = true;
    if (typeof content === "string") {
      fs.writeFileSync(fd, content, encoding);
    } else {
      fs.writeFileSync(fd, content);
    }
    fs.closeSync(fd);
    fd = undefined;
    replaceFileSync(tempPath, destination);
    ownsTempPath = false;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (ownsTempPath) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
    }
    throw error;
  }
}
