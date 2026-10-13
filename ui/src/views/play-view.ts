import type {
  RendererUserProfile,
  InstalledRuntimeInfo,
  SyncProgress,
} from "../types";
import { formatFriendlyError } from "../utils";

type GameStatus = "idle" | "syncing" | "launching" | "running";

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
  requestLogin?: () => Promise<void>;
  isNoSync?: () => boolean;
  onStatusChange?: (state: GameStatus) => void;
}

const PROGRESS_LABELS: Partial<Record<SyncProgress["status"], string>> = {
  checking: "CHECKING FOR UPDATES…",
  downloading: "DOWNLOADING…",
  verifying: "VERIFYING FILES…",
  staging: "INSTALLING…",
  repairing: "REPAIRING…",
};

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function describeProgress(prog: SyncProgress): string {
  if (prog.status === "downloading" && prog.totalBytes > 0) {
    return `Downloading ${formatMegabytes(prog.bytesDownloaded)} of ${formatMegabytes(prog.totalBytes)}`;
  }
  if (prog.totalFiles > 0 && prog.status !== "complete") {
    return `${prog.message || "Synchronizing"} (${prog.filesCompleted}/${prog.totalFiles})`;
  }
  return prog.message || "Synchronizing…";
}

export function initPlayView(options: PlayViewOptions): {
  updateRuntimeSpecsUI: (runtime: InstalledRuntimeInfo | null) => void;
  updateLaunchTargetUI: (release: any) => void;
  setGameStatus: (state: GameStatus) => void;
  refreshPlayButton: () => void;
  dispose: () => void;
} {
  const {
    showToast,
    getUser,
    clearConsole,
    appendLog,
    switchToTab,
    requestLogin,
    isNoSync,
    onStatusChange,
  } = options;

  const el = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  const btnPlay = el<HTMLButtonElement>("btn-play");
  const btnPlayText = el("btn-play-text");
  const btnPlaySpinner = el("btn-play-spinner");
  const btnStop = el<HTMLButtonElement>("btn-stop");
  const playTargetContainer = el("play-target-container");
  const playTargetServer = el("play-target-server");
  const progressContainer = el("progress-container");
  const progressFill = el("progress-fill");
  const progressMsg = el("progress-msg");
  const progressPercent = el("progress-percent");
  const launchError = el("launch-error");
  const launchErrorMsg = el("launch-error-msg");
  const btnLaunchErrorLogs = el<HTMLButtonElement>("btn-launch-error-logs");
  const btnLaunchErrorRepair = el<HTMLButtonElement>("btn-launch-error-repair");

  const titlebarStatusDot = el("titlebar-status-dot");
  const titlebarStatusText = el("titlebar-status-text");
  const runtimeLoaderVersion = el("runtime-loader-version");
  const runtimeMinecraftVersion = el("runtime-minecraft-version");
  const aboutMinecraftVersion = el("about-minecraft-version");

  let status: GameStatus = "idle";
  const disposers: Array<() => void> = [];

  function setPlayLabel(text: string, busy: boolean): void {
    if (btnPlayText) btnPlayText.innerText = text;
    if (btnPlaySpinner) {
      if (busy) btnPlaySpinner.classList.remove("hidden");
      else btnPlaySpinner.classList.add("hidden");
    }
  }

  /** Sets the idle/running label for the current login state. */
  function refreshPlayButton(): void {
    if (status === "running") {
      setPlayLabel("PLAYING", false);
    } else if (status === "idle") {
      setPlayLabel(getUser() ? "PLAY" : "LOG IN TO PLAY", false);
    }
  }

  function setGameStatus(state: GameStatus): void {
    status = state;
    if (titlebarStatusDot) {
      titlebarStatusDot.className = `status-dot status-dot-${state}`;
    }
    if (titlebarStatusText) {
      titlebarStatusText.innerText = state.toUpperCase();
    }

    const busy = state === "syncing" || state === "launching";
    if (btnPlay) {
      btnPlay.disabled = busy || state === "running";
      if (state === "running") btnPlay.classList.add("btn-running");
      else btnPlay.classList.remove("btn-running");
    }
    if (btnStop) {
      if (state === "idle") btnStop.classList.add("hidden");
      else btnStop.classList.remove("hidden");
    }
    if (state === "idle" || state === "running") {
      progressContainer?.classList.add("hidden");
    }
    refreshPlayButton();
    onStatusChange?.(state);
  }

  function setProgress(message: string, percent: number): void {
    progressContainer?.classList.remove("hidden");
    if (progressMsg) progressMsg.innerText = message;
    if (progressPercent) progressPercent.innerText = `${percent}%`;
    if (progressFill) progressFill.style.width = `${percent}%`;
  }

  function showLaunchError(message: string): void {
    if (launchErrorMsg) launchErrorMsg.innerText = message;
    launchError?.classList.remove("hidden");
  }

  function hideLaunchError(): void {
    launchError?.classList.add("hidden");
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
    if (runtime.minecraft) {
      if (runtimeMinecraftVersion)
        runtimeMinecraftVersion.innerText = runtime.minecraft;
      if (aboutMinecraftVersion)
        aboutMinecraftVersion.innerText = runtime.minecraft;
    }
  }

  function handleLaunchFailure(err: any): void {
    setGameStatus("idle");
    const friendly = formatFriendlyError(err);
    showLaunchError(friendly);
    appendLog("ERROR", err?.message || String(err));
  }

  async function launchGame(): Promise<void> {
    await window.lampas.game.launch();
    setGameStatus("running");
  }

  async function runNoSyncLaunch(): Promise<void> {
    setGameStatus("launching");
    setPlayLabel("STARTING…", true);
    appendLog(
      "INFO",
      "No-sync mode enabled: Skipping modpack synchronization.",
    );

    try {
      if (window.lampas.sync?.getInstalledRuntime) {
        const installedRuntime = await window.lampas.sync.getInstalledRuntime();
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
      await launchGame();
    } catch (err: any) {
      handleLaunchFailure(err);
    }
  }

  async function runSyncedLaunch(isRepair: boolean): Promise<void> {
    setGameStatus("syncing");
    setPlayLabel(isRepair ? "REPAIRING…" : "CHECKING FOR UPDATES…", true);
    setProgress(
      isRepair ? "Verifying every game file…" : "Checking for pack updates…",
      0,
    );

    let unsubProgress: (() => void) | null = null;
    try {
      unsubProgress = window.lampas.sync.onProgress((prog: SyncProgress) => {
        setProgress(describeProgress(prog), prog.percent);
        const label = PROGRESS_LABELS[prog.status];
        if (label) setPlayLabel(label, true);
      });

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
      unsubProgress = null;

      if (syncResult.release) updateLaunchTargetUI(syncResult.release);
      if (syncResult.runtime) updateRuntimeSpecsUI(syncResult.runtime);

      setGameStatus("launching");
      setPlayLabel("STARTING…", true);
      setProgress("Starting Minecraft…", 100);

      appendLog(
        "INFO",
        `Modpack v${syncResult.version} synchronized. Bootstrapping runtime...`,
      );

      await launchGame();
    } catch (err: any) {
      unsubProgress?.();
      handleLaunchFailure(err);
    }
  }

  async function startLaunch(isRepair: boolean): Promise<void> {
    if (status !== "idle") return;

    hideLaunchError();
    clearConsole();

    if (!isRepair && isNoSync?.()) {
      await runNoSyncLaunch();
    } else {
      await runSyncedLaunch(isRepair);
    }
  }

  // Subscribe to game exit events
  if (window.lampas.game?.onExit) {
    const unsub = window.lampas.game.onExit((code) => {
      setGameStatus("idle");
      appendLog(
        "INFO",
        `Minecraft process terminated (exit code ${code ?? 0})`,
      );
      if (code === 0 || code === null) {
        showToast("Minecraft closed.", "info");
      } else {
        showLaunchError(`Minecraft closed unexpectedly (exit code ${code}).`);
      }
    });
    disposers.push(unsub);
  }

  // Check initial game state
  if (window.lampas.game?.isRunning) {
    void window.lampas.game.isRunning().then((running) => {
      if (running) setGameStatus("running");
    });
  }

  if (btnPlay) {
    btnPlay.onclick = async (e: MouseEvent) => {
      if (!getUser()) {
        if (requestLogin) {
          await requestLogin();
        } else {
          showToast("Please log in with your Lampas account first.", "error");
        }
        return;
      }

      // Shift/Ctrl-click keeps the hidden "repair then launch" shortcut.
      await startLaunch(e.shiftKey || e.ctrlKey);
    };
  }

  if (btnLaunchErrorLogs) {
    btnLaunchErrorLogs.onclick = () => switchToTab("tab-console");
  }

  if (btnLaunchErrorRepair) {
    btnLaunchErrorRepair.onclick = () => void startLaunch(true);
  }

  if (btnStop) {
    btnStop.onclick = async () => {
      try {
        btnStop.disabled = true;
        btnStop.innerText = "Stopping…";
        await window.lampas.game.kill();
        showToast("Stopping Minecraft...", "info");
      } catch (err: any) {
        showToast(
          `Could not stop Minecraft: ${formatFriendlyError(err)}`,
          "error",
        );
      } finally {
        btnStop.disabled = false;
        btnStop.innerText = "Stop";
      }
    };
  }

  return {
    updateRuntimeSpecsUI,
    updateLaunchTargetUI,
    setGameStatus,
    refreshPlayButton,
    dispose: () => {
      disposers.forEach((d) => d());
    },
  };
}
