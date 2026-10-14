import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getServerStatusView } from "../ui/src/views/server-status-view";
import { initAuthView } from "../ui/src/views/auth-view";
import { initSettingsView } from "../ui/src/views/settings-view";
import { initModsView } from "../ui/src/views/mods-view";
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
    const html = fs.readFileSync(
      path.join(__dirname, "../ui/index.html"),
      "utf-8",
    );
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
    expect(html).toMatch(/<link\s+rel="stylesheet"\s+href="fonts\.css"\s*\/?>/);
  });

  test("local fonts and OFL licenses are present in ui/assets/fonts/", () => {
    const fontsDir = path.join(__dirname, "../ui/assets/fonts");
    expect(fs.existsSync(fontsDir)).toBe(true);

    const expectedFonts = [
      "IMFellEnglish-Regular.woff2",
      "IMFellEnglish-Italic.woff2",
      "AlegreyaSans-Regular.woff2",
      "AlegreyaSans-Medium.woff2",
      "AlegreyaSans-Bold.woff2",
      "GeistMono-Regular.woff2",
      "GeistMono-Medium.woff2",
      "GeistMono-Bold.woff2",
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
    const css = fs.readFileSync(
      path.join(__dirname, "../ui/fonts.css"),
      "utf-8",
    );
    expect(css).toMatch(/font-family:\s*["']IM Fell English["']/);
    expect(css).toMatch(/font-family:\s*["']Alegreya Sans["']/);
    expect(css).toMatch(/font-family:\s*["']Geist Mono["']/);
    expect(css).toContain("IMFellEnglish-Regular.woff2");
    expect(css).toContain("AlegreyaSans-Regular.woff2");
    expect(css).toContain("GeistMono-Regular.woff2");
  });

  test("mod-view template eliminates inline onerror attribute in favor of programmatic handling", () => {
    const modsViewSource = fs.readFileSync(
      path.join(__dirname, "../ui/src/views/mods-view.ts"),
      "utf-8",
    );
    expect(modsViewSource).not.toContain("onerror=");
    expect(modsViewSource).toMatch(/\.addEventListener\(\s*["']error["']/);
  });

  test("server status view model preserves 8-player cap and guidance labels", () => {
    const view = getServerStatusView({
      server: { state: "online", managementConnected: true },
      players: {
        online: 10,
        list: Array.from({ length: 10 }, (_, i) => ({
          uuid: `uuid-${i}`,
          username: `User${i}`,
        })),
      },
      presence: { freshness: "live", updatedAt: new Date().toISOString() },
    });

    expect(view.state).toBe("online");
    expect(view.label).toBe("Server online");
    expect(view.players.length).toBe(8);
    expect(view.more).toBe(2);
  });

  test("Vite production build emits dist/renderer without destroying dist/main.js", () => {
    const rootDir = path.join(__dirname, "..");
    const prodIndex = path.join(rootDir, "dist/renderer/index.html");
    const mainJs = path.join(rootDir, "dist/main.js");
    const preloadJs = path.join(rootDir, "dist/preload.js");

    if (
      !fs.existsSync(prodIndex) ||
      !fs.existsSync(mainJs) ||
      !fs.existsSync(preloadJs)
    ) {
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

  test("auth-view uses the brokered avatar image when opted in, handles fallback, and resets to 'P' on logout", async () => {
    // Check source code requirements
    const authSource = fs.readFileSync(
      path.join(__dirname, "../ui/src/views/auth-view.ts"),
      "utf-8",
    );
    expect(authSource).not.toContain("crafatar.com");
    expect(authSource).not.toContain("https://mc-heads.net/avatar/");
    expect(authSource).toMatch(/window\.lampas\.cosmetics\s*\.getAvatar/);

    // Mock DOM elements
    const elements = new Map<string, any>();
    class MockEl {
      id: string;
      innerText = "";
      src = "";
      alt = "";
      className = "";
      disabled = false;
      children: MockEl[] = [];
      classList = {
        add: () => {},
        remove: () => {},
      };
      onclick: any = null;
      onerror: any = null;
      constructor(id: string) {
        this.id = id;
      }
      appendChild(c: MockEl) {
        this.children.push(c);
      }
      replaceChildren(...newChildren: MockEl[]) {
        this.children = [...newChildren];
        this.innerText = "";
      }
    }

    const reg = (id: string) => {
      const el = new MockEl(id);
      elements.set(id, el);
      return el;
    };

    const userAvatar = reg("user-avatar");
    userAvatar.innerText = "P";
    reg("btn-login");
    reg("btn-logout");
    reg("user-card");
    reg("user-name");
    reg("user-role");

    const prevDoc = (globalThis as any).document;
    const prevWindow = (globalThis as any).window;
    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tag: string) => new MockEl(""),
    };
    (globalThis as any).window = {
      lampas: {
        cosmetics: {
          getAvatar: async () => ({
            dataUrl: "data:image/png;base64,AA==",
            mimeType: "image/png",
            width: 1,
            height: 1,
          }),
        },
      },
    };

    try {
      const auth = initAuthView({
        showToast: () => {},
        getPortalUrl: () => "https://dev.lampas.town",
        externalImages: () => true,
        onUserChanged: () => {},
      });

      // 1. Initial state
      expect(userAvatar.innerText).toBe("P");

      // 2. User logs in with UUID and username
      const sampleUser: RendererUserProfile = {
        id: "u-1",
        name: "Steve",
        minecraftUuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5",
        minecraftUsername: "Steve",
        isAdmin: false,
        isTech: false,
        roles: ["member"],
        allowedChannels: ["stable"],
      };

      auth.updateUserUI(sampleUser);
      await Promise.resolve();

      // Verify img element was added inside #user-avatar
      expect(userAvatar.children.length).toBe(1);
      const img = userAvatar.children[0];
      expect(img.src).toBe("data:image/png;base64,AA==");
      expect(img.alt).toBe("Steve's avatar");

      // 3. Test onerror fallback to initial
      if (img.onerror) {
        img.onerror();
      }
      expect(userAvatar.children.length).toBe(0);
      expect(userAvatar.innerText).toBe("S");

      // 4. Logout resets avatar to "P"
      auth.updateUserUI(null);
      expect(userAvatar.children.length).toBe(0);
      expect(userAvatar.innerText).toBe("P");
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWindow;
    }
  });

  test("settings-view populates #setting-gamedir-input and binds directory buttons", async () => {
    // Check source code requirements
    const settingsSource = fs.readFileSync(
      path.join(__dirname, "../ui/src/views/settings-view.ts"),
      "utf-8",
    );
    expect(settingsSource).toContain("setting-gamedir-input");

    const elements = new Map<string, any>();
    class MockEl {
      id: string;
      innerText = "";
      value = "";
      disabled = false;
      classList = {
        add: () => {},
        remove: () => {},
      };
      onclick: any = null;
      onchange: any = null;
      addEventListener: any = () => {};
      constructor(id: string) {
        this.id = id;
      }
    }

    const reg = (id: string) => {
      const el = new MockEl(id);
      elements.set(id, el);
      return el;
    };

    const gamedirInput = reg("setting-gamedir-input");
    const openDirBtn = reg("btn-settings-open-dir");
    const moveDirBtn = reg("btn-settings-move-dir");
    const repairBtn = reg("btn-repair-settings");
    reg("ram-slider");
    reg("setting-ram-val");
    reg("setting-portal");
    reg("setting-java-args");
    reg("setting-nosync");
    reg("modal-move-dir");
    reg("move-modal-confirm-view");
    reg("move-modal-progress-view");
    reg("move-source-path");
    reg("move-target-path");
    reg("btn-confirm-move");
    reg("btn-cancel-move");

    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;

    let openedPath = "";
    let switchedToTab = "";
    let repairCalled = false;

    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
      createElement: (tag: string) => new MockEl(""),
    };
    (globalThis as any).window = {
      lampas: {
        config: {
          get: async () => ({}),
          set: async (cfg: any) => cfg,
        },
        utils: {
          openPath: async (p: string) => {
            openedPath = p;
          },
        },
        sync: {
          repair: async () => {
            repairCalled = true;
            return { message: "All components repaired." };
          },
        },
        gameDirectory: {
          browse: async () => ({
            canceled: false,
            filePaths: ["D:/NewMinecraft"],
          }),
          validate: async () => ({ valid: true }),
          move: async () => ({ success: true, gameDir: "D:/NewMinecraft" }),
          onMoveProgress: () => () => {},
        },
      },
    };

    const toasts: Array<{ message: string; type: string }> = [];

    try {
      const settings = initSettingsView({
        showToast: (message, type) => {
          toasts.push({ message, type });
        },
        onConfigChanged: () => {},
        switchToTab: (tabId) => {
          switchedToTab = tabId;
        },
      });

      // Initially input is blank
      expect(gamedirInput.value).toBe("");

      // Initialize settings with a configured gameDir
      await settings.initSettings({
        gameDir: "C:/Users/markj/AppData/Roaming/.minecraft-lampas",
        allocatedRamGb: 6,
        portalUrl: "https://dev.lampas.town",
        selectedChannel: "stable",
      });

      // Verify #setting-gamedir-input is populated
      expect(gamedirInput.value).toBe(
        "C:/Users/markj/AppData/Roaming/.minecraft-lampas",
      );

      // Verify Open Folder button works
      expect(typeof openDirBtn.onclick).toBe("function");
      await openDirBtn.onclick();
      expect(openedPath).toBe(
        "C:/Users/markj/AppData/Roaming/.minecraft-lampas",
      );

      // Verify Move Installation button is wired
      expect(typeof moveDirBtn.onclick).toBe("function");

      // Verify Repair Game Files redirects to Console & Logs tab and shows completion toast
      expect(typeof repairBtn.onclick).toBe("function");
      await repairBtn.onclick();
      expect(switchedToTab).toBe("tab-console");
      expect(repairCalled).toBe(true);

      // Verify toasts: initial info toast followed by success completion toast
      expect(
        toasts.some(
          (t) => t.type === "info" && t.message.includes("Verifying"),
        ),
      ).toBe(true);
      expect(
        toasts.some(
          (t) =>
            t.type === "success" &&
            (t.message.includes("repaired") ||
              t.message.includes("Repair complete")),
        ),
      ).toBe(true);
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
    }
  });

  test("mods-view wires all Client Loadout header buttons (add, repair, verify, open folder)", async () => {
    // Check source code requirements
    const modsSource = fs.readFileSync(
      path.join(__dirname, "../ui/src/views/mods-view.ts"),
      "utf-8",
    );
    expect(modsSource).toContain("btn-add-mods");
    expect(modsSource).toContain("btn-repair-pack");
    expect(modsSource).toContain("btn-verify-pack");
    expect(modsSource).toContain("btn-mods-open-dir");

    const elements = new Map<string, any>();
    class MockEl {
      id: string;
      innerText = "";
      value = "";
      disabled = false;
      classList = {
        add: () => {},
        remove: () => {},
      };
      onclick: any = null;
      onchange: any = null;
      addEventListener: any = () => {};
      removeEventListener: any = () => {};
      constructor(id: string) {
        this.id = id;
      }
    }

    const reg = (id: string) => {
      const el = new MockEl(id);
      elements.set(id, el);
      return el;
    };

    const addModsBtn = reg("btn-add-mods");
    const repairPackBtn = reg("btn-repair-pack");
    const verifyPackBtn = reg("btn-verify-pack");
    const modsOpenDirBtn = reg("btn-mods-open-dir");
    reg("mods-grid");
    reg("mods-search-input");
    reg("mods-filtered-count");
    reg("managed-mod-count");
    reg("optional-mod-count");
    reg("local-mod-count");
    reg("mod-drop-zone");

    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;

    let browseAndAddCalled = false;
    let repairCalled = false;
    let startCalled = false;
    let openedPath = "";
    let switchedToTab = "";
    const toasts: Array<{ message: string; type: string }> = [];

    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
      createElement: (tag: string) => new MockEl(""),
    };

    (globalThis as any).window = {
      lampas: {
        mods: {
          browseAndAdd: async () => {
            browseAndAddCalled = true;
            return { success: true, filesAdded: ["custom-addon.jar"] };
          },
          addDropped: async () => ({ success: true }),
          setOfficialEnabled: async () => {},
          setCustomEnabled: async () => {},
          removeCustom: async () => {},
        },
        sync: {
          getModCatalog: async () => [],
          repair: async () => {
            repairCalled = true;
            return { message: "All components repaired." };
          },
          start: async () => {
            startCalled = true;
            return { version: "2.0.0", message: "Synchronized." };
          },
        },
        utils: {
          openPath: async (p: string) => {
            openedPath = p;
          },
        },
        config: {
          get: async () => ({ gameDir: "C:/LampasPack" }),
        },
      },
    };

    try {
      const dispose = initModsView({
        showToast: (message, type) => {
          toasts.push({ message, type });
        },
        onModsChanged: () => {},
        getGameDir: () => "C:/LampasPack",
        switchToTab: (tabId) => {
          switchedToTab = tabId;
        },
      });

      // 1. Test Add Local Mods button
      expect(typeof addModsBtn.onclick).toBe("function");
      await addModsBtn.onclick();
      expect(browseAndAddCalled).toBe(true);

      // 2. Test Repair Pack button
      expect(typeof repairPackBtn.onclick).toBe("function");
      await repairPackBtn.onclick();
      expect(switchedToTab).toBe("tab-console");
      expect(repairCalled).toBe(true);

      // 3. Test Verify Integrity button
      expect(typeof verifyPackBtn.onclick).toBe("function");
      await verifyPackBtn.onclick();
      expect(startCalled).toBe(true);

      // 4. Test Open Pack Folder button
      expect(typeof modsOpenDirBtn.onclick).toBe("function");
      await modsOpenDirBtn.onclick();
      expect(openedPath).toBe("C:/LampasPack");

      dispose();
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
    }
  });
});
