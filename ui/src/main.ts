import type { RendererSettingsDto, RendererUserProfile } from "./types";
import { initConsoleView } from "./views/console-view";
import { initModsView } from "./views/mods-view";
import { initServerStatusView } from "./views/server-status-view";
import { initAuthView } from "./views/auth-view";
import { initSettingsView } from "./views/settings-view";
import { initPlayView } from "./views/play-view";

// Toast notification helper
function showToast(
  message: string,
  type: "info" | "success" | "error" = "info",
  duration = 3500,
): void {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => {
      if (toast.parentNode === container) {
        container.removeChild(toast);
      }
    }, 300);
  }, duration);
}

// Tab navigation helper
function initNavigation(): (tabId: string) => void {
  const navPlay = document.getElementById(
    "nav-play",
  ) as HTMLButtonElement | null;
  const navMods = document.getElementById(
    "nav-mods",
  ) as HTMLButtonElement | null;
  const navConsole = document.getElementById(
    "nav-console",
  ) as HTMLButtonElement | null;
  const navSettings = document.getElementById(
    "nav-settings",
  ) as HTMLButtonElement | null;

  const tabPlay = document.getElementById("tab-play") as HTMLElement | null;
  const tabMods = document.getElementById("tab-mods") as HTMLElement | null;
  const tabConsole = document.getElementById(
    "tab-console",
  ) as HTMLElement | null;
  const tabSettings = document.getElementById(
    "tab-settings",
  ) as HTMLElement | null;

  const tabs: Record<
    string,
    { nav: HTMLButtonElement | null; tab: HTMLElement | null }
  > = {
    "tab-play": { nav: navPlay, tab: tabPlay },
    "tab-mods": { nav: navMods, tab: tabMods },
    "tab-console": { nav: navConsole, tab: tabConsole },
    "tab-settings": { nav: navSettings, tab: tabSettings },
  };

  function switchToTab(activeTabId: string): void {
    for (const [id, item] of Object.entries(tabs)) {
      if (id === activeTabId) {
        item.nav?.classList.add("active");
        item.tab?.classList.remove("hidden");
      } else {
        item.nav?.classList.remove("active");
        item.tab?.classList.add("hidden");
      }
    }
  }

  navPlay?.addEventListener("click", () => switchToTab("tab-play"));
  navMods?.addEventListener("click", () => switchToTab("tab-mods"));
  navConsole?.addEventListener("click", () => switchToTab("tab-console"));
  navSettings?.addEventListener("click", () => switchToTab("tab-settings"));

  return switchToTab;
}

// Window control buttons
function initWindowControls(): void {
  const btnMinimize = document.getElementById(
    "btn-minimize",
  ) as HTMLButtonElement | null;
  const btnMaximize = document.getElementById(
    "btn-maximize",
  ) as HTMLButtonElement | null;
  const btnClose = document.getElementById(
    "btn-close",
  ) as HTMLButtonElement | null;

  if (btnMinimize) btnMinimize.onclick = () => window.lampas.window.minimize();
  if (btnMaximize) btnMaximize.onclick = () => window.lampas.window.maximize();
  if (btnClose) btnClose.onclick = () => window.lampas.window.close();
}

async function startApp(): Promise<void> {
  initWindowControls();
  const switchToTab = initNavigation();

  let activeConfig: RendererSettingsDto = {
    portalUrl: "https://dev.lampas.town",
    selectedChannel: "stable",
    allocatedRamGb: 4,
    gameDir: "",
    noSync: false,
    externalImages: false,
  };

  // Initialize Console View
  const consoleView = initConsoleView({ showToast });

  // Initialize Auth View
  const authView = initAuthView({
    showToast,
    getPortalUrl: () => activeConfig.portalUrl,
    externalImages: () => Boolean(activeConfig.externalImages),
    onUserChanged: (user: RendererUserProfile | null) => {
      const btnPlayText = document.getElementById("btn-play-text");
      if (btnPlayText) {
        btnPlayText.innerText = user ? "PLAY" : "LOG IN TO PLAY";
      }
    },
  });

  // Initialize Play View
  const playView = initPlayView({
    showToast,
    getUser: () => authView.getCurrentUser(),
    clearConsole: () => {
      if ((window as any).clearConsoleLogs) (window as any).clearConsoleLogs();
    },
    appendLog: consoleView.appendLog,
    switchToTab,
    isNoSync: () => Boolean(activeConfig.noSync),
    onStatusChange: (status) => consoleView.setGameStatus(status),
  });

  // Initialize Settings View
  const settingsView = initSettingsView({
    showToast,
    onConfigChanged: (cfg: RendererSettingsDto) => {
      activeConfig = cfg;
    },
    switchToTab,
  });

  // Initialize Mods View
  const disposeMods = initModsView({
    showToast,
    onModsChanged: () => {
      // Refresh runtime or catalog if needed
    },
    getGameDir: () => activeConfig.gameDir,
    switchToTab,
    externalImages: () => Boolean(activeConfig.externalImages),
  });

  // Initialize Server Status View
  const disposeServerStatus = initServerStatusView(
    () => !!authView.getCurrentUser(),
  );

  // App Initialization
  try {
    const initialConfig = await window.lampas.config.get();
    activeConfig = initialConfig;
    await settingsView.initSettings(initialConfig);

    // Check directory onboarding
    const dirStatus = await window.lampas.gameDirectory.getStatus();
    await settingsView.checkInitialGameDir(dirStatus);

    // Titlebar app version
    if (window.lampas.utils?.getAppVersion) {
      try {
        const appVer = await window.lampas.utils.getAppVersion();
        const badge = document.getElementById("titlebar-version-badge");
        if (appVer && badge) badge.innerText = `v${appVer}`;
      } catch {}
    }

    // Auth verification
    try {
      const authRes = await window.lampas.auth.refresh();
      if (authRes.valid && authRes.user) {
        authView.updateUserUI(authRes.user);
      } else {
        authView.updateUserUI(null);
      }
    } catch {
      authView.updateUserUI(null);
    }

    // Load installed runtime specs
    if (window.lampas.sync?.getInstalledRuntime) {
      try {
        const installedRuntime = await window.lampas.sync.getInstalledRuntime();
        if (installedRuntime) {
          playView.updateRuntimeSpecsUI(installedRuntime);
          if (installedRuntime.launch) {
            playView.updateLaunchTargetUI(installedRuntime.launch);
          }
        }
      } catch {}
    }
  } catch (err: any) {
    console.error("Launcher initialization error:", err);
  }

  // Handle HMR / cleanup if reloaded
  window.addEventListener("beforeunload", () => {
    consoleView.dispose();
    disposeMods();
    disposeServerStatus();
    settingsView.dispose();
    playView.dispose();
    authView.dispose();
  });
}

// Boot up
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  void startApp();
}
