import type {
  DirectoryStatus,
  DirectoryMoveProgress,
  RendererSettingsDto,
} from "../types";

export interface SettingsViewOptions {
  showToast: (message: string, type: "info" | "success" | "error", duration?: number) => void;
  onConfigChanged: (config: RendererSettingsDto) => void;
}

export function initSettingsView(options: SettingsViewOptions): {
  initSettings: (config: RendererSettingsDto) => Promise<void>;
  checkInitialGameDir: (status: DirectoryStatus) => Promise<void>;
  dispose: () => void;
} {
  const { showToast, onConfigChanged } = options;

  const ramSlider = document.getElementById("ram-slider") as HTMLInputElement | null;
  const ramDisplay = document.getElementById("ram-display") as HTMLElement | null;
  const settingRamVal = document.getElementById("setting-ram-val") as HTMLElement | null;
  const gamedirDisplay = document.getElementById("gamedir-display") as HTMLElement | null;
  const settingGamedir = document.getElementById("setting-gamedir") as HTMLElement | null;
  const btnOpenGamedir = document.getElementById("btn-open-gamedir") as HTMLButtonElement | null;
  const btnMoveGamedir = document.getElementById("btn-move-gamedir") as HTMLButtonElement | null;
  const settingPortal = document.getElementById("setting-portal") as HTMLInputElement | null;
  const settingJavaArgs = document.getElementById("setting-java-args") as HTMLInputElement | null;
  const channelBtns = document.querySelectorAll<HTMLButtonElement>(".channel-btn");
  const titlebarChannelBadge = document.getElementById("titlebar-channel-badge") as HTMLElement | null;
  const btnToggleNosync = document.getElementById("btn-toggle-nosync") as HTMLButtonElement | null;
  const titlebarNoSyncBadge = document.getElementById("titlebar-nosync-badge") as HTMLElement | null;

  // Move Modal Elements
  const moveModal = document.getElementById("move-modal") as HTMLElement | null;
  const moveInput = document.getElementById("move-dir-input") as HTMLInputElement | null;
  const btnBrowseMove = document.getElementById("btn-browse-move") as HTMLButtonElement | null;
  const btnConfirmMove = document.getElementById("btn-confirm-move") as HTMLButtonElement | null;
  const btnCancelMove = document.getElementById("btn-cancel-move") as HTMLButtonElement | null;
  const moveError = document.getElementById("move-error") as HTMLElement | null;
  const moveProgressContainer = document.getElementById("move-progress-modal") as HTMLElement | null;
  const moveProgressPhase = document.getElementById("move-progress-phase") as HTMLElement | null;
  const moveProgressDetails = document.getElementById("move-progress-details") as HTMLElement | null;
  const moveProgressPercent = document.getElementById("move-progress-percent") as HTMLElement | null;
  const moveProgressFill = document.getElementById("move-progress-fill") as HTMLElement | null;
  const moveProgressFile = document.getElementById("move-progress-file") as HTMLElement | null;

  // Onboarding Modal Elements
  const dirModal = document.getElementById("dir-onboarding-modal") as HTMLElement | null;
  const dirInput = document.getElementById("dir-input") as HTMLInputElement | null;
  const dirError = document.getElementById("dir-error") as HTMLElement | null;
  const btnAcceptDefault = document.getElementById("btn-accept-default-dir") as HTMLButtonElement | null;
  const btnConfirmDir = document.getElementById("btn-confirm-dir") as HTMLButtonElement | null;
  const btnBrowseDir = document.getElementById("btn-browse-dir") as HTMLButtonElement | null;

  let currentConfig: RendererSettingsDto | null = null;
  const disposers: Array<() => void> = [];

  function updateGameDirUI(dir: string): void {
    if (gamedirDisplay) gamedirDisplay.innerText = dir;
    if (settingGamedir) settingGamedir.innerText = dir;
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
    if (titlebarNoSyncBadge) {
      if (noSync) titlebarNoSyncBadge.classList.remove("hidden");
      else titlebarNoSyncBadge.classList.add("hidden");
    }
    if (btnToggleNosync) {
      const toggle = btnToggleNosync.querySelector(".toggle-dot") as HTMLElement | null;
      if (noSync) {
        btnToggleNosync.classList.add("bg-amber-600");
        btnToggleNosync.classList.remove("bg-slate-700");
        if (toggle) toggle.classList.add("translate-x-4");
      } else {
        btnToggleNosync.classList.remove("bg-amber-600");
        btnToggleNosync.classList.add("bg-slate-700");
        if (toggle) toggle.classList.remove("translate-x-4");
      }
    }
  }

  async function checkInitialGameDir(status: DirectoryStatus): Promise<void> {
    if (!status.isConfigured && dirModal) {
      dirModal.classList.remove("hidden");
      if (dirInput) dirInput.value = status.defaultGameDir;

      if (btnAcceptDefault) {
        btnAcceptDefault.onclick = async () => {
          try {
            const updated = await window.lampas.gameDirectory.configure(status.defaultGameDir);
            dirModal.classList.add("hidden");
            updateGameDirUI(updated.gameDir);
            currentConfig = updated;
            onConfigChanged(updated);
            showToast("Installation directory initialized.", "success");
          } catch (err: any) {
            if (dirError) {
              dirError.innerText = err.message;
              dirError.classList.remove("hidden");
            }
          }
        };
      }

      if (btnBrowseDir) {
        btnBrowseDir.onclick = async () => {
          const res = await window.lampas.gameDirectory.browse(status.defaultGameDir);
          if (!res.canceled && res.filePaths?.[0] && dirInput) {
            dirInput.value = res.filePaths[0];
          }
        };
      }

      if (btnConfirmDir) {
        btnConfirmDir.onclick = async () => {
          const target = dirInput?.value || "";
          try {
            const updated = await window.lampas.gameDirectory.configure(target);
            dirModal.classList.add("hidden");
            updateGameDirUI(updated.gameDir);
            currentConfig = updated;
            onConfigChanged(updated);
            showToast("Installation directory configured.", "success");
          } catch (err: any) {
            if (dirError) {
              dirError.innerText = err.message;
              dirError.classList.remove("hidden");
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
  if (btnToggleNosync) {
    btnToggleNosync.onclick = async () => {
      const nextVal = !currentConfig?.noSync;
      try {
        const updated = await window.lampas.config.set({ noSync: nextVal });
        updateNoSyncUI(nextVal);
        currentConfig = updated;
        onConfigChanged(updated);
        showToast(`No-Sync mode ${nextVal ? "enabled" : "disabled"}`, "info");
      } catch (err: any) {
        showToast(`Failed to toggle No-Sync: ${err.message}`, "error");
      }
    };
  }

  // Open Game Directory in file explorer
  if (btnOpenGamedir) {
    btnOpenGamedir.onclick = async () => {
      if (currentConfig?.gameDir) {
        await window.lampas.utils.openPath(currentConfig.gameDir);
      }
    };
  }

  // Move Game Directory Modal & Operations
  if (btnMoveGamedir && moveModal) {
    btnMoveGamedir.onclick = () => {
      moveModal.classList.remove("hidden");
      if (moveInput && currentConfig?.gameDir) {
        moveInput.value = currentConfig.gameDir;
      }
      if (moveError) moveError.classList.add("hidden");
    };

    if (btnCancelMove) {
      btnCancelMove.onclick = () => {
        moveModal.classList.add("hidden");
      };
    }

    if (btnBrowseMove) {
      btnBrowseMove.onclick = async () => {
        const res = await window.lampas.gameDirectory.browse(currentConfig?.gameDir);
        if (!res.canceled && res.filePaths?.[0] && moveInput) {
          moveInput.value = res.filePaths[0];
        }
      };
    }

    if (btnConfirmMove) {
      btnConfirmMove.onclick = async () => {
        const targetPath = moveInput?.value?.trim() || "";
        if (!targetPath) return;

        // Validation
        const valRes = await window.lampas.gameDirectory.validate(targetPath, currentConfig?.gameDir);
        if (!valRes.valid) {
          if (moveError) {
            moveError.innerText = valRes.reason || "Invalid directory.";
            moveError.classList.remove("hidden");
          }
          return;
        }

        moveModal.classList.add("hidden");
        if (moveProgressContainer) moveProgressContainer.classList.remove("hidden");

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
            const mbDone = (prog.bytesCompleted / (1024 * 1024)).toFixed(1);
            const mbTotal = (prog.totalBytes / (1024 * 1024)).toFixed(1);
            moveProgressDetails.innerText = `${prog.filesCompleted} / ${prog.totalFiles} files (${mbDone} MB / ${mbTotal} MB)`;
          }
          if (moveProgressPercent) moveProgressPercent.innerText = `${prog.percent}%`;
          if (moveProgressFill) moveProgressFill.style.width = `${prog.percent}%`;
          if (moveProgressFile) moveProgressFile.innerText = prog.currentFile || "";
        });
        disposers.push(unsub);

        try {
          const moveRes = await window.lampas.gameDirectory.move(targetPath);
          unsub();
          if (moveProgressContainer) moveProgressContainer.classList.add("hidden");
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
          if (moveProgressContainer) moveProgressContainer.classList.add("hidden");
          showToast(`Relocation error: ${err.message}`, "error", 6000);
        }
      };
    }
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

  return {
    initSettings,
    checkInitialGameDir,
    dispose: () => {
      disposers.forEach((d) => d());
    },
  };
}
