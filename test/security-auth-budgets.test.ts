import { expect, mock, test } from "bun:test";
import * as os from "node:os";

mock.module("electron", () => ({ app: { getPath: () => os.tmpdir() } }));
const { portalFetch } = await import("../src/portal-policy");

test("authenticated Portal bodies reject streamed overflow even without Content-Length", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  let requestedInit: RequestInit | undefined;
  try {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestedInit = init;
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(128 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }) as typeof fetch;
    await expect(
      portalFetch("https://dev.lampas.town/api/v1/auth/verify", {
        headers: { Authorization: "Bearer synthetic-budget-token" },
      }),
    ).rejects.toThrow(/transfer limit/);
    expect(requestedInit?.redirect).toBe("manual");
    expect(cancelled).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("caller cancellation terminates a stalled authenticated body without successful partial JSON", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"valid":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch;
    timer = setTimeout(
      () => controller.abort(new Error("synthetic body deadline")),
      10,
    );
    await expect(
      portalFetch("https://dev.lampas.town/api/v1/auth/verify", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("synthetic body deadline");
    expect(cancelled).toBe(true);
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
  }
});
