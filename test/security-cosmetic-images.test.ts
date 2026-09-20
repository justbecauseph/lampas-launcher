import { afterEach, describe, expect, mock, test } from "bun:test";
import * as os from "node:os";

mock.module("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "" },
}));

const { CosmeticImageBroker } = await import("../src/cosmetic-images");

const originalFetch = globalThis.fetch;
const brokers: Array<InstanceType<typeof CosmeticImageBroker>> = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const broker of brokers.splice(0)) broker.dispose();
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOF0: dimensions are height then width in the JPEG frame header.
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
}

function broker(options: ConstructorParameters<typeof CosmeticImageBroker>[0]) {
  const value = new CosmeticImageBroker(options);
  brokers.push(value);
  return value;
}

describe("Phase 6 cosmetic image broker", () => {
  test("external images disabled by default makes zero requests", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(png(64, 64), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as typeof fetch;
    const images = broker({
      isEnabled: () => false,
      getUser: () => ({
        id: "user-1",
        name: "PlayerOne",
        isAdmin: false,
        isTech: false,
        roles: [],
        allowedChannels: [],
      }),
      resolveModIcon: async () => "https://cdn.modrinth.com/icon.png",
    });

    expect(await images.getAvatar()).toBeNull();
    expect(await images.getModIcon("mod-1")).toBeNull();
    expect(requests).toBe(0);
  });

  test("enabled avatar uses main-owned identity, approved host, and bounded cache", async () => {
    let requests = 0;
    let requestHeaders: Headers | undefined;
    globalThis.fetch = (async (input, init) => {
      requests++;
      requestHeaders = new Headers(init?.headers);
      expect(String(input)).toContain(
        "https://mc-heads.net/avatar/1234567890abcdef1234567890abcdef/64",
      );
      return new Response(png(64, 64), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as typeof fetch;
    const user = {
      id: "user-1",
      name: "Portal Name",
      minecraftUuid: "12345678-90ab-cdef-1234-567890abcdef",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: [],
    };
    const images = broker({ isEnabled: () => true, getUser: () => user });

    const first = await images.getAvatar();
    const second = await images.getAvatar();
    expect(first?.mimeType).toBe("image/png");
    expect(first?.width).toBe(64);
    expect(first?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(second).toEqual(first);
    expect(requests).toBe(1);
    expect(requestHeaders?.get("authorization")).toBeNull();
    expect(requestHeaders?.get("cookie")).toBeNull();
    expect(images.getCacheStats().entries).toBe(1);
  });

  test("simultaneous requests for one image share a bounded fetch", async () => {
    let requests = 0;
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = (() => {
      requests++;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as typeof fetch;
    const user = {
      id: "user-1",
      name: "PlayerOne",
      minecraftUuid: "12345678-90ab-cdef-1234-567890abcdef",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: [],
    };
    const images = broker({ isEnabled: () => true, getUser: () => user });

    const first = images.getAvatar();
    const second = images.getAvatar();
    await Promise.resolve();
    expect(requests).toBe(1);
    resolveFetch(
      new Response(png(64, 64), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  test("mod icon URL is resolved from main metadata and restricted redirects fall back", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.invalid/icon.png" },
      });
    }) as typeof fetch;
    const images = broker({
      isEnabled: () => true,
      resolveModIcon: async (id) =>
        id === "mod-1"
          ? "https://cdn.modrinth.com/data/mod-1/icon.png"
          : undefined,
    });

    expect(await images.getModIcon("mod-1")).toBeNull();
    expect(requests).toBe(1);
  });

  test("logout clears cache and prevents an in-flight response from becoming visible", async () => {
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as typeof fetch;
    const user = {
      id: "user-1",
      name: "PlayerOne",
      minecraftUuid: "12345678-90ab-cdef-1234-567890abcdef",
      isAdmin: false,
      isTech: false,
      roles: [],
      allowedChannels: [],
    };
    const images = broker({ isEnabled: () => true, getUser: () => user });
    const pending = images.getAvatar();
    images.clear();
    resolveFetch(
      new Response(png(64, 64), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );

    expect(await pending).toBeNull();
    expect(images.getCacheStats()).toEqual({ entries: 0, bytes: 0 });
  });

  test("oversized dimensions are rejected before a data URI is returned", async () => {
    globalThis.fetch = (async () =>
      new Response(png(4096, 1), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })) as typeof fetch;
    const images = broker({
      isEnabled: () => true,
      getUser: () => ({
        id: "user-1",
        name: "PlayerOne",
        isAdmin: false,
        isTech: false,
        roles: [],
        allowedChannels: [],
      }),
    });

    expect(await images.getAvatar()).toBeNull();
  });

  test("malformed PNG headers and reversed JPEG dimensions are rejected or measured safely", async () => {
    let payload = png(64, 64);
    payload[12] = 73;
    payload[13] = 68;
    payload[14] = 65;
    payload[15] = 84;
    globalThis.fetch = (async () =>
      new Response(payload, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })) as typeof fetch;
    const malformed = broker({
      isEnabled: () => true,
      getUser: () => ({
        id: "user-1",
        name: "PlayerOne",
        isAdmin: false,
        isTech: false,
        roles: [],
        allowedChannels: [],
      }),
    });
    expect(await malformed.getAvatar()).toBeNull();

    globalThis.fetch = (async () =>
      new Response(jpeg(128, 64), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      })) as typeof fetch;
    const jpegBroker = broker({
      isEnabled: () => true,
      getUser: () => ({
        id: "user-2",
        name: "PlayerTwo",
        isAdmin: false,
        isTech: false,
        roles: [],
        allowedChannels: [],
      }),
    });
    const image = await jpegBroker.getAvatar();
    expect(image?.width).toBe(128);
    expect(image?.height).toBe(64);
  });

  test("stalled cosmetic requests are bounded by the broker deadline", async () => {
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason || new Error("aborted")),
          { once: true },
        );
      })) as typeof fetch;
    const images = broker({
      isEnabled: () => true,
      requestTimeoutMs: 5,
      getUser: () => ({
        id: "user-1",
        name: "PlayerOne",
        isAdmin: false,
        isTech: false,
        roles: [],
        allowedChannels: [],
      }),
    });

    await expect(images.getAvatar()).resolves.toBeNull();
  });

  test("distinct stalled images cannot accumulate an unbounded queue", async () => {
    let requests = 0;
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        requests++;
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      })) as typeof fetch;
    const images = broker({
      isEnabled: () => true,
      resolveModIcon: async (id) => `https://cdn.modrinth.com/${id}.png`,
    });
    const pending = Array.from({ length: 70 }, (_, index) =>
      images.getModIcon(`mod-${index}`),
    );
    expect(await Promise.all(pending.slice(64))).toEqual(Array(6).fill(null));
    expect(requests).toBeLessThanOrEqual(4);
    images.clear();
    expect((await Promise.all(pending)).every((image) => image === null)).toBe(
      true,
    );
  });
});
