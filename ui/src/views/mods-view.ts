import type { ModCatalogEntry } from "../types";
import {
  cleanModDisplayName,
  formatFriendlyError,
  isUserCancelled,
} from "../utils";

interface NormalizedMod extends ModCatalogEntry {
  _searchKey: string;
}

export interface ModsViewOptions {
  showToast: (
    message: string,
    type: "info" | "success" | "error",
    duration?: number,
  ) => void;
  onModsChanged?: () => void;
  getGameDir?: () => string;
  switchToTab?: (tabId: string) => void;
  externalImages?: () => boolean;
}

type UploadMode = "mod" | "shader";

const UPLOAD_COPY: Record<
  UploadMode,
  {
    mark: string;
    title: string;
    hint: string;
    button: string;
    extension: string;
  }
> = {
  mod: {
    mark: ".jar",
    title: "Drop mod files (.jar) here",
    hint: "Mods you add here stay when the pack updates.",
    button: "Add your mods",
    extension: ".jar",
  },
  shader: {
    mark: ".zip",
    title: "Drop shader packs (.zip) here",
    hint: "Then pick it in-game under Options → Video Settings → Shader Packs.",
    button: "Add shader packs",
    extension: ".zip",
  },
};

const ICON_FETCH_CONCURRENCY = 4;

function formatBytes(bytes?: number): string {
  if (!bytes || isNaN(bytes)) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(value?: string | number): string {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[char] || char,
  );
}

export function initModsView(options: ModsViewOptions): () => void {
  const { showToast, onModsChanged, switchToTab, externalImages } = options;

  const modsGrid = document.getElementById("mods-grid") as HTMLElement | null;
  const modsSearchInput = document.getElementById(
    "mods-search-input",
  ) as HTMLInputElement | null;
  const modsFilteredCount = document.getElementById(
    "mods-filtered-count",
  ) as HTMLElement | null;
  const managedModCount = document.getElementById(
    "managed-mod-count",
  ) as HTMLElement | null;
  const optionalModCount = document.getElementById(
    "optional-mod-count",
  ) as HTMLElement | null;
  const localModCount = document.getElementById(
    "local-mod-count",
  ) as HTMLElement | null;
  const modFilterPills =
    document.querySelectorAll<HTMLElement>(".mod-filter-pill");

  // Client Loadout Action Buttons
  const btnAddMods = (document.getElementById("btn-add-mods") ||
    document.getElementById("btn-browse-mod")) as HTMLButtonElement | null;
  const btnRepairPack = document.getElementById(
    "btn-repair-pack",
  ) as HTMLButtonElement | null;
  const btnVerifyPack = document.getElementById(
    "btn-verify-pack",
  ) as HTMLButtonElement | null;
  const btnModsOpenDir = document.getElementById(
    "btn-mods-open-dir",
  ) as HTMLButtonElement | null;
  const modDropZone = (document.getElementById("mod-drop-zone") ||
    document.getElementById("tab-mods")) as HTMLElement | null;
  const dropMark = document.getElementById("drop-mark");
  const dropTitle = document.getElementById("drop-title");
  const dropHint = document.getElementById("drop-hint");
  const btnAddModsLabel = document.getElementById("btn-add-mods-label");

  let allMods: NormalizedMod[] = [];
  let activeModFilter = "all";
  let activeModSearch = "";
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isComposing = false;
  let isMutating = false;
  let iconRenderGeneration = 0;
  /** mod id → icon data URL, or null when the mod has no usable icon. */
  const iconCache = new Map<string, string | null>();

  function uploadMode(): UploadMode {
    return activeModFilter === "shader" ? "shader" : "mod";
  }

  function updateUploadCopy(): void {
    const copy = UPLOAD_COPY[uploadMode()];
    if (dropMark) dropMark.innerText = copy.mark;
    if (dropTitle) dropTitle.innerText = copy.title;
    if (dropHint) dropHint.innerText = copy.hint;
    if (btnAddModsLabel) btnAddModsLabel.innerText = copy.button;
  }

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

  async function loadExternalIcons(
    mods: NormalizedMod[],
    generation: number,
  ): Promise<void> {
    if (
      !externalImages?.() ||
      !window.lampas.cosmetics?.getModIcon ||
      !modsGrid
    )
      return;
    const grid = modsGrid;
    const showIcon = (mod: NormalizedMod, dataUrl: string) => {
      const holder = grid.querySelector<HTMLElement>(
        `[data-mod-icon-id="${CSS.escape(mod.id)}"]`,
      );
      if (!holder || holder.querySelector(".mod-icon-img")) return;
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = mod.name || mod.id;
      img.className = "mod-icon-img";
      const fallback = holder.querySelector<HTMLElement>(".mod-icon-fallback");
      if (fallback) fallback.style.display = "none";
      holder.prepend(img);
    };

    // Icons already fetched this session render immediately; the rest are
    // fetched a few at a time so a full pack never floods the main process.
    const pending: NormalizedMod[] = [];
    for (const mod of mods) {
      if (!mod.iconUrl) continue;
      if (iconCache.has(mod.id)) {
        const dataUrl = iconCache.get(mod.id);
        if (dataUrl) showIcon(mod, dataUrl);
      } else {
        pending.push(mod);
      }
    }

    let next = 0;
    const worker = async () => {
      while (next < pending.length && generation === iconRenderGeneration) {
        const mod = pending[next++];
        if (iconCache.has(mod.id)) continue;
        let dataUrl: string | null = null;
        try {
          dataUrl =
            (await window.lampas.cosmetics.getModIcon(mod.id))?.dataUrl ?? null;
        } catch {}
        iconCache.set(mod.id, dataUrl);
        if (dataUrl && generation === iconRenderGeneration)
          showIcon(mod, dataUrl);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ICON_FETCH_CONCURRENCY, pending.length) },
        worker,
      ),
    );
  }

  function renderMods(): void {
    if (!modsGrid) return;

    const query = activeModSearch.toLowerCase().trim();
    const filter = activeModFilter.toLowerCase();

    const filtered = allMods.filter((mod) => {
      // Filter category/type check
      if (
        filter === "optional" &&
        !(mod.source === "official" && mod.canDisable)
      )
        return false;
      if (
        filter === "required" &&
        !(mod.source === "official" && !mod.canDisable)
      )
        return false;
      if (filter === "disabled" && mod.enabled !== false) return false;
      if (filter === "custom" && mod.source !== "custom") return false;
      if (
        !["all", "optional", "required", "disabled", "custom"].includes(filter)
      ) {
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
      const emptyText =
        filter === "shader" && !query
          ? "No shader packs yet. Drop a .zip above to add one."
          : "No mods match your search.";
      modsGrid.innerHTML = `
        <div class="col-span-2 empty-state">
          ${emptyText}
        </div>
      `;
      return;
    }

    const generation = ++iconRenderGeneration;
    modsGrid.innerHTML = filtered
      .map((mod) => {
        const requirementBadge =
          mod.source === "official"
            ? `<span class="tag">${mod.canDisable ? "Optional" : "Required"}</span>`
            : "";

        const fallbackChar = escapeHtml(
          (mod.name || mod.id || "M")[0].toUpperCase(),
        );
        const modName = escapeHtml(mod.name || mod.filename || "Unknown mod");
        const modId = escapeHtml(mod.id);
        const iconHtml = `<div class="mod-icon-wrapper" data-mod-icon-id="${escapeHtml(mod.id)}">
              <div class="mod-icon-fallback">${fallbackChar}</div>
            </div>`;

        const catsHtml = (mod.categories || [])
          .slice(0, 3)
          .map((c) => `<span class="mod-category">#${escapeHtml(c)}</span>`)
          .join(" ");

        const linkBtn = mod.sourceUrl
          ? `<button data-source-url="${escapeHtml(mod.sourceUrl)}" class="mod-link-btn js-source-link" title="Open source page">View ↗</button>`
          : "";

        const toggle = mod.canDisable
          ? `<label class="mod-switch" title="${mod.enabled ? "Disable" : "Enable"} ${modName}">
              <input class="js-mod-toggle" type="checkbox" data-id="${modId}" data-name="${modName}" data-filename="${escapeHtml(mod.filename || "")}" data-source="${escapeHtml(mod.source)}" ${mod.enabled ? "checked" : ""}>
              <span></span>
            </label>`
          : "";
        const localBadge =
          mod.source === "custom"
            ? '<span class="local-mod-badge">Added by you</span>'
            : "";
        const remove =
          mod.source === "custom"
            ? `<button class="mod-remove-btn js-mod-remove" data-filename="${escapeHtml(mod.filename || "")}" data-kind="${mod.kind === "shaderpack" ? "shaderpack" : "mod"}" data-name="${modName}" title="Remove this ${mod.kind === "shaderpack" ? "shader pack" : "mod"}">Remove</button>`
            : "";

        return `
          <div class="mod-card" data-mod-id="${modId}">
            <div class="flex items-start gap-3">
              ${iconHtml}
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-1">
                  <h5 class="mod-name truncate" title="${modName}">${modName}</h5>
                  <div class="flex items-center gap-1">${localBadge}${requirementBadge}${toggle}</div>
                </div>
                <p class="mod-description line-clamp-2">${escapeHtml(mod.description || "Part of the Lampas pack.")}</p>
              </div>
            </div>
            <div class="mod-meta">
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
    void loadExternalIcons(filtered, generation);
  }

  let catalogLoaded = false;

  async function loadCatalog(): Promise<void> {
    if (!window.lampas.sync?.getModCatalog) return;
    try {
      const rawMods = await window.lampas.sync.getModCatalog();
      allMods = rawMods.map((mod) => ({
        ...mod,
        _searchKey: precomputeSearchKey(mod),
      }));
      catalogLoaded = true;
      updateCounts();
      renderMods();
    } catch (err: any) {
      console.warn("Failed to load mod catalog:", err?.message || err);
    }
  }

  /** The catalog costs portal requests, so load it only once the tab is opened. */
  function loadCatalogOnFirstView(): void {
    if (!catalogLoaded) void loadCatalog();
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
      true, // capture error events
    );

    // Delegated clicks for links and remove buttons
    modsGrid.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;

      const linkBtn = target.closest<HTMLButtonElement>(".js-source-link");
      if (linkBtn && linkBtn.dataset.sourceUrl) {
        if (window.lampas.utils.openSourcePage) {
          window.lampas.utils.openSourcePage(linkBtn.dataset.sourceUrl);
        } else {
          window.lampas.utils.openPath(linkBtn.dataset.sourceUrl);
        }
        return;
      }

      const removeBtn = target.closest<HTMLButtonElement>(".js-mod-remove");
      if (removeBtn && removeBtn.dataset.filename && !isMutating) {
        const filename = removeBtn.dataset.filename;
        const found = allMods.find((m) => m.filename === filename);
        const displayName =
          found?.name ||
          removeBtn.dataset.name ||
          cleanModDisplayName(filename);
        isMutating = true;
        removeBtn.disabled = true;
        try {
          if (removeBtn.dataset.kind === "shaderpack") {
            await window.lampas.shaders.remove(filename);
          } else {
            await window.lampas.mods.removeCustom(filename);
          }
          showToast(`Removed ${displayName}.`, "info");
          await loadCatalog();
          onModsChanged?.();
        } catch (err: any) {
          showToast(
            `Couldn't remove ${displayName}: ${formatFriendlyError(err)}`,
            "error",
          );
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

      const found = allMods.find((m) =>
        isOfficial ? m.id === modId : m.filename === filename,
      );
      const displayName =
        found?.name ||
        target.dataset.name ||
        cleanModDisplayName(filename) ||
        modId;

      isMutating = true;
      target.disabled = true;

      try {
        if (isOfficial) {
          await window.lampas.mods.setOfficialEnabled(modId, enabled);
        } else {
          await window.lampas.mods.setCustomEnabled(filename, enabled);
        }
        // Update local state
        if (found) found.enabled = enabled;
        updateCounts();
        if (activeModFilter === "disabled") {
          renderMods();
        }
        showToast(
          `${enabled ? "Enabled" : "Disabled"} ${displayName}.`,
          "info",
          1500,
        );
        onModsChanged?.();
      } catch (err: any) {
        // Rollback checkbox
        target.checked = !enabled;
        showToast(
          `Couldn't ${enabled ? "enable" : "disable"} ${displayName}: ${formatFriendlyError(err)}`,
          "error",
        );
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
      updateUploadCopy();
      renderMods();
    });
  });

  async function afterImport(mode: UploadMode, res: unknown): Promise<void> {
    if (Array.isArray(res) && res.length) {
      showToast(
        mode === "shader" ? "Shader packs updated." : "Mods added.",
        "success",
      );
      await loadCatalog();
      onModsChanged?.();
    }
  }

  function importErrorToast(mode: UploadMode, err: unknown): void {
    if (isUserCancelled(err)) return;
    showToast(
      `Couldn't add the ${mode === "shader" ? "shader pack" : "mod"}: ${formatFriendlyError(err)}`,
      "error",
    );
  }

  const handleAddLocalMods = async () => {
    const mode = uploadMode();
    try {
      const res =
        mode === "shader"
          ? await window.lampas.shaders.browseAndAdd()
          : await window.lampas.mods.browseAndAdd();
      await afterImport(mode, res);
    } catch (err: any) {
      importErrorToast(mode, err);
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
        showToast("Checking game files…", "info");
        const res = await window.lampas.sync.repair();
        const completionMsg =
          res?.message ||
          "Repair finished. Missing or damaged files were replaced.";
        showToast(completionMsg, "success", 4500);
        await loadCatalog();
        onModsChanged?.();
      } catch (err: any) {
        showToast(
          `Couldn't repair game files: ${formatFriendlyError(err)}`,
          "error",
          6000,
        );
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
        showToast("Checking pack files…", "info");
        const res = await window.lampas.sync.start();
        const completionMsg =
          res?.message || `All pack files are OK (version ${res.version}).`;
        showToast(completionMsg, "success", 4500);
        await loadCatalog();
        onModsChanged?.();
      } catch (err: any) {
        showToast(
          `Couldn't check files: ${formatFriendlyError(err)}`,
          "error",
          6000,
        );
      } finally {
        btnVerifyPack.disabled = false;
      }
    };
  }

  // Open Pack Folder Button
  if (btnModsOpenDir) {
    btnModsOpenDir.onclick = async () => {
      // Main only opens known location identifiers, never raw paths.
      await window.lampas.utils.openKnownLocation("modsDir");
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
      modDropZone.classList.add("drag-active");
    });
    modDropZone.addEventListener("dragleave", () => {
      modDropZone.classList.remove("drag-active");
    });
    modDropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      modDropZone.classList.remove("drag-active");
      const mode = uploadMode();
      const { extension } = UPLOAD_COPY[mode];
      const dropped = Array.from(e.dataTransfer?.files || []);
      const files = dropped.filter((f) =>
        f.name.toLowerCase().endsWith(extension),
      );
      if (files.length === 0) {
        if (dropped.length > 0) {
          showToast(
            mode === "shader"
              ? "Shader packs must be .zip files."
              : "Mods must be .jar files. To add shader packs, choose Shaders first.",
            "error",
          );
        }
        return;
      }

      try {
        const res =
          mode === "shader"
            ? await window.lampas.shaders.addDropped(files)
            : await window.lampas.mods.addDropped(files);
        await afterImport(mode, res);
      } catch (err: any) {
        importErrorToast(mode, err);
      }
    });
  }

  // Removing game files deletes local mods and shader packs; reload the list.
  const onGameFilesRemoved = () => {
    catalogLoaded = false;
    const tab = document.getElementById("tab-mods");
    if (tab && !tab.classList.contains("hidden")) void loadCatalog();
  };
  window.addEventListener?.("lampas:game-files-removed", onGameFilesRemoved);

  const navMods = document.getElementById("nav-mods");
  navMods?.addEventListener("click", loadCatalogOnFirstView);
  const tabMods = document.getElementById("tab-mods");
  if (tabMods && !tabMods.classList.contains("hidden"))
    loadCatalogOnFirstView();

  return () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    navMods?.removeEventListener("click", loadCatalogOnFirstView);
    window.removeEventListener?.(
      "lampas:game-files-removed",
      onGameFilesRemoved,
    );
  };
}
