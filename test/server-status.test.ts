import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-server-status-test-"));
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
}));

const { ConfigManager } = await import("../src/config");
const { ServerStatusClient, parseServerStatus } = await import("../src/server-status");

const validStatus = {
  server: { state: "online", managementConnected: true },
  players: {
    online: 1,
    list: [{ uuid: "853c80ef-3c37-49fd-aa49-938b674adae6", username: "jeb_" }],
  },
  presence: { freshness: "live", updatedAt: "2026-08-25T23:40:15.000Z" },
};

function response(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? (status === 200 ? "OK" : "Unauthorized"),
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  ConfigManager.resetForTesting();
  ConfigManager.set({
    portalUrl: "https://portal.example.test/",
    token: "launcher-token",
  });
});

afterAll(() => {
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("ServerStatusClient", () => {
  test("requests the authenticated status endpoint and validates the contract", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const status = await ServerStatusClient.getStatus({
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedInit = init;
        return response(validStatus);
      },
    });

    expect(requestedUrl).toBe("https://portal.example.test/api/v1/server/status");
    expect(requestedInit?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer launcher-token",
    });
    expect(status).toEqual(validStatus);
  });

  test("surfaces HTTP errors without exposing response details", async () => {
    await expect(ServerStatusClient.getStatus({
      fetchImpl: async () => response({ error: "management secret" }, { status: 401 }),
    })).rejects.toThrow("Server status request failed (401)");
  });

  test("rejects malformed JSON and malformed payloads", async () => {
    await expect(ServerStatusClient.getStatus({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => { throw new SyntaxError("Unexpected token"); },
      } as Response),
    })).rejects.toThrow("not valid JSON");

    expect(() => parseServerStatus({ ...validStatus, players: { online: "1", list: [] } }))
      .toThrow("players.online");
  });

  test("aborts a hung Portal request at the bounded timeout", async () => {
    await expect(ServerStatusClient.getStatus({
      timeoutMs: 15,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    })).rejects.toThrow("timed out after 15ms");
  });

  test("requires a stored launcher token", async () => {
    ConfigManager.set({ token: undefined });
    await expect(ServerStatusClient.getStatus()).rejects.toThrow("Portal session is not available");
  });
});
