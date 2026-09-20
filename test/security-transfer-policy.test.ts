import { afterEach, describe, expect, mock, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const {
  downloadVerified,
  fetchJsonWithRetry,
  TransferLimitError,
  PortalRedirectPolicyError,
  TransportPolicyError,
} = await import("../src/file-transfer");
const { fetchWithRedirectPolicy } = await import("../src/transport-policy");

const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "lampas-transfer-policy-"),
  );
  tempRoots.push(value);
  return value;
}

describe("Phase 5 transport and transfer limits", () => {
  test("authenticated metadata rejects redirects before issuing the second request", async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization:
          new Headers(init?.headers).get("authorization") || undefined,
      });
      return new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.invalid/metadata" },
      });
    }) as typeof fetch;

    await expect(
      fetchWithRedirectPolicy(
        "https://dev.lampas.town/api/v1/releases/dev",
        { headers: { Authorization: "Bearer secret" } },
        { kind: "portal-auth" },
      ),
    ).rejects.toBeInstanceOf(PortalRedirectPolicyError);
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe("Bearer secret");
  });

  test("public metadata strips caller credentials and forces credential-free fetches", async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return Response.json({ ok: true });
    }) as typeof fetch;

    await expect(
      fetchJsonWithRetry(
        "https://piston-meta.mojang.com/v1/test",
        {
          Authorization: "Bearer must-not-leave",
          Cookie: "session=must-not-leave",
        },
        1,
        5_000,
        undefined,
        "follow",
      ),
    ).resolves.toEqual({ ok: true });
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(requestInit?.credentials).toBe("omit");
  });

  test("redirect URLs with embedded credentials are rejected before the next fetch", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount++;
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://user:password@storage.railway.app/artifact.jar",
        },
      });
    }) as typeof fetch;

    await expect(
      fetchWithRedirectPolicy(
        "https://storage.railway.app/start",
        {},
        { kind: "artifact" },
      ),
    ).rejects.toBeInstanceOf(TransportPolicyError);
    expect(requestCount).toBe(1);
  });

  test("Portal blob redirects to Railway storage without forwarding credentials", async () => {
    const payload = Buffer.from("verified-railway-artifact");
    const digest = crypto.createHash("sha256").update(payload).digest("hex");
    const requests: Array<{
      url: string;
      authorization?: string;
      cookie?: string;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        authorization: headers.get("authorization") || undefined,
        cookie: headers.get("cookie") || undefined,
      });
      if (url.startsWith("https://dev.lampas.town/")) {
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://storage.railway.app/blobs/" +
              digest +
              "?X-Amz-Signature=test",
          },
        });
      }
      return new Response(payload, {
        status: 200,
        headers: { "Content-Length": String(payload.length) },
      });
    }) as typeof fetch;

    const destination = path.join(root(), "artifact.jar");
    await downloadVerified(
      "https://dev.lampas.town/api/v1/blobs/" + digest,
      destination,
      {
        expectedHash: digest,
        expectedSize: payload.length,
        headers: {
          Authorization: "Bearer must-not-leave",
          Cookie: "session=must-not-leave",
        },
        attempts: 1,
      },
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].authorization).toBeUndefined();
    expect(requests[0].cookie).toBeUndefined();
    expect(requests[1].authorization).toBeUndefined();
    expect(requests[1].cookie).toBeUndefined();
    expect(fs.readFileSync(destination)).toEqual(payload);
  });

  test("remote HTTP and private destinations are rejected before fetch", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount++;
      return new Response("unexpected");
    }) as typeof fetch;

    await expect(
      downloadVerified(
        "http://storage.railway.app/artifact",
        path.join(root(), "a.jar"),
        {
          expectedHash: "0".repeat(64),
          attempts: 1,
        },
      ),
    ).rejects.toBeInstanceOf(TransportPolicyError);
    await expect(
      downloadVerified(
        "https://192.168.1.20/artifact",
        path.join(root(), "b.jar"),
        {
          expectedHash: "0".repeat(64),
          attempts: 1,
        },
      ),
    ).rejects.toBeInstanceOf(TransportPolicyError);
    expect(requestCount).toBe(0);
  });

  test("chunked JSON is bounded while it is read", async () => {
    const chunks = ['{"large":"', "xxxxxxxx", "xxxxxxxx", '"}'];
    globalThis.fetch = (async () => {
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index === chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(chunks[index++]));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    await expect(
      fetchJsonWithRetry(
        "https://piston-meta.mojang.com/v1/test",
        undefined,
        1,
        5_000,
        undefined,
        "follow",
        {
          maxBytes: 10,
        },
      ),
    ).rejects.toBeInstanceOf(TransferLimitError);
  });

  test("late oversized artifact chunks fail before promotion and remove owned staging", async () => {
    const payload = Buffer.from(
      "this payload is larger than the four byte budget",
    );
    globalThis.fetch = (async () =>
      new Response(payload, { status: 200 })) as typeof fetch;
    const destination = path.join(root(), "oversized.jar");
    const digest = crypto.createHash("sha256").update(payload).digest("hex");

    await expect(
      downloadVerified("https://storage.railway.app/oversized", destination, {
        expectedHash: digest,
        maxBytes: 4,
        attempts: 1,
      }),
    ).rejects.toThrow(/Failed to download/);
    expect(fs.existsSync(destination)).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(destination))
        .filter((name) => name.includes(".partial.")).length,
    ).toBe(0);
  });

  test("a stalled artifact is aborted by the per-attempt timeout", async () => {
    globalThis.fetch = (async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          // Keep the stream pending until the request signal aborts.
          return new Promise<void>((resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        },
        cancel() {},
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const destination = path.join(root(), "stalled.jar");
    const payload = Buffer.from("never-completes");
    const digest = crypto.createHash("sha256").update(payload).digest("hex");

    await expect(
      downloadVerified("https://storage.railway.app/stalled", destination, {
        expectedHash: digest,
        timeoutMs: 25,
        attempts: 1,
      }),
    ).rejects.toThrow(/Failed to download|aborted|abort/i);
    expect(fs.existsSync(destination)).toBe(false);
  });

  test("valid upstream SHA-1 remains accepted", async () => {
    const payload = Buffer.from("official-mojang-runtime-byte");
    const digest = crypto.createHash("sha1").update(payload).digest("hex");
    globalThis.fetch = (async () =>
      new Response(payload, { status: 200 })) as typeof fetch;
    const destination = path.join(root(), "runtime.bin");

    await downloadVerified(
      "https://libraries.minecraft.net/com/mojang/runtime.bin",
      destination,
      {
        algorithm: "sha1",
        expectedHash: digest,
        expectedSize: payload.length,
        attempts: 1,
      },
    );
    expect(fs.readFileSync(destination)).toEqual(payload);
  });
});
