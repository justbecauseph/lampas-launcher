import { describe, expect, test } from "bun:test";
import { initPlayView } from "../ui/src/views/play-view";
import { initSettingsView } from "../ui/src/views/settings-view";
import type { RendererUserProfile, RendererSettingsDto } from "../src/types";

class MockElement {
  value = "";
  innerText = "";
  className = "";
  classList = {
    classes: new Set<string>(),
    add: (...c: string[]) => c.forEach((cls) => this.classList.classes.add(cls)),
    remove: (...c: string[]) => c.forEach((cls) => this.classList.classes.delete(cls)),
    contains: (cls: string) => this.classList.classes.has(cls),
  };
  style: Record<string, string> = {};
  disabled = false;
  checked = false;
  dataset: Record<string, string> = {};
  onclick: any = null;
  onchange: any = null;
  addEventListener: any = (event: string, handler: any) => {
    if (event === "change") this.onchange = handler;
    if (event === "click") this.onclick = handler;
  };
}

describe("Skip Pipeline (No Sync) Mode Verification", () => {
  test("Play view skips modpack synchronization when noSync is true", async () => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;

    const elements = new Map<string, MockElement>();
    const reg = (id: string): MockElement => {
      const el = new MockElement();
      elements.set(id, el);
      return el;
    };

    const btnPlay = reg("btn-play");
    const btnPlayText = reg("btn-play-text");
    const btnPlaySpinner = reg("btn-play-spinner");
    const btnStop = reg("btn-stop");
    const progressContainer = reg("progress-container");
    const progressFill = reg("progress-fill");
    const progressMsg = reg("progress-msg");
    const progressPercent = reg("progress-percent");
    const titlebarStatusDot = reg("titlebar-status-dot");
    const titlebarStatusText = reg("titlebar-status-text");
    const runtimeLoaderVersion = reg("runtime-loader-version");
    const runtimeMinecraftVersion = reg("runtime-minecraft-version");

    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new MockElement(),
    };

    let syncStartCalled = false;
    let syncRepairCalled = false;
    let gameLaunchCalled = false;
    let launchedUser: any = null;
    let getInstalledRuntimeCalled = false;

    let exitCallback: any = null;

    (globalThis as any).window = {
      lampas: {
        game: {
          isRunning: async () => false,
          launch: async (user: any) => {
            gameLaunchCalled = true;
            launchedUser = user;
            return true;
          },
          onExit: (cb: any) => {
            exitCallback = cb;
            return () => {};
          },
        },
        sync: {
          start: async () => {
            syncStartCalled = true;
            return { version: "2.0.0" };
          },
          repair: async () => {
            syncRepairCalled = true;
            return { version: "2.0.0" };
          },
          getInstalledRuntime: async () => {
            getInstalledRuntimeCalled = true;
            return {
              minecraft: "1.21.1",
              loader: { type: "fabric", version: "0.16.5" },
            };
          },
          onProgress: () => () => {},
        },
      },
    };

    const sampleUser: RendererUserProfile = {
      id: "u-1",
      name: "Alex",
      minecraftUuid: "12345678-1234-1234-1234-123456789abc",
      minecraftUsername: "Alex",
      isAdmin: false,
      isTech: false,
      roles: ["member"],
      allowedChannels: ["stable"],
    };

    const logs: Array<{ level: string; msg: string }> = [];
    const toasts: Array<{ msg: string; type: string }> = [];

    let noSyncEnabled = true;

    try {
      const play = initPlayView({
        showToast: (msg, type) => toasts.push({ msg, type }),
        getUser: () => sampleUser,
        clearConsole: () => {},
        appendLog: (level, msg) => logs.push({ level, msg }),
        switchToTab: () => {},
        isNoSync: () => noSyncEnabled,
      });

      // 1. Click PLAY with noSync = true
      expect(typeof btnPlay.onclick).toBe("function");
      await btnPlay.onclick({ shiftKey: false, ctrlKey: false } as any);

      // Verify sync was NOT called
      expect(syncStartCalled).toBe(false);
      expect(syncRepairCalled).toBe(false);

      // Verify installed runtime specs were loaded from disk
      expect(getInstalledRuntimeCalled).toBe(true);
      expect(runtimeMinecraftVersion.innerText).toBe("1.21.1");
      expect(runtimeLoaderVersion.innerText).toBe("0.16.5");

      // Verify game was launched directly
      expect(gameLaunchCalled).toBe(true);

      // Verify logs and toasts show no-sync mode messaging
      expect(logs.some((l) => l.msg.includes("No-sync mode enabled: Skipping modpack synchronization."))).toBe(true);
      expect(toasts.some((t) => t.msg.includes("No-sync mode active. Launching game..."))).toBe(true);
      expect(titlebarStatusText.innerText).toBe("RUNNING");

      // Reset test spies and simulate game closing
      exitCallback(0);
      syncStartCalled = false;
      gameLaunchCalled = false;
      noSyncEnabled = false;

      // 2. Click PLAY with noSync = false (standard pipeline mode)
      await btnPlay.onclick({ shiftKey: false, ctrlKey: false } as any);

      // Verify sync pipeline WAS called
      expect(syncStartCalled).toBe(true);
      expect(gameLaunchCalled).toBe(true);

      // Reset spies and simulate game closing
      exitCallback(0);
      syncStartCalled = false;
      syncRepairCalled = false;
      gameLaunchCalled = false;
      noSyncEnabled = true;

      // 3. Click PLAY with Shift key (explicit repair override)
      await btnPlay.onclick({ shiftKey: true, ctrlKey: false } as any);

      // Verify repair pipeline ran despite noSync being true
      expect(syncRepairCalled).toBe(true);
      expect(syncStartCalled).toBe(false);

      play.dispose();
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
    }
  });

  test("Settings view toggles noSync setting and updates titlebar badge", async () => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;

    const elements = new Map<string, MockElement>();
    const reg = (id: string): MockElement => {
      const el = new MockElement();
      elements.set(id, el);
      return el;
    };

    const settingNoSync = reg("setting-nosync");
    const titlebarNoSyncBadge = reg("titlebar-nosync-badge");
    titlebarNoSyncBadge.classList.add("hidden");

    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
      createElement: () => new MockElement(),
    };

    let savedConfig: any = null;
    (globalThis as any).window = {
      lampas: {
        config: {
          set: async (update: any) => {
            savedConfig = update;
            return { noSync: update.noSync };
          },
        },
      },
    };

    let reportedConfig: any = null;

    try {
      const settings = initSettingsView({
        showToast: () => {},
        onConfigChanged: (cfg) => {
          reportedConfig = cfg;
        },
      });

      // Initially unchecked
      expect(settingNoSync.checked).toBe(false);
      expect(titlebarNoSyncBadge.classList.contains("hidden")).toBe(true);

      // Initialize with noSync: true
      await settings.initSettings({
        portalUrl: "https://dev.lampas.town",
        selectedChannel: "stable",
        allocatedRamGb: 4,
        gameDir: "C:/game",
        noSync: true,
      });

      // Verify UI updated
      expect(settingNoSync.checked).toBe(true);
      expect(titlebarNoSyncBadge.classList.contains("hidden")).toBe(false);

      // Toggle off via checkbox
      settingNoSync.checked = false;
      await settingNoSync.onchange();

      expect(savedConfig).toEqual({ noSync: false });
      expect(reportedConfig).toEqual({ noSync: false });
      expect(titlebarNoSyncBadge.classList.contains("hidden")).toBe(true);

      // Toggle back on
      settingNoSync.checked = true;
      await settingNoSync.onchange();

      expect(savedConfig).toEqual({ noSync: true });
      expect(reportedConfig).toEqual({ noSync: true });
      expect(titlebarNoSyncBadge.classList.contains("hidden")).toBe(false);

      settings.dispose();
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
    }
  });
});
