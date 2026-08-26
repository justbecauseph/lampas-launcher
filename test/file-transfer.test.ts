import { describe, expect, mock, test } from "bun:test";
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

const { downloadVerified } = await import("../src/file-transfer");

describe("Launcher file-transfer: 302 redirect regression tests", () => {
  test("downloadVerified() follows 302 redirect from blob URL to object storage and verifies hash & size", async () => {
    const payload = Buffer.from("lampas-blob-payload-redirected-from-portal-to-s3-bucket");
    const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
    const size = payload.length;

    let blobRouteHit = false;
    let s3StorageHit = false;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === `/api/v1/blobs/${sha256}`) {
          blobRouteHit = true;
          return new Response(null, {
            status: 302,
            headers: {
              Location: `http://127.0.0.1:${server.port}/storage/blobs/${sha256.substring(0, 2)}/${sha256}?signed=true`,
              "Cache-Control": "no-store",
            },
          });
        }

        if (url.pathname === `/storage/blobs/${sha256.substring(0, 2)}/${sha256}`) {
          s3StorageHit = true;
          return new Response(payload, {
            status: 200,
            headers: {
              "Content-Type": "application/java-archive",
              "Content-Length": size.toString(),
            },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-download-302-"));
    const destination = path.join(tempDir, "custom-mod.jar");

    try {
      const initialUrl = `http://127.0.0.1:${server.port}/api/v1/blobs/${sha256}`;
      const downloadedBytes = await downloadVerified(initialUrl, destination, {
        expectedHash: sha256,
        algorithm: "sha256",
        expectedSize: size,
        attempts: 1,
      });

      expect(blobRouteHit).toBe(true);
      expect(s3StorageHit).toBe(true);
      expect(downloadedBytes).toBe(size);
      expect(fs.existsSync(destination)).toBe(true);

      const fileContent = fs.readFileSync(destination);
      expect(fileContent.equals(payload)).toBe(true);
      const computedHash = crypto.createHash("sha256").update(fileContent).digest("hex");
      expect(computedHash).toBe(sha256);
    } finally {
      server.stop(true);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("downloadVerified() rejects when redirected 302 payload has hash mismatch and does not promote partial file", async () => {
    const validPayload = Buffer.from("correct-payload");
    const validSha256 = crypto.createHash("sha256").update(validPayload).digest("hex");

    const corruptedPayload = Buffer.from("corrupted-payload-from-bucket");

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname.startsWith("/api/v1/blobs/")) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `http://127.0.0.1:${server.port}/storage/corrupted-object`,
            },
          });
        }

        if (url.pathname === "/storage/corrupted-object") {
          return new Response(corruptedPayload, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-download-mismatch-"));
    const destination = path.join(tempDir, "corrupted-mod.jar");

    try {
      const initialUrl = `http://127.0.0.1:${server.port}/api/v1/blobs/${validSha256}`;
      let caughtError: any = null;
      try {
        await downloadVerified(initialUrl, destination, {
          expectedHash: validSha256,
          algorithm: "sha256",
          expectedSize: validPayload.length,
          attempts: 1,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toContain("Failed to download");
      expect(caughtError.cause?.message).toContain("SHA256 mismatch");

      // File must not have been promoted to destination
      expect(fs.existsSync(destination)).toBe(false);
      // No temp partial files left in tempDir
      const remainingFiles = fs.readdirSync(tempDir);
      expect(remainingFiles.some((f) => f.includes(".partial."))).toBe(false);
    } finally {
      server.stop(true);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
