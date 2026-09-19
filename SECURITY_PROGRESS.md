# Lampas Launcher — Security Hardening Progress

## Review Gate 2 — Narrow IPC Capabilities and Lock Down the Renderer (SEC-02)

- **Execution Date:** 17-18 September 2026
- **Status:** Accepted (Accepted at checkpoint `16bd12ddecbbcd10041c79b5a2be45c2da0a60c7`)
- **Accepted Baseline Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc`
- **Accepted Review Gate 1 Checkpoint:** `e1d029112bd4b2843d61ccc19891556192e3efeb`
- **Accepted Review Gate 2 Checkpoint:** `16bd12ddecbbcd10041c79b5a2be45c2da0a60c7`
- **Reviewed Gate 2 Iterations:** `689800eda9c6b56910546cf608b34f243029d1db`, `f39ad0db8351c08e3bcf8c0c4f68ff6bed1b6f4a`, `f222afde515676d1cd26d1e6f8a7e624345667ff`
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

### 2. Review Gate 2 Defect Remediation Details (Five Targeted Amendment Items)

Following review of checkpoint `f222afde515676d1cd26d1e6f8a7e624345667ff`, all five targeted Phase 2 amendment requirements have been comprehensively implemented, verified with failing-before vs passing-after evidence, and integrated:

#### Item 1: Removal of Production Error-Sanitization Bypass and Hardening of Public Error Contract
- **Prior Defect:** `sanitizeIpcError` contained a `[SecurityHarness]` exception that allowed raw test exceptions to bypass IPC sanitization completely in production code. Furthermore, expected error classification relied on fragile message substring matching (`err.message.includes(...)`), which could be spoofed by backend error text or accidentally genericize valid main validation errors. Length bounds were not uniformly enforced on public error strings.
- **Remediation Implemented:**
  - **Complete Deletion of `[SecurityHarness]` Exception:** Removed the harness marker check entirely from `sanitizeIpcError` in `src/ipc-boundary.ts`. No production error sanitization bypasses exist.
  - **Out-of-Band Observation in Tests:** Process calls in Test 50 now observe intercepted execution out-of-band via an `interceptedProcesses` array populated by a mock `ChildProcess` returned by `child_process.spawn`. Tests do not rely on raw exceptions leaking across IPC boundaries.
  - **Main-Owned Error Hierarchy:** Replaced message substring heuristics with an explicit typed error hierarchy (`MainIpcError` with `readonly isMainOwnedError = true`):
    - `IpcSecurityError`: Maps directly to constant public message `"Security violation: IPC request rejected."`.
    - `IpcValidationError`: Main-owned validation errors (settings schema, file paths, web URLs).
    - `UserCancelledError`: Native dialog cancellations (`"Operation cancelled by user."`).
    - `OperationConflictError`: Background operation conflicts (`OperationBusyError`, `GameRunningConflictError`).
    - `InstallationStateError`: Launch and runtime descriptor validation errors.
    - `ModPolicyError`: Mod authority rejections (`"Cannot disable required mod."`).
  - **Strict Length Bounding:** Added `boundErrorMessage(msg, 120)` ensuring every public IPC error result is strictly bounded (<= 120 characters).
  - **Unexpected Error Masking:** All unknown or unclassified backend errors return generic `"Operation failed: An unexpected internal error occurred."`, regardless of internal message wording (e.g. operational phrases containing quoted JSON credentials or raw database paths).
- **Verification (Failing-Before vs Passing-After):**
  - *Before:* Errors marked with `[SecurityHarness]` leaked raw messages and stack traces across IPC boundaries; an error containing `[SecurityHarness] C:\Users\markj\secret` leaked the path; errors without marker but matching substrings were partially scrubbed; messages exceeded 120 characters.
  - *After:*
    - `[SecurityHarness]` errors with synthetic secrets/paths collapse to generic internal error `"Operation failed: An unexpected internal error occurred."`.
    - Long messages containing the harness marker collapse to generic internal error (47 chars).
    - Backend errors containing operational phrases and quoted JSON credentials (e.g., `"Invalid operation: {"token":"secret"}"`) collapse to generic internal error.
    - Main-owned errors (`UserCancelledError`, `OperationBusyError`, `GameRunningConflictError`, `InstallationStateError`, `ModPolicyError`) produce safe, scrubbed, length-bounded public messages (all <= 120 chars).
    - Characterization Test 51 passes all sanitization regression checks.

#### Item 2: Closing Argument-File Detection Gaps in Consumed Operands & Correcting `java.library.path` Policy
- **Prior Defect:** Argument files (`@file` expansion tokens) could bypass detection if passed as operands to recognized options (e.g. `-cp @file`, `-p @file`, `--patch-module mod=@file`), because the operand consumer did not inspect operand contents for prohibited `@` prefixes. Furthermore, `java.library.path` was previously documented/categorized as merely confirmation-gated rather than prohibited.
- **Remediation Implemented:**
  - **Pre-Pass and Operand-Level Expansion Token Detection:**
    - Updated `isLaunchTargetToken` to detect `@` prefixes at token starts and after separators (`/(?:^|[=;:\s])@/`).
    - Added pre-pass token scanner rejecting any `@`-prefixed argument before argument decomposition.
    - Hardened `validateAndConsumeOperand` and `validateEqualsOperand` in `src/ipc-boundary.ts` to explicitly check operand values against `isLaunchTargetToken`.
    - Preserved identical rejection decisions across both separate-token (`-cp @file`, `-p @file`, `--patch-module mod=@file`) and equals syntax (`--class-path=@file`, `--module-path=@file`, `--patch-module=mod=@file`).
  - **Policy Correction for `java.library.path` and Native-Search Overrides:**
    - Explicitly classified `java.library.path` (and equivalent overrides including `org.lwjgl.librarypath` and `minecraft.applet.TargetDirectory`) as prohibited launch target overrides (`hasLaunchTargetOverride: true`), not merely confirmation-gated. Documented and enforced at both the settings handler (`config:set`) and the process sink (`buildLaunchArguments`), rejecting code loading/native-search override fail-closed before native confirmation and before the spawn sink.
  - **Pre-Dialog Rejection & Zero Spawn Sink Enforcement:**
    - Rejection of launch target overrides in `config:set` occurs strictly before any native confirmation dialog is displayed, even if a confirmation mock would approve.
    - Rejection in `buildLaunchArguments` occurs with zero process execution (throws `InstallationStateError`).
- **Verification (Failing-Before vs Passing-After):**
  - *Before:* `-cp @args.txt` and `--class-path=@args.txt` allowed `@args.txt` as a consumed operand without triggering launch target rejection; `-Djava.library.path=/path` was confirmation-gated instead of rejected fail-closed.
  - *After:*
    - Standalone `@args.txt`, `-cp @args.txt`, `--class-path=@args.txt`, `-p @args.txt`, `--module-path=@args.txt`, `--patch-module mod=@args.txt`, `--patch-module=mod=@args.txt`, `-Djava.library.path=...`, `-Dorg.lwjgl.librarypath=...`, and `-Dminecraft.applet.TargetDirectory=...` are all classified as `hasLaunchTargetOverride: true`.
    - All rejected fail-closed in `config:set` before native dialog.
    - All rejected in `buildLaunchArguments` before `child_process.spawn` is reached.
    - Characterization Test 47 passes all 19 target override and privilege classification assertions.

#### Item 3: Complete Attached-Frame Validation
- **Prior Defect:** Detached frame states were not explicitly checked (`(frame as any).detached === true`). A sender frame, current main frame, or snapshot frame could be detached from its WebContents during asynchronous IPC processing or deferred native dialogs without detection.
- **Remediation Implemented:**
  - **Explicit Detachment Checks:**
    - Added explicit checks for `(frame as any).detached === true` and `(mainFrame as any).detached === true` in `validateIpcSender`, `createApprovalSnapshot`, and `validateApprovalSnapshot` in `src/ipc-boundary.ts`.
    - Preserved all existing checks: frame destruction (`frame.isDestroyed()`), current-frame identity (`frame === mainFrame`), generation consistency, WebContents ownership, URL consistency, and startup-policy checks.
    - Exercised detachment at entry and after deferred native dialogs.
- **Verification (Failing-Before vs Passing-After):**
  - *Before:* A frame marked `{ detached: true }` could pass frame validation if `isDestroyed()` was false.
  - *After:* Detached sender frames fail closed at IPC entry; detached snapshot or main frames fail closed after deferred native dialogs. Characterization Test 48 and Test 49 verify detachment rejections across both entry and deferred dialog lifecycles.

#### Item 4: Repository Evidence Aligned with Actual Coverage
- **Prior Defect:** Launch characterization tests relied on throwing a `[SecurityHarness]` exception from a mock spawn to prevent real process launch and observe arguments via caught error messages. Furthermore, deferred dialog cases did not exercise the actual handlers (`gameDir:configure`, `gameDir:move`, `mods:addPaths`). Approval TTL and generation handling was not tested with actual controlled clocks across generations below, at, and above 50.
- **Remediation Implemented:**
  - **Sanitizer Bypass Eliminated from Launch Tests:**
    - Replaced spawn exception harness in Test 50 with a mock `ChildProcess` that records arguments and options in an out-of-band `interceptedProcesses` array.
    - Preserved exact argument/value consecutive-pair assertions: `--username Player` at consecutive indices, `--version 26.2` at consecutive indices.
    - Preserved forged renderer input inertness assertions: renderer-supplied `{ user: { name: "Attacker" } }` is completely ignored in favor of main-side state.
  - **Actual Handlers Exercised for Deferred Dialogs:**
    - Test 49 directly exercises `gameDir:configure`, `gameDir:move`, and `mods:addPaths` with mock deferred dialogs, verifying safe handling of user cancellation, operation conflicts (`OperationBusyError`), and single-use token consumption.
  - **Controlled Clock Testing Across Document Generations (15, 50, 75):**
    - Tested actual document generations below 50 (gen 15), at 50 (gen 50), and above 50 (gen 75) using a controlled `Date.now` mock.
    - Verified 60s lifetime: +30s valid, +59s valid, +61s expired.
    - Verified stale generation rejection, future generation rejection, expiry rejection, and single-use invalidation.
  - **Permission-Query Exception Safety:**
    - Treated `navigator.permissions.query` exceptions as test failures, not successful denial.
- **Verification (Failing-Before vs Passing-After):**
  - *Before:* Launch arguments observed via caught `[SecurityHarness]` error message; actual handlers not exercised for deferred dialog conflict/cancellation; generations 15, 50, 75 not verified with controlled clock.
  - *After:* Intercepted process observed out-of-band; exact argument pairs verified; actual handlers tested with deferred dialogs; generations 15, 50, 75 verified with controlled clock; Tests 47-51 pass cleanly.

#### Item 5: Comprehensive Validation and Packaging Evidence
- All test suites, typechecks, and package builds executed cleanly:
  - `bun test/security-boundary-characterization.ts`: **51 passed, 0 failed, 0 skipped, 0 outbound violations**.
  - `bun test/security-regression-gates.test.ts`: **8 passed, 0 failed, 5 skipped (Phase 3/4/6), 7 todo**.
  - `bun test/security-characterization.test.ts`: **16 passed, 0 failed (95 expect calls)**.
  - `bun test`: **285 passed, 0 failed, 5 skipped, 7 todo across 34 files (1151 expect calls)**.
  - `bun run typecheck`: **0 errors**.
  - `bun x tsc -p tsconfig.security-test.json --noEmit`: **0 errors**.
  - `bun run build`: **Success**.
  - `bun run package:dir`: **Success**.
  - `bun test/smoke/electron-smoke.ts --strict`: **All 7 checks passed** (unpacked + packaged ASAR execution without `--no-sandbox`).
- Packaged Artifact SHA-256 Hashes:
  - `release\win-unpacked\resources\app.asar`: `02019237C5846346C30FFEAD02E13A46AA448A9E74B1BBEFF992F7E6AB438937`
  - `release\win-unpacked\Lampas Launcher.exe`: `C2B10D1A1CB8F65DBB882D80ABC1A2D724E919E5F59E6FBF18C5069A019EB7C2`
- Lockfile integrity: `git diff bun.lock` is empty (0 drift).

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

### 4. Verification Evidence (Categorized by Test Layer)

#### A. Direct Component Checks (Isolated Unit & Functional Suites)
Executed directly under the Bun test runner exercising isolated TypeScript modules without an active Electron windowing layer:
- **Parent Characterization Suite (`test/security-characterization.test.ts`):**
  - Total: **16 passed, 0 failed, 95 expect() calls**.
  - Direct checks: `normalizePortalUrl` bypass checks, uppercase scheme upgrades, legacy config migration assertions, and characterization test sentinels.
- **Full Launcher Suite (`bun test`):**
  - Total: **285 passed, 0 failed, 5 skipped, 7 todo across 34 test files** (1151 expect() calls).
  - Direct checks: Config manager, file transfer, logger, resource pack hashing, mod catalogs, server status, sync engine, and Minecraft bootstrap.

#### B. Registered-Handler Boundary Tests (Isolated Subprocess with Electron Mocking Harness)
Executed in an isolated child process (`test/security-boundary-characterization.ts`) with strict outbound network firewalling and comprehensive Electron API mocks (`BrowserWindow`, `WebContents`, `IpcMain`, `WebFrameMain`):
- Total Tests: **51 passed, 0 failed, 0 outbound policy violations, 0 skipped**
- **Phase 2 Boundary & Registered-Handler Tests (Tests 39-51):**
  - **Test 39 (Handler Registration):** Unauthorized IPC callers rejected (foreign BrowserWindow webContents, child frames with `parent !== null`, unapproved document origins).
  - **Test 40 (Handler Validation):** `config:set` allowlist schema strictly enforced (rejects `gameDir`, `token`, `sessionPortalUrl`, unexpected keys, prototype pollution).
  - **Test 41 (Handler Authority):** Main-owned launch authority (`game:launch` rejects renderer-supplied overrides; fetches user and release main-side).
  - **Test 42 (Handler Authority):** Main-owned mod authority (`mods:setOfficialEnabled` blocks disabling official mods when `canDisable !== true` in catalog).
  - **Test 43 (Handler Validation):** Custom mod import validation (`mods:addPaths` rejects non-jar files, directory paths, and non-existent files).
  - **Test 44 (Handler Approval):** Native approval & privileged `javaArgs` detection (flags `-javaagent:`, `@argfile`, etc.; single-use consumption; document generation invalidation).
  - **Test 45 (Startup Policy):** Packaged build renderer lockdown (production rejects loopback dev server, requires `file://` index).
  - **Test 46 (End-to-End Handlers):** Positive end-to-end paths (secure handlers succeed with valid sender, top-level frame, and approved inputs).
  - **Test 47 (Component & Sink):** Complete Java-argument privilege classification across full taxonomy (launch target overrides, sensitive options, ordinary tuning, settings handler confirmation/rejection, and process argument sink).
  - **Test 48 (Frame & Document):** Document trust independent of load observations and strict sender frame validation (did-finish-load does not approve arbitrary documents, unapproved dev ports rejected, detached frames rejected, foreign file URL authorities rejected).
  - **Test 49 (Approval Lifecycle):** Native approval binding (snapshot revalidation on generation advance, window loss, or frame detachment; operation conflict barriers during dialog; single-use consumption; platform-correct case normalization; 60s TTL).
  - **Test 50 (Admission & Process):** Main-owned launch admission (consolidated auth refresh; mandatory `installation.json` existence, non-emptiness, and version matching; `noSync` admission preservation; out-of-band intercepted spawn verification).
  - **Test 51 (Permissions & Sanitization):** Renderer permission lockdown and error sanitization (dual check/request handler denial; error sanitization masking security errors and scrubbing paths).
- **Regression Gates Suite (`test/security-regression-gates.test.ts`):**
  - Total Tests: **8 passed, 0 failed, 5 skipped (Phases 3/4/6), 7 todo (Phases 3-7)**
  - Phase 1 Gates (6 tests): URL normalization, production portal policy, origin-change invalidation, web link sink protocol enforcement, session origin binding, legacy migration disk cleanup.
  - Phase 2 Gates (2 tests): Sender frame validation (`validateIpcSender`), `config:set` allowlist schema (`validateConfigSet`).

#### C. Real Electron & Platform Evidence (Actual Sandboxed Runtime & Packaged ASAR Execution)
Executed using real operating-system processes (`electron.exe` and packaged `Lampas Launcher.exe`) under real Chromium sandbox constraints (strictly **without** `--no-sandbox`):
- **Strict Smoke Test Suite (`bun test/smoke/electron-smoke.ts --strict`):**
  - **Unpacked dev/dist execution:** Exit code 0, init: true, handlers: true, roundTrip: true, adversarial: true. Verified that real Electron Chromium sandbox and Node integration behave identically to unit specifications.
  - **Packaged distribution execution:** Real Windows executable (`release\win-unpacked\Lampas Launcher.exe`) and packaged ASAR archive (`resources\app.asar`, 3.27 MB). Exit code 0, init: true, handlers: true, roundTrip: true, adversarial: true.
  - **Security Fuses & Sandboxing:** Real Electron process executed with sandbox active; no sandbox-bypass flags.
  - **Publishing safety:** `publish: never` enforced; CI artifacts verified.

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

- **Acceptance Checkpoint:** `16bd12ddecbbcd10041c79b5a2be45c2da0a60c7`
- **Review Gate 2 Accepted:** Verified complete Phase 2 remediation across all 5 targeted items.
- **Historical Evidence Preservation:** Historical test evidence, artifact hashes, and metrics are preserved intact at their original checkpoint.
- **Transitional Authorization:** Acceptance of Review Gate 2 authorized targeted execution of Phase 3 only ("Separate secrets and make authentication race-safe"). Acceptance does not authorize merging, tagging, or publication.

---

## Review Gate 3 — Separate Secrets and Make Authentication Race-Safe (SEC-03, SEC-08)

- **Execution Date:** 18 September 2026
- **Status:** Complete (Review Gate 3 implementation verified; Phase 3 complete; paused before Phase 4)
- **Accepted Baseline Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc`
- **Accepted Review Gate 1 Checkpoint:** `e1d029112bd4b2843d61ccc19891556192e3efeb`
- **Accepted Review Gate 2 Checkpoint:** `16bd12ddecbbcd10041c79b5a2be45c2da0a60c7`
- **Amended Gate 3 Checkpoint:** `HEAD` on branch `feat/security`
- **Current Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 3 ("Separate secrets and make authentication race-safe", remediating SEC-03 and SEC-08). Phase 4 (Path containment and safe recovery) and subsequent phases remain paused. Acceptance does not close any subsequent production security finding or authorize merging, tagging, or publication.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A complete audit of changes was performed against accepted Review Gate 2 checkpoint (`16bd12ddecbbcd10041c79b5a2be45c2da0a60c7`) and earlier checkpoints:

| Dimension | Accepted Baseline (`149f100`) | Accepted RG 1 (`e1d0291`) | Accepted RG 2 (`16bd12d`) | Review Gate 3 (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline (`0 lines`) | 8 files modified, 1 added | 9 files modified, 2 added | 12 files modified, 4 added (`src/credential-store.ts`, `src/session-manager.ts`, `src/portal-policy.ts`, `src/ipc-boundary.ts`) | **Constrained strictly to Phase 3 hardening** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical (zero package mutations; 0 diff)** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | 8 passed (RG 0.1) | 38 passed | 51 passed | **61 passed, 0 failed, 0 outbound violations, 0 skipped** | **+10 Phase 3 dynamic tests (Tests 52-61)** |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | 16 passed | 16 passed | 16 passed | **16 passed, 0 failed (108 expect calls)** | **Phase 3 SEC-03 verification passing** |
| **Regression Gates (`test/security-regression-gates.test.ts`)** | 6 passed (Phase 1) | 6 passed | 8 passed | **10 passed, 0 failed, 4 skipped, 6 todo** | **Phase 3 persistence and epoch gates unskipped & passing** |
| **Full Test Suite (`bun test`)** | 277 passed | 283 passed | 285 passed | **287 passed, 0 failed, 4 skipped, 6 todo across 34 files** | **All 34 test files pass cleanly (1,180 expect calls)** |
| **Security Test Typecheck** | 0 errors | 0 errors | 0 errors | **0 errors (`tsconfig.security-test.json`)** | **0 errors** |
| **Production Typecheck & Build** | Clean | Clean | Clean | **0 errors (`tsc --noEmit && tsc -p tsconfig.renderer.json --noEmit` and `vite build`)** | **0 errors** |
| **Electron Smoke & Adversarial Tests** | Passed | Passed | Passed | **Passed (unpacked dev/dist + packaged binary ASAR + adversarial assertions)** | **0 errors (no `--no-sandbox`)** |

---

### 2. Credential Contract & Main-Only Storage Architecture (SEC-03)

1. **Schema Version 1 Credential Contract (`StoredCredentialRecord`):**
   - Stored in main-only file `credentials.enc` located in Electron `userData` directory (completely isolated from `gameDir` and `config.json`).
   - Schema defined in `src/credential-store.ts`:
     - `version: 1` (integer schema version identifier)
     - `portalUrl: string` (canonical issuing origin URL)
     - `accountId: string` (canonical user / Minecraft UUID identifier)
     - `accountUsername: string` (canonical username)
     - `token: string` (Portal JWT bearer token)
     - `refreshToken?: string` (Portal OAuth refresh token)
     - `minecraftAccessToken?: string` (Minecraft game session token)
     - `createdAt: number` (epoch timestamp)
     - `updatedAt: number` (epoch timestamp)

2. **Total Separation from `config.json`:**
   - Non-secret configuration properties (`gameDir`, `allocatedRamGb`, `selectedChannel`, `noSync`, `customJavaPath`, etc.) remain serialized in `config.json`.
   - `config.json` on disk is strictly **token-free**. `ConfigManager.persistAndEmit` deletes `token`, `refreshToken`, `minecraftAccessToken`, and `sessionPortalUrl` before atomic serialization to disk.
   - `ConfigManager.get()` dynamically overlays in-memory credentials from `SessionManager.getCredentials()` so main-process consumers observe active authenticated state without disk persistence.
   - Decoupled Observer pattern: `SessionManager` notifies registered listeners upon session changes, keeping `ConfigManager` in-memory cache synchronized without circular imports.

3. **Origin Binding & Integrity Verification:**
   - Stored records require explicit canonical origin matching (`stored.portalUrl === canonicalActivePortal`).
   - If active portal URL changes or origin mismatches, stored credentials are treated as invalid and purged fail-closed on initialization.

---

### 3. Platform Storage Backends & Fallback Policy

1. **Storage Backend Detection (`CredentialStore.detectStorageBackend`):**
   - **Windows:** Uses `safeStorage.isEncryptionAvailable()` to confirm Windows DPAPI backing (`"windows_dpapi"`).
   - **Linux:** Inspects `safeStorage.getSelectedStorageBackend()`. If backend is `"gnome_libsecret"`, `"kwallet5"`, or `"kwallet6"`, resolves to `"linux_keyring"`.
   - **Session-Only Fallback:** If the detected backend is `"basic_text"`, `"unknown"`, or if `isEncryptionAvailable()` returns `false` (e.g. locked keyring, headless container, or unavailable DPAPI), storage mode resolves strictly to `"session_only"`. Plaintext credentials are **NEVER** silently written to disk.

2. **Atomic Encrypted Writes & Permissions:**
   - Encrypted files are written atomically via temporary sibling `credentials.enc.tmp` before renaming to `credentials.enc`.
   - On POSIX platforms, file creation enforces owner-only permissions (`0o600`).

3. **Safe Corruption & Provider-Lock Handling:**
   - Decryption failures (corrupt ciphertext, key change, or provider lock) fail closed:
     - Error is caught safely and logged as a warning; never throws to callers or crashes the application.
     - Corrupt file is purged from disk immediately.
     - Returns `null`, requiring clean reauthentication without corrupting state or resurrecting plaintext.

---

### 4. Migration State Machine

A deterministic three-checkpoint state machine is implemented in `SessionManager.initialize()`:

1. **Checkpoint 1 (OS-Encrypted Store Inspection):**
   - Attempt to read and decrypt `credentials.enc`.
   - If present, valid schema v1, and `stored.portalUrl === activePortalUrl`: restore session into memory.
   - If present but origin does not match: purge stored credentials from disk and advance session epoch.

2. **Checkpoint 2 (Legacy Plaintext Detection in `config.json`):**
   - Check `config.json` for legacy unencrypted fields (`token`, `refreshToken`, `minecraftAccessToken`).
   - If legacy credentials exist but have no `sessionPortalUrl` or mismatch `activePortalUrl`:
     - Scrub plaintext fields from `config.json` immediately using atomic write.
     - Leave session unauthenticated (fail closed; requires reauthentication).

3. **Checkpoint 3 (Eligible Legacy Credential Migration):**
   - If legacy credentials match the active portal origin:
     - **In `session_only` mode:** Load credentials into memory for current session and scrub plaintext from `config.json` immediately.
     - **In secure storage mode:** Encrypt and write to `CredentialStore`. Perform immediate verification read-back. Only after read-back succeeds, scrub plaintext from `config.json`. If encryption or read-back fails, scrub plaintext from `config.json` and require reauthentication.
   - Old plaintext is **never** resurrected, and no unencrypted backup files are created.

---

### 5. Race-Safe Session Epochs & Authentication Lifecycle (SEC-08)

1. **Session Epoch Authority (`SessionManager`):**
   - Main-process session authority maintains atomic numeric `sessionEpoch`.
   - Epoch advances monotonically upon:
     - User logout (`LauncherAuth.logout()`)
     - Portal origin change (`SessionManager.onPortalUrlChanged()`)
     - Account identity change
     - Superseding login initialization (`SessionManager.startLoginSession()`)

2. **Asynchronous Invalidation Barriers:**
   - Every asynchronous authentication continuation snapshots `sessionEpoch` and canonical `portalUrl` prior to network dispatch (`token exchange`, `profile verification`, `session refresh`).
   - Upon completion of the asynchronous call, `SessionManager.getSessionEpoch() === snapshot` and `ConfigManager.get().portalUrl === portalUrl` are validated before updating in-memory or on-disk credentials.
   - Any late arrival from a cancelled, superseded, or logged-out session is silently discarded with a warning log.

3. **Single-Flight Refresh Coalescing:**
   - Concurrent calls to `LauncherAuth.refreshSession()` coalesce onto the exact same in-flight `Promise` reference (`p1 === p2`).
   - Eliminates parallel token refresh storms and prevents race conditions between overlapping refresh operations.
   - Cleared cleanly in a `finally` block upon resolution or rejection.

4. **Synchronous Logout Semantics:**
   - `LauncherAuth.logout()` executes synchronously:
     - Cancels active loopback OAuth server and pending login flow.
     - Advances `sessionEpoch`, invalidating all pending asynchronous callbacks.
     - Clears in-memory credentials and user profile.
     - Unlinks `credentials.enc` from disk.
   - **Honest Logout Scope:** Documentation and audit confirm that local launcher logout clears local launcher credentials, but does not terminate an already running external Minecraft child process or clear session cookies in the user's external system browser.

---

### 6. Hardened Loopback OAuth Listener (SEC-08)

1. **Loopback-Bound Ephemeral Server:**
   - Listens exclusively on `127.0.0.1` on an OS-assigned random port (`server.listen(0, "127.0.0.1")`).

2. **Strict Request & Authority Validation:**
   - **HTTP Method:** Rejects non-`GET` requests with HTTP 405 Method Not Allowed.
   - **URI Length Bounding:** Rejects request URLs exceeding 2,048 characters with HTTP 414 URI Too Long.
   - **Host Header Check:** Enforces that `Host` matches `127.0.0.1:${port}` or `localhost:${port}`, rejecting external or DNS-rebinding Host values with HTTP 400 Bad Request.

3. **Noise Resilience & Replay Protection:**
   - **Noise Tolerance:** Requests to non-`/callback` paths (such as `/favicon.ico` or browser preflights) return HTTP 404 text without closing the server or terminating the pending login flow.
   - **Invalid Query Handling:** Requests missing `code` or with mismatched `state` return HTTP 400 text without terminating the valid pending flow.
   - **Single-Use Replay Protection:** An atomic `exchanged` boolean flag guarantees the authorization code exchange is executed at most once. Concurrent or subsequent requests with the same state receive HTTP 409 Conflict.

4. **Zero Information Disclosure & HTML Safety:**
   - Browser completion HTML is served **only after** token exchange succeeds, Minecraft UUID is validated, and session is established.
   - Browser HTML responses never reflect raw authorization codes, tokens, or backend error strings.
   - All errors return generic, static user-friendly HTML text.

5. **Deterministic Lifecycle Cleanup:**
   - A single `cleanup()` handler removes all server listeners, closes the HTTP server, clears the 120-second timeout timer, and releases the login lock.
   - Cleanup is invoked deterministically across all exit paths: success, exchange failure, network timeout, explicit user cancellation (`cancelLogin()`), superseding login, and application quit (`app.on("before-quit")`).

---

### 7. Verification Evidence (Categorized by Test Layer)

#### A. Direct Component Checks (Isolated Unit & Functional Suites)
Executed directly under the Bun test runner exercising isolated TypeScript modules:
- **Parent Characterization Suite (`test/security-characterization.test.ts`):**
  - Total: **16 passed, 0 failed, 108 expect() calls**.
  - Includes Phase 3 SEC-03 test: `ConfigManager and SessionManager never persist authentication secrets in plaintext config.json`.
- **Full Launcher Suite (`bun test`):**
  - Total: **287 passed, 0 failed, 4 skipped (Phases 4/6), 6 todo (Phases 4-7) across 34 test files** (1,180 expect() calls).
  - Verified across game runner, server status, sync logging, mod management, and file transfer modules.

#### B. Registered-Handler & Isolated Boundary Tests (`test/security-boundary-characterization.ts`)
Executed in an isolated child process with complete Electron mocks and outbound firewall enforcement:
- Total Tests: **61 passed, 0 failed, 0 outbound policy violations, 0 skipped**
- **Phase 3 Boundary Tests (Tests 52-61):**
  - **Test 52 (Secure-Store Round Trip):** Verifies encryption, atomic write to `credentials.enc`, application restart simulation, and credential restoration.
  - **Test 53 (Session-Only Fallback):** Verifies that unavailable encryption or insecure backends (`basic_text`, `unknown`) operate purely in-memory with zero disk persistence.
  - **Test 54 (Corrupt Ciphertext & Locked Provider):** Verifies that corrupted encrypted files or decryption errors fail closed, return null, purge corrupt data, and avoid crashes.
  - **Test 55 (Origin Mismatch Purge):** Verifies that stale credentials or origin mismatches are purged fail-closed on initialization.
  - **Test 56 (Migration State Machine):** Verifies deterministic migration across each checkpoint (origin validation, read-back verification, and failure handling without resurrecting plaintext).
  - **Test 57 (Logout Atomicity & Disk Rollback):** Verifies that logout during persistent credential write invalidates the session epoch and rolls back disk storage.
  - **Test 58 (Invalidation Barriers):** Verifies that late responses from network continuations are discarded if session epoch advanced after logout or origin change.
  - **Test 59 (Single-Flight Refresh):** Verifies that concurrent calls coalesce onto identical Promise references and superseding login invalidates in-flight refreshes.
  - **Test 60 (Hardened Loopback OAuth Server):** Verifies `GET` enforcement, URI length bounds, Host header validation, noise resilience, concurrent single-use replay rejection (HTTP 409), and deterministic cleanup.
  - **Test 61 (Absence of Synthetic Secrets):** Verifies complete absence of synthetic test credentials in `config.json`, IPC DTOs, and serialized metadata.
- **Regression Gates Suite (`test/security-regression-gates.test.ts`):**
  - Total Tests: **10 passed, 0 failed, 4 skipped, 6 todo** (97 expect() calls).
  - **Phase 3 Gate 1 (Persistence):** `config.json` on disk contains no plaintext tokens or credentials. Attempting to set credentials via generic `ConfigManager.set` is stripped from disk.
  - **Phase 3 Gate 2 (Operation-level):** Authentication lifecycle uses session epochs, advances epoch on logout, wipes memory and disk store, and ignores late arrivals after logout.

#### C. Real Electron & Platform Evidence (Actual Sandboxed Runtime & Packaged ASAR Execution)
Executed using real operating-system processes (`electron.exe` and packaged `Lampas Launcher.exe`) under real Chromium sandbox constraints (strictly **without** `--no-sandbox`):
- **Strict Smoke Test Suite (`bun test/smoke/electron-smoke.ts --strict`):**
  - **Unpacked dev/dist execution:** Exit code 0, init: true, handlers: true, roundTrip: true, adversarial: true. Real Electron Chromium sandbox and Node integration verified.
  - **Packaged distribution execution:** Real Windows executable (`release\win-unpacked\Lampas Launcher.exe`) and packaged ASAR archive (`resources\app.asar`, 3.32 MB). Exit code 0, init: true, handlers: true, roundTrip: true, adversarial: true.
  - **Security Fuses & Sandboxing:** Real Electron process executed with sandbox active; zero sandbox-bypass flags.
  - **Publishing safety:** `publish: never` enforced; CI linux artifacts guaranteed.

#### D. Dependency & Lockfile Integrity
- `git diff bun.lock`: **0 changes (byte-for-byte identical to baseline)**.
- Package versions and dependency tree completely unchanged.

#### E. Packaged Artifact Hashes (SHA-256)
- `release\win-unpacked\resources\app.asar`: `B82E066C89D95703881F4B7BA2FE534F8A2384C85D83A8D1F74FAB19F58E495A`
- `release\win-unpacked\Lampas Launcher.exe`: `A5A2A14D038E3091344C2848345461E91C103D1E67B4A0622427313092975D23`

---

### 8. Finding Status & Remaining Scope (SEC-01 to SEC-12)

| Finding ID | Priority | Phase | Status at Review Gate 3 | Remediation & Remaining Scope |
|---|---|---|---|---|
| **SEC-01** | P0 / High | Phase 1 | **Remediated & Verified** | Complete Phase 1 remediation preserved intact: canonical origin policy, session origin binding, race safety, manual redirect rejection, disk scrubbing. |
| **SEC-02** | P0 / High | Phase 1 / Phase 2 | **Remediated & Verified** | All 38 inbound IPC channels registered through unified security boundary; sender frame & attachment validation; strict allowlist schema; launch target override prohibition; native approval lifecycle; dual permission lockdown; strict CSP. |
| **SEC-03** | P1 / High | Phase 3 | **Remediated & Verified (Amended)** | Plaintext credential separation complete. Restart-safe migration state machine, fail-closed protected record recovery, explicit `SaveCredentialsResult`/`ClearCredentialsResult` contracts, safe corruption purge, account-specific token replacement (zero cross-account inheritance), DPAPI/Linux keyring/session-only storage with `auth:getStorageStatus` IPC and UI status toasts, token-free `config.json` on disk. |
| **SEC-04** | P0 / High | Phase 4 | Pending | Path containment & ownership inconsistencies (`isPathProtected`). Deferred to Phase 4. |
| **SEC-05** | P1 / Med-High | Phase 4 | Pending | Move recovery recursive deletion of unvalidated staging path. Deferred to Phase 4. |
| **SEC-06** | P1 / High-Cond | Phase 5 | Pending | Executable verification fails open (missing hash fallback). Deferred to Phase 5. |
| **SEC-07** | P1 / High-Cond | Phase 5 | Pending | Inappropriate fallback on HTTP 410 REVOKED releases. Deferred to Phase 5. |
| **SEC-08** | P1 / Medium | Phase 3 | **Remediated & Verified (Amended)** | Loopback OAuth listener hardened. Bounded method (`GET`), URL (<= 2048), and `Host` validation. Noise-tolerant routing (404 without flow abort). Single-use exchange with replay rejection (HTTP 409). 120s timeout, terminal lifecycle with socket destruction and `AbortController`. Scoped refresh coalescing keyed by `(portalUrl, accountId, sessionEpoch)`. Late response rejection via monotonic epochs. Information-disclosure-free HTML. |
| **SEC-09** | P1 / Medium | Phase 6 | Pending | Logging redaction gaps (`refresh_token`, URL query codes, CLI args). Deferred to Phase 6. |
| **SEC-10** | P2 / Med-Priv | Phase 6 | Pending | Third-party information disclosure (`mc-heads.net`, unvalidated image URLs). Deferred to Phase 6. |
| **SEC-11** | P2 / Medium | Phase 5 | Pending | Unbounded decompression ingestion budgets in `ensureNatives`. Deferred to Phase 5. |
| **SEC-12** | P2 / Medium | Phase 7 | Pending | Release pipeline permissions and mutable action pins. Deferred to Phase 7. |

---

## Review Gate 3 Amendment — Separate Secrets and Make Authentication Race-Safe (SEC-03, SEC-08)

- **Execution Date:** 19 September 2026
- **Status:** Ready for Review (Gate 3 Amendment Complete)
- **Accepted Review Gate 2 Checkpoint:** `16bd12ddecbbcd10041c79b5a2be45c2da0a60c7`
- **Reviewed Gate 3 Checkpoint:** `589edc703580fab16c5cc20cbdffbb1572d5eff0`
- **Current Working Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 3 amendment ("Separate secrets and make authentication race-safe"). Phase 4 (Path containment), Phase 5 (Integrity checks fail-closed), and subsequent phases remain paused. Acceptance does not authorize merging, tagging, or publication.

---

### 1. Review Gate 3 Amendment Details (Eight Targeted Requirements)

Following the Review Gate 3 evaluation of checkpoint `589edc703580fab16c5cc20cbdffbb1572d5eff0`, all eight targeted amendment items have been fully resolved, verified with dedicated pre-change failure path reproductions, and validated with exact-version native Electron evidence:

#### Item 1: Failure Path Reproductions Before Production Changes
- **Defects Remediated:**
  - Need for reproducible verification of real failure modes (cancellation/timeout/supersession, deletion failure resurrection, failed account replacement, duplicate encrypted/plaintext migration, scrub-write failure + restart, cross-account token inheritance, and temporary path clobbering/link cases) without adding production test exemptions.
- **Implementation:**
  - Created `test/security-failure-reproductions.test.ts` covering 7 targeted failure paths using real production operations, synthetic credentials, controlled timers, and deferred request barriers:
    1. **Cancellation, Timeout, and Supersession:** Proves loopback OAuth listeners destroy all client sockets, abort signal triggers, and terminate promise lifecycle. Late HTTP callback attempts receive HTTP 409 Conflict with zero token exchange.
    2. **Failed Credential Deletion on Logout:** Emulates locked/EBUSY `credentials.enc`. Proves `clearCredentials()` returns `{ success: false }`, attempts zero-byte overwrite, records `credentials.invalidated` marker, and prevents stale credential resurrection upon restart.
    3. **Failed Account Replacement:** Emulates disk-full / persistence failure during new account login. Proves older account credentials are not restored; launcher falls back to session-only mode for the new user.
    4. **Duplicate Encrypted and Plaintext Records:** Proves valid protected credentials take precedence over coexisting legacy plaintext, and legacy plaintext is scrubbed immediately from `config.json`.
    5. **Scrub-Write Failure on config.json:** Emulates `EPERM` during legacy plaintext scrub. Proves `legacyScrubbed: false` is tracked and legacy scrub is safely resumed and completed on subsequent restart.
    6. **Cross-Account Optional Token Inheritance:** Proves logging into Account B without optional tokens (`minecraftAccessToken`, `minecraftUuid`) guarantees zero token bleed from prior Account A.
    7. **Fixed Temporary Path Link Case:** Proves exclusive creation flags (`O_CREAT | O_EXCL`) and randomized temporary filenames prevent symlink or pre-existing file hijacking.
- **Evidence:**
  - `test/security-failure-reproductions.test.ts`: **7 passed, 0 failed** (33 expect calls).

#### Item 2: Single Idempotent Terminal-State Path for Login
- **Defects Remediated:**
  - Loopback OAuth login operations lacked strict time-bounding, potentially leaving loopback HTTP listeners open indefinitely.
  - Concurrent or superseding login requests did not terminate prior in-flight sockets, creating race conditions and socket leaks.
- **Implementation:**
  - Introduced `LoginOperationContext` in `src/auth.ts`:
    - Fixed 120-second timeout (`LOGIN_TIMEOUT_MS = 120_000`).
    - Dedicated `AbortController` aborted upon timeout, cancellation, or supersession.
    - Set of active client `net.Socket` instances tracked and explicitly destroyed on termination.
    - `settleOnce` terminal barrier: closes server, clears timer, destroys sockets, and rejects subsequent incoming requests with HTTP 409 Conflict.
  - Superseding login requests terminate prior active login contexts with `OperationConflictError`.
  - User cancellation (`LauncherAuth.cancelLogin()`) destroys active sockets, closes the listener, and increments session epoch.
  - Sockets in connection queue during shutdown are destroyed immediately with error handling.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Cancellation, timeout, and supersession settle login promise and clean up resources` (passed, 10.73ms).
  - Characterization Test 59 (Loopback OAuth listener bounds, single-use, and replay resistance) passed.
  - Characterization Test 60 (OAuth callback lifecycle, replay resistance, cancellation cleanup) passed.

#### Item 3: Explicit Credential Persistence and Deletion Outcomes
- **Defects Remediated:**
  - Persistence operations previously returned void or implicit booleans without distinguishing storage backend, session-only mode, or disk write failures.
  - Deletion failures (e.g. `EBUSY` or permission errors on logout) were swallowed, claiming successful logout while encrypted credentials lingered on disk.
- **Implementation:**
  - Defined `SaveCredentialsResult`: `{ success: boolean; backend: StorageBackendType; sessionOnly: boolean; error?: string }`.
  - Defined `ClearCredentialsResult`: `{ success: boolean; error?: string; deletedTarget: boolean; deletedTemp: boolean }`.
  - `CredentialStore.saveCredentials` validates schema version 1, detects OS backend, writes atomically via `credentials.enc.tmp.<pid>.<time>.<random>` with exclusive flags and `0o600` permissions, and returns explicit failure on disk error without falsely claiming persistence.
  - `CredentialStore.clearCredentials` unlinks `credentials.enc` and temporary files. On deletion failure, attempts zero-byte overwrite, writes durable `credentials.invalidated` marker, logs the error, records `lastCleanupError`, and returns `{ success: false, error: ... }`.
  - `CredentialStore.loadCredentials` checks for `credentials.invalidated`; if present, rejects loading stale credentials fail-closed.
  - `LauncherAuth.logout()` invokes `SessionManager.clearSession()`, which returns `ClearCredentialsResult`.
- **Evidence:**
  - `[Phase 3 Gate] Persistence & Deletion: SaveCredentialsResult and ClearCredentialsResult report explicit outcomes and failure handling` (passed, 4.93ms).
  - `[Phase 3 Failure Path Reproductions] Failed credential deletion on logout must report failure and prevent silent resurrection` (passed, 8.60ms).

#### Item 4: Restart-Safe, Failure-Aware Migration State Machine
- **Defects Remediated:**
  - Prior migration logic could return before inspecting or cleaning legacy plaintext if a valid protected record existed, or could fail to reconcile coexisting records safely.
  - Corrupted or un-decryptable protected records could fail open or attempt to silently resurrect legacy plaintext.
  - Invented placeholder accounts (e.g. `"unverified-migration"` or `"account"`) could mask unverified credential state.
- **Implementation:**
  - Hardened `SessionManager.initialize(configPath, activePortalUrl)` to inspect both the protected credential store and `config.json` unconditionally.
  - **Coexistence Precedence:** If both protected credentials and legacy plaintext exist, the valid protected record takes precedence, and legacy plaintext is scrubbed immediately (`legacyScrubbed: true`).
  - **Interrupted Migration Recovery:** If a crash occurred after protected write but before legacy removal, the restart inspects both records, verifies protected integrity, and completes the pending scrub.
  - **Fail-Closed Corrupt Record Handling:** If the protected credentials file exists on disk but cannot be decrypted or parsed, `CredentialStore.loadCredentials()` safely purges the corrupt file and returns `null`. `SessionManager.initialize` marks `failedProtectedLoad: true`, scrubs legacy plaintext from `config.json`, and refuses to restore a session from legacy plaintext, requiring clean interactive re-authentication.
  - **Trusted Identity Requirement:** Legacy migration strictly requires trusted account identity (`portalAccountId` and `portalUsername`). If missing, discards unverified claims, scrubs `config.json`, advances session epoch, and requires re-authentication. No placeholder accounts are invented.
  - **Settings Preservation:** Non-secret user settings (`ram`, `javaPath`, `javaArgs`, `portalUrl`) in `config.json` are preserved intact during credential scrubbing.
  - **Explicit Outcome Contract:** `MigrationOutcome` reports `{ protectedLoaded, failedProtectedLoad, legacyPlaintextDetected, legacyScrubbed, migrated, error }`.
- **Evidence:**
  - `[Phase 3 Gate] Migration: Coexisting protected credentials and legacy plaintext prioritize protected record and scrub plaintext` (passed, 6.37ms).
  - `[Phase 3 Gate] Migration: Interrupted migration crash boundary recovers on restart and scrubs plaintext` (passed, 5.91ms).
  - `[Phase 3 Gate] Migration: Failed protected record load with legacy plaintext fails closed and scrubs disk without restoring session` (passed, 2.69ms).
  - `[Phase 3 Failure Path Reproductions] Scrub-write failure on config.json is tracked and retried on restart` (passed, 8.09ms).

#### Item 5: Account-Scoped Session Ownership & Refresh Coalescing
- **Defects Remediated:**
  - Switching accounts previously carried over optional tokens (such as `minecraftAccessToken`) from the prior user session if the new login response omitted them.
  - `setCurrentUser` lacked validation to prevent re-labeling an existing session to a different account ID or Minecraft UUID.
  - Generic `ConfigManager.set` allowed secret injection into settings state.
- **Implementation:**
  - Separated `SessionManager.establishNewSession(...)` from `SessionManager.updateSessionFromRefresh(...)`.
  - `establishNewSession`: Strictly initializes session state with newly authenticated credentials. Optional tokens (`minecraftAccessToken`, `minecraftUuid`, `minecraftUsername`) are NEVER inherited from older accounts or prior sessions.
  - Separated Portal account identity (`portalAccountId`, `portalUsername`) from Minecraft identity (`minecraftUuid`, `minecraftUsername`), while maintaining normalized aliases for backwards compatibility.
  - `SessionManager.setCurrentUser`: Guards active credentials against identity spoofing; throws an error if an attempt is made to relabel credentials to a different Portal user ID or Minecraft UUID without authenticating.
  - `ConfigManager.set`: Completely strips `token`, `refreshToken`, `minecraftAccessToken`, and `sessionPortalUrl`. Secrets are never accepted via generic settings mutation and are never written to `config.json`.
  - Coalescing in `SessionManager.getCoalescedRefresh` is strictly keyed by `(portalUrl, accountId, sessionEpoch)`.
  - Monotonic `sessionEpoch` advancement automatically invalidates prior refresh keys and isolates concurrent callers.
- **Evidence:**
  - `[Phase 3 Gate] Session Replacement: establishNewSession does not inherit optional tokens; setCurrentUser blocks account relabeling` (passed, 0.36ms).
  - `[Phase 3 Gate] Scoped Refresh Coalescing: In-flight refresh coalesces matching keys and isolates epochs` (passed, 42.09ms).
  - `[Phase 3 Failure Path Reproductions] Cross-account optional token inheritance must never occur in establishNewSession` (passed, 7.83ms).

#### Item 6: Hardened Credential Writer & Exposed Storage State
- **Defects Remediated:**
  - Fixed temporary file naming could allow symlink hijacking or race conditions.
  - Storage provider errors exposed internal low-level exception details.
- **Implementation:**
  - `CredentialStore.saveCredentials` generates exclusive, unpredictable temporary filenames: `credentials.enc.tmp.<pid>.<time>.<random16>`.
  - Uses `fs.openSync` with `O_CREAT | O_EXCL | O_WRONLY` and mode `0o600` inside trusted directory (`0o700`).
  - Performs pre-rename `fs.lstatSync` verification to ensure the file is a regular file, not a symlink, with `stats.nlink === 1`.
  - Added `sanitizeProviderError(...)` mapping internal OS/SafeStorage errors into sanitized local public error strings.
  - Added secure IPC channel `auth:getStorageStatus` returning `AuthStorageStatusDto`:
    - `backend`: `"windows_dpapi" | "linux_keyring" | "session_only"`
    - `sessionOnly`: boolean
    - `persistenceAvailable`: boolean
    - `lastPersistenceError`: string | null
    - `lastCleanupError`: string | null
  - Preload bridge exposes `window.lampas.auth.getStorageStatus()`.
  - UI integration: `ui/src/views/auth-view.ts` and `ui/renderer.js` render a prominent warning toast when running in `session_only` mode or when cleanup errors occur.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Fixed temporary path link case — pre-existing temporary file or link must be prevented from clobbering` (passed, 4.65ms).
  - `[Phase 3 Gate] Storage Status: getStorageStatus returns accurate non-secret DTO` (passed, 0.16ms).
  - Characterization Test 1: Verifies all 38 secure IPC handlers, including `auth:getStorageStatus`.

#### Item 7: Exact-Version Native Evidence & Windows ACL Verification
- **Defects Remediated:**
  - Lack of multi-process restart verification demonstrating DPAPI ciphertext survival across distinct process invocations and lack of filesystem ACL verification on Windows.
- **Implementation:**
  - Hardened `test/electron-dpapi-restart.test.ts`:
    - **Process 1:** Spawns real `electron.exe` (Electron 44.0.0). Verifies `safeStorage.isEncryptionAvailable()`. Encrypts synthetic payload via `safeStorage.encryptString()`. Writes `credentials.enc` to custom `userData`. Verifies `Local State` (DPAPI key) and `credentials.enc` on disk contain zero plaintext. Exits cleanly via `app.quit()`.
    - **Process 2:** Spawns a completely SEPARATE `electron.exe` process lifecycle pointing to the same `userData`. Loads `credentials.enc`, decrypts via `safeStorage.decryptString()`, and verifies exact byte-for-byte equality with the original plaintext payload.
    - **Process 3:** Spawns a third `electron.exe` process to delete `credentials.enc` and verifies clean unlinking.
    - **Windows ACL Verification:** Uses native Windows `icacls` to inspect the permissions of the credential directory and `credentials.enc`. Confirms that access is restricted strictly to `NT AUTHORITY\SYSTEM` and the active user (`(OI)(CI)(F)` or `(F)`), with unapproved inherited access disabled.
  - **Platform Availability Documentation:** Windows DPAPI separate-process restart check and ACL validation are verified natively on Windows (host system). Linux Secret Service / Keyring validation is platform-specific to Linux and executed in Linux CI environments (`.github/workflows/release-pack.yml`).
  - Integrated `auth:getStorageStatus` check into `--smoke-test` executed by real `electron.exe` and packaged `Lampas Launcher.exe` (ASAR).
- **Evidence:**
  - `test/electron-dpapi-restart.test.ts`: Passed (407.97ms, 16 assertions).
  - Strict Electron smoke test (`bun test/smoke/electron-smoke.ts --strict`): All 7 checks passed, including unpacked dev/dist and packaged binary ASAR execution. Real Electron Chromium sandbox active; zero `--no-sandbox` flags.

#### Item 8: Comprehensive Validation & Verification
- **Test Suite Results:**
  - Full suite (`bun test`): **302 passed, 0 failed, 4 skipped, 6 todo across 36 files** (1273 expect calls).
  - Security failure reproductions (`test/security-failure-reproductions.test.ts`): **7 passed, 0 failed** (33 expect calls).
  - Security regression gates (`test/security-regression-gates.test.ts`): **17 passed, 0 failed, 4 skipped, 6 todo** (141 expect calls).
  - Boundary characterization (`test/security-boundary-characterization.ts`): **61 passed, 0 failed, 0 skipped, 0 outbound violations** in isolated child process.
  - Security characterization parent suite (`test/security-characterization.test.ts`): **16 passed, 0 failed** (108 expect calls).
  - Real Electron DPAPI restart test (`test/electron-dpapi-restart.test.ts`): **1 passed, 0 failed** (16 expect calls).
  - Production & test typechecks: 0 errors across `tsconfig.json`, `tsconfig.renderer.json`, and `tsconfig.security-test.json`.
  - Production build: `bun run build` transforms 12 modules and bundles in 154ms.
  - Strict smoke test: `bun test/smoke/electron-smoke.ts --strict` exits with code 0.
- **Dependency & Lockfile Verification:**
  - `git diff bun.lock`: **0 changes (byte-for-byte identical to baseline)**.
  - `bun.lock` SHA-256: `51834981eaa1925b2234e14295e5b733bdebc72697e575efb2046479821e4b3a`.

---

## Review Gate 3 Second Amendment — Checkpoint 609623feb5a00b826f5e91069a2284bfd76a59a8

- **Execution Date:** 19 September 2026
- **Status:** Ready for Review (Gate 3 Second Amendment Complete)
- **Accepted Review Gate 2 Checkpoint:** `16bd12ddecbbcd10041c79b5a2be45c2da0a60c7`
- **Reviewed Checkpoint:** `609623feb5a00b826f5e91069a2284bfd76a59a8`
- **Current Working Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 3 amendment ("Separate secrets and make authentication race-safe"). Phase 4 (Path containment), Phase 5 (Integrity checks fail-closed), and subsequent phases remain paused. Acceptance does not authorize merging, tagging, or publication.

---

### 1. Review Gate 3 Amendment Details (Seven Targeted Requirements)

Following review of checkpoint `609623feb5a00b826f5e91069a2284bfd76a59a8` and `LAMPAS_RG3_609623_AMENDMENT_PLAN.md`, all seven targeted amendment requirements have been fully addressed, verified with failing-before vs passing-after evidence, and integrated:

#### Requirement 1: Invalidate Persisted Eligibility Independently of currentRecord
- **Defects Remediated:**
  - Persisting account A, restarting with provider unavailable, establishing account B in session-only mode, then restoring provider and restarting previously allowed account A to silently resurrect from encrypted disk storage because `establishNewSession` only cleared disk if `currentRecord` was already loaded in memory.
  - Undefined authority of retained encrypted records after account replacement, logout, and token rotation.
- **Implementation:**
  - `SessionManager.establishNewSession`: Whenever persistence fails or runs in session-only mode (`saveResult.sessionOnly || !saveResult.success`), the on-disk credential store is unlinked unconditionally via `CredentialStore.clearCredentials()`, independently of whether `currentRecord` was loaded.
  - Defined explicit authority of retained encrypted records: retained encrypted files on disk are invalid and purged unless they match the active verified session and active portal origin. If durable cleanup cannot succeed, a durable invalidation marker (`credentials.invalidated`) is written to disk and `ClearCredentialsResult` reports `{ success: false, error: ... }`.
  - Added reproduction test in `test/security-failure-reproductions.test.ts` (Defect 1): verifies Persist A -> restart unavailable -> establish B session-only -> restore provider and restart -> A does not silently return.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 1: Persist A, restart with provider unavailable, establish B in session-only mode, restore provider and restart — A must not resurrect` (passed, 5.40ms).

#### Requirement 2: Reject Invalid Authentication Data Before Publication
- **Defects Remediated:**
  - Schema/identity failures previously fell back to session-only storage downgrade instead of aborting.
  - Fallback expressions invented `"account"`, `"player"`, or `"unverified-migration"` identities.
  - Restoring credentials without `minecraftUuid` fell back to `stored.accountId` (Portal-ID-as-Minecraft-UUID restoration).
- **Implementation:**
  - `SessionManager.establishNewSession`: Validates that `token`, `portalAccountId`, and `portalUsername` are non-empty strings and not placeholder identities (`"account"`, `"unverified-migration"`). Throws an exception and aborts publication immediately if invalid.
  - `LauncherAuth.loginWithPortal`: Validates exchange response `token` and `user` (id and name) before committing; rejects missing, empty, or placeholder identities without publishing or downgrading.
  - `SessionManager.initialize`: When restoring protected records, `currentUser.minecraftUuid` is strictly populated from `stored.minecraftUuid` (zero fallback to `stored.accountId`).
  - Added reproduction test in `test/security-failure-reproductions.test.ts` (Defect 2): verifies empty tokens and missing identities throw and do not publish; verifies no Portal-ID-as-Minecraft-UUID fallback.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 2: Reject invalid authentication data before publication (no session-only downgrade, no placeholders, no Portal-ID-as-Minecraft-UUID)` (passed, 4.09ms).

#### Requirement 3: Make Malformed Legacy Data Ineligible Without Bypassing Cleanup
- **Defects Remediated:**
  - Malformed legacy data (e.g. invalid portal URLs or non-string tokens) could throw during normalization or parsing, aborting initialization before legacy plaintext cleanup occurred.
  - Legacy cleanup previously risked wiping non-secret settings.
- **Implementation:**
  - `SessionManager.initialize`: Wrapped `normalizePortalUrl(parsed.sessionPortalUrl)` in safe try-catch; if normalization fails, marks legacy credentials as ineligible and proceeds directly to scrub.
  - `SessionManager.scrubPlaintextFromConfig`: Safely removes sensitive fields (`token`, `refreshToken`, `minecraftAccessToken`, `sessionPortalUrl`) while preserving all non-secret settings (`ram`, `gameDir`, `javaPath`, `javaArgs`, `portalUrl`).
  - Coexistence precedence: If protected record exists and legacy config has malformed data, cleanup still runs and strips the plaintext keys.
  - Added reproduction test in `test/security-failure-reproductions.test.ts` (Defect 3): verifies malformed legacy URL `:::not-a-valid-url:::` does not abort cleanup; plaintext is scrubbed while `ram` and `gameDir` are preserved.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 3: Malformed legacy data is ineligible without bypassing cleanup; preserves settings` (passed, 2.90ms).

#### Requirement 4: Complete Credential Commit Contract
- **Defects Remediated:**
  - Short/zero-progress writes were not explicitly detected during temporary file writes.
  - `saveCredentials` could report success even if the `credentials.invalidated` marker could not be deleted prior to commit (which would cause the new record to be rejected on reload).
  - Write, flush, rename, marker, and cleanup failure paths were not tested independently.
- **Implementation:**
  - `CredentialStore.saveCredentials`: Implemented chunked write loop verifying `written <= 0` and throwing `"Zero-progress write encountered"`.
  - Explicit flush: Calls `fs.fsyncSync(fd)` before closing temporary file descriptor.
  - Pre-commit marker check: If `credentials.invalidated` exists, attempts to unlink it before rename. If marker unlinking fails, aborts commit, unlinks temporary file, and returns `{ success: false, error: "Failed to clear invalidation marker..." }`.
  - Post-commit double-check: Verifies marker is not recreated during rename.
  - Replacement ordering strictly preserved: write exclusive temp -> fsync -> validate stats (`stats.nlink === 1`) -> clear invalidation marker -> atomic rename -> verify marker clean -> scrub fallback/plaintext.
  - Added independent reproduction tests in `test/security-failure-reproductions.test.ts`:
    - Defect 4: Short write and invalidation marker persistence contract.
    - Defect 4b: Independent write failure path (`EIO` in `fs.writeSync`) unlinks temp and fails cleanly.
    - Defect 4c: Independent flush failure path (`EIO` in `fs.fsyncSync`) unlinks temp and fails cleanly.
    - Defect 4d: Independent rename failure path (`EBUSY` in `fs.renameSync`) unlinks temp and fails cleanly.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 4: Short write and invalidation marker persistence contract` (passed, 5.10ms).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 4b: Independent write failure path unlinks temp and fails cleanly` (passed, 1.50ms).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 4c: Independent flush failure path unlinks temp and fails cleanly` (passed, 0.81ms).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 4d: Independent rename failure path unlinks temp and fails cleanly` (passed, 3.71ms).

#### Requirement 5: Make Storage Status Truthful and Safe
- **Defects Remediated:**
  - Storage status reported `sessionOnly: false` whenever provider was available, even if the active session was held in memory due to persistence failure.
  - Error messages could expose internal filesystem paths or low-level provider exceptions.
  - UI adapters did not consume the single `ClearCredentialsResult` from logout.
- **Implementation:**
  - Added `SessionManager.isCurrentSessionPersisted: boolean` to track whether the active session was actually committed to encrypted storage.
  - `SessionManager.getStorageStatus()`: Computes `sessionOnly = !persistenceAvailable || (hasActiveSession && !this.isCurrentSessionPersisted)` and returns `sessionPersisted: this.isCurrentSessionPersisted`.
  - Added `sanitizeCleanupError(err)` in `src/credential-store.ts` mapping error codes to bounded main-chosen strings (<= 120 chars) without raw paths:
    - `"Failed to delete stored credentials file: resource busy or locked"`
    - `"Failed to delete stored credentials file: permission denied"`
    - `"Failed to delete stored credentials file: disk error"`
  - Updated preload and UI (`ui/src/views/auth-view.ts` and `ui/renderer.js`): `window.lampas.auth.logout()` returns `Promise<ClearCredentialsResult>` directly; UI reports toast notification reflecting actual cleanup outcome without claiming success if unverified.
  - Added reproduction test in `test/security-failure-reproductions.test.ts` (Defect 5): verifies `sessionPersisted: false` and `sessionOnly: true` when encryption fails, and verifies error message length <= 120 chars without path leakage.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 5: Storage status tracks session persistence separately from provider and returns bounded safe error` (passed, 0.49ms).

#### Requirement 6: Strengthen Tests and Native Evidence
- **Defects Remediated:**
  - Need for held-exchange timeout, cancellation, and supersession tests with deterministic request barriers and explicit nonpublication assertions.
  - Native Electron restart test ran raw `safeStorage` scripts instead of requiring and exercising the built launcher store and session modules across processes.
  - Need to assert Electron runtime version (`44.0.0`).
  - Windows ACL verification used fragile substring checks (`everyone`, `users:(i)(f)`) instead of parsing principals and rights.
  - Unavailable native platforms were silently skipped rather than marked skipped/unverified.
- **Implementation:**
  - Added held-exchange deterministic barrier tests in `test/security-failure-reproductions.test.ts`:
    - **Defect 6 (Cancellation):** Exchange is held at barrier; user cancels login; barrier released; late token response arrives and is discarded; nonpublication verified (0 token in memory, 0 in config).
    - **Defect 6b (Timeout):** Exchange is held at barrier; 120s timeout terminates context; barrier released; late response discarded; nonpublication verified.
    - **Defect 6c (Supersession):** Attempt A enters exchange and is held at barrier; Attempt B starts, supersedes A, and completes with Token B; barrier for A is released; Attempt A's response is discarded; Token B remains active.
  - Hardened `test/electron-dpapi-restart.test.ts`:
    - **Electron Version Assertion:** Child processes assert `process.versions.electron === "44.0.0"`.
    - **Built Module Execution:** Spawns distinct Electron 44.0.0 processes requiring `dist/credential-store.js` and `dist/session-manager.js`:
      - Process 1: `SessionManager.establishNewSession(...)` persists credentials via DPAPI.
      - Process 2: Completely separate Electron process calls `CredentialStore.loadCredentials()` and `SessionManager.initialize()`, verifying exact payload restoration.
      - Process 3: Completely separate Electron process calls `SessionManager.clearSession()`, verifying clean deletion and null reload.
    - **Parsed `icacls` ACL Verification:** Implemented `parseIcacls(output)` and `verifyAclSecurity(targetPath)`. Verifies that for both `userDataDir` and `credentials.enc`:
      - No dangerous/world principals (`Everyone`, `Users`, `Guests`, `Anonymous`, `World`) have write, modify, or full control permissions (`(F)`, `(M)`, `(W)`, `(WD)`, `(AD)`).
      - Privileged/owner principals (`SYSTEM`, `Administrators`, active user) exist and have access.
    - **Platform Skip Handling:** Uses `test.skipIf(!isWindows)` and registers `test.skip("Windows DPAPI credential store native verification (unverified on non-Windows platform)")` so unavailable platforms are explicitly marked skipped.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 6: Held-exchange cancellation and supersession with deterministic barriers and nonpublication` (passed, 78.92ms).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 6b: Held-exchange timeout with deterministic barrier and nonpublication` (passed, 74.98ms).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 6c: Held-exchange supersession with deterministic barrier and nonpublication` (passed, 114.41ms).
  - `test/electron-dpapi-restart.test.ts`: **1 passed, 0 failed** (29 expect calls, 412.61ms).

#### Requirement 7: Comprehensive Validation & Verification
- **Test Suite Results:**
  - Full suite (`bun test`): **313 passed, 0 failed, 4 skipped, 6 todo across 36 files** (1347 expect calls).
  - Security failure reproductions (`test/security-failure-reproductions.test.ts`): **18 passed, 0 failed** (94 expect calls).
  - Security regression gates (`test/security-regression-gates.test.ts`): **17 passed, 0 failed, 4 skipped, 6 todo** (141 expect calls).
  - Boundary characterization (`test/security-boundary-characterization.ts`): **61 passed, 0 failed, 0 skipped, 0 outbound violations** in isolated child process.
  - Real Electron DPAPI restart test (`test/electron-dpapi-restart.test.ts`): **1 passed, 0 failed** (29 expect calls).
  - Production & test typechecks: 0 errors across `tsconfig.json`, `tsconfig.renderer.json`, and `tsconfig.security-test.json`.
  - Production build: `bun run build` and `bun run package:dir` bundle and package with zero errors.
  - Strict smoke test: `bun test/smoke/electron-smoke.ts --strict` exits with code 0 (all 7 checks passed, real Electron sandbox active, zero `--no-sandbox`).
- **Dependency & Lockfile Verification:**
  - `git diff bun.lock`: **0 changes (byte-for-byte identical to baseline)**.
  - `bun.lock` SHA-256: `51834981eaa1925b2234e14295e5b733bdebc72697e575efb2046479821e4b3a`.

---

### 3. Review Gate 3 Third Amendment (Remediation of 5 Blocking Findings from `502ecb0266fa1232d2b1427785bc039cc367cbd9`)

Following thorough review of checkpoint `502ecb0266fa1232d2b1427785bc039cc367cbd9`, five blocking findings were remediated, verified against failing reproduction paths, and integrated:

#### Finding 1: High — Stale Persisted Credentials Resurrection on Invalidation Failure
- **Vulnerability:** In `SessionManager.establishNewSession`, when `saveCredentials()` returned session-only, it invoked `clearCredentials()`. However, it only aborted when both `clearResult.success === false` and `saveResult.success === false`. A session-only save reported `{ success: true, sessionOnly: true }`, so failed cleanup of disk credentials was ignored and Account B was published in memory. If secure storage later became available upon restart, Account A would silently resurrect.
- **Remediation:**
  - Extended `ClearCredentialsResult` in `src/types.ts` and `src/credential-store.ts` with `durablyInvalidated: boolean` and `staleRecordIneligible?: boolean`.
  - In `CredentialStore.clearCredentials()`, independently tracked `deletedTarget`, `destroyedTarget` (0-byte truncation), and `markerWritten` (durable invalidation marker). Computed `durablyInvalidated = !targetExisted || deletedTarget || destroyedTarget || markerWritten`.
  - In `SessionManager.establishNewSession()`: if storage is session-only or persistence fails, verifies `clearResult.durablyInvalidated`. If `!clearResult.durablyInvalidated` (e.g. unlink, 0-byte overwrite, and marker write all failed), the session manager immediately advances session epoch and throws an error fail-closed without publishing Account B in memory.
  - In `SessionManager.updateSessionFromRefresh()`: applied the identical fail-closed check on persistence failure (`if (!clearResult.durablyInvalidated) throw ...`).
  - Added reproduction test in `test/security-failure-reproductions.test.ts` (`Defect 1b`): simulates catastrophic disk deletion failure where unlink, overwrite, and marker creation all fail; verifies `durablyInvalidated === false` and `establishNewSession` throws without publishing Account B in memory.
- **Evidence:** `[Phase 3 Failure Path Reproductions] Reproduce Defect 1b: When unlink, overwrite, and marker creation all fail during replacement, replacement account B must NOT be published` (passed).

#### Finding 2: High — Syntactically Malformed Legacy JSON Non-Secret Wipe
- **Vulnerability:** When `config.json` was syntactically malformed or truncated (e.g., power loss mid-write), `JSON.parse` threw an error and left `parsed = null`. In that case, `scrubPlaintextFromConfig(configPath, null)` overwrote `config.json` with an empty `{}` object, obliterating all user settings (`allocatedRamGb`, `gameDir`, `portalUrl`, etc.). Additionally, key detection relied on truthiness (`parsed[key]`), causing present-but-empty tokens (e.g. `"token": ""`) to bypass scrubbing.
- **Remediation:**
  - Integrated `jsonc-parser` in `src/session-manager.ts` for tolerant parsing and regex key-value extraction as a fallback when `raw` is truncated or malformed.
  - Salvaged non-secret settings (`allocatedRamGb`, `gameDir`, `portalUrl`, `javaPath`, `javaArgs`, `noSync`, etc.) from truncated/malformed text.
  - Scrubbed secret keys (`token`, `refreshToken`, `minecraftAccessToken`, `sessionPortalUrl`) using regex redaction from the raw text.
  - Reconstructed and wrote back valid JSON preserving all salvaged non-secret settings.
  - Updated plaintext key detection to check presence (`SECRET_KEYS.some(k => k in parsed)`), capturing present-but-falsy keys (`"token": ""`).
  - Added reproduction test in `test/security-failure-reproductions.test.ts` (`Defect 3b`): verifies non-secret settings are preserved while tokens are scrubbed on truncated/malformed JSON and present-but-falsy tokens.
- **Evidence:** `[Phase 3 Failure Path Reproductions] Reproduce Defect 3b: Syntactically malformed / truncated legacy JSON and present-but-falsy tokens are cleaned up without wiping non-secret settings` (passed).

#### Finding 3: Medium — Synthetic Identity `"player"` Still Accepted
- **Vulnerability:** While `"account"` and `"unverified-migration"` were rejected as placeholder identities, literal `"player"` or `"Player"` was still accepted as a legitimate account identity, allowing synthetic or unverified accounts to be treated as genuine.
- **Remediation:**
  - In `src/credential-store.ts` (`validateRecord`): rejected `accountId.toLowerCase() === "player"` and `username.toLowerCase() === "player"`.
  - In `src/session-manager.ts` (`establishNewSession` and legacy account detection): rejected `portalAccountId.toLowerCase() === "player"` and `portalUsername.toLowerCase() === "player"`.
  - In `src/auth.ts` (`loginWithPortal`): rejected `user.name.toLowerCase() === "player"` and `user.id.toLowerCase() === "player"`, terminating the context with an error and returning HTTP 400.
  - Added reproduction test in `test/security-failure-reproductions.test.ts` (`Defect 2b`): asserts literal `"player"` / `"Player"` synthetic identity is rejected across token exchange, stored-record validation, and `establishNewSession`.
- **Evidence:** `[Phase 3 Failure Path Reproductions] Reproduce Defect 2b: Literal 'player' synthetic identity is rejected across exchange, session establishment, and stored-record validation` (passed).

#### Finding 4: Gate Blocker — CI Failures on Windows and Ubuntu
- **Vulnerability:**
  - On Windows CI: `bun install` does not run package postinstall/lifecycle scripts by default, leaving `electron.exe` missing from `node_modules/electron/dist/` and causing `test/electron-dpapi-restart.test.ts` to fail in CI.
  - On Ubuntu CI: 15 tests collapsed to session-only mode because `MockSafeStorage` did not implement `getSelectedStorageBackend()`, which `detectStorageBackend()` requires on Linux (`getSelectedStorageBackend() === "gnome_libsecret"`).
- **Remediation:**
  - Added `"trustedDependencies": ["electron"]` to `package.json`.
  - Added explicit `node node_modules/electron/install.js` step to `.github/workflows/validate.yml` following `bun install --frozen-lockfile`.
  - Verified `bun.lock` has **zero diff** (`git diff bun.lock` is empty).
  - Added fallback installer check in `test/electron-dpapi-restart.test.ts` ensuring `electron.exe` is installed if missing.
  - Added `getSelectedStorageBackend()` returning `"gnome_libsecret"` on Linux across `MockSafeStorage` and `MockGateSafeStorage` definitions in `test/security-boundary-characterization.ts`, `test/security-regression-gates.test.ts`, and `test/security-failure-reproductions.test.ts`.
- **Evidence:**
  - Local verification on Windows and cross-platform mock tests pass 100%.
  - `git diff bun.lock`: 0 changes (byte-identical lockfile).

#### Finding 5: Documentation Integrity — Exact Commit SHA Capture
- **Vulnerability:** Prior completion report inadvertently referenced a typo SHA (`502ecb04...` instead of actual `502ecb0266fa1232d2b1427785bc039cc367cbd9`).
- **Remediation:** All handoff reports and progress records now directly read and embed the exact 40-character commit SHA via `git rev-parse HEAD`.

---

### 4. Review Gate 3 Fourth Amendment (Remediation of 4 Blocking Findings from `9f6ff931a20f91738d36d03561b3428fff6b9a09`)

Following thorough review of checkpoint `9f6ff931a20f91738d36d03561b3428fff6b9a09`, four blocking findings (three credential-lifecycle gaps and one Windows CI socket closure race) were remediated, verified against failing reproduction paths, and integrated:

#### Finding 1: High — Invalidation Marker Premature Removal in `saveCredentials()`
- **Vulnerability:** In `CredentialStore.saveCredentials()`, the durable invalidation marker was removed *before* `fs.renameSync(uniqueTemp, targetFile)` was called. If an interruption (power loss, OS crash, process kill, or `EBUSY` rename failure) occurred after unlinking the marker but before the rename committed, stale Account A's encrypted file remained on disk without an invalidation marker. Upon application restart when secure storage was available, Account A would silently resurrect.
- **Remediation:**
  - Inverted the commit sequence in `src/credential-store.ts` (`saveCredentials()`):
    1. Write exclusive temp file (`fs.openSync` with `O_CREAT | O_EXCL | O_WRONLY`) and flush (`fs.fsyncSync`).
    2. Atomically rename temp file to target file (`fs.renameSync(uniqueTemp, targetFile)`). This commits the new credential record to disk FIRST while the invalidation marker is still authoritative.
    3. Remove the durable invalidation marker (`fs.unlinkSync(markerFile)`) ONLY AFTER the replacement credential file is committed.
    4. If unlinking the marker fails, the newly committed credential file is immediately unlinked (`fs.unlinkSync(targetFile)`), leaving the marker intact to prevent stale exposure, and a failure result is reported.
  - Added reproduction tests in `test/security-failure-reproductions.test.ts`:
    - `Defect 1c`: Interruption before replacement rename preserves invalidation marker; restart refuses to load stale credentials.
    - `Defect 1d`: Atomic rename failure (`EBUSY`) leaves invalidation marker intact; restart refuses to load stale credentials.
    - `Defect 1e`: Interruption after replacement but before marker removal leaves launcher safely logged out on restart.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 1c: Invalidation marker remains authoritative until replacement is committed (interruption before replacement)` (passed).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 1d: Invalidation marker remains authoritative on atomic rename failure` (passed).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 1e: Interruption after replacement but before marker removal leaves launcher safely logged out` (passed).

#### Finding 2: High — Escaped Credential Keys in Malformed JSON
- **Vulnerability:** In `SessionManager`, tolerant plaintext scrubbing was gated behind a regex (`SECRET_KEY_REGEX = /"(?:token|refreshToken|minecraftAccessToken|sessionPortalUrl)"\s*:/`) that missed unicode-escaped keys such as `"to\u006ben"`. Furthermore, if `config.json` was truncated or malformed and no non-secret settings were salvaged, the scrubber previously fell back to writing raw unverified text, potentially leaving unscrubbed or malformed content on disk.
- **Remediation:**
  - Added `decodeJsonStringToken(content)` to decode unicode escape sequences (`\uXXXX`) and standard JSON string escapes (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`) in property names.
  - Implemented `detectPlaintextSecretKeys(parsed, raw)`: structurally checks parsed object keys and tolerantly scans decoded property names from raw text against `SECRET_KEYS_SET = new Set(["token", "refreshToken", "minecraftAccessToken", "sessionPortalUrl"])`.
  - In `scrubPlaintextFromConfig()`:
    - Scans property names using `decodeJsonStringToken`, stripping secret key-value pairs regardless of literal or escaped representation.
    - Salvages all non-secret configuration properties (`allocatedRamGb`, `gameDir`, `portalUrl`, `javaPath`, `javaArgs`, `noSync`, etc.).
    - Formats valid JSON with 2-space indentation (or `"{}\n"` if no non-secret keys exist).
    - Verifies the scrubbed result by reading it back from disk and validating with `JSON.parse`.
  - Added reproduction tests in `test/security-failure-reproductions.test.ts`:
    - `Defect 3c`: Escaped unicode keys (`to\u006ben`, `\u0072efreshToken`, `minecraft\u0041ccessToken`, `session\u0050ortalUrl`) in truncated JSON are scrubbed cleanly while preserving non-secret settings.
    - `Defect 3d`: Duplicate keys, mixed literal/escaped keys, and present-but-falsy values are scrubbed cleanly to valid JSON.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 3c: Tolerant scanning detects escaped keys in malformed JSON and scrubs without losing non-secret settings` (passed).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 3d: Malformed JSON with duplicate and mixed escaped/literal keys scrubs clean and validates output` (passed).

#### Finding 3: Medium — Refresh Publishes `"player"`/`"Player"` & Candidate Validation Fail-Closed
- **Vulnerability:** In `SessionManager.updateSessionFromRefresh()`, `this.currentUser = user` was assigned *before* candidate record validation. If credential store schema validation failed, the method caught the error and treated it as a persistence failure, downgrading to session-only mode and publishing the invalid user in memory. Furthermore, `LauncherAuth.refreshSession()` and `verifySession()` did not check commit outcomes, allowing invalid authentication data to be treated as a valid refresh.
- **Remediation:**
  - Added `validateCandidateSession(record, user)` shared validator enforcing:
    - Credential store schema validation (`CredentialStore.validateRecord(record)`).
    - Identity and profile field constraints (UUID format, non-empty, non-synthetic names).
    - Case-insensitive rejection of placeholder identities: `"player"`, `"account"`, `"unverified-migration"`.
  - In `SessionManager.setCurrentUser()`: rejected placeholder identities case-insensitively.
  - In `SessionManager.establishNewSession()`: validates candidate record first; re-throws schema rejections fail-closed without publishing.
  - In `SessionManager.updateSessionFromRefresh()`:
    - Validates complete candidate session BEFORE mutating `this.currentUser` or publishing any state.
    - If candidate record fails schema validation, immediately aborts fail-closed and re-throws the error. This is NOT a storage error and must never downgrade to session-only mode.
    - Assigns `this.currentUser = user` ONLY AFTER persistence checks succeed or safe session-only fallback is explicitly permitted.
  - In `src/auth.ts`:
    - `refreshSession()` and `verifySession()` check `updateSessionFromRefresh()` return value and catch validation errors, returning `{ valid: false }` without publishing.
  - Added reproduction tests in `test/security-failure-reproductions.test.ts`:
    - `Defect 2c`: Refresh returning `"player"` and `"Player"` throws, does not alter published user or session state, and `refreshSession()` returns `{ valid: false }`.
    - `Defect 2d`: Refresh returning malformed optional token types (e.g. number instead of string) throws and does not downgrade to session-only mode.
- **Evidence:**
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 2c: Same-account refresh rejects 'player' and 'Player' without altering published user or session state` (passed).
  - `[Phase 3 Failure Path Reproductions] Reproduce Defect 2d: Same-account refresh rejects malformed optional token types and does not downgrade to session-only` (passed).

#### Finding 4: Gate Blocker — Windows CI Socket Closure on Loopback OAuth Listener
- **Vulnerability:** In `src/auth.ts`, `settleOnce()` called `socket.destroy()` unconditionally across all client sockets immediately upon sending the HTTP response. On Windows, immediate socket destruction resets the connection (`ECONNRESET` / `WSAECONNRESET`) while the HTTP response (`200 OK` or error payload) is still queued in the Windows TCP stack buffer, before the client browser or test harness can read it. This caused intermittent socket hangs and connection reset failures on Windows CI.
- **Remediation:**
  - Separated immediate logical settlement from bounded transport cleanup:
    - **Logical Settlement:** Immediately sets `isSettled = true`, closes the HTTP server to new incoming connections (`server.close()`), and unregisters event listeners.
    - **Transport Teardown:**
      - For intentional response paths (`200 OK`, `400 Bad Request`, `409 Conflict`, etc.): allows Node's HTTP server to transmit buffered response data and close sockets gracefully via `socket.end()`. Sockets that do not close within a 250ms unref grace period are destroyed via `socket.destroy()`.
      - For immediate abort paths (cancellation, timeout, supersession, shutdown): calls `socket.destroy()` immediately to terminate in-flight connections without waiting.
  - Preserved strict single-use semantics and deterministic listener lifecycle.
- **Evidence:**
  - Characterization Test 60 (`Loopback OAuth listener enforces method, path, host, single-use, and deterministic cleanup`): passed cleanly.
  - Security failure reproductions (`test/security-failure-reproductions.test.ts`): all 28 tests pass cleanly with 0 connection resets or unhandled socket errors.

---

### 5. Review Gate 3 Status & Pause Declaration

- **All 4 Blocking Findings Remediated and Verified:**
  - Full suite (`bun test`): **323 passed, 0 failed, 4 skipped, 6 todo across 36 files** (1428 expect calls).
  - Security failure reproductions (`test/security-failure-reproductions.test.ts`): **28 passed, 0 failed** (175 expect calls).
  - Security regression gates (`test/security-regression-gates.test.ts`): **17 passed, 0 failed, 4 skipped, 6 todo** (141 expect calls).
  - Child boundary runner (`test/security-boundary-characterization.ts`): **61 passed, 0 failed, 0 outbound violations, 0 skipped**.
  - Real Electron DPAPI restart test (`test/electron-dpapi-restart.test.ts`): **1 passed, 0 failed** (29 expect calls).
  - TypeScript typechecks: 0 errors across `tsconfig.json`, `tsconfig.renderer.json`, and `tsconfig.security-test.json`.
  - Production build: `bun run build` succeeds cleanly.
  - Strict smoke test: `bun test/smoke/electron-smoke.ts --strict` succeeds cleanly (real Electron 44.0.0 and packaged binary ASAR verified; zero `--no-sandbox`).
  - Lockfile: `git diff bun.lock` is empty (zero drift; byte-identical to baseline).

**STOPPING AT REVIEW GATE 3.** Phase 4 remains paused pending formal review and acceptance of Review Gate 3. Acceptance does not authorize merging, tagging, or publication. Ready for user review.


