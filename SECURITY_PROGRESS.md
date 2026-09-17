# Lampas Launcher — Security Hardening Progress

## Review Gate 2 — Narrow IPC Capabilities and Lock Down the Renderer (SEC-02)

- **Execution Date:** 17 September 2026
- **Status:** Complete (Review Gate 2 implementation verified; Phase 2 complete; paused before Phase 3)
- **Accepted Baseline Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc`
- **Accepted Review Gate 1 Checkpoint:** `e1d029112bd4b2843d61ccc19891556192e3efeb`
- **Review Gate 2 Starting Checkpoint:** `e1d029112bd4b2843d61ccc19891556192e3efeb`
- **Review Gate 2 Ending Checkpoint:** `HEAD` on branch `feat/security`
- **Current Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 2 ("Narrow IPC capabilities and lock down the renderer"). Phase 3 (OS keyring/DPAPI), Phase 4 (Path containment), and subsequent phases remain paused. Acceptance does not close any subsequent production security finding or authorize merging, tagging, or publication.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A complete audit of changes was performed against the accepted Review Gate 1 checkpoint (`e1d029112bd4b2843d61ccc19891556192e3efeb`) and the baseline:

| Dimension | Accepted Baseline (`149f100`) | Accepted RG 1 (`e1d0291`) | Review Gate 2 (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline (`0 lines`) | 8 files modified, 1 added | 9 files modified, 2 added (`src/portal-policy.ts`, `src/ipc-boundary.ts`) | **Constrained strictly to Phase 2 hardening** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical (zero package mutations)** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | 8 passed (RG 0.1) | 38 passed | **46 passed, 0 failed, 0 outbound violations, 0 skipped** | **+8 Phase 2 dynamic tests (Tests 39-46)** |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | 16 passed | 16 passed | **16 passed (15 unit/component + 1 child runner assertion verifying all 46)** | **16/16 passing** |
| **Regression Gates (`test/security-regression-gates.test.ts`)** | 6 passed (Phase 1) | 6 passed | **8 passed, 0 failed, 5 skipped, 7 todo** | **Phase 2 gates unskipped and passing** |
| **Full Test Suite (`bun test`)** | 277 passed | 283 passed | **285 passed, 0 failed, 5 skipped, 7 todo across 34 files** | **All 34 test files pass cleanly** |
| **Security Test Typecheck** | 0 errors | 0 errors | **0 errors (`tsconfig.security-test.json`)** | **0 errors** |
| **Production Typecheck & Build** | Clean | Clean | **0 errors (`tsc --noEmit && tsc -p tsconfig.renderer.json --noEmit` and `vite build`)** | **0 errors** |
| **Electron Smoke Tests** | Passed | Passed | **Passed (unpacked dev/dist + packaged binary ASAR)** | **0 errors** |

**Documentation and Ignore Invariants:**
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **tracked under git**.

---

### 2. Phase 2 Architecture & Security Invariants

Phase 2 narrows IPC capabilities, establishes main-owned launch and mod authority, requires native user approval for privileged operations, and hardens the renderer execution environment.

#### A. Unified IPC Registration and Sender Validation Boundary (`src/ipc-boundary.ts`)
- **Sender Frame & Identity Verification:** Every incoming IPC invocation on all 38 channels is mediated by `IpcBoundary.validateIpcSender`:
  1. `mainWindow` must exist and match `event.sender === mainWindow.webContents` (rejects calls from any foreign browser window or detached context).
  2. `event.senderFrame.parent === null` strictly enforces top-level frame invocation (rejects iframes, child frames, and nested browsing contexts).
  3. Document URL validation:
     - In packaged production (`app.isPackaged` or `productionOverride === true`), the document URL must strictly start with `file://` and point to the approved `dist/renderer/index.html`. Loopback URLs (`http://localhost:*`, `http://127.0.0.1:*`) are rejected immediately.
     - In development (`!app.isPackaged`), approved documents are restricted to the local loopback dev server (`http://localhost:5173/*`, `http://127.0.0.1:5173/*`) or local filesystem `file://` URLs.
  4. Desync Detection: The sender frame URL and the window `webContents.getURL()` are verified to point to the same origin; if a navigation occurs or URLs desync, the call fails closed.
  5. Blank Origin Rejection: `about:blank`, `data:`, `blob:`, and untrusted foreign web URLs are rejected fail-closed with `IpcSecurityError`.
- **Registration Wrappers:**
  - `registerSecureHandler(channel, validator, handler)`: Wraps `ipcMain.handle`.
  - `registerSecureListener(channel, validator, listener)`: Wraps `ipcMain.on`.
- **Exception Sanitization:** Errors thrown during IPC handling are logged main-side with detailed diagnostic information via `LauncherLogger.warn`, but scrubbed before returning to the renderer via `sanitizeIpcError` (stripping internal stack traces and leaking paths).

#### B. Strict Runtime Allowlist Schema for Settings (`config:set`)
- Replaced open dictionary merging and caller blacklists with `validateConfigSet`:
  - Permitted settings keys: `portalUrl`, `selectedChannel`, `allocatedRamGb`, `noSync`, `javaPath`, `javaArgs`.
  - Any unlisted key (including `token`, `refreshToken`, `minecraftAccessToken`, `sessionPortalUrl`, `gameDir`, `customClientMods`, `disabledClientMods`) throws `IpcValidationError`.
  - Prototype pollution guards reject `__proto__`, `constructor`, `prototype`.
  - Type validations:
    - `portalUrl`: Non-empty string validated against `normalizePortalUrl`.
    - `selectedChannel`: Allowed enum string (`"stable" | "beta" | "alpha"`).
    - `allocatedRamGb`: Integer between 1 and 64.
    - `noSync`: Boolean.
    - `javaPath`: String or undefined.
    - `javaArgs`: String or undefined.
- **Privileged Java Arguments Detection:**
  - When `config:set` updates `javaPath` or `javaArgs`, arguments are parsed and analyzed by `isPrivilegedJavaArg`.
  - Flags flagged as privileged include: `-javaagent:`, `-agentlib:`, `-agentpath:`, `@argfile`, `-cp`, `--class-path`, `--module-path`, `-Djava.system.class.loader=`, `-Xbootclasspath`.
  - Updating custom `javaPath` or privileged `javaArgs` requires explicit native user approval; unapproved calls trigger a native confirmation modal (`confirmPrivilegedOperation`).

#### C. Main-Owned Launch Authority (`game:launch`)
- `game:launch` accepts **zero renderer parameters** (`handler(event)` without renderer arguments).
- Previously, the renderer passed `{ user: UserProfile | null, releaseOverride?: any }`, permitting caller injection of user identities and arbitrary release descriptors.
- Main process directly owns launch authority:
  1. Authenticated user session is refreshed directly from main storage via `LauncherAuth.refreshSession()`. If not authenticated or refresh fails, launch rejects.
  2. Release descriptor is loaded directly from trusted local disk (`.lampas/release.json`).
  3. Release descriptor is cross-checked against `.lampas/installation.json` (channel, version, sync generation). Caller cannot supply or override release payloads.

#### D. Main-Owned Mod Authority (`mods:*`)
- **Official Mod Enforcement (`mods:setOfficialEnabled`):**
  - Queries Portal mod catalog for the specified mod ID.
  - If the mod catalog does not have `canDisable === true`, the disable request is rejected (`"Mod <id> is required by the server modpack and cannot be disabled"`).
- **Custom Mod Validation (`mods:browseAndAdd`, `mods:addPaths`):**
  - File import strictly validates `.jar` extension, file existence, regular file stat, and size limit (<= 100MB).
  - Directory imports or non-jar files are rejected fail-closed.
  - Adding mod paths requires explicit native user approval (`confirmPrivilegedOperation`).

#### E. Single-Use Native Approval Workflow for Privileged Operations
- Privileged operations requiring native approval:
  1. `gameDir:configure` (re-targeting launcher game directory)
  2. `gameDir:move` (moving game directory contents)
  3. `mods:addPaths` (importing custom mods from external filesystem paths)
  4. `config:set` with custom `javaPath` or privileged `javaArgs`
- **Security Invariants:**
  - Caller-supplied `preApproved` flags are ignored.
  - Approvals are granted solely main-side via native dialogs (`dialog.showOpenDialog`, `dialog.showMessageBox`).
  - Approvals are registered in an in-memory approval table with a 60-second TTL.
  - Approvals are single-use: consuming an approval immediately deletes it from the registry.
  - Approvals are bound to the document generation: navigating or reloading the window advances the document generation and invalidates all pending approvals.
  - Unapproved privileged actions trigger a native Electron modal confirmation dialog (`dialog.showMessageBox` with `parent: mainWindow`). If the user cancels, the operation is aborted.

#### F. Hardened Renderer Execution Environment & Navigation Policy
- **Window Configuration (`src/main.ts`):**
  - `sandbox: true`
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `webSecurity: true`
  - `allowRunningInsecureContent: false`
- **Packaged Mode Enforcement:**
  - If `app.isPackaged` (or `productionOverride === true`), `VITE_DEV_SERVER_URL` is unconditionally ignored, and `mainWindow.loadFile(dist/renderer/index.html)` is enforced.
- **Strict Content Security Policy (CSP):**
  - Enforced via both HTML `<meta>` tag and HTTP header modification (`session.defaultSession.webRequest.onHeadersReceived`):
  - `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: https:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';`
  - `unsafe-eval` is strictly forbidden.
- **Navigation & External Links:**
  - `setWindowOpenHandler`: Denies creation of new auxiliary browser windows or webviews. Valid external HTTP/HTTPS URLs are opened safely via `validateWebUrl(url)` and `shell.openExternal`.
  - `will-navigate` & `will-redirect`: Intercepted and blocked on the main window.
  - `will-attach-webview`: Intercepted and rejected (`event.preventDefault()`).
  - `setPermissionRequestHandler`: Rejects all permission requests fail-closed.

---

### 3. Comprehensive Inbound IPC Channel Inventory

All 38 inbound IPC channels (37 handlers + 1 listener) are registered through the secure boundary with dedicated validators:

| # | Channel Name | Type | Line | Validator | Privileged Approval | Arguments | Description / Action | Return Type |
|---|---|---|---|---|---|---|---|---|
| 1 | `window:minimize` | `handle` | 512 | None | No | None | Minimizes main window | `void` |
| 2 | `window:maximize` | `handle` | 517 | None | No | None | Toggles maximize / unmaximize | `void` |
| 3 | `window:isMaximized` | `handle` | 526 | None | No | None | Queries maximized state | `boolean` |
| 4 | `window:close` | `handle` | 530 | None | No | None | Closes main window | `void` |
| 5 | `utils:getAppVersion` | `handle` | 535 | None | No | None | Returns launcher version | `string` |
| 6 | `utils:openPath` | `handle` | 539 | `validateOpenPath` | No | `rawPath: string` | Opens web URLs via `shell.openExternal`; local paths rejected | `string` |
| 7 | `utils:openSourcePage` | `handle` | 545 | `validateOpenSourcePage` | No | `rawUrl: string` | Validates HTTP(S) URL via `validateWebUrl`; opens in browser | `void` |
| 8 | `utils:openKnownLocation` | `handle` | 550 | `validateOpenKnownLocation` | No | `target: KnownLocationId` | Opens validated known location (`modsDir`, `logsDir`, `launcherLog`, `minecraftLog`) | `string` |
| 9 | `utils:getLogPath` | `handle` | 556 | None | No | None | Returns active launcher log file path | `string` |
| 10 | `utils:openLogsDir` | `handle` | 560 | None | No | None | Opens logs directory via `openKnownLocation("logsDir")` | `string` |
| 11 | `utils:openLogFile` | `handle` | 564 | None | No | None | Opens launcher log file via `openKnownLocation("launcherLog")` | `string` |
| 12 | `utils:getMinecraftLogPath` | `handle` | 568 | None | No | None | Returns latest Minecraft log path | `string` |
| 13 | `utils:openMinecraftLog` | `handle` | 572 | None | No | None | Opens Minecraft log file via `openKnownLocation("minecraftLog")` | `string` |
| 14 | `config:get` | `handle` | 576 | None | No | None | Returns sanitized settings DTO (secrets redacted) | `RendererSettingsDto` |
| 15 | `config:set` | `handle` | 580 | `validateConfigSet` | Custom javaPath / privileged javaArgs | `patch: UpdateSettingsDto` | Updates settings under strict allowlist schema; triggers native confirmation for privileged javaPath/javaArgs | `RendererSettingsDto` |
| 16 | `gameDir:getStatus` | `handle` | 602 | None | No | None | Returns current gameDir state and default path | `GameDirStatusDto` |
| 17 | `gameDir:browse` | `handle` | 610 | `validateGameDirBrowse` | Grants Approval | `defaultPath?: string` | Displays native folder picker dialog; grants single-use approval for chosen path | `OpenDialogReturnValue` |
| 18 | `gameDir:validate` | `handle` | 622 | `validateGameDirValidateArgs` | No | `targetPath: string, currentPath?: string` | Checks directory syntax, drive roots, existence, writability | `GameDirValidationResult` |
| 19 | `gameDir:configure` | `handle` | 627 | `validateGameDirTarget` | Yes (Native Dialog / Browse) | `targetPath: string` | Re-targets `gameDir`; requires native approval token or confirmation dialog | `RendererSettingsDto` |
| 20 | `gameDir:move` | `handle` | 641 | `validateGameDirTarget` | Yes (Native Dialog / Browse) | `targetPath: string` | Moves game directory; requires native approval token or confirmation dialog | `DirectoryMoveResult` |
| 21 | `auth:login` | `handle` | 659 | None | No | None | Zero-arg; authenticates via canonical configured Portal with generation binding | `{ user: RendererUserProfile }` |
| 22 | `auth:logout` | `handle` | 664 | None | No | None | Zero-arg; clears credentials, session portal, advances generation | `void` |
| 23 | `auth:verify` | `handle` | 669 | None | No | None | Zero-arg; verifies session with bound portal | `{ valid: boolean; user?: RendererUserProfile }` |
| 24 | `auth:refresh` | `handle` | 674 | None | No | None | Zero-arg; refreshes session with bound portal | `{ valid: boolean; user?: RendererUserProfile }` |
| 25 | `server:getStatus` | `handle` | 679 | None | No | None | Zero-arg; queries Portal server status with manual redirect | `ServerStatus` |
| 26 | `sync:start` | `handle` | 683 | None | No | None | Executes standard sync pipeline | `SyncResult` |
| 27 | `sync:repair` | `handle` | 702 | None | No | None | Executes full hash audit and repair | `SyncResult` |
| 28 | `sync:getModCatalog` | `handle` | 722 | None | No | None | Reads mod catalog from Portal endpoint | `ModCatalogItem[]` |
| 29 | `sync:getInstalledRuntime` | `handle` | 726 | None | No | None | Reads local `.lampas/release.json` and `installation.json` | `InstalledRuntimeDto \| null` |
| 30 | `mods:browseAndAdd` | `handle` | 730 | None | Grants Approval | None | Displays native file picker for `.jar` files; imports approved files | `CustomClientMod[]` |
| 31 | `mods:addPaths` | `handle` | 741 | `validateModPaths` | Yes (Native Dialog / Browse) | `paths: string[]` | Validates and imports external `.jar` files; requires native approval or confirmation dialog | `CustomClientMod[]` |
| 32 | `mods:setOfficialEnabled` | `handle` | 754 | `validateOfficialModToggle` | Main Authority | `id: string, enabled: boolean` | Enforces mod catalog `canDisable === true`; required mods cannot be disabled | `string[]` |
| 33 | `mods:setCustomEnabled` | `handle` | 765 | `validateCustomModToggle` | No | `filename: string, enabled: boolean` | Toggles custom mod between `.jar` and `.jar.disabled` | `CustomClientMod[]` |
| 34 | `mods:removeCustom` | `handle` | 770 | `validateCustomModFilename` | No | `filename: string` | Deletes custom mod from `gameDir/mods/` | `CustomClientMod[]` |
| 35 | `game:launch` | `handle` | 775 | None | Main Authority | None | Zero-arg; main-owned launch authority; refreshes session and validates release descriptor | `boolean` |
| 36 | `game:kill` | `handle` | 800 | None | No | None | Terminates running game process | `void` |
| 37 | `game:isRunning` | `handle` | 804 | None | No | None | Queries running game status | `boolean` |
| 38 | `game:logAck` | `on` (listener) | 809 | `validateLogAck` | No | `lastSequence: number` | Acknowledges stream log sequence | `void` |

---

### 4. Verification Evidence

#### A. Security Boundary Characterization Suite (`test/security-boundary-characterization.ts`)
Executed in isolated child process with outbound network enforcement and complete Electron mocks:
- Total Tests: **46 passed, 0 failed, 0 outbound policy violations, 0 skipped**
- **Phase 2 Tests (Tests 39-46):**
  - **Test 39:** Unauthorized IPC callers rejected (foreign BrowserWindow webContents, child frames with `parent !== null`, unapproved document origins).
  - **Test 40:** `config:set` allowlist schema strictly enforced (rejects `gameDir`, `token`, `sessionPortalUrl`, unexpected keys, prototype pollution).
  - **Test 41:** Main-owned launch authority (`game:launch` rejects renderer-supplied overrides; fetches user and release main-side).
  - **Test 42:** Main-owned mod authority (`mods:setOfficialEnabled` blocks disabling official mods when `canDisable !== true` in catalog).
  - **Test 43:** Custom mod import validation (`mods:addPaths` rejects non-jar files, directory paths, and non-existent files).
  - **Test 44:** Native approval & privileged `javaArgs` detection (flags `-javaagent:`, `@argfile`, etc.; single-use consumption; document generation invalidation).
  - **Test 45:** Packaged build renderer lockdown (production rejects loopback dev server, requires `file://` index).
  - **Test 46:** Positive end-to-end paths (secure handlers succeed with valid sender, top-level frame, and approved inputs).

#### B. Regression Gates Suite (`test/security-regression-gates.test.ts`)
- Total Tests: **8 passed, 0 failed, 5 skipped (Phases 3/4/6), 7 todo (Phases 3-7)**
- **Phase 2 Gate 1:** Operation-level sender frame validation and rejection of foreign windows, child iframes, and desynced documents (Passed).
- **Phase 2 Gate 2:** Operation-level `config:set` strict allowlist schema rejecting unapproved runtime fields and credential injection (Passed).

#### C. Parent Characterization Suite (`test/security-characterization.test.ts`)
- Total Tests: **16 passed, 0 failed, 90 expect() calls**
- 15 unit/component security tests + 1 child runner assertion verifying all 46 boundary characterizations.

#### D. Full Launcher Test Suite (`bun test`)
- Total Tests: **285 passed, 0 failed, 5 skipped, 7 todo across 34 test files** (1146 expect() calls).

#### E. Smoke Test Verification (`bun run smoke`)
- Real Electron dev/dist unpacked execution: **Exit code 0, init: true, handlers: true, roundTrip: true**.
- Packaged binary execution (ASAR verification): **Exit code 0, init: true, handlers: true, roundTrip: true**.

#### F. Dependency & Lockfile Integrity
- `git diff bun.lock`: **0 changes (byte-for-byte identical)**.
- Frozen lockfile verification: `bun install --frozen-lockfile` confirmed clean.

---

### 5. Finding Status & Remaining Scope (SEC-01 to SEC-12)

| Finding ID | Priority | Phase | Status at Review Gate 2 | Remediation & Remaining Scope |
|---|---|---|---|---|
| **SEC-01** | P0 / High | Phase 1 | **Remediated & Verified** | Complete Phase 1 remediation preserved intact: canonical origin policy, session origin binding, race safety, manual redirect rejection, disk scrubbing. |
| **SEC-02** | P0 / High | Phase 1 / Phase 2 | **Remediated & Verified** | • Web link sink and opener paths hardened in Phase 1.<br>• All 38 inbound IPC channels registered through unified security boundary (`registerSecureHandler`, `registerSecureListener`).<br>• Top-level sender frame verification (`event.senderFrame.parent === null`), main window verification, document URL approval, and desync detection.<br>• Strict settings allowlist schema (`validateConfigSet`) rejecting unexpected keys, credentials, and prototype pollution.<br>• Main-owned launch authority (`game:launch` zero args; main-managed auth refresh and release descriptor).<br>• Main-owned mod authority (catalog `canDisable === true` enforcement; .jar file validation).<br>• Single-use native approval workflow with TTL and document generation invalidation.<br>• Packaged renderer lockdown (enforces `file://`, ignores `VITE_DEV_SERVER_URL`), strict CSP without `unsafe-eval`, externalized navigation, webviews/auxiliary windows denied, fail-closed permissions. |
| **SEC-03** | P1 / High | Phase 3 | Pending | Plaintext credential persistence in `config.json`. Deferred to Phase 3 (Keyring / Session Store). |
| **SEC-04** | P0 / High | Phase 4 | Pending | Path containment & ownership inconsistencies (`isPathProtected`). Deferred to Phase 4. |
| **SEC-05** | P1 / Med-High | Phase 4 | Pending | Move recovery recursive deletion of unvalidated staging path. Deferred to Phase 4. |
| **SEC-06** | P1 / High-Cond | Phase 5 | Pending | Executable verification fails open (missing hash fallback). Deferred to Phase 5. |
| **SEC-07** | P1 / High-Cond | Phase 5 | Pending | Inappropriate fallback on HTTP 410 REVOKED releases. Deferred to Phase 5. |
| **SEC-08** | P1 / Medium | Phase 3 | Pending | OAuth callback server denial-of-service / hanging connection. Deferred to Phase 3. |
| **SEC-09** | P1 / Medium | Phase 6 | Pending | Logging redaction gaps (`refresh_token`, URL query codes, CLI args). Deferred to Phase 6. |
| **SEC-10** | P2 / Med-Priv | Phase 6 | Pending | Third-party information disclosure (`mc-heads.net`, unvalidated image URLs). Deferred to Phase 6. |
| **SEC-11** | P2 / Medium | Phase 5 | Pending | Unbounded decompression ingestion budgets in `ensureNatives`. Deferred to Phase 5. |
| **SEC-12** | P2 / Medium | Phase 7 | Pending | Release pipeline permissions and mutable action pins. Deferred to Phase 7. |

---

### 6. Review Gate 2 Acceptance Confirmation

- **Phase 2 Scope Fully Implemented & Verified:**
  - Complete IPC registration and validation boundary in place (`registerSecureHandler`, `registerSecureListener`).
  - All 38 inbound channels inventoried, validated, and protected against unauthorized or desynced callers.
  - Strict allowlist settings schema in production.
  - Main-owned launch and mod authority enforced.
  - Native approval workflow operating for privileged actions.
  - Packaged renderer hardened with strict CSP and navigation denial.
- **Outbound Request Policy Harness Verified:**
  - Zero unapproved outbound network requests detected during isolated boundary execution.
- **Pre-Existing Invariants:**
  - All baseline and Phase 1 tests pass with zero regressions (285 passed across 34 test files).
- **Dependencies & Lockfile:**
  - `bun.lock` is byte-for-byte identical with baseline. Zero dependency mutations.
- **Typecheck & Packaging:**
  - Production typecheck (`bun run typecheck`), security test typecheck (`tsconfig.security-test.json`), production Vite packaging (`bun run build`), and Electron smoke tests (`bun run smoke`) pass cleanly with 0 errors.

**STOPPING AT REVIEW GATE 2.** Phase 3 (Keyring / Session Store & Race-Safe Auth) has not been implemented and remains paused. Ready for commit, push, and Review Gate 2 review.
