import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { LauncherLogger } from "./logger";

export type HashAlgorithm = "sha1" | "sha256";

export interface VerifiedTransferOptions {
  expectedHash?: string;
  algorithm?: HashAlgorithm;
  expectedSize?: number;
  headers?: Record<string, string>;
  attempts?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class HttpResponseError extends Error {
  constructor(public readonly status: number, public readonly statusText: string, url: string) {
    super(`HTTP ${status} ${statusText} for ${url}`);
  }
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

export async function fetchJsonWithRetry<T>(
  url: string,
  headers?: Record<string, string>,
  attempts = 3,
  timeoutMs = 60_000,
  signal?: AbortSignal
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
    LauncherLogger.logApiRequest("GET", url, attempt > 1 ? { attempt, maxAttempts: attempts } : undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, { signal: controller.signal, headers });
      const durationMs = Date.now() - startTime;
      if (!response.ok) {
        LauncherLogger.logApiResponse("GET", url, response.status, durationMs, response.statusText);
        throw new HttpResponseError(response.status, response.statusText, url);
      }
      const data = await response.json() as T;
      LauncherLogger.logApiResponse("GET", url, response.status, durationMs, data);
      return data;
    } catch (error: any) {
      if (signal?.aborted) {
        throw signal.reason || error;
      }
      const durationMs = Date.now() - startTime;
      lastError = error;
      LauncherLogger.logApiError("GET", url, error, durationMs);
      if (error instanceof HttpResponseError && error.status >= 400 && error.status < 500 && error.status !== 429) throw error;
      if (attempt < attempts) await sleepWithSignal(250 * 2 ** (attempt - 1), signal);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${attempts} attempts`, { cause: lastError });
}

function tempSibling(filePath: string): string {
  return `${filePath}.partial.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function replaceFile(tempPath: string, destination: string): Promise<void> {
  try {
    await fs.promises.rename(tempPath, destination);
  } catch (error: any) {
    if (!fs.existsSync(destination) || (error?.code !== "EEXIST" && error?.code !== "EPERM")) throw error;
    const backupPath = tempSibling(`${destination}.previous`);
    await fs.promises.rename(destination, backupPath);
    try {
      await fs.promises.rename(tempPath, destination);
      await fs.promises.rm(backupPath, { force: true });
    } catch (replacementError) {
      await fs.promises.rename(backupPath, destination).catch(() => undefined);
      throw replacementError;
    }
  }
}

export async function hashFile(filePath: string, algorithm: HashAlgorithm): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function streamVerified(
  source: NodeJS.ReadableStream,
  destination: string,
  options: VerifiedTransferOptions
): Promise<number> {
  if (options.signal?.aborted) {
    throw options.signal.reason || new Error("Transfer aborted before start");
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = tempSibling(destination);
  const algorithm = options.algorithm || "sha256";
  const hash = createHash(algorithm);
  let size = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(source, verifier, fs.createWriteStream(tempPath, { flags: "wx" }), {
      signal: options.signal,
    });
    const actualHash = hash.digest("hex");
    if (options.expectedHash && actualHash !== options.expectedHash) {
      throw new Error(`${algorithm.toUpperCase()} mismatch: expected ${options.expectedHash}, got ${actualHash}`);
    }
    if (options.expectedSize !== undefined && size !== options.expectedSize) {
      throw new Error(`Size mismatch: expected ${options.expectedSize} bytes, got ${size}`);
    }
    await replaceFile(tempPath, destination);
    return size;
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function copyVerified(
  sourcePath: string,
  destination: string,
  options: VerifiedTransferOptions
): Promise<number> {
  return streamVerified(fs.createReadStream(sourcePath), destination, options);
}

export async function downloadVerified(
  url: string,
  destination: string,
  options: VerifiedTransferOptions = {}
): Promise<number> {
  const attempts = options.attempts || 3;
  let lastError: unknown;
  const signal = options.signal;

  if (signal?.aborted) {
    throw signal.reason || new Error(`Download of ${url} was aborted.`);
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason || new Error(`Download of ${url} was aborted.`);
    }

    const startTime = Date.now();
    const destName = path.basename(destination);
    LauncherLogger.log("INFO", `[Download Request] GET ${url} -> ${destName} (attempt ${attempt}/${attempts})`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60_000);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, { signal: controller.signal, headers: options.headers });
      if (!response.ok || !response.body) {
        const durationMs = Date.now() - startTime;
        LauncherLogger.log("ERROR", `[Download Error] HTTP ${response.status} ${response.statusText} for ${url} (${durationMs}ms)`);
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const bytes = await streamVerified(Readable.fromWeb(response.body as any), destination, options);
      const durationMs = Date.now() - startTime;
      LauncherLogger.log("INFO", `[Download Complete] ${destName} (${bytes} bytes in ${durationMs}ms) from ${url}`);
      return bytes;
    } catch (error: any) {
      if (signal?.aborted) {
        throw signal.reason || error;
      }
      const durationMs = Date.now() - startTime;
      lastError = error;
      LauncherLogger.log("WARN", `[Download Retry] Failed ${destName}: ${error?.message || error} (${durationMs}ms)`);
      if (attempt < attempts) await sleepWithSignal(250 * 2 ** (attempt - 1), signal);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  throw new Error(`Failed to download ${url} after ${attempts} attempts`, { cause: lastError });
}

export async function copyAtomic(
  sourcePath: string,
  destination: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  if (options?.signal?.aborted) {
    throw options.signal.reason || new Error("Copy aborted before start");
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = tempSibling(destination);
  try {
    await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_FICLONE);
    if (options?.signal?.aborted) {
      throw options.signal.reason || new Error("Copy aborted after write");
    }
    await replaceFile(tempPath, destination);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeAtomicFile(
  destination: string,
  content: string | Buffer,
  options?: { encoding?: BufferEncoding; signal?: AbortSignal }
): Promise<void> {
  if (options?.signal?.aborted) {
    throw options.signal.reason || new Error("Write aborted before start");
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = tempSibling(destination);
  try {
    if (typeof content === "string") {
      await fs.promises.writeFile(tempPath, content, options?.encoding || "utf-8");
    } else {
      await fs.promises.writeFile(tempPath, content);
    }
    if (options?.signal?.aborted) {
      throw options.signal.reason || new Error("Write aborted after write");
    }
    await replaceFile(tempPath, destination);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function writeAtomicFileSync(
  destination: string,
  content: string | Buffer,
  encoding: BufferEncoding = "utf-8"
): void {
  const dir = path.dirname(destination);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${destination}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    if (typeof content === "string") {
      fs.writeFileSync(tempPath, content, encoding);
    } else {
      fs.writeFileSync(tempPath, content);
    }
    try {
      fs.renameSync(tempPath, destination);
    } catch (err: any) {
      if (err.code === "EEXIST" || err.code === "EPERM") {
        fs.copyFileSync(tempPath, destination);
        fs.rmSync(tempPath, { force: true });
      } else {
        throw err;
      }
    }
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {}
    throw error;
  }
}

