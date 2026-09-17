# Lampas Launcher — Security Hardening Progress

## Review Gate 2 — Narrow IPC Capabilities and Lock Down the Renderer (SEC-02)

- **Execution Date:** 17-18 September 2026
- **Status:** Complete (Review Gate 2 amended implementation verified; Phase 2 complete; paused before Phase 3)
- **Accepted Baseline Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc`
- **Accepted Review Gate 1 Checkpoint:** `e1d029112bd4b2843d61ccc19891556192e3efeb`
- **Reviewed Gate 2 Checkpoints:** `689800eda9c6b56910546cf608b34f243029d1db`, `f39ad0db8351c08e3bcf8c0c4f68ff6bed1b6f4a`
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

### 2. Review Gate 2 Defect Remediation Details (Five Specific Amendment Items)

Following review of checkpoint `f39ad0db8351c08e3bcf8c0c4f68ff6bed1b6f4a`, all five review items have been completely addressed, verified with failing-before vs passing-after evidence, and integrated:

#### Item 1: System-Property Code-Loading Approval Bypasses Closed
- **Prior Defect:** A generic heuristic permitted safe-looking `-D` properties (e.g. any `-D[a-zA-Z0-9_.-]+=[^'"\s]+`), allowing unreviewed properties to bypass native confirmation. Mod-discovery and launch authority properties (e.g. `fabric.addMods`, `fabric.modsFolder`, `quilt.addMods`, `forge.modsFolder`, `neoforge.modsFolder`, `java.library.path`, `org.lwjgl.librarypath`, `minecraft.applet.TargetDirectory`, `java.system.class.loader`, `java.security.*`, `com.sun.management.*`, class loading) could be injected without native approval. Furthermore, option operands were not consumed as part of sequence parsing, allowing separate-token and equals forms to differ in classification.
- **Remediation Implemented:**
  - Replaced generic `-D` heuristic with an explicit dictionary `ORDINARY_SYSTEM_PROPERTIES` specifying exact allowed property names and strict regular expressions for permitted values:
    - Standard localization, encoding, and headless properties (`file.encoding`, `user.language`, `user.country`, `java.awt.headless`, `sun.java2d.opengl`, etc.).
  - Added `LAUNCH_AUTHORITY_PROPERTY_PATTERN` classifying all mod-discovery, library search path, classloader, security manager, and management properties:
    - `fabric.addMods`, `fabric.modsFolder`, `quilt.addMods`, `forge.modsFolder`, `neoforge.modsFolder`, `java.library.path`, `org.lwjgl.librarypath`, `minecraft.applet.TargetDirectory`, `java.system.class.loader`, `java.security.*`, `com.sun.management.*`, etc.
    - Mod-discovery properties are classified as `hasLaunchTargetOverride: true` and strictly prohibited from renderer configuration.
    - Other unknown properties are classified as `hasPrivilegedOptions: true`, requiring native approval or rejection.
  - Implemented sequence-aware argument parser (`classifyJavaArgs`) that consumes option operands across both separate-token (`-cp foo`, `-m mod/main`, `--patch-module mod=dir`) and equals forms (`--module=mod/main`, `--patch-module=mod=dir`), ensuring equivalent classifications.
  - Prohibited positional launch targets (main class names, `.java` source files, `@argfile` argument files) across all forms.
  - Controls enforced at both the actual settings handler (`config:set` rejects launch targets fail-closed and triggers native dialog for privileged options) and the process-argument sink (`buildLaunchArguments` in `GameRunner`).
  - Tested: ordinary tuning is usable without approval; sensitive properties trigger confirmation dialog; cancelled dialog leaves settings invariant; prohibited launch targets fail-closed; no real Java processes are spawned.
- **Verification (Failing-Before vs Passing-After):**
  - *Before:* `-Dfabric.addMods=C:\\pwn.jar` and `-Djava.library.path=C:\\pwn` were classified as ordinary safe tuning options and accepted without native approval. Separate-token `-cp foo` separated `-cp` from `foo`, treating `foo` as a positional target rather than operand.
  - *After:* `-Dfabric.addMods=C:\\pwn.jar` is classified as launch-target override and rejected fail-closed; `-Djava.library.path=C:\\pwn` is classified as privileged and requires native approval; sequence parsing consumes operands cleanly in both separate and equals syntax; cancelling confirmation leaves settings unchanged. All 18 cases in Test 47 pass.

#### Item 2: Approval Generation and Lifetime Made Unambiguous
- **Prior Defect:** `grantApproval` used a overloaded magnitude heuristic (`optionsOrGeneration > 10_000` inferred TTL, while smaller values inferred generation number), conflating document generations with lifetimes. Document generations at or above 50 or below 50 were ambiguous. Approval lifetime was not decoupled from generation number. Missing `mainFrame` or detached frames were not strictly handled.
- **Remediation Implemented:**
  - Replaced the overloaded parameter with explicit options: `{ generation?: number; ttlMs?: number }`.
  - Enforced exact equality with the current document generation:
    `if (options?.generation !== undefined && options.generation !== this.documentGeneration) { throw new IpcSecurityError("Document generation mismatch during approval grant."); }`
  - Decoupled approval lifetime: default lifetime is always 60,000ms (`APPROVAL_TTL_MS = 60_000`) regardless of document generation number.
  - Updated legacy test call sites specifying low TTL to pass explicit `{ ttlMs: 100 }`.
  - Added comprehensive coverage in Test 49 for generations below 50, at 50, and above 50, stale/future generations, expiration, and single-use consumption.
  - Enforced strict sender and snapshot frame validation: missing `mainFrame` fails closed, detached or destroyed frames fail closed, and approved document URL is revalidated after native approval returns.
  - Exercised actual registered handlers (`gameDir:configure`, `gameDir:move`, `mods:addPaths`, `config:set`) with deferred native dialogs: navigation during dialog fails closed, conflicting operations during dialog fail closed, user cancellation leaves settings intact, unavailable dialog service fails closed, and confirmed operations execute properly.
- **Verification (Failing-Before vs Passing-After):**
  - *Before:* Passing generation number `60_000` was misinterpreted as a TTL; passing generation `5` was accepted for document generation `3` if `< 50`; missing `mainFrame` did not throw security error; navigation during dialog could allow stale approval consumption.
  - *After:* Generation number requires exact equality (`=== this.documentGeneration`), generations 0, 50, 100 behave identically; missing `mainFrame` throws `IpcSecurityError`; navigation during open dialog invalidates snapshot and rejects operation fail-closed. All 14 cases in Test 48 and Test 49 pass.

#### Item 3: Public IPC Error Contract Hardened
- **Prior Defect:** Handlers could echo raw internal error messages, stack traces, paths, or secrets back to the renderer. Posix single-component root paths like `/etc`, `/tmp`, and `/secret` were not matched by multi-segment regexes. Unexpected internal exceptions leaked backend implementation details.
- **Remediation Implemented:**
  - Hardened `sanitizeIpcError`:
    - Unexpected backend failures return a stable, generic public error: `"Operation failed: An unexpected internal error occurred."`.
    - `IpcSecurityError` returns masked generic `"Security violation: IPC request rejected."`.
    - `IpcValidationError` and known operational conflict errors are sanitized through `scrubErrorText` and bounded to maximum approved lengths (<= 120 chars for validation, <= 200 chars for operational conflicts).
  - Hardened `scrubErrorText`:
    - Strips stack trace lines (requiring preceding newline `\r?\n\s*at\s+`).
    - Collapses newlines and multiline spacing to single lines.
    - Scrubs Windows drive paths (`C:\...`) and UNC paths (`\\server\...`) to `<path>`.
    - Scrubs POSIX absolute paths, including single-component root directories (`/etc`, `/tmp`, `/secret`, `/var`) as well as nested paths (`/a/b/c`) to `<path>`.
    - Scrubs synthetic secrets, tokens, passwords, bearer tokens, JWTs, hex hashes, and base64 payloads to `<redacted>`.
    - Bounds unknown validation messages to <= 120 characters with ellipsis.
- **Verification (Failing-Before vs Passing-After):**
  - *Before:* Error containing `/etc/passwd` or `/tmp/dump.log` left POSIX root path intact; multiline errors preserved newline stacks; unexpected internal bugs echoed backend file paths and database states.
  - *After:* `/etc/shadow`, `/tmp/secret`, `C:\Windows\System32`, multiline traces, and synthetic tokens (JWT, hex, base64) are completely scrubbed; unexpected errors return generic public contract; Test 51 passes all sanitization assertions.

#### Item 4: Evidence Correction and Strengthening
- **Prior Defect:** Tests checked only token presence rather than exact argument/value pairs; forged renderer inputs were not proven inert; permission-query exceptions were caught and ignored (falsely counting as denied); smoke report claims lacked direct verification.
- **Remediation Implemented:**
  - Strengthened launch admission assertions in Test 50 to verify exact argument/value pairs:
    - Verifies `--username Player` appears as an exact consecutive pair.
    - Verifies `--version 26.2` appears as an exact consecutive pair.
    - Confirms forged renderer identity overrides (`{ user: { name: "Attacker" } }`) or release overrides are ignored.
    - Confirms `installation.json` presence, non-emptiness, and version consistency are strictly enforced.
    - Confirms `noSync: true` skips network manifest fetch but strictly preserves local installation admission checks.
  - In `src/main.ts` smoke test adversarial check: treats `navigator.permissions.query` exceptions as test failure (`permissionDenied = false`) rather than swallowing exceptions.
  - Real Electron execution without `--no-sandbox` verifies live runtime permissions, renderer IPC insulation, and settings lockdown.
- **Verification (Failing-Before vs Passing-After):**
  - *Before:* Assertions checked `args.includes("--username")` and `args.includes("Player")` separately; permission query errors were swallowed in a bare `catch {}`; renderer overrides were not proven ignored at the final spawn sink.
  - *After:* Exact consecutive index assertions verified; permission query exceptions cause test failure; forged renderer parameters proven ignored; Test 50 and live smoke tests pass cleanly.

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
  - `release\win-unpacked\resources\app.asar`: `FDF56F3A01A4D156DC6C10EAE67C02867EBCA60FA961C529916785515ACEFA02`
  - `release\win-unpacked\Lampas Launcher.exe`: `F4625A001856D66761F258C3AB0642A22E97DCDF76756C821BBF1565DAD8F942`
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
