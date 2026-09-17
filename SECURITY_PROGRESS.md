# Lampas Launcher — Security Hardening Progress

## Review Gate 2 — Narrow IPC Capabilities and Lock Down the Renderer (SEC-02)

- **Execution Date:** 17-18 September 2026
- **Status:** Complete (Review Gate 2 amended implementation verified; Phase 2 complete; paused before Phase 3)
- **Accepted Baseline Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc`
- **Accepted Review Gate 1 Checkpoint:** `e1d029112bd4b2843d61ccc19891556192e3efeb`
- **Reviewed Gate 2 Checkpoint:** `689800eda9c6b56910546cf608b34f243029d1db`
- **Amended Gate 2 Checkpoint:** `HEAD` on branch `feat/security`
- **Current Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 2 ("Narrow IPC capabilities and lock down the renderer"). Phase 3 (OS keyring/DPAPI), Phase 4 (Path containment), and subsequent phases remain paused. Acceptance does not close any subsequent production security finding or authorize merging, tagging, or publication.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A complete audit of changes was performed against the accepted Review Gate 1 checkpoint (`e1d029112bd4b2843d61ccc19891556192e3efeb`) and the baseline:

| Dimension | Accepted Baseline (`149f100`) | Accepted RG 1 (`e1d0291`) | Amended RG 2 (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline (`0 lines`) | 8 files modified, 1 added | 9 files modified, 2 added (`src/portal-policy.ts`, `src/ipc-boundary.ts`) | **Constrained strictly to Phase 2 hardening** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical (zero package mutations; 0 diff)** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | 8 passed (RG 0.1) | 38 passed | **51 passed, 0 failed, 0 outbound violations, 0 skipped** | **+13 Phase 2 dynamic tests (Tests 39-51)** |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | 16 passed | 16 passed | **16 passed (15 unit/component + 1 child runner assertion verifying all 51)** | **16/16 passing (95 expect calls)** |
| **Regression Gates (`test/security-regression-gates.test.ts`)** | 6 passed (Phase 1) | 6 passed | **8 passed, 0 failed, 5 skipped, 7 todo** | **Phase 2 gates unskipped and passing** |
| **Full Test Suite (`bun test`)** | 277 passed | 283 passed | **285 passed, 0 failed, 5 skipped, 7 todo across 34 files** | **All 34 test files pass cleanly (1151 expect calls)** |
| **Security Test Typecheck** | 0 errors | 0 errors | **0 errors (`tsconfig.security-test.json`)** | **0 errors** |
| **Production Typecheck & Build** | Clean | Clean | **0 errors (`tsc --noEmit && tsc -p tsconfig.renderer.json --noEmit` and `vite build`)** | **0 errors** |
| **Electron Smoke & Adversarial Tests** | Passed | Passed | **Passed (unpacked dev/dist + packaged binary ASAR + adversarial assertions)** | **0 errors (no `--no-sandbox`)** |

**Documentation and Ignore Invariants:**
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **tracked under git**.

---

### 2. Review Gate 2 Defect Remediation Details

Following the review of checkpoint `689800eda9c6b56910546cf608b34f243029d1db`, all six reviewed defect categories have been completely amended and rigorously verified:

#### Item 1: Complete Java-Argument Privilege Classification Across Full Taxonomy
- **Root Problem in Prior Checkpoint:** Privilege classification only scanned for a handful of prefix substrings (e.g. `-javaagent:`) and missed `-jar`, positional main class/source file operands, equals-form module options, argument files (`@...`), command execution hooks (`-XX:OnError=`, `-XX:OnOutOfMemoryError=`), diagnostic dump file redirection (`-XX:ErrorFile=`), module patching/export options, and JDWP debugging. Furthermore, launch target control was not strictly reserved to main.
- **Remediation Implemented:**
  - Implemented `parseJavaArgs` (pure token parsing supporting quotes and whitespace) and `classifyJavaArgs` in `src/ipc-boundary.ts`.
  - Classifies complete taxonomy:
    1. **Launch Target Overrides:** Classifies any token not starting with `-` as a launch-target override operand (positional main class, source `.java` file, or argument file `@...`). Also flags `-jar` (and its operand) and module options (`-m`, `--module`, `-m=...`, `--module=...`). `hasLaunchTargetOverride: true` is strictly reserved to main authority.
    2. **Privileged / Sensitive Options:** Flags class paths (`-cp`, `-classpath`, `--class-path`), module paths (`-p`, `--module-path`), module patches/reads/exports/opens (`--patch-module`, `--upgrade-module-path`, `--add-reads`, `--add-exports`, `--add-opens`), java agents (`-javaagent:`), native agents (`-agentlib:`, `-agentpath:`), bootstrap classpath (`-Xbootclasspath`), command execution hooks (`-XX:OnError=`, `-XX:OnOutOfMemoryError=`, `-XX:ErrorFile=`), custom system class loaders (`-Djava.system.class.loader=`), security managers (`-Djava.security.manager=`), and JDWP debug options.
    3. **Ordinary Reviewed Tuning Options:** Explicitly permits standard GC and performance tuning without requiring native approval: heap bounds (`-Xmx`, `-Xms`, `-Xmn`, `-Xss`), collectors (`-XX:+UseG1GC`, `-XX:+UseZGC`, `-XX:+UseParallelGC`, `-XX:+UseSerialGC`), GC tuning (`-XX:MaxGCPauseMillis=`, `-XX:G1ReservePercent=`, etc.), pre-touch (`-XX:+AlwaysPreTouch`), string deduplication, standard system properties (`-Dfile.encoding=UTF-8`, `-Duser.language=en`, etc.).
  - **Sink Verification:** Enforced at both the settings ingress handler (`config:set` rejects launch target overrides fail-closed and requires user approval for privileged options) AND the final process-argument sink (`buildLaunchArguments` in `src/game-runner.ts` classifies tokens and rejects launch target overrides fail-closed).
  - Process execution intercepted in all tests via mock harness; zero real processes spawned.

#### Item 2: Document Trust Independent of Load Observations & Strict Sender Frame Validation
- **Root Problem in Prior Checkpoint:** The boundary previously accepted a `productionOverride` flag in tests and updated its approved document on `did-finish-load`, meaning any URL that finished loading could potentially be trusted.
- **Remediation Implemented:**
  - Removed `productionOverride`. Established startup trust policy via `IpcBoundary.initializeStartupPolicy({ isPackaged, devEndpoint, appPath })` invoked in `main.ts` `app.whenReady()`.
  - `did-finish-load` and `did-start-navigation` events advance document generation and invalidate existing approvals, but **never** dynamically approve loaded URLs.
  - In `validateIpcSender`:
    1. Validates main window webContents equality (`event.sender === mainWindow.webContents`).
    2. Enforces top-level frame identity (`event.senderFrame.parent === null`).
    3. Strictly checks attachment to active main frame (`event.senderFrame === event.sender.mainFrame`).
    4. In packaged production, requires document protocol `file:` pointing strictly to normalized `dist/renderer/index.html`. Rejects loopback HTTP(S) URLs.
    5. In development, confines allowed origins strictly to the explicitly initialized `devEndpoint` (`new URL(devEndpoint).origin`).
    6. Uses standard `fileURLToPath` for path conversion.
    7. Strictly rejects foreign file-URL authorities (`parsed.hostname !== "" && parsed.hostname !== "localhost"`).
    8. Detects frame-to-window desync (`event.sender.getURL() !== frameUrl`).

#### Item 3: Native Approval Bound to the Initiating Operation
- **Root Problem in Prior Checkpoint:** Approvals were not bound to the initiating operation/document generation, allowing approvals to outlive navigation or reload. Missing native dialog support did not fail closed cleanly.
- **Remediation Implemented:**
  - **Snapshotting:** `IpcBoundary.createApprovalSnapshot(event)` captures `{ generation, window, frame }` prior to launching native dialogs.
  - **Post-Dialog Revalidation:** `IpcBoundary.validateApprovalSnapshot(snapshot)` re-checks that document generation has not incremented, window has not been destroyed or replaced, and sender frame remains active and attached. If navigation occurred while dialog was open, the approval is denied fail-closed.
  - **Operation Coordination Barrier:** Mutating handlers (`config:set`, `gameDir:browse`, `gameDir:configure`, `gameDir:move`, `mods:browseAndAdd`, `mods:addPaths`) recheck `OperationCoordinator.assertCanMutate(...)` after the async native dialog resolves, preventing race conditions if an asynchronous operation (e.g. sync or launch) commenced while the dialog was awaiting user input.
  - **Platform-Correct Path Normalization:** `normalizeApprovalTarget(target)` normalizes paths platform-correctly: case-insensitive on Windows (`.toLowerCase()`), case-distinct on Linux/POSIX.
  - **Single-Use Consumption:** `consumeApproval(operation, target)` immediately purges the approval token upon consumption, including during browse-and-import workflows.
  - **Fail-Closed on Missing Dialog:** `confirmPrivilegedOperation` checks dialog availability; if `dialog.showMessageBox` is unavailable, throws `IpcSecurityError` immediately.
  - **Configured TTL:** Documented and verified 60-second TTL (`APPROVAL_TTL_MS = 60_000`).

#### Item 4: Complete Main-Owned Launch Admission
- **Root Problem in Prior Checkpoint:** Authentication refresh was duplicated between `main.ts` and `game-runner.ts`. `game-runner.ts` did not fail closed on missing or empty `installation.json`, allowing uninstalled states to fall through.
- **Remediation Implemented:**
  - **Single Consolidated Auth Resolution:** `game:launch` in `main.ts` resolves the authenticated user via `LauncherAuth.refreshSession()` exactly once and passes the resolved, verified `UserProfile` to `GameRunner.launchGame(user, ...)`. `launchGame` uses this caller-provided identity, eliminating redundant HTTP roundtrips.
  - **Mandatory Installation State Evidence:**
    - `installation.json` must exist. Missing file throws `"Missing installation state metadata: No installed modpack found. Please synchronize or repair your modpack installation first."`.
    - Corrupted or empty `{}` state throws `"Installation state metadata is empty. Please synchronize or repair your modpack installation first."`.
    - Mandatory string `version` property is required. Missing version throws `"Installation state metadata is missing mandatory 'version' field. Please synchronize or repair."`.
    - Version must match `release.json`. Mismatch throws `"Incompatible installation state detected: installed version '...' does not match release descriptor '...'."`.
  - **Preservation of `noSync` Semantics:** Setting `noSync: true` skips remote manifest synchronization, but **does not bypass** local installation admission checks.
  - **Complete Authenticated Launch Regression:** Test 50 exercises the full end-to-end admission flow with valid release and installation fixtures, confirming session verification and intercepted spawn sink arguments (`Player`, `26.2`).

#### Item 5: Renderer Lockdown and IPC Error Restrictions
- **Root Problem in Prior Checkpoint:** Permissions policy only implemented request handlers without check handlers. IPC errors leaked internal paths and stack traces. Prior reports made inaccurate claims about CSP in HTML head vs headers.
- **Remediation Implemented:**
  - **Dual Permission Lockdown:** Installed both `setPermissionCheckHandler` and `setPermissionRequestHandler` on the main session before loading application content. Both reject all permission checks and requests (media, geolocation, notifications, midi, etc.) fail-closed with warning logs.
  - **IPC Error Sanitization:** All IPC handler errors are sanitized through `sanitizeIpcError`:
    - Security violations are masked to `"Security violation: IPC request rejected."`.
    - Generic errors have internal Windows drive paths (`[A-Za-z]:\\[^'"\s]+`) and POSIX absolute paths (`/[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)+`) scrubbed and replaced with `<path>`.
    - Internal stack traces are stripped before passing to renderer.
  - **Accurate Architectural Claims:**
    - Documented CSP is enforced via HTTP header modification (`session.defaultSession.webRequest.onHeadersReceived`) and meta tag.
    - Verified approval TTL is strictly 60 seconds (`APPROVAL_TTL_MS = 60_000`).
    - Verified custom mod file size limit is strictly 100MB (`MAX_CUSTOM_MOD_FILE_SIZE_BYTES = 100 * 1024 * 1024`).

#### Item 6: Repaired and Extended Verification Evidence
- **Root Problem in Prior Checkpoint:** Mock lifecycle events did not invoke actual registered handlers. Child harness did not verify all new Phase 2 security invariants. Smoke test did not perform real adversarial checks.
- **Remediation Implemented:**
  - Extended isolated child process characterization harness (`test/security-boundary-characterization.ts`) from 46 to 51 exhaustive tests, covering all taxonomy classifications, document trust independence, native approval barriers, consolidated launch admission, and permission lockdown.
  - Mock lifecycle events directly invoke actual registered handlers and listeners (`ipcHandlers.get(channel)`).
  - Enhanced packaged and unpacked Electron smoke test (`test/smoke/electron-smoke.ts` and `src/main.ts` `--smoke-test`) to execute real adversarial checks:
    - Verifies `nodeIntegration` is disabled in the running renderer.
    - Verifies raw `ipcRenderer` is not exposed on `window`.
    - Verifies adversarial `config:set` injecting `token` or `sessionPortalUrl` is rejected.
    - Verifies `utils:openPath` with local path is rejected.
    - Verifies permission queries for media/geolocation are denied.
  - Strict packaged distribution verified without `--no-sandbox`.
  - Artifact SHA-256 hashes recorded:
    - `release\win-unpacked\resources\app.asar`: `42019DD6F08B69C88BFE9647FE2F2324C13D670CA76EC4DA79AE511B52BBB89E`
    - `release\win-unpacked\Lampas Launcher.exe`: `8CDD6D3AB16CE8EEF11EE65C4F6B33802AE9453EC53F8AF4B39448B711E108A7`
  - Honest accounting of unavailable native platform coverage: Windows host tested directly; Linux case-distinct target logic verified via platform-specific branch testing; macOS/Linux packaging unexecutable on Windows recorded honestly.

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
| 35 | `game:launch` | `handle` | 757 | None | Main Authority | None | Zero-arg; main-owned launch authority; refreshes session and validates release descriptor | `boolean` |
| 36 | `game:kill` | `handle` | 782 | None | No | None | Terminates running game process | `void` |
| 37 | `game:isRunning` | `handle` | 786 | None | No | None | Queries running game status | `boolean` |
| 38 | `game:logAck` | `on` (listener) | 788 | `validateLogAck` | No | `lastSequence: number` | Acknowledges stream log sequence | `void` |

---

### 4. Verification Evidence

#### A. Security Boundary Characterization Suite (`test/security-boundary-characterization.ts`)
Executed in isolated child process with outbound network enforcement and complete Electron mocks:
- Total Tests: **51 passed, 0 failed, 0 outbound policy violations, 0 skipped**
- **Phase 2 Tests (Tests 39-51):**
  - **Test 39:** Unauthorized IPC callers rejected (foreign BrowserWindow webContents, child frames with `parent !== null`, unapproved document origins).
  - **Test 40:** `config:set` allowlist schema strictly enforced (rejects `gameDir`, `token`, `sessionPortalUrl`, unexpected keys, prototype pollution).
  - **Test 41:** Main-owned launch authority (`game:launch` rejects renderer-supplied overrides; fetches user and release main-side).
  - **Test 42:** Main-owned mod authority (`mods:setOfficialEnabled` blocks disabling official mods when `canDisable !== true` in catalog).
  - **Test 43:** Custom mod import validation (`mods:addPaths` rejects non-jar files, directory paths, and non-existent files).
  - **Test 44:** Native approval & privileged `javaArgs` detection (flags `-javaagent:`, `@argfile`, etc.; single-use consumption; document generation invalidation).
  - **Test 45:** Packaged build renderer lockdown (production rejects loopback dev server, requires `file://` index).
  - **Test 46:** Positive end-to-end paths (secure handlers succeed with valid sender, top-level frame, and approved inputs).
  - **Test 47:** Complete Java-argument privilege classification across full taxonomy (launch target overrides, sensitive options, ordinary tuning, settings handler confirmation/rejection, and process argument sink).
  - **Test 48:** Document trust independent of load observations and strict sender frame validation (did-finish-load does not approve arbitrary documents, unapproved dev ports rejected, detached frames rejected, foreign file URL authorities rejected).
  - **Test 49:** Native approval binding (snapshot revalidation on generation advance, window loss, or frame detachment; operation conflict barriers during dialog; single-use consumption; platform-correct case normalization; 60s TTL).
  - **Test 50:** Main-owned launch admission (consolidated auth refresh; mandatory `installation.json` existence, non-emptiness, and version matching; `noSync` admission preservation; intercepted spawn verification).
  - **Test 51:** Renderer permission lockdown and error sanitization (dual check/request handler denial; error sanitization masking security errors and scrubbing paths).

#### B. Regression Gates Suite (`test/security-regression-gates.test.ts`)
- Total Tests: **8 passed, 0 failed, 5 skipped (Phases 3/4/6), 7 todo (Phases 3-7)**
- **Phase 1 Gates (6 tests):** URL helper normalization, production portal policy, origin-change invalidation, web link sink protocol enforcement, session origin binding, legacy migration disk cleanup. All passed.
- **Phase 2 Gates (2 tests):**
  - Sender frame validation and rejection of foreign windows, child iframes, and desynced documents (Passed).
  - `config:set` strict allowlist schema rejecting unapproved runtime fields and credential injection (Passed).

#### C. Parent Characterization Suite (`test/security-characterization.test.ts`)
- Total Tests: **16 passed, 0 failed, 95 expect() calls**
- 15 unit/component security tests + 1 child runner assertion verifying all 51 boundary characterizations.

#### D. Full Launcher Test Suite (`bun test`)
- Total Tests: **285 passed, 0 failed, 5 skipped, 7 todo across 34 test files** (1151 expect() calls).

#### E. Strict Packaged Electron Smoke & Adversarial Verification (`bun run smoke --strict`)
- **Unpacked dev/dist execution:** Exit code 0, init: true, handlers: true, roundTrip: true, adversarial: true.
- **Packaged distribution execution:** ASAR size 3.27 MB, Exit code 0, init: true, handlers: true, roundTrip: true, adversarial: true.
- **Publishing safety:** publish: never, CI linux artifacts guaranteed.
- **Zero `--no-sandbox`:** Tests run under standard sandbox constraints.

#### F. Dependency & Lockfile Integrity
- `git diff bun.lock`: **0 changes (byte-for-byte identical)**.
- Frozen lockfile verification: `bun install --frozen-lockfile` confirmed clean.

---

### 5. Finding Status & Remaining Scope (SEC-01 to SEC-12)

| Finding ID | Priority | Phase | Status at Review Gate 2 | Remediation & Remaining Scope |
|---|---|---|---|---|
| **SEC-01** | P0 / High | Phase 1 | **Remediated & Verified** | Complete Phase 1 remediation preserved intact: canonical origin policy, session origin binding, race safety, manual redirect rejection, disk scrubbing. |
| **SEC-02** | P0 / High | Phase 1 / Phase 2 | **Remediated & Verified** | • Web link sink and opener paths hardened in Phase 1.<br>• All 38 inbound IPC channels registered through unified security boundary (`registerSecureHandler`, `registerSecureListener`).<br>• Top-level sender frame verification (`event.senderFrame.parent === null`), main window verification, document URL approval, and desync detection.<br>• Strict settings allowlist schema (`validateConfigSet`) rejecting unexpected keys, credentials, and prototype pollution.<br>• Complete Java argument privilege classification across full taxonomy; launch-target control reserved to main; verified at settings handler and process sink.<br>• Document trust independent of load observations; startup policy initialized main-side; foreign file authorities rejected.<br>• Native approval bound to operation snapshot; revalidated after dialog; operation coordinator recheck; platform-correct case normalization; 60s TTL.<br>• Main-owned launch admission; consolidated single auth refresh; mandatory `installation.json` evidence.<br>• Dual permission lockdown (check + request handlers); IPC error sanitization masking security violations and scrubbing paths.<br>• Packaged renderer lockdown (enforces `file://`, ignores `VITE_DEV_SERVER_URL`), strict CSP without `unsafe-eval`, externalized navigation, webviews/auxiliary windows denied. |
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
  - Complete Java-argument privilege classification across the full taxonomy; launch-target control strictly reserved to main; verified at settings handler and process sink.
  - Document trust independent of load observations; top-level mainFrame attachment check; confined development endpoint; foreign file authorities rejected.
  - Native approval bound to operation snapshot with revalidation, operation conflict rechecks, platform-correct case normalization, and 60-second TTL.
  - Main-owned launch admission with consolidated auth refresh and mandatory `installation.json` evidence.
  - Dual permission check and request lockdown; IPC error sanitization masking security errors and scrubbing paths.
  - Packaged renderer hardened with strict CSP and navigation denial.
- **Outbound Request Policy Harness Verified:**
  - Zero unapproved outbound network requests detected during isolated boundary execution.
- **Pre-Existing Invariants:**
  - All baseline and Phase 1 tests pass with zero regressions (285 passed across 34 test files).
- **Dependencies & Lockfile:**
  - `bun.lock` is byte-for-byte identical with baseline. Zero dependency mutations.
- **Typecheck & Packaging:**
  - Production typecheck (`bun run typecheck`), security test typecheck (`tsconfig.security-test.json`), production Vite packaging (`bun run build`), and Electron smoke tests (`bun run smoke --strict`) pass cleanly with 0 errors without `--no-sandbox`.

**STOPPING AT REVIEW GATE 2.** Phase 3 (Keyring / Session Store & Race-Safe Auth) has not been implemented and remains paused. Ready for commit, push, and Review Gate 2 review.
