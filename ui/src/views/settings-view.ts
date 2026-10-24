import type {
  DirectoryStatus,
  DirectoryMoveProgress,
  RendererSettingsDto,
} from "../types";
import { formatFriendlyError, isUserCancelled } from "../utils";

export interface SettingsViewOptions {
  showToast: (
    message: string,
    type: "info" | "success" | "error",
    duration?: number,
  ) => void;
  onConfigChanged: (config: RendererSettingsDto) => void;
  switchToTab?: (tabId: string) => void;
}

const PENDING_TOAST_KEY = "lampas:pending-toast";

const CHANNEL_LABELS: Record<"stable" | "beta" | "dev", string> = {
  stable: "Stable",
  beta: "Beta",
  dev: "Dev",
};

/** Holds a toast across window.location.reload(); see showPendingToast. */
function queueToastAfterReload(
  message: string,
  type: "success" | "error",
): void {
  try {
    sessionStorage.setItem(
      PENDING_TOAST_KEY,
      JSON.stringify({ message, type }),
    );
  } catch {
    // Storage unavailable: the reload still happens, without the toast.
  }
}

/** Shows a toast queued before the last reload, once. */
export function showPendingToast(
  showToast: (
    message: string,
    type: "success" | "error",
    duration?: number,
  ) => void,
): void {
  try {
    const raw = sessionStorage.getItem(PENDING_TOAST_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_TOAST_KEY);
    const { message, type } = JSON.parse(raw);
    if (
      typeof message === "string" &&
      (type === "success" || type === "error")
    ) {
      showToast(message, type, 8000);
    }
  } catch {
    // Ignore a malformed or unavailable entry.
  }
}

function formatBytes(bytes?: number): string {
  if (!bytes || isNaN(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function initSettingsView(options: SettingsViewOptions): {
  initSettings: (config: RendererSettingsDto) => Promise<void>;
  checkInitialGameDir: (status: DirectoryStatus) => Promise<void>;
  dispose: () => void;
} {
  const { showToast, onConfigChanged, switchToTab } = options;

  const ramSlider = document.getElementById(
    "ram-slider",
  ) as HTMLInputElement | null;
  const ramDisplay = document.getElementById(
    "ram-display",
  ) as HTMLElement | null;
  const settingRamVal = document.getElementById(
    "setting-ram-val",
  ) as HTMLElement | null;
  const gamedirDisplay = document.getElementById(
    "gamedir-display",
  ) as HTMLElement | null;
  const settingGamedirInput = (document.getElementById(
    "setting-gamedir-input",
  ) || document.getElementById("setting-gamedir")) as HTMLInputElement | null;
  const btnSettingsOpenDir = (document.getElementById(
    "btn-settings-open-dir",
  ) || document.getElementById("btn-open-gamedir")) as HTMLButtonElement | null;
  const btnSettingsMoveDir = (document.getElementById(
    "btn-settings-move-dir",
  ) || document.getElementById("btn-move-gamedir")) as HTMLButtonElement | null;
  const btnRepairSettings = document.getElementById(
    "btn-repair-settings",
  ) as HTMLButtonElement | null;
  const settingsSaved = document.getElementById(
    "settings-saved",
  ) as HTMLElement | null;
  const settingPortal = document.getElementById(
    "setting-portal",
  ) as HTMLInputElement | null;
  const settingJavaArgs = (document.getElementById("setting-java-args") ||
    document.getElementById("setting-javaargs")) as
    HTMLInputElement | HTMLTextAreaElement | null;
  const settingNoSync = (document.getElementById("setting-nosync") ||
    document.getElementById("btn-toggle-nosync")) as
    HTMLInputElement | HTMLButtonElement | null;
  const settingExternalImages = document.getElementById(
    "setting-external-images",
  ) as HTMLInputElement | null;
  const channelBtns =
    document.querySelectorAll<HTMLButtonElement>(".channel-btn");
  const titlebarChannelBadge = document.getElementById(
    "titlebar-channel-badge",
  ) as HTMLElement | null;
  const titlebarNoSyncBadge = document.getElementById(
    "titlebar-nosync-badge",
  ) as HTMLElement | null;

  // Move Modal Elements
  const modalMoveDir = (document.getElementById("modal-move-dir") ||
    document.getElementById("move-modal")) as HTMLElement | null;
  const moveModalConfirmView = document.getElementById(
    "move-modal-confirm-view",
  ) as HTMLElement | null;
  const moveModalProgressView = (document.getElementById(
    "move-modal-progress-view",
  ) || document.getElementById("move-progress-modal")) as HTMLElement | null;
  const moveSourcePath = document.getElementById(
    "move-source-path",
  ) as HTMLElement | null;
  const moveTargetPath = document.getElementById(
    "move-target-path",
  ) as HTMLElement | null;
  const btnCancelMove = document.getElementById(
    "btn-cancel-move",
  ) as HTMLButtonElement | null;
  const btnConfirmMove = document.getElementById(
    "btn-confirm-move",
  ) as HTMLButtonElement | null;
  const moveInput = document.getElementById(
    "move-dir-input",
  ) as HTMLInputElement | null;
  const moveError = document.getElementById("move-error") as HTMLElement | null;
  const btnBrowseMove = document.getElementById(
    "btn-browse-move",
  ) as HTMLButtonElement | null;

  const moveProgressPhase = document.getElementById(
    "move-progress-phase",
  ) as HTMLElement | null;
  const moveProgressDetails = document.getElementById(
    "move-progress-details",
  ) as HTMLElement | null;
  const moveProgressPercent = document.getElementById(
    "move-progress-percent",
  ) as HTMLElement | null;
  const moveProgressFill = document.getElementById(
    "move-progress-fill",
  ) as HTMLElement | null;
  const moveProgressFile = document.getElementById(
    "move-progress-file",
  ) as HTMLElement | null;

  // Onboarding Modal Elements
  const modalInitialDir = (document.getElementById("modal-initial-dir") ||
    document.getElementById("dir-onboarding-modal")) as HTMLElement | null;
  const initialGamedirInput = (document.getElementById(
    "initial-gamedir-input",
  ) || document.getElementById("dir-input")) as HTMLInputElement | null;
  const initialDirError = (document.getElementById("initial-dir-error") ||
    document.getElementById("dir-error")) as HTMLElement | null;
  const btnInitialBrowse = (document.getElementById("btn-initial-browse") ||
    document.getElementById("btn-browse-dir")) as HTMLButtonElement | null;
  const btnInitialConfirm = (document.getElementById("btn-initial-confirm") ||
    document.getElementById("btn-confirm-dir")) as HTMLButtonElement | null;
  const btnAcceptDefault = document.getElementById(
    "btn-accept-default-dir",
  ) as HTMLButtonElement | null;

  let currentConfig: RendererSettingsDto | null = null;
  let pendingMoveTargetPath = "";
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  const disposers: Array<() => void> = [];

  function flashSaved(): void {
    if (!settingsSaved) return;
    settingsSaved.innerText = "Saved";
    settingsSaved.classList.add("visible");
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      settingsSaved.classList.remove("visible");
    }, 1800);
  }

  // The Store default folder, whose long package path means nothing to
  // most people. Known once the directory status has loaded.
  let appStorageDir: string | null = null;

  function updateGameDirUI(dir: string): void {
    if (gamedirDisplay) {
      const isAppStorage =
        appStorageDir !== null &&
        dir.toLowerCase() === appStorageDir.toLowerCase();
      gamedirDisplay.innerText = isAppStorage ? "Default location" : dir;
      gamedirDisplay.title = dir;
    }
    if (settingGamedirInput) {
      settingGamedirInput.value = dir;
      settingGamedirInput.innerText = dir;
    }
  }

  function applyChannel(channel: "stable" | "beta" | "dev"): void {
    channelBtns.forEach((btn) => {
      if (btn.dataset.channel === channel) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
    if (titlebarChannelBadge) {
      titlebarChannelBadge.innerText = CHANNEL_LABELS[channel];
      if (channel === "stable") titlebarChannelBadge.classList.add("hidden");
      else titlebarChannelBadge.classList.remove("hidden");
    }
  }

  function updateNoSyncUI(noSync?: boolean): void {
    const isNoSync = Boolean(noSync);
    if (titlebarNoSyncBadge) {
      if (isNoSync) titlebarNoSyncBadge.classList.remove("hidden");
      else titlebarNoSyncBadge.classList.add("hidden");
    }
    if (settingNoSync) {
      if ("checked" in settingNoSync) {
        settingNoSync.checked = isNoSync;
      } else if (typeof settingNoSync.querySelector === "function") {
        const toggle = settingNoSync.querySelector(
          ".toggle-dot",
        ) as HTMLElement | null;
        if (isNoSync) {
          settingNoSync.classList.add("bg-amber-600");
          settingNoSync.classList.remove("bg-slate-700");
          if (toggle) toggle.classList.add("translate-x-4");
        } else {
          settingNoSync.classList.remove("bg-amber-600");
          settingNoSync.classList.add("bg-slate-700");
          if (toggle) toggle.classList.remove("translate-x-4");
        }
      }
    }
  }

  async function checkInitialGameDir(status: DirectoryStatus): Promise<void> {
    appStorageDir = status.defaultIsAppStorage ? status.defaultGameDir : null;
    if (currentConfig?.gameDir) updateGameDirUI(currentConfig.gameDir);

    if (!status.isConfigured && modalInitialDir) {
      modalInitialDir.classList.remove("hidden");
      if (initialGamedirInput)
        initialGamedirInput.value = status.defaultGameDir;

      // Explain the app-storage default, which reads as an opaque path.
      const initialDirNote = document.getElementById("initial-dir-note");
      const updateInitialDirNote = () => {
        const showNote =
          status.defaultIsAppStorage &&
          initialGamedirInput?.value.trim() === status.defaultGameDir;
        initialDirNote?.classList.toggle("hidden", !showNote);
      };
      updateInitialDirNote();
      if (initialGamedirInput)
        initialGamedirInput.oninput = updateInitialDirNote;

      if (btnAcceptDefault) {
        btnAcceptDefault.onclick = async () => {
          try {
            const updated = await window.lampas.gameDirectory.configure(
              status.defaultGameDir,
            );
            modalInitialDir.classList.add("hidden");
            updateGameDirUI(updated.gameDir);
            currentConfig = updated;
            onConfigChanged(updated);
            showToast("Game folder set.", "success");
          } catch (err: any) {
            if (isUserCancelled(err)) return;
            if (initialDirError) {
              initialDirError.innerText = formatFriendlyError(err);
              initialDirError.classList.remove("hidden");
            }
          }
        };
      }

      if (btnInitialBrowse) {
        btnInitialBrowse.onclick = async () => {
          const res = await window.lampas.gameDirectory.browse(
            status.defaultGameDir,
          );
          if (!res.canceled && res.filePaths?.[0] && initialGamedirInput) {
            initialGamedirInput.value = res.filePaths[0];
            updateInitialDirNote();
          }
        };
      }

      if (btnInitialConfirm) {
        btnInitialConfirm.onclick = async () => {
          const target = initialGamedirInput?.value?.trim() || "";
          try {
            if (window.lampas?.gameDirectory?.validate) {
              const val = await window.lampas.gameDirectory.validate(target);
              if (!val.valid) {
                if (initialDirError) {
                  initialDirError.innerText =
                    val.reason || "Choose a different folder.";
                  initialDirError.classList.remove("hidden");
                }
                return;
              }
            }

            const updated = await window.lampas.gameDirectory.configure(target);
            modalInitialDir.classList.add("hidden");
            updateGameDirUI(updated.gameDir);
            currentConfig = updated;
            onConfigChanged(updated);
            showToast("Game folder set.", "success");
          } catch (err: any) {
            if (isUserCancelled(err)) return;
            if (initialDirError) {
              initialDirError.innerText = formatFriendlyError(err);
              initialDirError.classList.remove("hidden");
            }
          }
        };
      }
    }
  }

  async function initSettings(config: RendererSettingsDto): Promise<void> {
    currentConfig = config;

    const ram = config.allocatedRamGb || 8;
    if (ramSlider) ramSlider.value = String(ram);
    if (ramDisplay) ramDisplay.innerText = `${ram} GB RAM`;
    if (settingRamVal) settingRamVal.innerText = `${ram} GB`;

    updateGameDirUI(config.gameDir || ".minecraft-lampas");
    if (settingPortal)
      settingPortal.value = config.portalUrl || "https://dev.lampas.town";
    if (settingJavaArgs) settingJavaArgs.value = config.javaArgs || "";
    if (settingExternalImages)
      settingExternalImages.checked = Boolean(config.externalImages);

    updateNoSyncUI(config.noSync);
    applyChannel(config.selectedChannel || "stable");
  }

  // RAM Slider change
  if (ramSlider) {
    ramSlider.addEventListener("input", () => {
      const val = parseInt(ramSlider.value, 10);
      if (ramDisplay) ramDisplay.innerText = `${val} GB RAM`;
      if (settingRamVal) settingRamVal.innerText = `${val} GB`;
    });
    ramSlider.addEventListener("change", async () => {
      const val = parseInt(ramSlider.value, 10);
      try {
        const updated = await window.lampas.config.set({ allocatedRamGb: val });
        currentConfig = updated;
        onConfigChanged(updated);
        flashSaved();
      } catch (err: any) {
        showToast(
          `Couldn't change memory: ${formatFriendlyError(err)}`,
          "error",
        );
      }
    });
  }

  // Channel Buttons
  channelBtns.forEach((btn) => {
    btn.onclick = async () => {
      const channel = btn.dataset.channel as "stable" | "beta" | "dev";
      try {
        const updated = await window.lampas.config.set({
          selectedChannel: channel,
        });
        applyChannel(channel);
        currentConfig = updated;
        onConfigChanged(updated);
        showToast(
          `You'll now get ${CHANNEL_LABELS[channel]} pack updates.`,
          "info",
        );
      } catch (err: any) {
        showToast(
          `Couldn't change the pack version: ${formatFriendlyError(err)}`,
          "error",
        );
      }
    };
  });

  // NoSync Toggle
  if (settingNoSync) {
    const handleNoSyncToggle = async () => {
      const nextVal =
        "checked" in settingNoSync
          ? settingNoSync.checked
          : !currentConfig?.noSync;
      try {
        const updated = await window.lampas.config.set({ noSync: nextVal });
        updateNoSyncUI(nextVal);
        currentConfig = updated;
        onConfigChanged(updated);
        flashSaved();
        if (nextVal) {
          showToast("Pack updates will be skipped when you launch.", "info");
        }
      } catch (err: any) {
        showToast(
          `Couldn't change this setting: ${formatFriendlyError(err)}`,
          "error",
        );
        updateNoSyncUI(currentConfig?.noSync);
      }
    };

    if ("checked" in settingNoSync) {
      settingNoSync.onchange = handleNoSyncToggle;
    } else {
      settingNoSync.onclick = handleNoSyncToggle;
    }
  }

  if (settingExternalImages) {
    settingExternalImages.onchange = async () => {
      try {
        const updated = await window.lampas.config.set({
          externalImages: settingExternalImages.checked,
        });
        currentConfig = updated;
        onConfigChanged(updated);
        flashSaved();
      } catch (err: any) {
        settingExternalImages.checked = Boolean(currentConfig?.externalImages);
        showToast(
          `Couldn't change this setting: ${formatFriendlyError(err)}`,
          "error",
        );
      }
    };
  }

  // Open Game Directory in file explorer
  if (btnSettingsOpenDir) {
    btnSettingsOpenDir.onclick = async () => {
      // Main only opens known location identifiers, never raw paths.
      await window.lampas.utils.openKnownLocation("gameDir");
    };
  }

  // Move Game Directory Modal & Operations
  if (btnSettingsMoveDir) {
    btnSettingsMoveDir.onclick = async () => {
      // If modal has a browse button and input inside it, show modal first
      if (btnBrowseMove && moveInput) {
        if (modalMoveDir) modalMoveDir.classList.remove("hidden");
        if (currentConfig?.gameDir) {
          moveInput.value = currentConfig.gameDir;
        }
        if (moveError) moveError.classList.add("hidden");
        return;
      }

      // Standard ui/index.html flow: trigger browse dialog immediately
      try {
        const browseRes = await window.lampas.gameDirectory.browse(
          currentConfig?.gameDir,
        );
        if (browseRes.canceled || !browseRes.filePaths?.length) {
          return;
        }

        const targetPath = browseRes.filePaths[0];
        const valRes = await window.lampas.gameDirectory.validate(
          targetPath,
          currentConfig?.gameDir,
        );
        if (!valRes.valid) {
          showToast(
            valRes.reason || "Choose a different folder.",
            "error",
            5000,
          );
          return;
        }

        pendingMoveTargetPath = targetPath;
        if (moveSourcePath)
          moveSourcePath.innerText = currentConfig?.gameDir || "";
        if (moveTargetPath) moveTargetPath.innerText = targetPath;

        if (moveModalConfirmView)
          moveModalConfirmView.classList.remove("hidden");
        if (moveModalProgressView)
          moveModalProgressView.classList.add("hidden");
        if (modalMoveDir) modalMoveDir.classList.remove("hidden");
      } catch (err: any) {
        showToast(
          `Couldn't use that folder: ${formatFriendlyError(err)}`,
          "error",
        );
      }
    };
  }

  if (btnCancelMove) {
    btnCancelMove.onclick = () => {
      if (modalMoveDir) modalMoveDir.classList.add("hidden");
      pendingMoveTargetPath = "";
    };
  }

  if (btnBrowseMove) {
    btnBrowseMove.onclick = async () => {
      const res = await window.lampas.gameDirectory.browse(
        currentConfig?.gameDir,
      );
      if (!res.canceled && res.filePaths?.[0]) {
        if (moveInput) moveInput.value = res.filePaths[0];
        pendingMoveTargetPath = res.filePaths[0];
        if (moveTargetPath) moveTargetPath.innerText = res.filePaths[0];
      }
    };
  }

  if (btnConfirmMove) {
    btnConfirmMove.onclick = async () => {
      const targetPath =
        pendingMoveTargetPath || moveInput?.value?.trim() || "";
      if (!targetPath) return;

      // Validation
      const valRes = await window.lampas.gameDirectory.validate(
        targetPath,
        currentConfig?.gameDir,
      );
      if (!valRes.valid) {
        if (moveError) {
          moveError.innerText = valRes.reason || "Choose a different folder.";
          moveError.classList.remove("hidden");
        }
        showToast(valRes.reason || "Choose a different folder.", "error");
        return;
      }

      if (moveModalConfirmView) moveModalConfirmView.classList.add("hidden");
      if (moveModalProgressView)
        moveModalProgressView.classList.remove("hidden");

      if (moveProgressPhase) moveProgressPhase.innerText = "Getting ready…";
      if (moveProgressDetails)
        moveProgressDetails.innerText = "Counting files…";
      if (moveProgressPercent) moveProgressPercent.innerText = "0%";
      if (moveProgressFill) moveProgressFill.style.width = "0%";
      if (moveProgressFile) moveProgressFile.innerText = "";

      const unsub = window.lampas.gameDirectory.onMoveProgress(
        (prog: DirectoryMoveProgress) => {
          if (moveProgressPhase) {
            const phaseLabels: Record<string, string> = {
              preparing: "Getting ready…",
              moving: "Copying files…",
              verifying: "Checking the copy…",
              cleaning: "Removing the old folder…",
              complete: "Done.",
            };
            moveProgressPhase.innerText = phaseLabels[prog.phase] || prog.phase;
          }
          if (moveProgressDetails) {
            moveProgressDetails.innerText = `${prog.filesCompleted} / ${prog.totalFiles} files (${formatBytes(prog.bytesCompleted)} / ${formatBytes(prog.totalBytes)})`;
          }
          if (moveProgressPercent)
            moveProgressPercent.innerText = `${prog.percent}%`;
          if (moveProgressFill)
            moveProgressFill.style.width = `${prog.percent}%`;
          if (moveProgressFile)
            moveProgressFile.innerText = prog.currentFile || "";
        },
      );
      disposers.push(unsub);

      try {
        const moveRes = await window.lampas.gameDirectory.move(targetPath);
        unsub();
        if (modalMoveDir) modalMoveDir.classList.add("hidden");
        if (moveModalProgressView)
          moveModalProgressView.classList.add("hidden");
        pendingMoveTargetPath = "";

        if (moveRes.success) {
          updateGameDirUI(moveRes.gameDir);
          showToast(`Game folder moved to ${moveRes.gameDir}.`, "success");
          const freshConfig = await window.lampas.config.get();
          currentConfig = freshConfig;
          onConfigChanged(freshConfig);
        } else if (!isUserCancelled(moveRes.error)) {
          showToast(
            `Couldn't move the game folder: ${formatFriendlyError(moveRes.error)}`,
            "error",
            6000,
          );
        }
      } catch (err: any) {
        unsub();
        if (modalMoveDir) modalMoveDir.classList.add("hidden");
        if (moveModalProgressView)
          moveModalProgressView.classList.add("hidden");
        pendingMoveTargetPath = "";
        if (isUserCancelled(err)) return;
        showToast(
          `Couldn't move the game folder: ${formatFriendlyError(err)}`,
          "error",
          6000,
        );
      }
    };
  }

  // Save Settings Inputs
  if (settingPortal) {
    settingPortal.onchange = async () => {
      try {
        const updated = await window.lampas.config.set({
          portalUrl: settingPortal.value.trim(),
        });
        currentConfig = updated;
        onConfigChanged(updated);
        flashSaved();
      } catch (err: any) {
        showToast(
          `Couldn't save the address: ${formatFriendlyError(err)}`,
          "error",
        );
      }
    };
  }

  if (settingJavaArgs) {
    settingJavaArgs.onchange = async () => {
      try {
        const updated = await window.lampas.config.set({
          javaArgs: settingJavaArgs.value.trim(),
        });
        currentConfig = updated;
        onConfigChanged(updated);
        flashSaved();
      } catch (err: any) {
        if (isUserCancelled(err)) {
          settingJavaArgs.value = currentConfig?.javaArgs || "";
          return;
        }
        showToast(
          `Couldn't save Java arguments: ${formatFriendlyError(err)}`,
          "error",
        );
      }
    };
  }

  const btnRemoveGameFiles = document.getElementById(
    "btn-remove-game-files",
  ) as HTMLButtonElement | null;
  if (btnRemoveGameFiles) {
    btnRemoveGameFiles.onclick = async () => {
      if (!window.lampas?.gameDirectory?.removeFiles) return;
      const label = btnRemoveGameFiles.textContent;
      btnRemoveGameFiles.disabled = true;
      btnRemoveGameFiles.textContent = "Checking…";
      try {
        // Main measures the folder and asks for confirmation in a system dialog.
        const res = await window.lampas.gameDirectory.removeFiles();
        if (res.cancelled) return;
        if (res.settingsReset) {
          // Signed out with default settings: restart the renderer into
          // first-run setup, and show the outcome once it has loaded.
          queueToastAfterReload(
            res.signOutWarning
              ? `Game files removed and settings reset, but the saved sign-in couldn't be deleted (${res.signOutWarning}).`
              : `Removed ${formatBytes(res.freedBytes)} of game files and reset launcher settings.`,
            res.signOutWarning ? "error" : "success",
          );
          window.location.reload();
          return;
        }
        window.dispatchEvent(new Event("lampas:game-files-removed"));
        // Main may have cleared local mods and turned off No Sync.
        const freshConfig = await window.lampas.config.get();
        currentConfig = freshConfig;
        onConfigChanged(freshConfig);
        updateNoSyncUI(freshConfig.noSync);
        if (res.failedEntries.length > 0) {
          const skipped = res.settingsResetSkipped
            ? " Settings weren't reset."
            : "";
          showToast(
            `Some game files couldn't be removed (${res.failedEntries.join(", ")}). Close Minecraft or anything else using them and try again.${skipped}`,
            "error",
            8000,
          );
        } else {
          const leftover =
            res.leftoverEntries > 0
              ? ` ${res.leftoverEntries} other item${res.leftoverEntries === 1 ? " was" : "s were"} left in the folder.`
              : "";
          const noSync = res.noSyncTurnedOff
            ? " Pack updates are back on so Play can download the game."
            : "";
          showToast(
            `Removed ${formatBytes(res.freedBytes)} of game files.${leftover}${noSync}`,
            "success",
            6000,
          );
        }
      } catch (err: any) {
        showToast(formatFriendlyError(err), "error", 6000);
      } finally {
        btnRemoveGameFiles.disabled = false;
        btnRemoveGameFiles.textContent = label;
      }
    };
  }

  if (btnRepairSettings) {
    btnRepairSettings.onclick = async () => {
      if (switchToTab) {
        switchToTab("tab-console");
      } else {
        const navConsole = document.getElementById("nav-console");
        if (navConsole) navConsole.click();
      }

      if (!window.lampas?.sync?.repair) return;
      try {
        btnRepairSettings.disabled = true;
        showToast("Checking game files…", "info");
        const res = await window.lampas.sync.repair();
        const aboutPackVersion = document.getElementById("about-pack-version");
        if (res?.version && aboutPackVersion)
          aboutPackVersion.innerText = res.version;
        const completionMsg =
          res?.message ||
          "Repair finished. Missing or damaged files were replaced.";
        showToast(completionMsg, "success", 4500);
      } catch (err: any) {
        showToast(
          `Couldn't repair game files: ${formatFriendlyError(err)}`,
          "error",
          6000,
        );
      } finally {
        btnRepairSettings.disabled = false;
      }
    };
  }

  return {
    initSettings,
    checkInitialGameDir,
    dispose: () => {
      if (savedTimer) clearTimeout(savedTimer);
      disposers.forEach((d) => d());
    },
  };
}
