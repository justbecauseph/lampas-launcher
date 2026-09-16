import type { ModCatalogEntry } from "../types";

interface NormalizedMod extends ModCatalogEntry {
  _searchKey: string;
}

export interface ModsViewOptions {
  showToast: (message: string, type: "info" | "success" | "error", duration?: number) => void;
  onModsChanged?: () => void;
  getGameDir?: () => string;
  switchToTab?: (tabId: string) => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || isNaN(bytes)) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(value?: string | number): string {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char] || char);
}

export function initModsView(options: ModsViewOptions): () => void {
  const { showToast, onModsChanged, getGameDir, switchToTab } = options;

  const modsGrid = document.getElementById("mods-grid") as HTMLElement | null;
  const modsSearchInput = document.getElementById("mods-search-input") as HTMLInputElement | null;
  const modsFilteredCount = document.getElementById("mods-filtered-count") as HTMLElement | null;
  const managedModCount = document.getElementById("managed-mod-count") as HTMLElement | null;
  const optionalModCount = document.getElementById("optional-mod-count") as HTMLElement | null;
  const localModCount = document.getElementById("local-mod-count") as HTMLElement | null;
  const modFilterPills = document.querySelectorAll<HTMLElement>(".mod-filter-pill");

  // Client Loadout Action Buttons
  const btnAddMods = (document.getElementById("btn-add-mods") || document.getElementById("btn-browse-mod")) as HTMLButtonElement | null;
  const btnRepairPack = document.getElementById("btn-repair-pack") as HTMLButtonElement | null;
  const btnVerifyPack = document.getElementById("btn-verify-pack") as HTMLButtonElement | null;
  const btnModsOpenDir = document.getElementById("btn-mods-open-dir") as HTMLButtonElement | null;
  const modDropZone = (document.getElementById("mod-drop-zone") || document.getElementById("tab-mods")) as HTMLElement | null;

  let allMods: NormalizedMod[] = [];
  let activeModFilter = "all";
  let activeModSearch = "";
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isComposing = false;
  let isMutating = false;

  function precomputeSearchKey(mod: ModCatalogEntry): string {
    const parts = [
      mod.name || "",
      mod.id || "",
      mod.filename || "",
      mod.description || "",
      ...(mod.categories || []),
    ];
    return parts.join(" ").toLowerCase();
  }

  function updateCounts(): void {
    let managed = 0;
    let optional = 0;
    let local = 0;
    for (const mod of allMods) {
      if (mod.source === "custom") local++;
      else if (mod.canDisable) optional++;
      else managed++;
    }
    if (managedModCount) managedModCount.innerText = String(managed);
    if (optionalModCount) optionalModCount.innerText = String(optional);
    if (localModCount) localModCount.innerText = String(local);
  }

  function renderMods(): void {
    if (!modsGrid) return;

    const query = activeModSearch.toLowerCase().trim();
    const filter = activeModFilter.toLowerCase();

    const filtered = allMods.filter((mod) => {
      // Filter category/type check
      if (filter === "client" && mod.side !== "client") return false;
      if (filter === "disabled" && mod.enabled !== false) return false;
      if (filter === "custom" && mod.source !== "custom") return false;
      if (filter === "server" && mod.side !== "server") return false;
      if (filter === "both" && mod.side !== "both") return false;
      if (!["all", "client", "disabled", "custom", "server", "both"].includes(filter)) {
        const cats = (mod.categories || []).map((c) => c.toLowerCase());
        if (!cats.includes(filter)) return false;
      }

      // Fast precomputed search check
      if (query && !mod._searchKey.includes(query)) {
        return false;
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

        const fallbackChar = escapeHtml((mod.name || mod.id || "M")[0].toUpperCase());
        const modName = escapeHtml(mod.name || mod.filename || "Unknown mod");
        const modId = escapeHtml(mod.id);
        const iconHtml = mod.iconUrl
          ? `<div class="mod-icon-wrapper">
              <img src="${escapeHtml(mod.iconUrl)}" alt="${modName}" class="mod-icon-img" loading="lazy" />
              <div class="mod-icon-fallback" style="display: none;">${fallbackChar}</div>
            </div>`
          : `<div class="mod-icon-wrapper">
              <div class="mod-icon-fallback">${fallbackChar}</div>
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
              <input class="js-mod-toggle" type="checkbox" data-id="${modId}" data-filename="${escapeHtml(mod.filename || "")}" data-source="${escapeHtml(mod.source)}" ${mod.enabled ? "checked" : ""}>
              <span></span>
            </label>`
          : "";
        const localBadge = mod.source === "custom" ? '<span class="local-mod-badge">LOCAL</span>' : "";
        const remove = mod.source === "custom"
          ? `<button class="mod-remove-btn js-mod-remove" data-filename="${escapeHtml(mod.filename || "")}" title="Remove this local mod">Remove</button>`
          : "";

        return `
          <div class="mod-card" data-mod-id="${modId}">
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
  }

  async function loadCatalog(): Promise<void> {
    if (!window.lampas.sync?.getModCatalog) return;
    try {
      const rawMods = await window.lampas.sync.getModCatalog();
      allMods = rawMods.map((mod) => ({
        ...mod,
        _searchKey: precomputeSearchKey(mod),
      }));
      updateCounts();
      renderMods();
    } catch (err: any) {
      console.warn("Failed to load mod catalog:", err?.message || err);
    }
  }

  // Delegated Event Listeners on modsGrid
  if (modsGrid) {
    // Programmatic error listener for mod icons without inline onerror attribute
    modsGrid.addEventListener(
      "error",
      (e) => {
        const target = e.target as HTMLElement;
        if (target && target.classList.contains("mod-icon-img")) {
          target.style.display = "none";
          const fallback = target.nextElementSibling as HTMLElement;
          if (fallback) fallback.style.display = "flex";
        }
      },
      true // capture error events
    );

    // Delegated clicks for links and remove buttons
    modsGrid.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;

      const linkBtn = target.closest<HTMLButtonElement>(".js-source-link");
      if (linkBtn && linkBtn.dataset.sourceUrl) {
        window.lampas.utils.openPath(linkBtn.dataset.sourceUrl);
        return;
      }

      const removeBtn = target.closest<HTMLButtonElement>(".js-mod-remove");
      if (removeBtn && removeBtn.dataset.filename && !isMutating) {
        const filename = removeBtn.dataset.filename;
        isMutating = true;
        removeBtn.disabled = true;
        try {
          await window.lampas.mods.removeCustom(filename);
          showToast(`Removed ${filename}`, "info");
          await loadCatalog();
          onModsChanged?.();
        } catch (err: any) {
          showToast(`Failed to remove mod: ${err.message}`, "error");
        } finally {
          isMutating = false;
        }
      }
    });

    // Delegated toggle change with rollback on failure
    modsGrid.addEventListener("change", async (e) => {
      const target = e.target as HTMLInputElement;
      if (!target.classList.contains("js-mod-toggle") || isMutating) return;

      const isOfficial = target.dataset.source === "official";
      const modId = target.dataset.id || "";
      const filename = target.dataset.filename || "";
      const enabled = target.checked;

      isMutating = true;
      target.disabled = true;

      try {
        if (isOfficial) {
          await window.lampas.mods.setOfficialEnabled(modId, enabled);
        } else {
          await window.lampas.mods.setCustomEnabled(filename, enabled);
        }
        // Update local state
        const found = allMods.find((m) => (isOfficial ? m.id === modId : m.filename === filename));
        if (found) found.enabled = enabled;
        updateCounts();
        if (activeModFilter === "disabled") {
          renderMods();
        }
        showToast(`${enabled ? "Enabled" : "Disabled"} ${filename || modId}`, "info", 1500);
        onModsChanged?.();
      } catch (err: any) {
        // Rollback checkbox
        target.checked = !enabled;
        showToast(`Failed to toggle mod: ${err.message}`, "error");
      } finally {
        target.disabled = false;
        isMutating = false;
      }
    });
  }

  // 150ms debounced search with composition handling
  if (modsSearchInput) {
    modsSearchInput.addEventListener("compositionstart", () => {
      isComposing = true;
    });
    modsSearchInput.addEventListener("compositionend", () => {
      isComposing = false;
      triggerSearch();
    });
    modsSearchInput.addEventListener("input", () => {
      if (isComposing) return;
      triggerSearch();
    });
  }

  function triggerSearch(): void {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      activeModSearch = modsSearchInput?.value || "";
      renderMods();
    }, 150);
  }

  // Filter pills
  modFilterPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      modFilterPills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      activeModFilter = pill.dataset.filter || "all";
      renderMods();
    });
  });

  const handleAddLocalMods = async () => {
    try {
      const res = await window.lampas.mods.browseAndAdd();
      if (res.success && res.filesAdded?.length) {
        showToast(`Imported: ${res.filesAdded.join(", ")}`, "success");
        await loadCatalog();
        onModsChanged?.();
      } else if (res.error) {
        showToast(`Import Failed: ${res.error}`, "error");
      }
    } catch (err: any) {
      showToast(`Import Error: ${err.message}`, "error");
    }
  };

  // Add Local Mods Button
  if (btnAddMods) {
    btnAddMods.onclick = handleAddLocalMods;
  }

  // Repair Pack Button
  if (btnRepairPack) {
    btnRepairPack.onclick = async () => {
      if (switchToTab) {
        switchToTab("tab-console");
      } else {
        const navConsole = document.getElementById("nav-console");
        if (navConsole) navConsole.click();
      }

      if (!window.lampas?.sync?.repair) return;
      try {
        btnRepairPack.disabled = true;
        showToast("Verifying and repairing game files...", "info");
        const res = await window.lampas.sync.repair();
        const completionMsg = res?.message || "Repair complete! All game files, assets, and libraries verified.";
        showToast(completionMsg, "success", 4500);
        await loadCatalog();
        onModsChanged?.();
      } catch (err: any) {
        showToast(`Repair error: ${err.message}`, "error", 6000);
      } finally {
        btnRepairPack.disabled = false;
      }
    };
  }

  // Verify Integrity Button
  if (btnVerifyPack) {
    btnVerifyPack.onclick = async () => {
      if (switchToTab) {
        switchToTab("tab-console");
      } else {
        const navConsole = document.getElementById("nav-console");
        if (navConsole) navConsole.click();
      }

      if (!window.lampas?.sync?.start) return;
      try {
        btnVerifyPack.disabled = true;
        showToast("Verifying modpack integrity...", "info");
        const res = await window.lampas.sync.start();
        const completionMsg = res?.message || `Modpack v${res.version} verified successfully.`;
        showToast(completionMsg, "success", 4500);
        await loadCatalog();
        onModsChanged?.();
      } catch (err: any) {
        showToast(`Verification error: ${err.message}`, "error", 6000);
      } finally {
        btnVerifyPack.disabled = false;
      }
    };
  }

  // Open Pack Folder Button
  if (btnModsOpenDir) {
    btnModsOpenDir.onclick = async () => {
      let dir = getGameDir?.();
      if (!dir && window.lampas?.config?.get) {
        try {
          const cfg = await window.lampas.config.get();
          dir = cfg?.gameDir;
        } catch {}
      }
      if (dir && window.lampas?.utils?.openPath) {
        await window.lampas.utils.openPath(dir);
      }
    };
  }

  // Drag & drop mods and click drop zone
  if (modDropZone) {
    modDropZone.onclick = (e) => {
      if ((e.target as HTMLElement)?.closest?.(".badge")) return;
      if ((e.target as HTMLElement)?.closest?.("button")) return;
      void handleAddLocalMods();
    };

    modDropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      modDropZone.classList.add("drag-over");
    });
    modDropZone.addEventListener("dragleave", () => {
      modDropZone.classList.remove("drag-over");
    });
    modDropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      modDropZone.classList.remove("drag-over");
      const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
        f.name.toLowerCase().endsWith(".jar")
      );
      if (files.length === 0) return;

      try {
        const res = await window.lampas.mods.addDropped(files);
        if (res.success && res.filesAdded?.length) {
          showToast(`Imported: ${res.filesAdded.join(", ")}`, "success");
          await loadCatalog();
          onModsChanged?.();
        } else if (res.error) {
          showToast(`Import Failed: ${res.error}`, "error");
        }
      } catch (err: any) {
        showToast(`Import Error: ${err.message}`, "error");
      }
    });
  }

  void loadCatalog();

  return () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  };
}
