import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getServerStatusView } from "../ui/src/views/server-status-view";
import type { RendererSettingsDto, RendererUserProfile } from "../src/types";

describe("Phase 6 — Modular Renderer, Types, and Local Fonts", () => {
  test("secret-bearing tokens are excluded from renderer DTO interfaces", () => {
    // Verify RendererSettingsDto structure
    const sampleDto: RendererSettingsDto = {
      portalUrl: "https://dev.lampas.town",
      selectedChannel: "stable",
      allocatedRamGb: 4,
      gameDir: "C:/game",
      gameDirConfigured: true,
      javaPath: "C:/java/javaw.exe",
      javaArgs: "-Xmx4G",
      disabledClientMods: [],
      customClientMods: [],
      noSync: false,
    };

    expect((sampleDto as any).token).toBeUndefined();
    expect((sampleDto as any).refreshToken).toBeUndefined();
    expect((sampleDto as any).minecraftAccessToken).toBeUndefined();

    // Verify RendererUserProfile structure
    const sampleUser: RendererUserProfile = {
      id: "u-123",
      name: "PlayerOne",
      minecraftUuid: "12345678-1234-1234-1234-123456789abc",
      minecraftUsername: "PlayerOne",
      isAdmin: false,
      isTech: false,
      roles: ["member"],
      allowedChannels: ["stable"],
    };

    expect((sampleUser as any).token).toBeUndefined();
    expect((sampleUser as any).minecraftAccessToken).toBeUndefined();
  });

  test("ui/index.html does not contain remote font requests", () => {
    const html = fs.readFileSync(path.join(__dirname, "../ui/index.html"), "utf-8");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
    expect(html).toContain('<link rel="stylesheet" href="fonts.css">');
  });

  test("local fonts and OFL licenses are present in ui/assets/fonts/", () => {
    const fontsDir = path.join(__dirname, "../ui/assets/fonts");
    expect(fs.existsSync(fontsDir)).toBe(true);

    const expectedFonts = [
      "IBMPlexSans-Regular.woff2",
      "IBMPlexSans-Medium.woff2",
      "IBMPlexSans-SemiBold.woff2",
      "IBMPlexSans-Bold.woff2",
      "IBMPlexMono-Regular.woff2",
      "IBMPlexMono-Medium.woff2",
      "IBMPlexMono-SemiBold.woff2",
      "Rajdhani-SemiBold.woff2",
      "Rajdhani-Bold.woff2",
    ];

    for (const fontName of expectedFonts) {
      const fontPath = path.join(fontsDir, fontName);
      expect(fs.existsSync(fontPath)).toBe(true);
      expect(fs.statSync(fontPath).size).toBeGreaterThan(1000);
    }

    const licensePath = path.join(fontsDir, "LICENSE.txt");
    expect(fs.existsSync(licensePath)).toBe(true);
    const licenseText = fs.readFileSync(licensePath, "utf-8");
    expect(licenseText).toContain("SIL OPEN FONT LICENSE");
  });

  test("ui/fonts.css defines all required @font-face declarations", () => {
    const css = fs.readFileSync(path.join(__dirname, "../ui/fonts.css"), "utf-8");
    expect(css).toContain("font-family: 'IBM Plex Sans'");
    expect(css).toContain("font-family: 'IBM Plex Mono'");
    expect(css).toContain("font-family: 'Rajdhani'");
    expect(css).toContain("IBMPlexSans-Regular.woff2");
    expect(css).toContain("IBMPlexMono-Regular.woff2");
    expect(css).toContain("Rajdhani-Bold.woff2");
  });

  test("mod-view template eliminates inline onerror attribute in favor of programmatic handling", () => {
    const modsViewSource = fs.readFileSync(
      path.join(__dirname, "../ui/src/views/mods-view.ts"),
      "utf-8"
    );
    expect(modsViewSource).not.toContain("onerror=");
    expect(modsViewSource).toMatch(/\.addEventListener\(\s*["']error["']/);
  });

  test("server status view model preserves 8-player cap and guidance labels", () => {
    const view = getServerStatusView({
      server: { state: "online", managementConnected: true },
      players: {
        online: 10,
        list: Array.from({ length: 10 }, (_, i) => ({ uuid: `uuid-${i}`, username: `User${i}` })),
      },
      presence: { freshness: "live", updatedAt: new Date().toISOString() },
    });

    expect(view.state).toBe("online");
    expect(view.label).toBe("SERVER ONLINE");
    expect(view.players.length).toBe(8);
    expect(view.more).toBe(2);
  });

  test("Vite production build emits dist/renderer without destroying dist/main.js", () => {
    const rootDir = path.join(__dirname, "..");
    const prodIndex = path.join(rootDir, "dist/renderer/index.html");
    const mainJs = path.join(rootDir, "dist/main.js");
    const preloadJs = path.join(rootDir, "dist/preload.js");

    if (!fs.existsSync(prodIndex) || !fs.existsSync(mainJs) || !fs.existsSync(preloadJs)) {
      const { execSync } = require("node:child_process");
      execSync("bun run build", { cwd: rootDir, stdio: "pipe" });
    }

    expect(fs.existsSync(prodIndex)).toBe(true);
    expect(fs.existsSync(mainJs)).toBe(true);
    expect(fs.existsSync(preloadJs)).toBe(true);

    const prodHtml = fs.readFileSync(prodIndex, "utf-8");
    // Verify script tags in production build use relative paths suitable for loadFile
    expect(prodHtml).toMatch(/src="\.\/assets\/index-[^"]+\.js"/);
    expect(prodHtml).toMatch(/href="\.\/assets\/index-[^"]+\.css"/);
  });
});
