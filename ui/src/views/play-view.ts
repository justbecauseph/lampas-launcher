import type {
  RendererUserProfile,
  InstalledRuntimeInfo,
  SyncProgress,
} from "../types";
import { formatFriendlyError } from "../utils";

export interface PlayViewOptions {
  showToast: (
    message: string,
    type: "info" | "success" | "error",
    duration?: number,
  ) => void;
  getUser: () => RendererUserProfile | null;
  clearConsole: () => void;
  appendLog: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
  switchToTab: (tabId: string) => void;
  isNoSync?: () => boolean;
  onStatusChange?: (
    state: "idle" | "syncing" | "launching" | "running",
  ) => void;
}

export function initPlayView(options: PlayViewOptions): {
  updateRuntimeSpecsUI: (runtime: InstalledRuntimeInfo | null) => void;
  updateLaunchTargetUI: (release: any) => void;
  setGameStatus: (state: "idle" | "syncing" | "launching" | "running") => void;
  dispose: () => void;
} {
  const {
    showToast,
    getUser,
    clearConsole,
    appendLog,
    switchToTab,
    isNoSync,
    onStatusChange,
  } = options;

  const btnPlay = document.getElementById(
    "btn-play",
  ) as HTMLButtonElement | null;
  const btnPlayText = document.getElementById(
    "btn-play-text",
  ) as HTMLElement | null;
  const btnPlaySpinner = document.getElementById(
    "btn-play-spinner",
  ) as HTMLElement | null;
  const btnStop = document.getElementById(
    "btn-stop",
  ) as HTMLButtonElement | null;
  const playTargetContainer = document.getElementById(
    "play-target-container",
  ) as HTMLElement | null;
  const playTargetServer = document.getElementById(
    "play-target-server",
  ) as HTMLElement | null;
  const progressContainer = document.getElementById(
    "progress-container",
  ) as HTMLElement | null;
  const progressFill = document.getElementById(
    "progress-fill",
  ) as HTMLElement | null;
  const progressMsg = document.getElementById(
    "progress-msg",
  ) as HTMLElement | null;
  const progressPercent = document.getElementById(
    "progress-percent",
  ) as HTMLElement | null;

  const titlebarStatusDot = document.getElementById(
    "titlebar-status-dot",
  ) as HTMLElement | null;
  const titlebarStatusText = document.getElementById(
    "titlebar-status-text",
  ) as HTMLElement | null;
  const runtimeLoaderVersion = document.getElementById(
    "runtime-loader-version",
  ) as HTMLElement | null;
  const runtimeMinecraftVersion = document.getElementById(
    "runtime-minecraft-version",
  ) as HTMLElement | null;

  let isLaunching = false;
  let isGameRunning = false;
  const disposers: Array<() => void> = [];

  function setGameStatus(
    state: "idle" | "syncing" | "launching" | "running",
  ): void {
    if (titlebarStatusDot) {
      titlebarStatusDot.className = `status-dot status-dot-${state}`;
    }
    if (titlebarStatusText) {
      titlebarStatusText.innerText = state.toUpperCase();
    }
    if (onStatusChange) {
      onStatusChange(state);
    }
  }

  function updateLaunchTargetUI(release: any): void {
    if (playTargetContainer && playTargetServer) {
      if (release?.launch?.autoConnect && release?.launch?.server) {
        playTargetServer.innerText = release.launch.server;
        playTargetContainer.classList.remove("hidden");
      } else {
        playTargetContainer.classList.add("hidden");
      }
    }
  }

  function updateRuntimeSpecsUI(runtime: InstalledRuntimeInfo | null): void {
    if (!runtime) return;
    if (runtime.loader?.version && runtimeLoaderVersion) {
      runtimeLoaderVersion.innerText = runtime.loader.version;
    }
    if (runtime.minecraft && runtimeMinecraftVersion) {
      runtimeMinecraftVersion.innerText = runtime.minecraft;
    }
  }

  // Subscribe to game exit events
  if (window.lampas.game?.onExit) {
    const unsub = window.lampas.game.onExit((code) => {
      isGameRunning = false;
      isLaunching = false;
      setGameStatus("idle");

      if (btnPlay) {
        btnPlay.disabled = false;
        btnPlay.classList.remove("btn-running");
      }
      if (btnPlayText)
        btnPlayText.innerText = getUser() ? "PLAY" : "LOG IN TO PLAY";
      if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
      if (btnStop) btnStop.classList.add("hidden");
      if (progressContainer) progressContainer.classList.add("hidden");

      appendLog(
        "INFO",
        `Minecraft process terminated (exit code ${code ?? 0})`,
      );
      if (code === 0 || code === null) {
        showToast("Minecraft closed.", "info");
      } else {
        showToast(
          `Minecraft closed unexpectedly (exit code ${code}). Check Console for details.`,
          "error",
          6000,
        );
      }
    });
    disposers.push(unsub);
  }

  // Check initial game state
  if (window.lampas.game?.isRunning) {
    void window.lampas.game.isRunning().then((running) => {
      if (running) {
        isGameRunning = true;
        setGameStatus("running");
        if (btnPlayText) btnPlayText.innerText = "RUNNING";
        if (btnStop) btnStop.classList.remove("hidden");
      }
    });
  }

  if (btnPlay) {
    btnPlay.onclick = async (e: MouseEvent) => {
      const user = getUser();
      if (!user) {
        switchToTab("tab-play");
        showToast("Please log in with your Lampas account first.", "error");
        return;
      }

      switchToTab("tab-console");

      if (isGameRunning || isLaunching) return;

      isLaunching = true;
      clearConsole();

      const isRepair = e.shiftKey || e.ctrlKey;
      const noSyncMode = !isRepair && Boolean(isNoSync?.());

      if (noSyncMode) {
        if (btnPlayText) btnPlayText.innerText = "LAUNCHING...";
        if (btnPlaySpinner) btnPlaySpinner.classList.remove("hidden");
        if (btnStop) btnStop.classList.remove("hidden");
        if (progressContainer) progressContainer.classList.add("hidden");

        setGameStatus("launching");
        appendLog(
          "INFO",
          "No-sync mode enabled: Skipping modpack synchronization.",
        );

        try {
          if (window.lampas.sync?.getInstalledRuntime) {
            const installedRuntime =
              await window.lampas.sync.getInstalledRuntime();
            if (installedRuntime) {
              updateRuntimeSpecsUI(installedRuntime);
              if (installedRuntime.launch) {
                updateLaunchTargetUI(installedRuntime.launch);
              }
            }
          }
        } catch {}

        appendLog("INFO", "Bootstrapping runtime and launching game...");
        showToast("No-sync mode active. Launching game...", "info", 2500);

        try {
          await window.lampas.game.launch();

          isGameRunning = true;
          isLaunching = false;
          setGameStatus("running");

          if (btnPlayText) btnPlayText.innerText = "RUNNING";
          if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
          if (btnPlay) {
            btnPlay.disabled = false;
            btnPlay.classList.add("btn-running");
          }
        } catch (err: any) {
          isLaunching = false;
          isGameRunning = false;
          setGameStatus("idle");

          if (btnPlay) {
            btnPlay.disabled = false;
            btnPlay.classList.remove("btn-running");
          }
          if (btnPlayText)
            btnPlayText.innerText = getUser() ? "PLAY" : "LOG IN TO PLAY";
          if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
          if (btnStop) btnStop.classList.add("hidden");
          if (progressContainer) progressContainer.classList.add("hidden");

          showToast(
            `Could not launch Minecraft: ${formatFriendlyError(err)}`,
            "error",
            6000,
          );
          appendLog("ERROR", err.message);
        }
        return;
      }

      if (btnPlayText)
        btnPlayText.innerText = isRepair ? "REPAIRING..." : "SYNCING...";
      if (btnPlaySpinner) btnPlaySpinner.classList.remove("hidden");
      if (btnStop) btnStop.classList.remove("hidden");
      if (progressContainer) progressContainer.classList.remove("hidden");

      setGameStatus("syncing");

      try {
        const unsubProgress = window.lampas.sync.onProgress(
          (prog: SyncProgress) => {
            if (progressMsg)
              progressMsg.innerText = prog.message || "Synchronizing...";
            if (progressPercent) progressPercent.innerText = `${prog.percent}%`;
            if (progressFill) progressFill.style.width = `${prog.percent}%`;
            if (prog.status === "downloading" && btnPlayText) {
              btnPlayText.innerText = "DOWNLOADING...";
            }
          },
        );

        appendLog(
          "INFO",
          isRepair
            ? "Initiating full repair synchronization..."
            : "Initiating synchronization...",
        );
        const syncResult = isRepair
          ? await window.lampas.sync.repair()
          : await window.lampas.sync.start();
        unsubProgress();

        if (syncResult.release) {
          updateLaunchTargetUI(syncResult.release);
        }
        if (syncResult.runtime) {
          updateRuntimeSpecsUI(syncResult.runtime);
        }

        if (btnPlayText) btnPlayText.innerText = "LAUNCHING...";
        setGameStatus("launching");
        if (progressMsg) progressMsg.innerText = "Starting Minecraft JVM...";
        if (progressFill) progressFill.style.width = "100%";
        if (progressPercent) progressPercent.innerText = "100%";

        appendLog(
          "INFO",
          `Modpack v${syncResult.version} synchronized. Bootstrapping runtime...`,
        );
        showToast(
          `Modpack v${syncResult.version} verified. Launching game...`,
          "info",
          2500,
        );

        await window.lampas.game.launch();

        isGameRunning = true;
        isLaunching = false;
        setGameStatus("running");

        if (btnPlayText) btnPlayText.innerText = "RUNNING";
        if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
        if (btnPlay) {
          btnPlay.disabled = false;
          btnPlay.classList.add("btn-running");
        }
      } catch (err: any) {
        isLaunching = false;
        isGameRunning = false;
        setGameStatus("idle");

        if (btnPlay) {
          btnPlay.disabled = false;
          btnPlay.classList.remove("btn-running");
        }
        if (btnPlayText)
          btnPlayText.innerText = getUser() ? "PLAY" : "LOG IN TO PLAY";
        if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
        if (btnStop) btnStop.classList.add("hidden");
        if (progressContainer) progressContainer.classList.add("hidden");

        showToast(
          `Could not launch Minecraft: ${formatFriendlyError(err)}`,
          "error",
          6000,
        );
        appendLog("ERROR", err.message);
      }
    };
  }

  if (btnStop) {
    btnStop.onclick = async () => {
      try {
        btnStop.disabled = true;
        btnStop.innerText = "STOPPING...";
        await window.lampas.game.kill();
        showToast("Stopping Minecraft...", "info");
      } catch (err: any) {
        showToast(
          `Could not stop Minecraft: ${formatFriendlyError(err)}`,
          "error",
        );
      } finally {
        btnStop.disabled = false;
        btnStop.innerText = "STOP";
      }
    };
  }

  return {
    updateRuntimeSpecsUI,
    updateLaunchTargetUI,
    setGameStatus,
    dispose: () => {
      disposers.forEach((d) => d());
    },
  };
}
