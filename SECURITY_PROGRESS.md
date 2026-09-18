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
| **SEC-03** | P1 / High | Phase 3 | **Remediated & Verified** | Plaintext credential separation complete. Main-only `CredentialStore` using OS-encrypted DPAPI (`credentials.enc`), `session_only` fallback for insecure backends (`basic_text`), atomic writes with `0o600` permissions, safe corruption recovery, deterministic 3-checkpoint migration, and token-free `config.json` on disk. |
| **SEC-04** | P0 / High | Phase 4 | Pending | Path containment & ownership inconsistencies (`isPathProtected`). Deferred to Phase 4. |
| **SEC-05** | P1 / Med-High | Phase 4 | Pending | Move recovery recursive deletion of unvalidated staging path. Deferred to Phase 4. |
| **SEC-06** | P1 / High-Cond | Phase 5 | Pending | Executable verification fails open (missing hash fallback). Deferred to Phase 5. |
| **SEC-07** | P1 / High-Cond | Phase 5 | Pending | Inappropriate fallback on HTTP 410 REVOKED releases. Deferred to Phase 5. |
| **SEC-08** | P1 / Medium | Phase 3 | **Remediated & Verified** | Loopback OAuth listener hardened. Bounded method (`GET`), URL (<= 2048), and `Host` validation. Noise-tolerant routing (404 without flow abort). Single-use exchange with replay rejection (HTTP 409). Session epoch coordination discarding late responses. Single-flight refresh coalescing. Information-disclosure-free completion HTML. Unified deterministic cleanup. |
| **SEC-09** | P1 / Medium | Phase 6 | Pending | Logging redaction gaps (`refresh_token`, URL query codes, CLI args). Deferred to Phase 6. |
| **SEC-10** | P2 / Med-Priv | Phase 6 | Pending | Third-party information disclosure (`mc-heads.net`, unvalidated image URLs). Deferred to Phase 6. |
| **SEC-11** | P2 / Medium | Phase 5 | Pending | Unbounded decompression ingestion budgets in `ensureNatives`. Deferred to Phase 5. |
| **SEC-12** | P2 / Medium | Phase 7 | Pending | Release pipeline permissions and mutable action pins. Deferred to Phase 7. |

---

### 9. Review Gate 3 Acceptance & Pause Declaration

- **Phase 3 Scope Fully Implemented & Verified:**
  - `src/credential-store.ts` and `src/session-manager.ts` implemented and integrated.
  - Credential record contract schema v1 enforced with origin binding.
  - Storage backends (`windows_dpapi`, `linux_keyring`, `session_only` fallback) verified.
  - Deterministic migration state machine and crash-consistency boundary verified.
  - Monotonic `sessionEpoch` coordination and continuation invalidation barriers verified.
  - Loopback OAuth listener hardened (method/URL/Host validation, noise resilience, single-use replay defense, HTML sanitization, and deterministic cleanup).
  - Single-flight refresh coalescing verified.
  - Synchronous logout semantics verified.
  - Token-free settings persistence verified (`config.json` contains zero secrets).
  - Zero synthetic secrets leaked in IPC, logs, or disk files.
- **Pre-Existing Invariants:**
  - All baseline, Phase 1, and Phase 2 protections preserved intact.
  - Full suite: 287 passed, 0 failed across all 34 test files.
- **Dependencies & Lockfile:**
  - `bun.lock` is byte-for-byte identical with baseline (zero package mutations).
- **Typecheck & Packaging:**
  - Production typecheck, security test typecheck, production Vite build, and Electron smoke tests (`--strict`, without `--no-sandbox`) pass cleanly with 0 errors.

**STOPPING AT REVIEW GATE 3.** Phase 4 (Unify metadata, path ownership and safe recovery) has not been started and remains paused. Acceptance does not authorize merging, tagging, or publication. Ready for human review.
