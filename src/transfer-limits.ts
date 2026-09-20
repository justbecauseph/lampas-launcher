import { Buffer } from "node:buffer";

/**
 * Resource budgets for network responses and staged artifacts.
 *
 * These are deliberately explicit so callers and review reports can refer to
 * the same values.  Artifact downloads have a generous ceiling for ordinary
 * modpacks while JSON and sidecar responses stay small enough to parse safely.
 */
export const TRANSFER_LIMITS = Object.freeze({
  jsonBytes: 8 * 1024 * 1024,
  textBytes: 256 * 1024,
  checksumBytes: 16 * 1024,
  artifactBytes: 2 * 1024 * 1024 * 1024,
  maxRedirects: 4,
} as const);

export type TransferLimitName = keyof typeof TRANSFER_LIMITS;

export class TransferLimitError extends Error {
  constructor(
    public readonly resource: string,
    public readonly limit: number,
    public readonly observed: number,
  ) {
    super(
      `${resource} exceeds the ${limit}-byte transfer limit (${observed} bytes observed).`,
    );
    this.name = "TransferLimitError";
  }
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers?.get?.("content-length");
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TransferLimitError(
      "response",
      0,
      Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER,
    );
  }
  return parsed;
}

/**
 * Read a response body with a hard byte budget. The content-length check is an
 * early rejection only; streamed chunks are counted as well because servers
 * may omit or lie about that header.
 */
export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  resource = "response",
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`Invalid ${resource} limit: ${maxBytes}`);
  }
  const declared = contentLength(response);
  if (declared !== undefined && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TransferLimitError(resource, maxBytes, declared);
  }
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw signal.reason || new Error("Response read aborted");
  }

  const body = response.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let settled = false;
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason || new Error("Response read aborted");
      }
      const next = await reader.read();
      if (signal?.aborted) {
        throw signal.reason || new Error("Response read aborted");
      }
      if (next.done) break;
      const chunk =
        next.value instanceof Uint8Array
          ? next.value
          : new Uint8Array(next.value as ArrayBuffer);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new TransferLimitError(resource, maxBytes, total);
      }
      chunks.push(chunk);
    }
    settled = true;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!settled) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  resource = "text response",
): Promise<string> {
  const bytes = await readResponseBytes(response, maxBytes, signal, resource);
  return new TextDecoder().decode(bytes);
}

export async function readResponseJson<T>(
  response: Response,
  maxBytes = TRANSFER_LIMITS.jsonBytes,
  signal?: AbortSignal,
): Promise<T> {
  const text = await readResponseText(
    response,
    maxBytes,
    signal,
    "JSON response",
  );
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error("Response body is not valid JSON", { cause: error });
  }
}

export function byteLength(value: string | Buffer | Uint8Array): number {
  return typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : value.byteLength;
}
