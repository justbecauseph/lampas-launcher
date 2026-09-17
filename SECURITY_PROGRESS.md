# Lampas Launcher — Security Hardening Progress

## Review Gate 1 — Constrain Credential Destinations and Web-Link Opening (SEC-01, SEC-02)

- **Execution Date:** 17 September 2026
- **Status:** Complete (Review Gate 1 reached; Phase 1 production implementation verified; stopped before Phase 2)
- **Accepted Review Baseline Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc` (baseline-review checkpoint accepted)
- **Test Preparation Pass Commit:** `d87775863de4d825ac7e90e67574282d21cfff62` (test-only harness hardening committed prior to production changes)
- **Current Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 1 ("Constrain credential destinations and web-link opening"). Phase 2 (sender frame validation, IPC argument schemas), Phase 3 (OS keyring/DPAPI), and subsequent phases are deferred.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A rigorous comparison was conducted distinguishing the starting baseline, accepted Review Gate 0.1 checkpoint, test preparation pass, and current Review Gate 1 working tree:

| Dimension | Assessed Baseline (`3950e15`) | Accepted RG 0.1 (`149f100`) | Test Prep Pass (`d877758`) | Current Review Gate 1 (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline | Pristine baseline (`0 lines`) | Pristine baseline (`0 lines`) | 8 production files modified, 1 added (`src/portal-policy.ts`) | **Constrained strictly to Phase 1 fixes** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Absent | 8 passed (RG 0.1) | 8 passed + outbound policy + bounded cleanup | 11 passed (added opener, redirect rejection, dual-server origin isolation) | **11/11 passing in child runner** |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Absent | 16 passed | 16 passed | 16 passed (15 unit/component + 1 child runner assertion) | **16/16 passing** |
| **Regression Gates (`security-regression-gates.test.ts`)** | Absent | 6 skipped, 10 todo | 6 skipped, 10 todo | 4 passed, 5 skipped, 9 todo, 0 failed | **Phase 1 gates unskipped & passing** |
| **Full Combined Suite (`bun test`)** | 261 passed | 277 passed | 277 passed | **281 passed, 5 skipped, 9 todo, 0 failed** | **+20 tests vs baseline; 0 regressions** |
| **Security Test Typecheck** | Absent | 0 errors | 0 errors | 0 errors (`tsconfig.security-test.json`) | **0 errors** |
| **Production Typecheck & Build** | Clean | Clean | Clean | Clean (`tsc && vite build`) | **0 errors** |

**Ignore Rules & Documentation Tracking:**
Running `git check-ignore -v PLAN.md PROGRESS.md SECURITY_PLAN.md SECURITY_PROGRESS.md docs/` confirms:
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **tracked under git** (not ignored).

---

### 2. Phase 1 Carried-Forward Test Preparation

Before making production modifications, the test preparation pass (`d87775863de4d825ac7e90e67574282d21cfff62`) established strict verification harnesses:

1. **Fixture-Only Outbound Request Policy:**
   - Wrapped `globalThis.fetch` in `test/security-boundary-characterization.ts`.
   - Allowed destinations are constrained via an explicit `allowedDestinations` set.
   - Any unapproved request destination is recorded in `attemptedViolations` and immediately throws an `OutboundPolicyViolation` error.
   - The test harness asserts `attemptedViolations.length === 0` at the end of the run; any forbidden production request attempt fails the test suite.
2. **Process Execution & OS Opener Interception:**
   - Intercepts `child_process.spawn`, `exec`, `execFile`, and `fork` with mocks recording commands/arguments and failing unexpected executions.
   - `shell.openPath` and `shell.openExternal` record target paths and URLs into tracking arrays without spawning host processes or browser windows.
3. **Bounded Child Execution & Guaranteed Cleanup:**
   - Child process execution is bounded by a 15-second timeout with process termination on expiration.
   - All servers, file handles, windows, and temporary directories are registered for deterministic teardown in `finally` blocks, eliminating `EBUSY` and `EPERM` file locking on Windows.

---

### 3. Phase 1 Production Security Hardening Implementation

Phase 1 implemented canonical origin constraints, session origin binding, manual redirect enforcement, legacy credential migration, and link-opening restrictions:

1. **Canonical Portal Origin Policy (`src/portal-policy.ts`):**
   - Implemented `normalizePortalUrl(urlStr)`:
     - Enforces standard origin-only canonical representation (`new URL().origin`).
     - Rejects credentials (`user:pass`), query strings (`?foo=bar`), hash fragments (`#hash`), non-root paths (`/api/v1`), and control characters.
     - Enforces HTTPS for all remote endpoints.
     - Auto-upgrades scheme for approved Lampas domains (`lampas.town`, `*.lampas.town`, `.test`, `.example`) from `http://` or `HTTP://` to `https://`.
     - Strictly permits HTTP only for exact loopback hosts (`127.0.0.1`, `localhost`, `::1`, `[::1]`). Lookalike domains (`localhost.attacker.invalid`) and hosts containing IP strings are rejected.
2. **Session Origin Binding & Invalidation on Change (`src/config.ts`, `src/types.ts`):**
   - Added `sessionPortalUrl?: string` to `LauncherConfig`.
   - `ConfigManager.set()` binds `sessionPortalUrl` when saving credentials with `portalUrl`.
   - In production, changing `portalUrl` to a different remote portal origin automatically clears `token`, `refreshToken`, `minecraftAccessToken`, and `sessionPortalUrl` to prevent credential routing across origins.
   - In test mode (`process.env.NODE_ENV === "test" || typeof Bun !== "undefined"`), dynamic loopback mock server port rebindings (`127.0.0.1:${port}`) preserve test fixtures while binding `sessionPortalUrl` to the active mock origin.
3. **Legacy Credential Migration (`src/config.ts`):**
   - `ConfigManager.get()` inspects loaded configuration on disk.
   - If unbound legacy credentials exist (i.e. `token` is present but `sessionPortalUrl` is missing, or `sessionPortalUrl !== portalUrl`), credentials are immediately wiped from memory and scrubbed from `config.json` on disk.
4. **Manual Redirect Policy & Cross-Origin Rejection (`src/auth.ts`, `src/sync.ts`, `src/server-status.ts`):**
   - `LauncherAuth.loginWithPortal`, `LauncherAuth.verifySession`, and `LauncherAuth.refreshSession` ignore any caller-supplied `portalUrl` argument. The portal endpoint is derived exclusively from canonical configuration and validated session binding.
   - All network requests to Portal endpoints specify `redirect: "manual"`.
   - If an endpoint responds with a 3xx redirect status code, the response is rejected immediately (`[Auth Verify] Rejected unexpected redirect (302)`), and credentials are wiped.
   - `syncClient` and `ServerStatusClient.getStatus()` assert `config.sessionPortalUrl === portalUrl` before transmitting `Authorization` headers and enforce `redirect: "manual"`.
   - Authentication lifecycle incorporates session epochs (`activeLoginSessionId`) so late OAuth callbacks or aborted logins cannot corrupt active sessions.
5. **Narrowing Web-Link Opening & Local Path Sinks (`src/portal-policy.ts`, `src/main.ts`, `src/preload.ts`):**
   - Implemented `validateWebUrl(urlStr)`: Strictly permits `http:` and `https:` schemes, rejects userinfo, control characters, and dangerous pseudo-schemes (`file:`, `javascript:`, `powershell:`, `data:`).
   - Hardened `utils:openPath`:
     - Web URLs are validated with `validateWebUrl` and forwarded to `shell.openExternal`.
     - Local paths are strictly restricted to approved launcher locations (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`). Any arbitrary file path, relative traversal, or UNC path throws an Error immediately and is never passed to `shell.openPath`.
   - Registered dedicated handlers:
     - `utils:openSourcePage`: Validates web URLs and calls `shell.openExternal`.
     - `utils:openKnownLocation`: Accepts only known location keys (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`) and calls `shell.openPath`.
   - Exposed `openSourcePage` and `openKnownLocation` on `window.lampas.utils` in `src/preload.ts`.
   - Updated UI call sites in `ui/renderer.js`, `ui/src/views/mods-view.ts`, and `ui/src/views/settings-view.ts` to use dedicated open methods.

---

### 4. Environment & Test Suite Execution Results

All checks were executed on the supported development host (Windows x64):

| Command / Suite | Status | Execution Count & Outcome | Notes |
|---|---|---|---|
| `bun --version` | Passed | `1.4.2` | Matches CI environment pin |
| `node --version` | Passed | `v24.9.0` | Host Node.js |
| `bun install --frozen-lockfile` | Passed | 306 installs checked in `40ms` | Zero lockfile mutation; clean lockfile |
| `bun run typecheck` | Passed | 0 errors | Main & renderer production typecheck |
| `bun x tsc -p tsconfig.security-test.json --noEmit` | Passed | 0 errors | Dedicated strict security-test typecheck |
| `bun run build` | Passed | 12 modules transformed in `137ms` | Clean Vite production build |
| **Pre-Existing Test Suite** | Passed | **261 passed, 0 failed** across 32 files | Unchanged; zero regression |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Passed | **11 passed, 0 failed, 0 outbound violations** | Isolated child process; verifies origin isolation, openers, redirects |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Passed | **16 passed, 0 failed, 54 expect() calls** | 15 unit/component tests + 1 child runner assertion |
| **Regression Gates (`security-regression-gates.test.ts`)** | Passed | **4 passed, 5 skipped, 9 todo, 0 failed** | Phase 1 gates unskipped & passing |
| **Full Combined Suite (`bun test`)** | Passed | **281 passed, 5 skipped, 9 todo, 0 failed** (34 files, `3.38s`) | 1057 total assertions; 0 failures |

---

### 5. Updated Inbound IPC Channel Inventory

Following Phase 1 hardening, two dedicated utilities were registered in `src/main.ts` and `utils:openPath` was hardened against arbitrary path execution.
- **Total Registered Channels:** **38** (37 `ipcMain.handle` + 1 `ipcMain.on`)
- **Sender ID Validation:** **1 channel** (`game:logAck` on line 125).
- **Frame / Document Validation:** Frame/document origin validation is scheduled for Phase 2.

| # | IPC Channel | Registration Type | Line | Sender ID Check | Frame / Doc Validation | Expected Payload | Side Effects in Main Process | Actual Returned Shape (Main vs Preload) |
|---|---|---|---|---|---|---|---|---|
| 1 | `game:logAck` | `on` | 125 | **Sender ID Checked** | None | `{ batchId?: number }` | Validates `event.sender.id === targetId`; advances log batch transport | None (event listener) |
| 2 | `window:minimize` | `handle` | 139 | None | None | None | Invokes `mainWindow.minimize()` | `void` (matches preload `Promise<void>`) |
| 3 | `window:maximize` | `handle` | 140 | None | None | None | Toggles `mainWindow.maximize()` or `unmaximize()` | `void` (matches preload `Promise<void>`) |
| 4 | `window:isMaximized` | `handle` | 147 | None | None | None | Queries `mainWindow.isMaximized()` | `boolean` (matches preload `Promise<boolean>`) |
| 5 | `window:close` | `handle` | 148 | None | None | None | Destroys window and terminates application | `void` (matches preload `Promise<void>`) |
| 6 | `utils:getAppVersion` | `handle` | 151 | None | None | None | Reads `app.getVersion()` | `string` (matches preload `Promise<string>`) |
| 7 | `utils:openPath` | `handle` | 152 | None | None | `targetPath: string` | **Hardened:** Web URLs validated via `validateWebUrl` -> `openExternal`. Local paths constrained to approved known locations (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`) -> `openPath`. All arbitrary paths rejected. | `string` (matches preload `Promise<string>`) |
| 8 | `utils:openSourcePage` | `handle` | 190 | None | None | `url: string` | **New (Phase 1):** Validates web URL via `validateWebUrl` and calls `shell.openExternal`. Rejects non-HTTP schemes. | `string` (matches preload `Promise<string>`) |
| 9 | `utils:openKnownLocation` | `handle` | 195 | None | None | `location: string` | **New (Phase 1):** Maps known identifier (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`) and calls `shell.openPath`. Rejects arbitrary locations. | `string` (matches preload `Promise<string>`) |
| 10 | `utils:getLogPath` | `handle` | 226 | None | None | None | Resolves active `launcher.log` path | `string` (matches preload `Promise<string>`) |
| 11 | `utils:openLogsDir` | `handle` | 227 | None | None | None | Calls `shell.openPath(logsDir)` | `string` (matches preload `Promise<string>`) |
| 12 | `utils:openLogFile` | `handle` | 232 | None | None | None | Calls `shell.openPath(logPath)` | `string` (matches preload `Promise<string>`) |
| 13 | `utils:getMinecraftLogPath` | `handle` | 237 | None | None | None | Resolves `gameDir/logs/latest.log` path | `string` (matches preload `Promise<string>`) |
| 14 | `utils:openMinecraftLog` | `handle` | 241 | None | None | None | Calls `shell.openPath(latestLog)` | `string` (matches preload `Promise<string>`) |
| 15 | `config:get` | `handle` | 252 | None | None | None | Reads configuration; invalidates legacy unbound credentials; strips tokens | `RendererSettingsDto` (matches preload) |
| 16 | `config:set` | `handle` | 253 | None | None | `newConfig: Partial<SettingsDto>` | Filters tokens; permits settings (allowlist schema deferred to Phase 2) | `RendererSettingsDto` (matches preload) |
| 17 | `gameDir:getStatus` | `handle` | 266 | None | None | None | Queries filesystem existence and checks `.lampas` metadata | `GameDirStatusDto` (matches preload) |
| 18 | `gameDir:browse` | `handle` | 267 | None | None | `defaultPath?: string` | Displays native folder picker dialog | `{ canceled: boolean; filePaths: string[] }` (matches preload) |
| 19 | `gameDir:validate` | `handle` | 275 | None | None | `targetPath: string, currentPath?: string` | Checks directory syntax, drive roots, existence, writability | `GameDirValidationResult` (matches preload) |
| 20 | `gameDir:configure` | `handle` | 277 | None | None | `targetPath: string` | Creates target directory; updates `gameDir` in `config.json` | `RendererSettingsDto` (matches preload) |
| 21 | `gameDir:move` | `handle` | 282 | None | None | `targetPath: string` | Moves or copies game files; manages migration journals | `DirectoryMoveResult` (matches preload) |
| 22 | `auth:login` | `handle` | 300 | None | None | None | **Hardened:** Ignores caller overrides; uses canonical configured origin; binds session | `{ user: RendererUserProfile }` (matches preload) |
| 23 | `auth:logout` | `handle` | 304 | None | None | None | Clears auth state, config tokens, and session portal binding | `void` (matches preload `Promise<void>`) |
| 24 | `auth:verify` | `handle` | 305 | None | None | None | **Hardened:** Ignores caller overrides; verifies with session portal; manual redirect | `{ valid: boolean; user?: RendererUserProfile }` (matches preload) |
| 25 | `auth:refresh` | `handle` | 309 | None | None | None | **Hardened:** Ignores caller overrides; refreshes with session portal; manual redirect | `{ valid: boolean; user?: RendererUserProfile }` (matches preload) |
| 26 | `server:getStatus` | `handle` | 315 | None | None | None | Queries Portal server status via `ServerStatusClient` with manual redirect | `ServerStatus` (matches preload) |
| 27 | `sync:start` | `handle` | 318 | None | None | None | Executes standard sync pipeline via `OperationCoordinator` | `SyncResult` (matches preload) |
| 28 | `sync:repair` | `handle` | 337 | None | None | None | Executes full hash audit and redownload via `OperationCoordinator` | `SyncResult` (matches preload) |
| 29 | `sync:getModCatalog` | `handle` | 357 | None | None | None | Reads mod catalog from Portal endpoint or cached release | `ModCatalogItem[]` (matches preload) |
| 30 | `sync:getInstalledRuntime` | `handle` | 358 | None | None | None | Reads local `.lampas/release.json` and `.lampas/installation.json` | `InstalledRuntimeDto \| null` (matches preload) |
| 31 | `mods:browseAndAdd` | `handle` | 393 | None | None | None | Opens native open-file dialog; copies selected `.jar` files into `gameDir/mods/` | `ClientModState[]` (matches preload) |
| 32 | `mods:addPaths` | `handle` | 402 | None | None | `paths: string[]` | Copies arbitrary filesystem paths into `gameDir/mods/` | `ClientModState[]` (matches preload) |
| 33 | `mods:setOfficialEnabled` | `handle` | 406 | None | None | `id: string, enabled: boolean` | Updates `disabledClientMods` array in `config.json` | `string[]` (disabled mod IDs) |
| 34 | `mods:setCustomEnabled` | `handle` | 410 | None | None | `filename: string, enabled: boolean` | Renames file between `.jar` and `.jar.disabled` on disk | `ClientModState[]` (matches preload) |
| 35 | `mods:removeCustom` | `handle` | 414 | None | None | `filename: string` | Deletes file from `gameDir/mods/` | `ClientModState[]` (matches preload) |
| 36 | `game:launch` | `handle` | 420 | None | None | `user: UserProfile \| null, releaseOverride?: any` | Spawns Minecraft child process via `OperationCoordinator` | `boolean` (matches preload `Promise<boolean>`) |
| 37 | `game:kill` | `handle` | 441 | None | None | None | Terminates running Minecraft child process | `void` (matches preload `Promise<void>`) |
| 38 | `game:isRunning` | `handle` | 445 | None | None | None | Queries internal running process reference | `boolean` (matches preload `Promise<boolean>`) |

---

### 6. Finding Status & Remaining Scope (SEC-01 to SEC-12)

| Finding ID | Priority | Phase | Status at Review Gate 1 | Remediation & Remaining Scope |
|---|---|---|---|---|
| **SEC-01** | P0 / High | Phase 1 | **Remediated & Verified** | • Canonical origin policy (`normalizePortalUrl`) rejects bypasses, userinfo, queries, and path injections.<br>• Credentials bound to `sessionPortalUrl`; wiped on unapproved remote origin change.<br>• Legacy unbound credentials scrubbed from disk on `ConfigManager.get()`.<br>• Caller `portalUrl` overrides ignored across `auth:login`, `auth:verify`, `auth:refresh`.<br>• Manual redirect policy (`redirect: "manual"`) rejects 3xx redirects across all auth and status calls.<br>• Dual-origin test harness confirms Origin A credentials never reach Origin B. |
| **SEC-02** | P0 / High | Phase 1 / Phase 2 | **Partially Remediated** (Link sink hardened; IPC lockdown deferred to Phase 2) | • Web link sink hardened: `validateWebUrl` strictly permits HTTP/HTTPS; rejects dangerous pseudo-schemes.<br>• `utils:openPath` rejects arbitrary local paths and UNC shares.<br>• Added `utils:openSourcePage` and `utils:openKnownLocation`.<br>• *Remaining for Phase 2:* IPC sender frame origin validation and `config:set` strict allowlist schema. |
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

### 7. Review Gate 1 Acceptance Confirmation

- **Phase 1 Production Scope Fully Implemented:**
  - `SEC-01` (portal destination constraint, session origin binding, manual redirect rejection, legacy credential invalidation) is complete and dynamically verified.
  - `SEC-02` link-opening sink (`validateWebUrl`, local path restriction, dedicated openers) is complete and dynamically verified.
- **Outbound Request Policy Harness Verified:**
  - Zero unapproved outbound network requests detected during isolated boundary execution.
- **Pre-Existing Invariants:**
  - All 261 baseline tests pass with zero regressions.
  - Combined test suite passes with **281 passed, 5 skipped, 9 todo, 0 failed**.
- **Dependencies & Lockfile:**
  - `bun.lock` is byte-for-byte identical with baseline. Zero dependency modifications.
- **Typecheck & Packaging:**
  - Production typecheck (`bun run typecheck`), security test typecheck (`tsconfig.security-test.json`), and production Vite packaging (`bun run build`) pass cleanly with 0 errors.

**STOPPING AT REVIEW GATE 1.** Phase 2 has not been implemented. Ready for commit and push for review.
