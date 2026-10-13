import type { LauncherUpdateInfo } from "../types";

/** Re-ask main periodically; main itself only contacts GitHub every few hours. */
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

export function initUpdateView(): () => void {
  const card = document.getElementById("update-card");
  const notesBtn = document.getElementById(
    "btn-update-notes",
  ) as HTMLButtonElement | null;
  const downloadBtn = document.getElementById(
    "btn-update-download",
  ) as HTMLButtonElement | null;

  let current: LauncherUpdateInfo | null = null;

  function render(update: LauncherUpdateInfo | null): void {
    current = update;
    if (!card) return;
    if (!update) {
      card.classList.add("hidden");
      return;
    }
    if (notesBtn) notesBtn.innerText = `Version ${update.version} · What's new`;
    card.classList.remove("hidden");
  }

  async function check(): Promise<void> {
    if (!window.lampas.updates?.check) return;
    try {
      render(await window.lampas.updates.check());
    } catch {
      // A failed check is silent; the launcher works the same without it.
    }
  }

  if (downloadBtn) {
    downloadBtn.onclick = () => {
      if (current) void window.lampas.utils.openSourcePage(current.downloadUrl);
    };
  }
  if (notesBtn) {
    notesBtn.onclick = () => {
      if (current) void window.lampas.utils.openSourcePage(current.releaseUrl);
    };
  }

  void check();
  const timer = setInterval(() => {
    if (!document.hidden) void check();
  }, RECHECK_INTERVAL_MS);

  return () => clearInterval(timer);
}
