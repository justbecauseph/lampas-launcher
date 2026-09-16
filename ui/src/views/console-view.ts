import type { GameLogEntry } from "../types";
import { formatFriendlyError } from "../utils";

export interface ConsoleViewOptions {
  showToast: (message: string, type: "info" | "success" | "error", duration?: number) => void;
}

export interface ConsoleViewInstance {
  appendLog: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
  isAutoScroll: () => boolean;
  setGameStatus: (state: "idle" | "syncing" | "launching" | "running", textOverride?: string) => void;
  dispose: () => void;
}

export function initConsoleView(options: ConsoleViewOptions): ConsoleViewInstance {
  const { showToast } = options;

  const consoleOutput = document.getElementById("console-output") as HTMLElement | null;
  const consoleCount = document.getElementById("console-count") as HTMLElement | null;
  const btnClearLogs = document.getElementById("btn-clear-logs") as HTMLButtonElement | null;
  const btnCopyLogs = document.getElementById("btn-copy-logs") as HTMLButtonElement | null;
  const btnOpenLogFile = document.getElementById("btn-open-log-file") as HTMLButtonElement | null;
  const btnOpenLogFolder = document.getElementById("btn-open-log-folder") as HTMLButtonElement | null;
  const btnOpenMinecraftLog = document.getElementById("btn-open-minecraft-log") as HTMLButtonElement | null;
  const consoleAutoscroll = (document.getElementById("console-autoscroll") || document.getElementById("btn-autoscroll")) as HTMLInputElement | HTMLButtonElement | null;
  const btnConsoleStop = document.getElementById("btn-console-stop") as HTMLButtonElement | null;
  const consoleGameStatus = document.getElementById("console-game-status") as HTMLElement | null;
  const consoleStatusDot = document.getElementById("console-status-dot") as HTMLElement | null;
  const consoleStatusText = document.getElementById("console-status-text") as HTMLElement | null;
  const logFilterSelect = document.getElementById("log-filter-level") as HTMLSelectElement | null;

  let logLineCount = 0;
  let autoScroll = consoleAutoscroll && "checked" in consoleAutoscroll ? Boolean(consoleAutoscroll.checked) : true;
  let activeFilterLevel = "ALL";
  const disposers: Array<() => void> = [];

  function isAutoScrollEnabled(): boolean {
    if (consoleAutoscroll && "checked" in consoleAutoscroll) {
      return Boolean(consoleAutoscroll.checked);
    }
    return autoScroll;
  }

  function updateAutoscrollUI(): void {
    if (!consoleAutoscroll) return;
    if ("checked" in consoleAutoscroll) {
      consoleAutoscroll.checked = autoScroll;
    } else {
      if (autoScroll) {
        consoleAutoscroll.classList.add("bg-cyan-500/20", "text-cyan-400", "border-cyan-500/40");
        consoleAutoscroll.classList.remove("text-slate-400");
      } else {
        consoleAutoscroll.classList.remove("bg-cyan-500/20", "text-cyan-400", "border-cyan-500/40");
        consoleAutoscroll.classList.add("text-slate-400");
      }
    }
  }

  function clearConsoleLogs(notify = false): void {
    if (consoleOutput) {
      consoleOutput.innerHTML = "";
    }
    logLineCount = 0;
    if (consoleCount) {
      consoleCount.innerText = "0 lines";
    }
    if (notify) {
      showToast("Console cleared.", "info", 1500);
    }
  }

  // Retain window global for backward compatibility and characterization tests
  (window as any).clearConsoleLogs = clearConsoleLogs;

  function pruneLines(): void {
    if (!consoleOutput) return;
    while (consoleOutput.childNodes.length > 1000) {
      consoleOutput.removeChild(consoleOutput.firstChild!);
    }
  }

  function formatLogLine(entry: GameLogEntry): HTMLElement {
    const line = document.createElement("div");
    line.className = "console-line";
    line.dataset.level = entry.level;

    const timeSpan = document.createElement("span");
    timeSpan.className = "console-time";
    timeSpan.textContent = `[${entry.timestamp}]`;

    const levelSpan = document.createElement("span");
    levelSpan.className = `console-level console-level-${entry.level.toLowerCase()}`;
    levelSpan.textContent = `[${entry.level}]`;

    const msgSpan = document.createElement("span");
    msgSpan.className = "console-msg";
    msgSpan.textContent = ` ${entry.message}`;

    if (typeof line.append === "function") {
      line.append(timeSpan, " ", levelSpan, msgSpan);
    } else {
      line.appendChild(timeSpan);
      line.appendChild(levelSpan);
      line.appendChild(msgSpan);
    }
    return line;
  }

  function appendBatch(entries: GameLogEntry[]): void {
    if (!consoleOutput || entries.length === 0) return;

    const fragment = typeof document.createDocumentFragment === "function"
      ? document.createDocumentFragment()
      : null;

    for (const entry of entries) {
      logLineCount++;
      const lineEl = formatLogLine(entry);
      if (activeFilterLevel !== "ALL" && entry.level !== activeFilterLevel) {
        lineEl.style.display = "none";
      }
      if (fragment) {
        fragment.appendChild(lineEl);
      } else {
        consoleOutput.appendChild(lineEl);
      }
    }

    if (fragment) {
      consoleOutput.appendChild(fragment);
    }
    pruneLines();

    if (consoleCount) {
      consoleCount.innerText = `${logLineCount} line${logLineCount === 1 ? "" : "s"}`;
    }

    if (isAutoScrollEnabled() && consoleOutput) {
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }
  }

  function appendLog(level: "INFO" | "WARN" | "ERROR", message: string): void {
    const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    appendBatch([{ timestamp, level, message }]);
  }

  function setGameStatus(state: "idle" | "syncing" | "launching" | "running", textOverride?: string): void {
    if (consoleGameStatus && consoleStatusDot && consoleStatusText) {
      if (state === "running") {
        consoleStatusDot.className = "status-dot status-dot-running";
        consoleStatusText.innerText = textOverride || "GAME RUNNING";
        consoleGameStatus.className = "badge flex items-center gap-1.5 text-emerald-400 border-emerald-500/40 bg-emerald-950/50";
        if (btnConsoleStop) btnConsoleStop.classList.remove("hidden");
      } else if (state === "syncing" || state === "launching") {
        consoleStatusDot.className = "status-dot status-dot-launching";
        consoleStatusText.innerText = textOverride || (state === "syncing" ? "SYNCING..." : "LAUNCHING...");
        consoleGameStatus.className = "badge flex items-center gap-1.5 text-amber-400 border-amber-500/40 bg-amber-950/50";
        if (btnConsoleStop) btnConsoleStop.classList.remove("hidden");
      } else {
        consoleStatusDot.className = "status-dot status-dot-idle";
        consoleStatusText.innerText = textOverride || "IDLE";
        consoleGameStatus.className = "badge flex items-center gap-1.5 text-slate-400";
        if (btnConsoleStop) btnConsoleStop.classList.add("hidden");
      }
    }
  }

  // Subscribe to batch log delivery
  if (window.lampas?.game?.onLogBatch) {
    const unsub = window.lampas.game.onLogBatch((batch) => {
      appendBatch(batch.entries);
    });
    disposers.push(unsub);
  } else if (window.lampas?.game?.onLog) {
    const unsub = window.lampas.game.onLog((entry) => {
      appendBatch([entry]);
    });
    disposers.push(unsub);
  }

  if (window.lampas?.game?.onExit) {
    const unsub = window.lampas.game.onExit(() => {
      setGameStatus("idle");
    });
    disposers.push(unsub);
  }

  if (btnClearLogs) {
    const onClear = () => clearConsoleLogs(true);
    btnClearLogs.addEventListener("click", onClear);
    disposers.push(() => btnClearLogs.removeEventListener("click", onClear));
  }

  if (consoleAutoscroll) {
    if ("checked" in consoleAutoscroll) {
      const onCheckboxChange = () => {
        autoScroll = Boolean((consoleAutoscroll as HTMLInputElement).checked);
        if (autoScroll && consoleOutput) {
          consoleOutput.scrollTop = consoleOutput.scrollHeight;
        }
      };
      consoleAutoscroll.addEventListener("change", onCheckboxChange);
      disposers.push(() => consoleAutoscroll.removeEventListener("change", onCheckboxChange));
    } else {
      const onBtnClick = () => {
        autoScroll = !autoScroll;
        updateAutoscrollUI();
        if (autoScroll && consoleOutput) {
          consoleOutput.scrollTop = consoleOutput.scrollHeight;
        }
      };
      consoleAutoscroll.addEventListener("click", onBtnClick);
      disposers.push(() => consoleAutoscroll.removeEventListener("click", onBtnClick));
      updateAutoscrollUI();
    }
  }

  if (btnConsoleStop) {
    const onStop = async () => {
      try {
        btnConsoleStop.disabled = true;
        await window.lampas?.game?.kill?.();
        showToast("Stopping Minecraft...", "info");
      } catch (err: any) {
        showToast(`Could not stop Minecraft: ${formatFriendlyError(err)}`, "error");
      } finally {
        btnConsoleStop.disabled = false;
      }
    };
    btnConsoleStop.addEventListener("click", onStop);
    disposers.push(() => btnConsoleStop.removeEventListener("click", onStop));
  }

  if (btnCopyLogs) {
    const onCopy = async () => {
      if (!consoleOutput) return;
      const text = consoleOutput.innerText;
      try {
        await navigator.clipboard.writeText(text);
        showToast("Console output copied to clipboard.", "success", 2000);
      } catch {
        showToast("Failed to copy console logs.", "error");
      }
    };
    btnCopyLogs.addEventListener("click", onCopy);
    disposers.push(() => btnCopyLogs.removeEventListener("click", onCopy));
  }

  if (btnOpenLogFile) {
    const onOpenFile = async () => {
      try {
        await window.lampas?.utils?.openLogFile?.();
      } catch (err: any) {
        showToast(`Could not open log file: ${formatFriendlyError(err)}`, "error");
      }
    };
    btnOpenLogFile.addEventListener("click", onOpenFile);
    disposers.push(() => btnOpenLogFile.removeEventListener("click", onOpenFile));
  }

  if (btnOpenLogFolder) {
    const onOpenFolder = async () => {
      try {
        await window.lampas?.utils?.openLogsDir?.();
      } catch (err: any) {
        showToast(`Could not open logs folder: ${formatFriendlyError(err)}`, "error");
      }
    };
    btnOpenLogFolder.addEventListener("click", onOpenFolder);
    disposers.push(() => btnOpenLogFolder.removeEventListener("click", onOpenFolder));
  }

  if (btnOpenMinecraftLog) {
    const onOpenMcLog = async () => {
      try {
        await window.lampas?.utils?.openMinecraftLog?.();
      } catch (err: any) {
        showToast(`Could not open Minecraft log: ${formatFriendlyError(err)}`, "error");
      }
    };
    btnOpenMinecraftLog.addEventListener("click", onOpenMcLog);
    disposers.push(() => btnOpenMinecraftLog.removeEventListener("click", onOpenMcLog));
  }

  if (logFilterSelect) {
    const onFilterChange = () => {
      activeFilterLevel = logFilterSelect.value;
      if (!consoleOutput) return;
      const lines = consoleOutput.querySelectorAll<HTMLElement>(".console-line");
      lines.forEach((line) => {
        if (activeFilterLevel === "ALL" || line.dataset.level === activeFilterLevel) {
          line.style.display = "";
        } else {
          line.style.display = "none";
        }
      });
      if (isAutoScrollEnabled() && consoleOutput) {
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
      }
    };
    logFilterSelect.addEventListener("change", onFilterChange);
    disposers.push(() => logFilterSelect.removeEventListener("change", onFilterChange));
  }

  return {
    appendLog,
    isAutoScroll: isAutoScrollEnabled,
    setGameStatus,
    dispose: () => {
      disposers.forEach((dispose) => dispose());
    },
  };
}
