// Lampas Launcher UI Renderer

let currentUser = null;
let currentConfig = null;
let isLaunching = false;
let logLineCount = 0;

// DOM Elements: Titlebar Controls
const btnMinimize = document.getElementById("btn-minimize");
const btnMaximize = document.getElementById("btn-maximize");
const btnClose = document.getElementById("btn-close");
const titlebarVersionBadge = document.getElementById("titlebar-version-badge");
const titlebarChannelBadge = document.getElementById("titlebar-channel-badge");
const titlebarNoSyncBadge = document.getElementById("titlebar-nosync-badge");
const titlebarGameStatus = document.getElementById("titlebar-game-status");
const titlebarStatusDot = document.getElementById("titlebar-status-dot");
const titlebarStatusText = document.getElementById("titlebar-status-text");

// DOM Elements: Navigation
const navPlay = document.getElementById("nav-play");
const navMods = document.getElementById("nav-mods");
const navConsole = document.getElementById("nav-console");
const navSettings = document.getElementById("nav-settings");

const tabPlay = document.getElementById("tab-play");
const tabMods = document.getElementById("tab-mods");
const tabConsole = document.getElementById("tab-console");
const tabSettings = document.getElementById("tab-settings");

// DOM Elements: User & Auth
const btnLogin = document.getElementById("btn-login");
const btnLogout = document.getElementById("btn-logout");
const userCard = document.getElementById("user-card");
const userName = document.getElementById("user-name");
const userRole = document.getElementById("user-role");
const userAvatar = document.getElementById("user-avatar");

// DOM Elements: Play & Launch Controls
const btnPlay = document.getElementById("btn-play");
const btnPlayText = document.getElementById("btn-play-text");
const btnPlaySpinner = document.getElementById("btn-play-spinner");
const btnStop = document.getElementById("btn-stop");
const playTargetContainer = document.getElementById("play-target-container");
const playTargetServer = document.getElementById("play-target-server");
const progressContainer = document.getElementById("progress-container");
const progressFill = document.getElementById("progress-fill");
const progressMsg = document.getElementById("progress-msg");
const progressPercent = document.getElementById("progress-percent");
const ramDisplay = document.getElementById("ram-display");
const gamedirDisplay = document.getElementById("gamedir-display");
const btnOpenGamedir = document.getElementById("btn-open-gamedir");
const channelBtns = document.querySelectorAll(".channel-btn");

// DOM Elements: Live server presence
const serverPresence = document.getElementById("server-presence");
const serverPresenceDot = document.getElementById("server-presence-dot");
const serverPresenceState = document.getElementById("server-presence-state");
const serverPresenceCount = document.getElementById("server-presence-count");
const serverPresenceDetail = document.getElementById("server-presence-detail");
const serverPresencePlayers = document.getElementById("server-presence-players");
let latestServerStatus = null;
let serverStatusRequest = null;
let serverStatusInterval = null;

function renderServerStatus(status) {
  const view = window.LampasServerStatusView.getServerStatusView(status);
  const state = view.state;

  if (serverPresence) serverPresence.dataset.state = state;
  if (serverPresenceDot) serverPresenceDot.className = `presence-dot presence-dot-${state}`;
  if (serverPresenceState) serverPresenceState.innerText = view.label;
  if (serverPresenceCount) serverPresenceCount.innerText = view.count;
  if (serverPresenceDetail) serverPresenceDetail.innerText = view.detail;

  if (!serverPresencePlayers) return;
  serverPresencePlayers.replaceChildren();
  if (state !== "online" || view.players.length === 0) return;

  view.players.forEach((player) => {
    const card = document.createElement("span");
    card.className = "presence-player";
    const avatar = document.createElement("span");
    avatar.className = "presence-player-avatar";
    avatar.innerText = player.initial;
    avatar.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "presence-player-name";
    name.innerText = player.username;
    card.append(avatar, name);
    serverPresencePlayers.appendChild(card);
  });
  if (view.more > 0) {
    const more = document.createElement("span");
    more.className = "presence-more";
    more.innerText = `+${view.more} others`;
    serverPresencePlayers.appendChild(more);
  }
}

async function refreshServerStatus() {
  if (!window.lampas.server?.getStatus) return null;
  if (!currentUser) {
    latestServerStatus = null;
    renderServerStatus(null);
    return null;
  }
  if (serverStatusRequest) return serverStatusRequest;

  serverStatusRequest = window.lampas.server.getStatus()
    .then((status) => {
      latestServerStatus = status;
      renderServerStatus(status);
      return status;
    })
    .catch((err) => {
      latestServerStatus = null;
      renderServerStatus(null);
      console.warn("Server presence unavailable:", err?.message || err);
      return null;
    })
    .finally(() => {
      serverStatusRequest = null;
    });
  return serverStatusRequest;
}

function startServerStatusPolling() {
  if (serverStatusInterval) clearInterval(serverStatusInterval);
  void refreshServerStatus();
  serverStatusInterval = setInterval(() => {
    if (!document.hidden) void refreshServerStatus();
  }, 15_000);
}

window.addEventListener("focus", () => void refreshServerStatus());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshServerStatus();
});

function updateLaunchTargetUI(release) {
  if (playTargetContainer && playTargetServer) {
    if (release?.launch?.autoConnect && release?.launch?.server) {
      playTargetServer.innerText = release.launch.server;
      playTargetContainer.classList.remove("hidden");
    } else {
      playTargetContainer.classList.add("hidden");
    }
  }
}

const runtimeLoaderType = document.getElementById("runtime-loader-type");
const runtimeLoaderVersion = document.getElementById("runtime-loader-version");
const runtimeMinecraftVersion = document.getElementById("runtime-minecraft-version");

function updateRuntimeSpecsUI(runtime) {
  if (!runtime) return;
  const loader = runtime.loader;
  if (loader?.version && runtimeLoaderVersion) {
    runtimeLoaderVersion.innerText = loader.version;
  }
  if (loader?.type && runtimeLoaderType) {
    runtimeLoaderType.innerText = `${loader.type === "fabric" ? "Fabric" : loader.type} Loader`;
  }
  if (runtime.minecraft && runtimeMinecraftVersion) {
    runtimeMinecraftVersion.innerText = runtime.minecraft;
  }
}

// DOM Elements: Modpack Info Tab
const modsPackVersion = document.getElementById("mods-pack-version");
const modsChannelBadge = document.getElementById("mods-channel-badge");
const btnRepairPack = document.getElementById("btn-repair-pack");
const btnVerifyPack = document.getElementById("btn-verify-pack");
const btnModsOpenDir = document.getElementById("btn-mods-open-dir");
const btnAddMods = document.getElementById("btn-add-mods");
const modDropZone = document.getElementById("mod-drop-zone");

// DOM Elements: Console Tab
const consoleOutput = document.getElementById("console-output");
const consoleCount = document.getElementById("console-count");
const consoleAutoscroll = document.getElementById("console-autoscroll");
const btnOpenLogFile = document.getElementById("btn-open-log-file");
const btnCopyLogs = document.getElementById("btn-copy-logs");
const btnClearLogs = document.getElementById("btn-clear-logs");
const consoleGameStatus = document.getElementById("console-game-status");
const consoleStatusDot = document.getElementById("console-status-dot");
const consoleStatusText = document.getElementById("console-status-text");
const btnConsoleStop = document.getElementById("btn-console-stop");

function setConsoleStatus(status, textOverride) {
  // Update Console Indicator
  if (consoleGameStatus && consoleStatusDot && consoleStatusText) {
    if (status === "running") {
      consoleStatusDot.className = "status-dot status-dot-running";
      consoleStatusText.innerText = textOverride || "GAME RUNNING";
      consoleGameStatus.className = "badge flex items-center gap-1.5 text-emerald-400 border-emerald-500/40 bg-emerald-950/50";
      if (btnConsoleStop) btnConsoleStop.classList.remove("hidden");
    } else if (status === "syncing" || status === "launching" || status === "repairing") {
      consoleStatusDot.className = "status-dot status-dot-launching";
      consoleStatusText.innerText = textOverride || (status === "syncing" ? "SYNCING..." : status === "repairing" ? "REPAIRING..." : "LAUNCHING...");
      consoleGameStatus.className = "badge flex items-center gap-1.5 text-amber-400 border-amber-500/40 bg-amber-950/50";
      if (btnConsoleStop) btnConsoleStop.classList.remove("hidden");
    } else {
      consoleStatusDot.className = "status-dot status-dot-idle";
      consoleStatusText.innerText = textOverride || "IDLE";
      consoleGameStatus.className = "badge flex items-center gap-1.5 text-slate-400";
      if (btnConsoleStop) btnConsoleStop.classList.add("hidden");
    }
  }

  // Update Titlebar Indicator
  if (titlebarGameStatus && titlebarStatusDot && titlebarStatusText) {
    if (status === "running") {
      titlebarStatusDot.className = "status-dot status-dot-running";
      titlebarStatusText.innerText = textOverride || "RUNNING";
      titlebarGameStatus.className = "badge flex items-center gap-1.5 text-emerald-400 border-emerald-500/40 bg-emerald-950/50";
    } else if (status === "syncing" || status === "launching" || status === "repairing") {
      titlebarStatusDot.className = "status-dot status-dot-launching";
      titlebarStatusText.innerText = textOverride || (status === "syncing" ? "SYNCING" : status === "repairing" ? "REPAIRING" : "LAUNCHING");
      titlebarGameStatus.className = "badge flex items-center gap-1.5 text-amber-400 border-amber-500/40 bg-amber-950/50";
    } else {
      titlebarStatusDot.className = "status-dot status-dot-idle";
      titlebarStatusText.innerText = textOverride || "IDLE";
      titlebarGameStatus.className = "badge flex items-center gap-1.5 text-slate-400";
    }
  }
}

// DOM Elements: Settings Tab
const ramSlider = document.getElementById("ram-slider");
const settingRamVal = document.getElementById("setting-ram-val");
const settingGamedirInput = document.getElementById("setting-gamedir-input");
const btnSettingsOpenDir = document.getElementById("btn-settings-open-dir");
const btnSettingsMoveDir = document.getElementById("btn-settings-move-dir");
const settingPortal = document.getElementById("setting-portal");
const settingNoSync = document.getElementById("setting-nosync");
const settingJavaArgs = document.getElementById("setting-java-args");
const btnRepairSettings = document.getElementById("btn-repair-settings");
const btnSaveSettings = document.getElementById("btn-save-settings");

function updateNoSyncUI(noSync) {
  const isNoSync = Boolean(noSync);
  if (settingNoSync) settingNoSync.checked = isNoSync;
  if (titlebarNoSyncBadge) titlebarNoSyncBadge.classList.toggle("hidden", !isNoSync);
}

// DOM Elements: Initial Directory Setup Modal
const modalInitialDir = document.getElementById("modal-initial-dir");
const initialGamedirInput = document.getElementById("initial-gamedir-input");
const btnInitialBrowse = document.getElementById("btn-initial-browse");
const btnInitialConfirm = document.getElementById("btn-initial-confirm");
const initialDirError = document.getElementById("initial-dir-error");

// DOM Elements: Move Installation Modal
const modalMoveDir = document.getElementById("modal-move-dir");
const moveModalConfirmView = document.getElementById("move-modal-confirm-view");
const moveModalProgressView = document.getElementById("move-modal-progress-view");
const moveSourcePath = document.getElementById("move-source-path");
const moveTargetPath = document.getElementById("move-target-path");
const btnCancelMove = document.getElementById("btn-cancel-move");
const btnConfirmMove = document.getElementById("btn-confirm-move");
const moveProgressPhase = document.getElementById("move-progress-phase");
const moveProgressDetails = document.getElementById("move-progress-details");
const moveProgressPercent = document.getElementById("move-progress-percent");
const moveProgressFill = document.getElementById("move-progress-fill");
const moveProgressFile = document.getElementById("move-progress-file");

// DOM Elements: Toast Container
const toastContainer = document.getElementById("toast-container");

// ========================================================
// Toast Notification Utility
// ========================================================
function showToast(message, type = "info", duration = 3500) {
  if (!toastContainer) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  let iconSvg = "";
  if (type === "success") {
    iconSvg = `<svg class="w-4 h-4 toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
  } else if (type === "error") {
    iconSvg = `<svg class="w-4 h-4 toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;
  } else {
    iconSvg = `<svg class="w-4 h-4 toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
  }

  toast.innerHTML = `
    ${iconSvg}
    <span class="truncate">${message}</span>
  `;

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// ========================================================
// Window Titlebar Controls
// ========================================================
if (btnMinimize) {
  btnMinimize.onclick = () => window.lampas.window.minimize();
}

if (btnMaximize) {
  btnMaximize.onclick = async () => {
    await window.lampas.window.maximize();
  };
}

if (btnClose) {
  btnClose.onclick = () => window.lampas.window.close();
}

// ========================================================
// Navigation Tabs
// ========================================================
function switchTab(activeNav, activeTab) {
  window.scrollTo(0, 0);
  [navPlay, navMods, navConsole, navSettings].forEach((n) => n?.classList.remove("active"));
  [tabPlay, tabMods, tabConsole, tabSettings].forEach((t) => t?.classList.add("hidden"));

  activeNav?.classList.add("active");
  activeTab?.classList.remove("hidden");
}

if (navPlay) navPlay.onclick = () => switchTab(navPlay, tabPlay);
if (navMods) navMods.onclick = () => switchTab(navMods, tabMods);
if (navConsole) navConsole.onclick = () => switchTab(navConsole, tabConsole);
if (navSettings) navSettings.onclick = () => switchTab(navSettings, tabSettings);

// ========================================================
// RAM Slider & Real-Time Sync
// ========================================================
if (ramSlider) {
  ramSlider.oninput = (e) => {
    const val = e.target.value;
    if (ramDisplay) ramDisplay.innerText = `${val} GB RAM`;
    if (settingRamVal) settingRamVal.innerText = `${val} GB`;
  };
}

// ========================================================
// Console Logging
// ========================================================
function appendLog(level, message, timestamp) {
  if (!consoleOutput) return;

  const line = document.createElement("div");
  const lvl = (level || "INFO").toUpperCase();
  const time = timestamp || new Date().toLocaleTimeString();

  line.className = `console-line console-line-${lvl.toLowerCase()}`;
  line.innerText = `[${time}] [${lvl}] ${message}`;

  consoleOutput.appendChild(line);
  logLineCount++;

  if (consoleCount) {
    consoleCount.innerText = `${logLineCount} line${logLineCount === 1 ? "" : "s"}`;
  }

  if (consoleAutoscroll && consoleAutoscroll.checked) {
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }
}

if (btnClearLogs) {
  btnClearLogs.onclick = () => {
    if (consoleOutput) {
      consoleOutput.innerHTML = "";
      logLineCount = 0;
      if (consoleCount) consoleCount.innerText = "0 lines";
      showToast("Console cleared", "info", 1500);
    }
  };
}

if (btnOpenLogFile) {
  btnOpenLogFile.onclick = async () => {
    try {
      if (window.lampas.utils?.openLogFile) {
        await window.lampas.utils.openLogFile();
      } else if (window.lampas.utils?.getLogPath) {
        const logPath = await window.lampas.utils.getLogPath();
        await window.lampas.utils.openPath(logPath);
      }
      showToast("Opening launcher.log...", "info", 2000);
    } catch (err) {
      showToast(`Failed to open log file: ${err.message}`, "error", 3000);
    }
  };
}

if (btnCopyLogs) {
  btnCopyLogs.onclick = async () => {
    if (!consoleOutput) return;
    try {
      const text = consoleOutput.innerText;
      await navigator.clipboard.writeText(text);
      showToast("Logs copied to clipboard!", "success", 2000);
    } catch {
      showToast("Failed to copy logs", "error", 2000);
    }
  };
}

// Subscribe to Game Logs
window.lampas.game.onLog((entry) => {
  appendLog(entry.level, entry.message, entry.timestamp);
});

// Subscribe to Game Exit
window.lampas.game.onExit((code) => {
  isLaunching = false;
  setConsoleStatus("idle", "IDLE");
  if (btnPlay) {
    btnPlay.disabled = false;
  }
  if (btnPlayText) btnPlayText.innerText = currentUser ? "PLAY" : "LOG IN TO PLAY";
  if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
  if (btnStop) btnStop.classList.add("hidden");
  if (progressContainer) progressContainer.classList.add("hidden");

  appendLog(code === 0 ? "INFO" : "ERROR", `Game process terminated (exit code: ${code})`);

  if (code !== 0 && code !== null) {
    showToast(`Minecraft exited with code ${code}. Check Console tab for logs.`, "error", 5000);
  } else {
    showToast("Minecraft session ended.", "info", 2500);
  }
  void refreshServerStatus();
});

// ========================================================
// Auth & Profile Management
// ========================================================
function updateUserUI(user) {
  if (user && (!user.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000")) {
    currentUser = null;
    showToast("Minecraft account not bound. Please link your Minecraft account on the portal dashboard.", "error", 5000);
    user = null;
  }

  currentUser = user;

  if (user) {
    if (btnLogin) btnLogin.classList.add("hidden");
    if (userCard) userCard.classList.remove("hidden");

    const displayName = user.minecraftUsername || user.name || user.discordTag || "Player";
    if (userName) userName.innerText = displayName;
    if (userRole) {
      userRole.innerText = user.isTech ? "Tech Staff" : user.isAdmin ? "Admin" : "Verified";
    }
    if (userAvatar) {
      const fallbackInitial = displayName[0]?.toUpperCase() || "P";
      const identifier = user.minecraftUuid && user.minecraftUuid !== "00000000-0000-0000-0000-000000000000"
        ? user.minecraftUuid.replace(/-/g, "")
        : (user.minecraftUsername || displayName);

      if (identifier) {
        userAvatar.replaceChildren();
        const img = document.createElement("img");
        img.src = `https://mc-heads.net/avatar/${encodeURIComponent(identifier)}/64`;
        img.alt = `${displayName}'s avatar`;
        img.onerror = () => {
          userAvatar.innerText = fallbackInitial;
        };
        userAvatar.appendChild(img);
      } else {
        userAvatar.innerText = fallbackInitial;
      }
    }

    if (btnPlayText && !isLaunching) {
      btnPlayText.innerText = "PLAY";
    }

    // Channel gating based on user permissions
    const allowed = user.allowedChannels || ["stable"];
    channelBtns.forEach((btn) => {
      const ch = btn.dataset.channel;
      btn.disabled = !allowed.includes(ch);
    });
  } else {
    if (btnLogin) btnLogin.classList.remove("hidden");
    if (userCard) userCard.classList.add("hidden");
    if (userAvatar) {
      userAvatar.replaceChildren();
      userAvatar.innerText = "P";
    }

    if (btnPlayText && !isLaunching) {
      btnPlayText.innerText = "LOG IN TO PLAY";
    }

    channelBtns.forEach((btn) => {
      btn.disabled = btn.dataset.channel !== "stable";
    });

    const activeChannelBtn = document.querySelector(".channel-btn.active");
    if (activeChannelBtn && activeChannelBtn.dataset.channel !== "stable") {
      applyChannel("stable");
    }
  }
}

// Portal OAuth Login
if (btnLogin) {
  btnLogin.onclick = async () => {
    try {
      btnLogin.disabled = true;
      btnLogin.innerHTML = `
        <span class="spinner mr-2"></span>
        <span>Authorizing in browser...</span>
      `;
      showToast("Opening browser for Lampas Portal authentication...", "info", 4000);

      const res = await window.lampas.auth.login(currentConfig?.portalUrl);
      updateUserUI(res.user);
      void refreshServerStatus();
      showToast(`Welcome back, ${res.user.minecraftUsername || res.user.name || "Player"}!`, "success");
    } catch (err) {
      showToast(`Login failed: ${err.message}`, "error", 5000);
    } finally {
      if (btnLogin) {
        btnLogin.disabled = false;
        btnLogin.innerHTML = `
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
          </svg>
          <span>Log In with Portal</span>
        `;
      }
    }
  };
}

if (btnLogout) {
  btnLogout.onclick = async () => {
    try {
      await window.lampas.auth.logout();
      currentConfig = await window.lampas.config.get();
      updateUserUI(null);
      latestServerStatus = null;
      renderServerStatus(null);
      showToast("Logged out successfully.", "info");
    } catch (err) {
      showToast(`Logout failed: ${err.message}`, "error");
    }
  };
}

// ========================================================
// Channel Switching
// ========================================================
function applyChannel(channel) {
  channelBtns.forEach((b) => {
    if (b.dataset.channel === channel) {
      b.classList.add("active");
    } else {
      b.classList.remove("active");
    }
  });

  const upper = (channel || "stable").toUpperCase();
  if (titlebarChannelBadge) titlebarChannelBadge.innerText = upper;
  if (modsChannelBadge) modsChannelBadge.innerText = upper;
}

channelBtns.forEach((btn) => {
  btn.onclick = async () => {
    if (btn.disabled) return;
    const channel = btn.dataset.channel;
    const prevChannel = currentConfig?.selectedChannel;
    applyChannel(channel);
    currentConfig = await window.lampas.config.set({ selectedChannel: channel });
    if (prevChannel !== channel) {
      appendLog("INFO", `[Settings] Selected channel changed to ${channel.toUpperCase()}`);
    }
    showToast(`Switched channel to ${channel.toUpperCase()}`, "info", 2000);
  };
});

// ========================================================
// Directory Opening & Relocation Actions
// ========================================================
let pendingMoveTargetPath = "";

function updateGameDirUI(newGameDir) {
  if (currentConfig) {
    currentConfig.gameDir = newGameDir;
  }
  if (gamedirDisplay) gamedirDisplay.innerText = newGameDir;
  if (settingGamedirInput) settingGamedirInput.value = newGameDir;
}

async function openGameDir() {
  if (currentConfig?.gameDir && window.lampas.utils?.openPath) {
    await window.lampas.utils.openPath(currentConfig.gameDir);
  }
}

if (btnOpenGamedir) btnOpenGamedir.onclick = openGameDir;
if (btnSettingsOpenDir) btnSettingsOpenDir.onclick = openGameDir;
if (btnModsOpenDir) btnModsOpenDir.onclick = openGameDir;

function checkInitialGameDir(dirStatus) {
  return new Promise((resolve) => {
    if (dirStatus.isConfigured) {
      resolve();
      return;
    }

    if (modalInitialDir && initialGamedirInput) {
      initialGamedirInput.value = dirStatus.defaultGameDir || dirStatus.gameDir;
      if (initialDirError) initialDirError.classList.add("hidden");
      modalInitialDir.classList.remove("hidden");

      if (btnInitialBrowse) {
        btnInitialBrowse.onclick = async () => {
          try {
            const res = await window.lampas.gameDirectory.browse(initialGamedirInput.value);
            if (!res.canceled && res.filePaths.length > 0) {
              initialGamedirInput.value = res.filePaths[0];
              if (initialDirError) initialDirError.classList.add("hidden");
            }
          } catch (err) {
            showToast(`Could not select folder: ${err.message}`, "error");
          }
        };
      }

      if (btnInitialConfirm) {
        btnInitialConfirm.onclick = async () => {
          const selected = initialGamedirInput.value.trim();
          try {
            const val = await window.lampas.gameDirectory.validate(selected);
            if (!val.valid) {
              if (initialDirError) {
                initialDirError.innerText = val.reason || "Invalid directory path";
                initialDirError.classList.remove("hidden");
              }
              return;
            }

            btnInitialConfirm.disabled = true;
            currentConfig = await window.lampas.gameDirectory.configure(selected);
            updateGameDirUI(currentConfig.gameDir);
            modalInitialDir.classList.add("hidden");
            showToast("Installation directory configured!", "success", 3000);
            resolve();
          } catch (err) {
            if (initialDirError) {
              initialDirError.innerText = err.message;
              initialDirError.classList.remove("hidden");
            }
          } finally {
            if (btnInitialConfirm) btnInitialConfirm.disabled = false;
          }
        };
      }
    } else {
      resolve();
    }
  });
}

// Settings Move Installation Flow
if (btnSettingsMoveDir) {
  btnSettingsMoveDir.onclick = async () => {
    if (isLaunching) {
      showToast("Cannot move installation while game or sync is in progress.", "warning", 4000);
      return;
    }

    try {
      const browseRes = await window.lampas.gameDirectory.browse(currentConfig?.gameDir);
      if (browseRes.canceled || !browseRes.filePaths?.length) {
        return;
      }

      const targetPath = browseRes.filePaths[0];
      const val = await window.lampas.gameDirectory.validate(targetPath, currentConfig?.gameDir);
      if (!val.valid) {
        showToast(val.reason || "Cannot use this location.", "error", 5000);
        return;
      }

      pendingMoveTargetPath = targetPath;
      if (moveSourcePath) moveSourcePath.innerText = currentConfig?.gameDir || "";
      if (moveTargetPath) moveTargetPath.innerText = targetPath;

      if (moveModalConfirmView) moveModalConfirmView.classList.remove("hidden");
      if (moveModalProgressView) moveModalProgressView.classList.add("hidden");
      if (modalMoveDir) modalMoveDir.classList.remove("hidden");
    } catch (err) {
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

if (btnConfirmMove) {
  btnConfirmMove.onclick = async () => {
    if (!pendingMoveTargetPath) return;

    try {
      isLaunching = true;
      if (btnPlay) btnPlay.disabled = true;
      if (btnRepairPack) btnRepairPack.disabled = true;
      if (btnRepairSettings) btnRepairSettings.disabled = true;

      if (moveModalConfirmView) moveModalConfirmView.classList.add("hidden");
      if (moveModalProgressView) moveModalProgressView.classList.remove("hidden");

      if (moveProgressFill) moveProgressFill.style.width = "0%";
      if (moveProgressPercent) moveProgressPercent.innerText = "0%";
      if (moveProgressPhase) moveProgressPhase.innerText = "Preparing relocation...";
      if (moveProgressDetails) moveProgressDetails.innerText = "Scanning files...";
      if (moveProgressFile) moveProgressFile.innerText = "";

      const removeProgress = window.lampas.gameDirectory.onMoveProgress((progress) => {
        if (moveProgressFill) moveProgressFill.style.width = `${progress.percent}%`;
        if (moveProgressPercent) moveProgressPercent.innerText = `${progress.percent}%`;

        if (progress.phase === "preparing") {
          if (moveProgressPhase) moveProgressPhase.innerText = "Preparing relocation...";
          if (moveProgressDetails) moveProgressDetails.innerText = "Scanning files...";
        } else if (progress.phase === "moving") {
          if (moveProgressPhase) moveProgressPhase.innerText = "Copying files...";
          if (moveProgressDetails) {
            moveProgressDetails.innerText = `${progress.filesCompleted} / ${progress.totalFiles} files (${formatBytes(progress.bytesCompleted)} / ${formatBytes(progress.totalBytes)})`;
          }
          if (moveProgressFile) moveProgressFile.innerText = progress.currentFile || "";
        } else if (progress.phase === "verifying") {
          if (moveProgressPhase) moveProgressPhase.innerText = "Verifying file integrity...";
          if (moveProgressDetails) moveProgressDetails.innerText = `Verifying ${progress.totalFiles} files...`;
          if (moveProgressFile) moveProgressFile.innerText = "";
        } else if (progress.phase === "cleaning") {
          if (moveProgressPhase) moveProgressPhase.innerText = "Cleaning previous location...";
          if (moveProgressDetails) moveProgressDetails.innerText = "Finalizing directory...";
          if (moveProgressFile) moveProgressFile.innerText = "";
        }
      });

      appendLog("INFO", `[Game Directory] Moving installation to ${pendingMoveTargetPath}...`);
      const result = await window.lampas.gameDirectory.move(pendingMoveTargetPath);
      removeProgress();

      updateGameDirUI(result.gameDir);
      if (modalMoveDir) modalMoveDir.classList.add("hidden");
      showToast(`Minecraft installation successfully moved to ${result.gameDir}!`, "success", 5000);
      appendLog("INFO", `[Game Directory] Installation moved from ${result.previousGameDir} to ${result.gameDir}`);

      // Reload mod catalog with new directory
      await loadModCatalog();
    } catch (err) {
      if (modalMoveDir) modalMoveDir.classList.add("hidden");
      showToast(`Move failed: ${err.message}`, "error", 6000);
      appendLog("ERROR", `[Game Directory] Move failed: ${err.message}`);
    } finally {
      isLaunching = false;
      pendingMoveTargetPath = "";
      if (btnPlay) btnPlay.disabled = false;
      if (btnRepairPack) btnRepairPack.disabled = false;
      if (btnRepairSettings) btnRepairSettings.disabled = false;
    }
  };
}

// ========================================================
// Settings Management
// ========================================================
if (settingNoSync) {
  settingNoSync.onchange = async () => {
    try {
      const noSyncVal = Boolean(settingNoSync.checked);
      currentConfig = await window.lampas.config.set({ noSync: noSyncVal });
      updateNoSyncUI(currentConfig?.noSync);
      appendLog("INFO", `[Settings] No-sync mode ${noSyncVal ? "enabled" : "disabled"}`);
      showToast(`No-sync mode ${noSyncVal ? "enabled (sync skipped on launch)" : "disabled"}`, "info", 2500);
    } catch (err) {
      showToast(`Failed to update setting: ${err.message}`, "error");
      if (settingNoSync) settingNoSync.checked = Boolean(currentConfig?.noSync);
    }
  };
}

if (btnSaveSettings) {
  btnSaveSettings.onclick = async () => {
    try {
      const ram = parseInt(ramSlider?.value || "4", 10);
      const portalUrl = settingPortal?.value?.trim() || "https://dev.lampas.town";
      const javaArgs = settingJavaArgs?.value?.trim() || "";
      const noSync = Boolean(settingNoSync?.checked);
      const prev = currentConfig || {};

      currentConfig = await window.lampas.config.set({
        allocatedRamGb: ram,
        portalUrl,
        javaArgs,
        noSync,
      });

      updateNoSyncUI(currentConfig?.noSync);

      if (prev.allocatedRamGb !== ram) {
        appendLog("INFO", `[Settings] RAM allocation updated to ${ram} GB`);
      }
      if (prev.portalUrl !== portalUrl) {
        appendLog("INFO", `[Settings] Portal URL updated to ${portalUrl}`);
      }
      if ((prev.javaArgs || "") !== javaArgs) {
        appendLog("INFO", `[Settings] Java arguments updated: ${javaArgs || "<none>"}`);
      }
      if (Boolean(prev.noSync) !== noSync) {
        appendLog("INFO", `[Settings] No-sync mode ${noSync ? "enabled" : "disabled"}`);
      }

      showToast("Settings saved successfully!", "success");
    } catch (err) {
      showToast(`Failed to save settings: ${err.message}`, "error");
    }
  };
}

// ========================================================
// Installation Repair & Integrity Recovery
// ========================================================
async function handleRepair() {
  if (isLaunching) {
    showToast("Cannot repair while game or launch is in progress.", "info");
    return;
  }

  if (!currentUser) {
    showToast("Authentication required: Please log in with Lampas Portal before repairing files.", "warning", 4000);
    if (btnLogin) btnLogin.click();
    return;
  }

  try {
    isLaunching = true;
    setConsoleStatus("repairing", "REPAIRING...");
    if (btnRepairPack) btnRepairPack.disabled = true;
    if (btnRepairSettings) btnRepairSettings.disabled = true;
    if (btnPlay) btnPlay.disabled = true;

    // Refresh token with portal
    const session = await window.lampas.auth.refresh(currentConfig?.portalUrl);
    if (!session?.valid || !session?.user) {
      updateUserUI(null);
      showToast("Portal session expired. Please log in again.", "warning", 4000);
      if (btnLogin) btnLogin.click();
      return;
    }
    updateUserUI(session.user);

    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressFill) progressFill.style.width = "0%";
    if (progressPercent) progressPercent.innerText = "0%";
    if (progressMsg) progressMsg.innerText = "Initiating full file & asset repair...";

    appendLog("INFO", "[Repair] Starting full installation repair and asset verification...");
    showToast("Repairing installation: validating assets, libraries, and mod files...", "info", 4000);

    const removeListener = window.lampas.sync.onProgress((progress) => {
      if (progressFill) progressFill.style.width = `${progress.percent}%`;
      if (progressPercent) progressPercent.innerText = `${progress.percent}%`;
      if (progressMsg) progressMsg.innerText = progress.message;
    });

    const repairRes = await window.lampas.sync.repair();
    removeListener();

    if (progressFill) progressFill.style.width = "100%";
    if (progressPercent) progressPercent.innerText = "100%";
    if (progressMsg) progressMsg.innerText = "Repair complete!";

    appendLog("INFO", `[Repair] ${repairRes.message || "All components verified and repaired."}`);
    showToast("Repair complete! All assets, libraries, and mods verified.", "success", 4500);
  } catch (err) {
    appendLog("ERROR", `[Repair Error] ${err.message}`);
    showToast(`Repair Error: ${err.message}`, "error", 6000);
  } finally {
    isLaunching = false;
    setConsoleStatus("idle", "IDLE");
    if (btnRepairPack) btnRepairPack.disabled = false;
    if (btnRepairSettings) btnRepairSettings.disabled = false;
    if (btnPlay) btnPlay.disabled = false;
  }
}

if (btnRepairPack) btnRepairPack.onclick = handleRepair;
if (btnRepairSettings) btnRepairSettings.onclick = handleRepair;

// ========================================================
// Force Verify Modpack Button
// ========================================================
if (btnVerifyPack) {
  btnVerifyPack.onclick = async () => {
    if (isLaunching) {
      showToast("Launch is already in progress.", "info");
      return;
    }
    switchTab(navPlay, tabPlay);
    btnPlay.click();
  };
}

// ========================================================
// Game Stop / Kill Button
// ========================================================
async function handleStopGame() {
  try {
    if (btnStop) btnStop.disabled = true;
    if (btnConsoleStop) btnConsoleStop.disabled = true;
    appendLog("WARN", "Termination signal sent to Minecraft process...");
    showToast("Terminating Minecraft process...", "info", 2000);
    await window.lampas.game.kill();
  } catch (err) {
    showToast(`Failed to terminate game: ${err.message}`, "error");
  } finally {
    if (btnStop) btnStop.disabled = false;
    if (btnConsoleStop) btnConsoleStop.disabled = false;
  }
}

if (btnStop) btnStop.onclick = handleStopGame;
if (btnConsoleStop) btnConsoleStop.onclick = handleStopGame;

// ========================================================
// Sync & Play Launch Flow
// ========================================================
if (btnPlay) {
  btnPlay.onclick = async () => {
    if (isLaunching) {
      // If already playing, switch to console
      switchTab(navConsole, tabConsole);
      return;
    }

    // Require authentication before playing
    if (!currentUser) {
      showToast("Authentication required: Please log in with Lampas Portal to play.", "warning", 4000);
      if (btnLogin) {
        btnLogin.click();
      }
      return;
    }

    // Presence is advisory. Warn on a known degraded state, but never make
    // the status request part of the launch critical path.
    if (latestServerStatus?.server.state === "starting") {
      showToast("The server is still starting. Launch will continue.", "warning", 4500);
    } else if (latestServerStatus?.server.state === "offline") {
      showToast("The server appears offline. Launch will continue anyway.", "warning", 4500);
    }
    void refreshServerStatus();

    // Navigate to Console and Logs tab on play
    switchTab(navConsole, tabConsole);

    try {
      isLaunching = true;
      btnPlay.disabled = true;
      setConsoleStatus("syncing", "VERIFYING TOKEN...");
      if (btnPlayText) btnPlayText.innerText = "VERIFYING...";
      if (btnPlaySpinner) btnPlaySpinner.classList.remove("hidden");
      if (btnStop) btnStop.classList.remove("hidden");

      // 1. Refresh & ensure fresh token from Portal
      const session = await window.lampas.auth.refresh(currentConfig?.portalUrl);
      if (!session?.valid || !session?.user) {
        isLaunching = false;
        updateUserUI(null);
        showToast("Portal session expired. Please log in again.", "warning", 5000);
        if (btnLogin) btnLogin.click();
        return;
      }
      updateUserUI(session.user);

      if (currentConfig?.noSync) {
        appendLog("INFO", "No-sync mode enabled: Skipping modpack synchronization.");
        if (progressContainer) progressContainer.classList.add("hidden");

        try {
          const installedRuntime = await window.lampas.sync.getInstalledRuntime();
          if (installedRuntime) {
            updateRuntimeSpecsUI(installedRuntime);
            if (installedRuntime.launch) {
              updateLaunchTargetUI(installedRuntime);
            }
          }
        } catch {}

        if (btnPlayText) btnPlayText.innerText = "LAUNCHING...";
        setConsoleStatus("launching", "STARTING JVM...");
        appendLog("INFO", "Bootstrapping runtime and launching game...");
        showToast("No-sync mode active. Launching game...", "info", 2500);

        await window.lampas.game.launch(currentUser);
      } else {
        if (progressContainer) {
          progressContainer.classList.remove("hidden");
        }
        if (progressFill) progressFill.style.width = "0%";
        if (progressPercent) progressPercent.innerText = "0%";
        if (progressMsg) progressMsg.innerText = "Connecting to pipeline...";

        // Progress listener
        const removeListener = window.lampas.sync.onProgress((progress) => {
          if (progressFill) progressFill.style.width = `${progress.percent}%`;
          if (progressPercent) progressPercent.innerText = `${progress.percent}%`;
          if (progressMsg) progressMsg.innerText = progress.message;

          if (progress.status === "downloading") {
            if (btnPlayText) btnPlayText.innerText = "DOWNLOADING...";
            setConsoleStatus("syncing", "DOWNLOADING...");
          } else if (progress.status === "staging") {
            if (btnPlayText) btnPlayText.innerText = "STAGING...";
            setConsoleStatus("syncing", "STAGING...");
          }
        });

        appendLog("INFO", "Initiating modpack synchronization...");
        const syncResult = await window.lampas.sync.start();
        removeListener();

        updateLaunchTargetUI(syncResult.release);
        updateRuntimeSpecsUI(syncResult.runtime || syncResult.release);

        if (btnPlayText) btnPlayText.innerText = "LAUNCHING...";
        setConsoleStatus("launching", "STARTING JVM...");
        if (progressMsg) progressMsg.innerText = "Starting Minecraft JVM...";
        if (progressFill) progressFill.style.width = "100%";
        if (progressPercent) progressPercent.innerText = "100%";

        const loaderType = syncResult.runtime?.loader?.type || syncResult.release?.loader?.type || "Fabric";
        const loaderName = loaderType === "fabric" ? "Fabric" : loaderType;
        appendLog("INFO", `Pack v${syncResult.version} synchronized. Bootstrapping ${loaderName} runtime...`);
        showToast(`Pack v${syncResult.version} verified. Launching game...`, "info", 2500);

        await window.lampas.game.launch(currentUser, syncResult.release);
      }

      if (btnPlayText) btnPlayText.innerText = "RUNNING";
      setConsoleStatus("running", "GAME RUNNING");
      if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
      if (btnPlay) btnPlay.disabled = false; // allow clicking to switch to console
    } catch (err) {
      isLaunching = false;
      setConsoleStatus("idle", "ERROR");
      if (btnPlay) btnPlay.disabled = false;
      if (btnPlayText) btnPlayText.innerText = currentUser ? "PLAY" : "LOG IN TO PLAY";
      if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
      if (btnStop) btnStop.classList.add("hidden");
      if (progressContainer) progressContainer.classList.add("hidden");

      showToast(`Launch Error: ${err.message}`, "error", 6000);
      appendLog("ERROR", err.message);
    }
  };
}

// ========================================================
// Initialization on App Load
// ========================================================
async function init() {
  try {
    currentConfig = await window.lampas.config.get();

    // Check directory configuration & handle first-run onboarding
    const dirStatus = await window.lampas.gameDirectory.getStatus();
    await checkInitialGameDir(dirStatus);

    // RAM allocation display & controls
    const ram = currentConfig.allocatedRamGb || 4;
    if (ramSlider) ramSlider.value = ram;
    if (ramDisplay) ramDisplay.innerText = `${ram} GB RAM`;
    if (settingRamVal) settingRamVal.innerText = `${ram} GB`;

    // Game Directory display
    updateGameDirUI(currentConfig.gameDir || ".minecraft-lampas");

    // Portal Endpoint
    if (settingPortal) {
      settingPortal.value = currentConfig.portalUrl || "https://dev.lampas.town";
    }
    if (settingJavaArgs) settingJavaArgs.value = currentConfig.javaArgs || "";

    // Launcher version badge
    if (window.lampas.utils?.getAppVersion) {
      try {
        const appVer = await window.lampas.utils.getAppVersion();
        if (appVer && titlebarVersionBadge) {
          titlebarVersionBadge.innerText = `v${appVer}`;
        }
      } catch {}
    }

    // No Sync toggle & UI indicator
    updateNoSyncUI(currentConfig.noSync);

    // Selected Channel
    const selChannel = currentConfig.selectedChannel || "stable";
    applyChannel(selChannel);

    // Verify & refresh session
    try {
      const authCheck = await window.lampas.auth.refresh(currentConfig.portalUrl);
      if (authCheck?.valid && authCheck?.user) {
        updateUserUI(authCheck.user);
      } else {
        updateUserUI(null);
      }
    } catch {
      updateUserUI(null);
    }

    // Load installed runtime specs into Quick Spec cards
    if (window.lampas.sync?.getInstalledRuntime) {
      try {
        const installedRuntime = await window.lampas.sync.getInstalledRuntime();
        if (installedRuntime) {
          updateRuntimeSpecsUI(installedRuntime);
          if (installedRuntime.launch) {
            updateLaunchTargetUI(installedRuntime);
          }
        }
      } catch {}
    }

    // Load rich mod catalog
    await loadModCatalog();
    startServerStatusPolling();
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

// ========================================================
// Mod Explorer & Metadata Catalog
// ========================================================
let allMods = [];
let activeModFilter = "all";
let activeModSearch = "";

const modsGrid = document.getElementById("mods-grid");
const modsSearchInput = document.getElementById("mods-search-input");
const modsFilteredCount = document.getElementById("mods-filtered-count");
const managedModCount = document.getElementById("managed-mod-count");
const optionalModCount = document.getElementById("optional-mod-count");
const localModCount = document.getElementById("local-mod-count");
const modFilterPills = document.querySelectorAll(".mod-filter-pill");

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function renderMods() {
  if (!modsGrid) return;

  const query = (activeModSearch || "").toLowerCase().trim();
  const filter = (activeModFilter || "all").toLowerCase();

  const filtered = allMods.filter((mod) => {
    // Filter check
    if (filter === "client" && mod.side !== "client") return false;
    if (filter === "disabled" && mod.enabled !== false) return false;
    if (filter === "custom" && mod.source !== "custom") return false;
    if (filter === "server" && mod.side !== "server") return false;
    if (filter === "both" && mod.side !== "both") return false;
    if (!["all", "client", "disabled", "custom", "server", "both"].includes(filter)) {
      const cats = (mod.categories || []).map((c) => c.toLowerCase());
      if (!cats.includes(filter)) return false;
    }

    // Search query check
    if (query) {
      const matchName = (mod.name || "").toLowerCase().includes(query);
      const matchId = (mod.id || "").toLowerCase().includes(query);
      const matchDesc = (mod.description || "").toLowerCase().includes(query);
      const matchCats = (mod.categories || []).some((c) => c.toLowerCase().includes(query));
      if (!matchName && !matchId && !matchDesc && !matchCats) return false;
    }

    return true;
  });

  if (modsFilteredCount) {
    modsFilteredCount.innerText = `${filtered.length} of ${allMods.length}`;
  }

  if (filtered.length === 0) {
    modsGrid.innerHTML = `
      <div class="col-span-2 py-12 text-center text-slate-500 text-xs">
        No mods found matching your search and filter criteria.
      </div>
    `;
    return;
  }

  modsGrid.innerHTML = filtered
    .map((mod) => {
      const sideBadge =
        mod.side === "client"
          ? '<span class="text-[9px] font-bold text-cyan-400 bg-cyan-950/80 border border-cyan-800/60 px-1.5 py-0.5 rounded-md">CLIENT ONLY</span>'
          : mod.side === "server"
          ? '<span class="text-[9px] font-bold text-emerald-400 bg-emerald-950/80 border border-emerald-800/60 px-1.5 py-0.5 rounded-md">SERVER ONLY</span>'
          : '<span class="text-[9px] font-bold text-indigo-400 bg-indigo-950/80 border border-indigo-800/60 px-1.5 py-0.5 rounded-md">REQUIRED</span>';

      const fallbackText = escapeHtml((mod.name || mod.id || "M")[0].toUpperCase());
      const modName = escapeHtml(mod.name || mod.filename || "Unknown mod");
      const modId = escapeHtml(mod.id);
      const iconHtml = mod.iconUrl
        ? `<div class="mod-icon-wrapper">
            <img src="${escapeHtml(mod.iconUrl)}" alt="${modName}" class="mod-icon-img" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <div class="mod-icon-fallback" style="display: none;">${fallbackText}</div>
          </div>`
        : `<div class="mod-icon-wrapper">
            <div class="mod-icon-fallback">${fallbackText}</div>
          </div>`;

      const catsHtml = (mod.categories || [])
        .slice(0, 3)
        .map((c) => `<span class="text-[9px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded">#${escapeHtml(c)}</span>`)
        .join(" ");

      const linkBtn = mod.sourceUrl
        ? `<button data-source-url="${escapeHtml(mod.sourceUrl)}" class="mod-link-btn js-source-link" title="Open source page">View ↗</button>`
        : "";

      const toggle = mod.canDisable
        ? `<label class="mod-switch" title="${mod.enabled ? "Disable" : "Enable"} ${modName}">
            <input class="js-mod-toggle" type="checkbox" data-id="${modId}" data-filename="${escapeHtml(mod.filename)}" data-source="${escapeHtml(mod.source)}" ${mod.enabled ? "checked" : ""}>
            <span></span>
          </label>`
        : "";
      const localBadge = mod.source === "custom" ? '<span class="local-mod-badge">LOCAL</span>' : "";
      const remove = mod.source === "custom"
        ? `<button class="mod-remove-btn js-mod-remove" data-filename="${escapeHtml(mod.filename)}" title="Remove this local mod">Remove</button>`
        : "";

      return `
        <div class="mod-card">
          <div class="flex items-start gap-3">
            ${iconHtml}
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-1">
                <h5 class="font-bold text-xs text-white truncate" title="${modName}">${modName}</h5>
                <div class="flex items-center gap-1">${localBadge}${sideBadge}${toggle}</div>
              </div>
              <p class="text-[11px] text-slate-400 line-clamp-2 mt-1 leading-relaxed">${escapeHtml(mod.description || "Synchronized modpack component.")}</p>
            </div>
          </div>
          <div class="flex items-center justify-between pt-1 border-t border-slate-900/80 text-[10px] text-slate-500 font-mono">
            <div class="flex items-center gap-1 overflow-hidden">
              ${catsHtml}
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <span>${formatBytes(mod.size)}</span>
              ${remove}
              ${linkBtn}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  modsGrid.querySelectorAll(".js-source-link").forEach((button) => {
    button.onclick = () => window.lampas.utils.openPath(button.dataset.sourceUrl);
  });
  modsGrid.querySelectorAll(".js-mod-toggle").forEach((toggle) => {
    toggle.onchange = async () => {
      const enabled = toggle.checked;
      const filename = toggle.dataset.filename;
      const modId = toggle.dataset.id;
      const source = toggle.dataset.source;
      try {
        toggle.disabled = true;
        if (source === "custom") {
          await window.lampas.mods.setCustomEnabled(filename, enabled);
        } else {
          await window.lampas.mods.setOfficialEnabled(modId, enabled);
        }
        const entry = allMods.find((mod) => mod.id === modId);
        if (entry) entry.enabled = enabled;
        toggle.disabled = false;
        showToast(`${enabled ? "Enabled" : "Disabled"} ${filename}. Changes apply on the next sync.`, "success");
      } catch (err) {
        toggle.checked = !enabled;
        toggle.disabled = false;
        showToast(`Could not update mod: ${err.message}`, "error");
      }
      window.scrollTo(0, 0);
    };
  });
  modsGrid.querySelectorAll(".js-mod-remove").forEach((button) => {
    button.onclick = async () => {
      try {
        const filename = button.dataset.filename;
        button.blur();
        await window.lampas.mods.removeCustom(filename);
        await loadModCatalog();
        showToast(`Removed ${filename}.`, "success");
      } catch (err) {
        showToast(`Could not remove mod: ${err.message}`, "error");
      }
    };
  });
}

async function addLocalMods(files) {
  try {
    if (files) await window.lampas.mods.addDropped(Array.from(files));
    else await window.lampas.mods.browseAndAdd();
    await loadModCatalog();
    showToast("Local client mods added. They will be preserved during sync.", "success");
  } catch (err) {
    showToast(`Could not add mod: ${err.message}`, "error", 5000);
  }
}

if (btnAddMods) btnAddMods.onclick = () => addLocalMods();
if (modDropZone) {
  for (const eventName of ["dragenter", "dragover"]) {
    modDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      modDropZone.classList.add("drag-active");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    modDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      modDropZone.classList.remove("drag-active");
    });
  }
  modDropZone.addEventListener("drop", (event) => addLocalMods(event.dataTransfer?.files));
  modDropZone.onclick = () => addLocalMods();
}

async function loadModCatalog() {
  try {
    if (window.lampas.sync?.getModCatalog) {
      allMods = await window.lampas.sync.getModCatalog();
      if (managedModCount) managedModCount.innerText = allMods.filter((mod) => mod.source === "official").length;
      if (optionalModCount) optionalModCount.innerText = allMods.filter((mod) => mod.source === "official" && mod.canDisable).length;
      if (localModCount) localModCount.innerText = allMods.filter((mod) => mod.source === "custom").length;
      renderMods();
      window.scrollTo(0, 0);
    }
  } catch (err) {
    console.warn("Failed to load mod catalog:", err);
  }
}

if (modsSearchInput) {
  modsSearchInput.oninput = (e) => {
    activeModSearch = e.target.value;
    renderMods();
  };
}

modFilterPills.forEach((pill) => {
  pill.onclick = () => {
    modFilterPills.forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    activeModFilter = pill.dataset.filter || "all";
    renderMods();
  };
});

init();
