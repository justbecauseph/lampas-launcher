import type { GameLogEntry } from "../types";
import { formatFriendlyError } from "../utils";

export interface ConsoleViewOptions {
  showToast: (message: string, type: "info" | "success" | "error", duration?: number) => void;
}

export function initConsoleView(options: ConsoleViewOptions): () => void {
  const { showToast } = options;

  const consoleOutput = document.getElementById("console-output") as HTMLElement | null;
  const consoleCount = document.getElementById("console-count") as HTMLElement | null;
  const btnClearLogs = document.getElementById("btn-clear-logs") as HTMLButtonElement | null;
  const btnCopyLogs = document.getElementById("btn-copy-logs") as HTMLButtonElement | null;
  const btnOpenLogFile = document.getElementById("btn-open-log-file") as HTMLButtonElement | null;
  const btnOpenLogFolder = document.getElementById("btn-open-log-folder") as HTMLButtonElement | null;
  const btnOpenMinecraftLog = document.getElementById("btn-open-minecraft-log") as HTMLButtonElement | null;
  const btnAutoscroll = document.getElementById("btn-autoscroll") as HTMLButtonElement | null;
  const logFilterSelect = document.getElementById("log-filter-level") as HTMLSelectElement | null;

  let logLineCount = 0;
  let autoScroll = true;
  let activeFilterLevel = "ALL";
  const disposers: Array<() => void> = [];

  function updateAutoscrollUI(): void {
    if (!btnAutoscroll) return;
    if (autoScroll) {
      btnAutoscroll.classList.add("bg-cyan-500/20", "text-cyan-400", "border-cyan-500/40");
      btnAutoscroll.classList.remove("text-slate-400");
    } else {
      btnAutoscroll.classList.remove("bg-cyan-500/20", "text-cyan-400", "border-cyan-500/40");
      btnAutoscroll.classList.add("text-slate-400");
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

    line.append(timeSpan, document.createTextNode(" "), levelSpan, msgSpan);
    return line;
  }

  function appendBatch(entries: GameLogEntry[]): void {
    if (!consoleOutput || entries.length === 0) return;

    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      logLineCount++;
      const lineEl = formatLogLine(entry);
      if (activeFilterLevel !== "ALL" && entry.level !== activeFilterLevel) {
        lineEl.style.display = "none";
      }
      fragment.appendChild(lineEl);
    }

    consoleOutput.appendChild(fragment);
    pruneLines();

    if (consoleCount) {
      consoleCount.innerText = `${logLineCount} line${logLineCount === 1 ? "" : "s"}`;
    }

    if (autoScroll) {
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }
  }

  // Subscribe to batch log delivery
  if (window.lampas.game?.onLogBatch) {
    const unsub = window.lampas.game.onLogBatch((batch) => {
      appendBatch(batch.entries);
    });
    disposers.push(unsub);
  } else if (window.lampas.game?.onLog) {
    const unsub = window.lampas.game.onLog((entry) => {
      appendBatch([entry]);
    });
    disposers.push(unsub);
  }

  if (btnClearLogs) {
    btnClearLogs.onclick = () => clearConsoleLogs(true);
  }

  if (btnAutoscroll) {
    btnAutoscroll.onclick = () => {
      autoScroll = !autoScroll;
      updateAutoscrollUI();
      if (autoScroll && consoleOutput) {
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
      }
    };
    updateAutoscrollUI();
  }

  if (btnCopyLogs) {
    btnCopyLogs.onclick = async () => {
      if (!consoleOutput) return;
      const text = consoleOutput.innerText;
      try {
        await navigator.clipboard.writeText(text);
        showToast("Console output copied to clipboard.", "success", 2000);
      } catch {
        showToast("Failed to copy console logs.", "error");
      }
    };
  }

  if (btnOpenLogFile) {
    btnOpenLogFile.onclick = async () => {
      try {
        await window.lampas.utils.openLogFile();
      } catch (err: any) {
        showToast(`Could not open log file: ${formatFriendlyError(err)}`, "error");
      }
    };
  }

  if (btnOpenLogFolder) {
    btnOpenLogFolder.onclick = async () => {
      try {
        await window.lampas.utils.openLogsDir();
      } catch (err: any) {
        showToast(`Could not open logs folder: ${formatFriendlyError(err)}`, "error");
      }
    };
  }

  if (btnOpenMinecraftLog) {
    btnOpenMinecraftLog.onclick = async () => {
      try {
        await window.lampas.utils.openMinecraftLog();
      } catch (err: any) {
        showToast(`Could not open Minecraft log: ${formatFriendlyError(err)}`, "error");
      }
    };
  }

  if (logFilterSelect) {
    logFilterSelect.onchange = () => {
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
      if (autoScroll) {
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
      }
    };
  }

  return () => {
    disposers.forEach((dispose) => dispose());
  };
}
