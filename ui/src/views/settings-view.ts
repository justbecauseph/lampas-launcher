import type {
  DirectoryStatus,
  DirectoryMoveProgress,
  RendererSettingsDto,
} from "../types";

export interface SettingsViewOptions {
  showToast: (message: string, type: "info" | "success" | "error", duration?: number) => void;
  onConfigChanged: (config: RendererSettingsDto) => void;
  switchToTab?: (tabId: string) => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || isNaN(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function initSettingsView(options: SettingsViewOptions): {
  initSettings: (config: RendererSettingsDto) => Promise<void>;
  checkInitialGameDir: (status: DirectoryStatus) => Promise<void>;
  dispose: () => void;
} {
  const { showToast, onConfigChanged, switchToTab } = options;

  const ramSlider = document.getElementById("ram-slider") as HTMLInputElement | null;
  const ramDisplay = document.getElementById("ram-display") as HTMLElement | null;
  const settingRamVal = document.getElementById("setting-ram-val") as HTMLElement | null;
  const gamedirDisplay = document.getElementById("gamedir-display") as HTMLElement | null;
  const settingGamedirInput = (document.getElementById("setting-gamedir-input") || document.getElementById("setting-gamedir")) as HTMLInputElement | null;
  const btnSettingsOpenDir = (document.getElementById("btn-settings-open-dir") || document.getElementById("btn-open-gamedir")) as HTMLButtonElement | null;
  const btnSettingsMoveDir = (document.getElementById("btn-settings-move-dir") || document.getElementById("btn-move-gamedir")) as HTMLButtonElement | null;
  const btnRepairSettings = document.getElementById("btn-repair-settings") as HTMLButtonElement | null;
  const btnSaveSettings = document.getElementById("btn-save-settings") as HTMLButtonElement | null;
  const settingPortal = document.getElementById("setting-portal") as HTMLInputElement | null;
  const settingJavaArgs = (document.getElementById("setting-java-args") || document.getElementById("setting-javaargs")) as HTMLInputElement | HTMLTextAreaElement | null;
  const settingNoSync = (document.getElementById("setting-nosync") || document.getElementById("btn-toggle-nosync")) as HTMLInputElement | HTMLButtonElement | null;
  const channelBtns = document.querySelectorAll<HTMLButtonElement>(".channel-btn");
  const titlebarChannelBadge = document.getElementById("titlebar-channel-badge") as HTMLElement | null;
  const titlebarNoSyncBadge = document.getElementById("titlebar-nosync-badge") as HTMLElement | null;

  // Move Modal Elements
  const modalMoveDir = (document.getElementById("modal-move-dir") || document.getElementById("move-modal")) as HTMLElement | null;
  const moveModalConfirmView = document.getElementById("move-modal-confirm-view") as HTMLElement | null;
  const moveModalProgressView = (document.getElementById("move-modal-progress-view") || document.getElementById("move-progress-modal")) as HTMLElement | null;
  const moveSourcePath = document.getElementById("move-source-path") as HTMLElement | null;
  const moveTargetPath = document.getElementById("move-target-path") as HTMLElement | null;
  const btnCancelMove = document.getElementById("btn-cancel-move") as HTMLButtonElement | null;
  const btnConfirmMove = document.getElementById("btn-confirm-move") as HTMLButtonElement | null;
  const moveInput = document.getElementById("move-dir-input") as HTMLInputElement | null;
  const moveError = document.getElementById("move-error") as HTMLElement | null;
  const btnBrowseMove = document.getElementById("btn-browse-move") as HTMLButtonElement | null;

  const moveProgressPhase = document.getElementById("move-progress-phase") as HTMLElement | null;
  const moveProgressDetails = document.getElementById("move-progress-details") as HTMLElement | null;
  const moveProgressPercent = document.getElementById("move-progress-percent") as HTMLElement | null;
  const moveProgressFill = document.getElementById("move-progress-fill") as HTMLElement | null;
  const moveProgressFile = document.getElementById("move-progress-file") as HTMLElement | null;

  // Onboarding Modal Elements
  const modalInitialDir = (document.getElementById("modal-initial-dir") || document.getElementById("dir-onboarding-modal")) as HTMLElement | null;
  const initialGamedirInput = (document.getElementById("initial-gamedir-input") || document.getElementById("dir-input")) as HTMLInputElement | null;
  const initialDirError = (document.getElementById("initial-dir-error") || document.getElementById("dir-error")) as HTMLElement | null;
  const btnInitialBrowse = (document.getElementById("btn-initial-browse") || document.getElementById("btn-browse-dir")) as HTMLButtonElement | null;
  const btnInitialConfirm = (document.getElementById("btn-initial-confirm") || document.getElementById("btn-confirm-dir")) as HTMLButtonElement | null;
  const btnAcceptDefault = document.getElementById("btn-accept-default-dir") as HTMLButtonElement | null;

  let currentConfig: RendererSettingsDto | null = null;
  let pendingMoveTargetPath = "";
  const disposers: Array<() => void> = [];

  function updateGameDirUI(dir: string): void {
    if (gamedirDisplay) gamedirDisplay.innerText = dir;
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
      titlebarChannelBadge.innerText = channel.toUpperCase();
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
        const toggle = settingNoSync.querySelector(".toggle-dot") as HTMLElement | null;
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
    if (!status.isConfigured && modalInitialDir) {
      modalInitialDir.classList.remove("hidden");
      if (initialGamedirInput) initialGamedirInput.value = status.defaultGameDir;

      if (btnAcceptDefault) {
        btnAcceptDefault.onclick = async () => {
          try {
            const updated = await window.lampas.gameDirectory.configure(status.defaultGameDir);
            modalInitialDir.classList.add("hidden");
            updateGameDirUI(updated.gameDir);
            currentConfig = updated;
            onConfigChanged(updated);
            showToast("Installation directory initialized.", "success");
          } catch (err: any) {
            if (initialDirError) {
              initialDirError.innerText = err.message;
              initialDirError.classList.remove("hidden");
            }
          }
        };
      }

      if (btnInitialBrowse) {
        btnInitialBrowse.onclick = async () => {
          const res = await window.lampas.gameDirectory.browse(status.defaultGameDir);
          if (!res.canceled && res.filePaths?.[0] && initialGamedirInput) {
            initialGamedirInput.value = res.filePaths[0];
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
                  initialDirError.innerText = val.reason || "Invalid directory path";
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
            showToast("Installation directory configured.", "success");
          } catch (err: any) {
            if (initialDirError) {
              initialDirError.innerText = err.message;
              initialDirError.classList.remove("hidden");
            }
          }
        };
      }
    }
  }

  async function initSettings(config: RendererSettingsDto): Promise<void> {
    currentConfig = config;

    const ram = config.allocatedRamGb || 4;
    if (ramSlider) ramSlider.value = String(ram);
    if (ramDisplay) ramDisplay.innerText = `${ram} GB RAM`;
    if (settingRamVal) settingRamVal.innerText = `${ram} GB`;

    updateGameDirUI(config.gameDir || ".minecraft-lampas");
    if (settingPortal) settingPortal.value = config.portalUrl || "https://dev.lampas.town";
    if (settingJavaArgs) settingJavaArgs.value = config.javaArgs || "";

    updateNoSyncUI(config.noSync);
    applyChannel(config.selectedChannel || "stable");
  }

  // RAM Slider change
  if (ramSlider) {
    ramSlider.addEventListener("input", async () => {
      const val = parseInt(ramSlider.value, 10);
      if (ramDisplay) ramDisplay.innerText = `${val} GB RAM`;
      if (settingRamVal) settingRamVal.innerText = `${val} GB`;
      try {
        const updated = await window.lampas.config.set({ allocatedRamGb: val });
        currentConfig = updated;
        onConfigChanged(updated);
      } catch (err: any) {
        showToast(`Failed to update RAM: ${err.message}`, "error");
      }
    });
  }

  // Channel Buttons
  channelBtns.forEach((btn) => {
    btn.onclick = async () => {
      const channel = btn.dataset.channel as "stable" | "beta" | "dev";
      try {
        const updated = await window.lampas.config.set({ selectedChannel: channel });
        applyChannel(channel);
        currentConfig = updated;
        onConfigChanged(updated);
        showToast(`Channel switched to ${channel.toUpperCase()}`, "info");
      } catch (err: any) {
        showToast(`Failed to switch channel: ${err.message}`, "error");
      }
    };
  });

  // NoSync Toggle
  if (settingNoSync) {
    const handleNoSyncToggle = async () => {
      const nextVal = "checked" in settingNoSync ? settingNoSync.checked : !currentConfig?.noSync;
      try {
        const updated = await window.lampas.config.set({ noSync: nextVal });
        updateNoSyncUI(nextVal);
        currentConfig = updated;
        onConfigChanged(updated);
        showToast(`No-Sync mode ${nextVal ? "enabled" : "disabled"}`, "info");
      } catch (err: any) {
        showToast(`Failed to toggle No-Sync: ${err.message}`, "error");
        updateNoSyncUI(currentConfig?.noSync);
      }
    };

    if ("checked" in settingNoSync) {
      settingNoSync.onchange = handleNoSyncToggle;
    } else {
      settingNoSync.onclick = handleNoSyncToggle;
    }
  }

  // Open Game Directory in file explorer
  if (btnSettingsOpenDir) {
    btnSettingsOpenDir.onclick = async () => {
      if (currentConfig?.gameDir && window.lampas?.utils?.openPath) {
        await window.lampas.utils.openPath(currentConfig.gameDir);
      }
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
        const browseRes = await window.lampas.gameDirectory.browse(currentConfig?.gameDir);
        if (browseRes.canceled || !browseRes.filePaths?.length) {
          return;
        }

        const targetPath = browseRes.filePaths[0];
        const valRes = await window.lampas.gameDirectory.validate(targetPath, currentConfig?.gameDir);
        if (!valRes.valid) {
          showToast(valRes.reason || "Cannot use this location.", "error", 5000);
          return;
        }

        pendingMoveTargetPath = targetPath;
        if (moveSourcePath) moveSourcePath.innerText = currentConfig?.gameDir || "";
        if (moveTargetPath) moveTargetPath.innerText = targetPath;

        if (moveModalConfirmView) moveModalConfirmView.classList.remove("hidden");
        if (moveModalProgressView) moveModalProgressView.classList.add("hidden");
        if (modalMoveDir) modalMoveDir.classList.remove("hidden");
      } catch (err: any) {
        showToast(`Error choosing directory: ${err.message}`, "error");
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
      const res = await window.lampas.gameDirectory.browse(currentConfig?.gameDir);
      if (!res.canceled && res.filePaths?.[0]) {
        if (moveInput) moveInput.value = res.filePaths[0];
        pendingMoveTargetPath = res.filePaths[0];
        if (moveTargetPath) moveTargetPath.innerText = res.filePaths[0];
      }
    };
  }

  if (btnConfirmMove) {
    btnConfirmMove.onclick = async () => {
      const targetPath = pendingMoveTargetPath || moveInput?.value?.trim() || "";
      if (!targetPath) return;

      // Validation
      const valRes = await window.lampas.gameDirectory.validate(targetPath, currentConfig?.gameDir);
      if (!valRes.valid) {
        if (moveError) {
          moveError.innerText = valRes.reason || "Invalid directory.";
          moveError.classList.remove("hidden");
        }
        showToast(valRes.reason || "Invalid directory.", "error");
        return;
      }

      if (moveModalConfirmView) moveModalConfirmView.classList.add("hidden");
      if (moveModalProgressView) moveModalProgressView.classList.remove("hidden");

      if (moveProgressPhase) moveProgressPhase.innerText = "Preparing relocation...";
      if (moveProgressDetails) moveProgressDetails.innerText = "Scanning files...";
      if (moveProgressPercent) moveProgressPercent.innerText = "0%";
      if (moveProgressFill) moveProgressFill.style.width = "0%";
      if (moveProgressFile) moveProgressFile.innerText = "";

      const unsub = window.lampas.gameDirectory.onMoveProgress((prog: DirectoryMoveProgress) => {
        if (moveProgressPhase) {
          const phaseLabels: Record<string, string> = {
            preparing: "Preparing relocation...",
            moving: "Copying files to staging...",
            verifying: "Verifying checksums and counts...",
            cleaning: "Cleaning source directory...",
            complete: "Relocation complete!",
          };
          moveProgressPhase.innerText = phaseLabels[prog.phase] || prog.phase;
        }
        if (moveProgressDetails) {
          moveProgressDetails.innerText = `${prog.filesCompleted} / ${prog.totalFiles} files (${formatBytes(prog.bytesCompleted)} / ${formatBytes(prog.totalBytes)})`;
        }
        if (moveProgressPercent) moveProgressPercent.innerText = `${prog.percent}%`;
        if (moveProgressFill) moveProgressFill.style.width = `${prog.percent}%`;
        if (moveProgressFile) moveProgressFile.innerText = prog.currentFile || "";
      });
      disposers.push(unsub);

      try {
        const moveRes = await window.lampas.gameDirectory.move(targetPath);
        unsub();
        if (modalMoveDir) modalMoveDir.classList.add("hidden");
        if (moveModalProgressView) moveModalProgressView.classList.add("hidden");
        pendingMoveTargetPath = "";

        if (moveRes.success) {
          updateGameDirUI(moveRes.gameDir);
          showToast(`Installation relocated to: ${moveRes.gameDir}`, "success");
          const freshConfig = await window.lampas.config.get();
          currentConfig = freshConfig;
          onConfigChanged(freshConfig);
        } else {
          showToast(`Relocation failed: ${moveRes.error}`, "error");
        }
      } catch (err: any) {
        unsub();
        if (modalMoveDir) modalMoveDir.classList.add("hidden");
        if (moveModalProgressView) moveModalProgressView.classList.add("hidden");
        pendingMoveTargetPath = "";
        showToast(`Relocation error: ${err.message}`, "error", 6000);
      }
    };
  }

  // Save Settings Inputs
  if (settingPortal) {
    settingPortal.onchange = async () => {
      try {
        const updated = await window.lampas.config.set({ portalUrl: settingPortal.value.trim() });
        currentConfig = updated;
        onConfigChanged(updated);
        showToast("Portal URL updated.", "info");
      } catch (err: any) {
        showToast(`Failed to save portal URL: ${err.message}`, "error");
      }
    };
  }

  if (settingJavaArgs) {
    settingJavaArgs.onchange = async () => {
      try {
        const updated = await window.lampas.config.set({ javaArgs: settingJavaArgs.value.trim() });
        currentConfig = updated;
        onConfigChanged(updated);
        showToast("JVM arguments updated.", "info");
      } catch (err: any) {
        showToast(`Invalid JVM arguments: ${err.message}`, "error");
      }
    };
  }

  if (btnSaveSettings) {
    btnSaveSettings.onclick = async () => {
      try {
        const ram = ramSlider ? parseInt(ramSlider.value, 10) : (currentConfig?.allocatedRamGb || 4);
        const portalUrl = settingPortal?.value?.trim() || currentConfig?.portalUrl || "https://dev.lampas.town";
        const javaArgs = settingJavaArgs?.value?.trim() || "";
        const noSync = settingNoSync && "checked" in settingNoSync ? Boolean(settingNoSync.checked) : Boolean(currentConfig?.noSync);

        const updated = await window.lampas.config.set({
          allocatedRamGb: ram,
          portalUrl,
          javaArgs,
          noSync,
        });
        currentConfig = updated;
        onConfigChanged(updated);
        showToast("Settings saved successfully!", "success");
      } catch (err: any) {
        showToast(`Failed to save settings: ${err.message}`, "error");
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
        showToast("Verifying and repairing game files...", "info");
        const res = await window.lampas.sync.repair();
        showToast(res?.message || "Game files verified and repaired.", "success");
      } catch (err: any) {
        showToast(`Repair error: ${err.message}`, "error");
      } finally {
        btnRepairSettings.disabled = false;
      }
    };
  }

  return {
    initSettings,
    checkInitialGameDir,
    dispose: () => {
      disposers.forEach((d) => d());
    },
  };
}
