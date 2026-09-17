# Lampas Launcher — Security Hardening Progress

## Review Gate 1 (Amended) — Constrain Credential Destinations and Web-Link Opening (SEC-01, SEC-02)

- **Execution Date:** 17 September 2026
- **Status:** Complete (Review Gate 1 amended & verified; Phase 1 production implementation hardened; stopped before Phase 2)
- **Accepted Baseline Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc`
- **Initial Phase 1 Submission Checkpoint:** `49e49dc4b6ed2cf65f1bab88fb9998d7bdb91518`
- **Reviewed Target Checkpoint (Starting Checkpoint for this Amendment Pass):** `d635eba0e39b98a12d2ebb4458f9d054a3641e0d`
- **Amended Review Gate 1 Ending Checkpoint:** `HEAD` on branch `feat/security`
- **Current Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 1 ("Constrain credential destinations and web-link opening"). Phase 2 (sender frame validation, IPC argument allowlist schemas), Phase 3 (OS keyring/DPAPI), and subsequent phases remain paused.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A complete audit of changes was performed against the accepted baseline checkpoint (`149f10021efce2939c6c12150a3a07dd61b622dc`), the initial Phase 1 commit (`49e49dc4b6ed2cf65f1bab88fb9998d7bdb91518`), the reviewed amendment checkpoint (`d635eba0e39b98a12d2ebb4458f9d054a3641e0d`), and the amended Review Gate 1 working tree:

| Dimension | Assessed Baseline (`3950e15`) | Accepted RG 0.1 (`149f100`) | Reviewed Amendment (`d635eba`) | Amended RG 1 (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline | Pristine baseline (`0 lines`) | 8 production files modified, 1 added (`src/portal-policy.ts`) | 8 production files modified, 1 added (`src/portal-policy.ts`) | **Constrained strictly to Phase 1 fixes & Review Gate 1 corrections** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical (zero package mutations)** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Absent | 8 passed (RG 0.1) | 20 passed | **33 passed, 0 failed, 0 outbound violations** | **+13 dynamic regression tests for origin changes without sessions, opener symlink escapes, real OAuth exchange, and independent redirects** |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Absent | 16 passed | 16 passed | **16 passed (15 unit/component + 1 child runner assertion verifying all 33)** | **16/16 passing** |
| **Regression Gates (`security-regression-gates.test.ts`)** | Absent | 6 skipped, 10 todo | 4 passed, 5 skipped, 9 todo | **6 passed, 5 skipped, 9 todo, 0 failed** | **Phase 1 gates verify origin-change invalidation without session and production policy lockdown** |
| **Security Test Typecheck** | Absent | 0 errors | 0 errors | **0 errors (`tsconfig.security-test.json`)** | **0 errors** |
| **Production Typecheck & Build** | Clean | Clean | Clean | **0 errors (`tsc && vite build`)** | **0 errors** |

**Documentation and Ignore Invariants:**
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **tracked under git** (not ignored).

---

### 2. Review Gate 1 Amendment Corrections & Technical Invariants

During Review Gate 1 review, five specific amendment requirements were identified and implemented:

#### A. Origin-Change Invalidation Without an Established Session
- **Invariant:** A change between the prior and next canonical active Portal must be detected independently of whether `sessionPortalUrl` exists. The authentication generation (`sessionGeneration`) must advance on every actual origin change, preserving credential cleanup and post-await snapshot checks. `establishSession()` must not be used as a substitute for settings changes in origin-change regressions.
- **Implementation (`src/config.ts`):**
  In `ConfigManager.set()`:
  ```ts
  if (sanitizedConfig.portalUrl !== undefined) {
    const priorCanonical = normalizePortalUrl(current.portalUrl);
    const nextCanonical = normalizePortalUrl(sanitizedConfig.portalUrl);
    updated.portalUrl = nextCanonical;

    const originChanged = priorCanonical !== nextCanonical;
    const sessionMismatch = Boolean(current.sessionPortalUrl && nextCanonical !== current.sessionPortalUrl);

    if (originChanged || sessionMismatch) {
      updated.token = undefined;
      updated.refreshToken = undefined;
      updated.minecraftAccessToken = undefined;
      updated.sessionPortalUrl = undefined;
      this.incrementSessionGeneration();
    }
  }
  ```
- **Empirical Regressions (`test/security-boundary-characterization.ts`):**
  Implemented deterministic latching using `RequestBarrier` without flaky timing sleeps across all 6 required cases:
  1. **Case 1 (Test 15):** Fresh logged-out login at A, settings change A→B→A before callback. Local callback server rejects with 400, login rejects, zero credentials established.
  2. **Case 2 (Test 16):** Fresh logged-out login at A, settings change A→B→A during token exchange (held deterministically by `RequestBarrier`). Post-await generation check detects mismatch, exchange aborts, zero credentials established.
  3. **Case 3 (Test 17):** Fresh logged-out login at A, settings change A→B without returning to A. Token exchange aborts, zero credentials established for B.
  4. **Case 4 (Test 18):** Unchanged portal (settings change updating `allocatedRamGb: 6` with identical canonical `portalUrl`). Generation does not advance; login and exchange succeed normally.
  5. **Case 5 (Test 19):** In-flight exchange while credentials exist. Settings change to B wipes credentials and advances generation; exchange rejects, credentials remain wiped.
  6. **Case 6 (Test 20):** Refresh while origin changes (held deterministically by `RequestBarrier`). Post-await snapshot check detects generation mismatch; refresh returns `{ valid: false }`, tokens not published.

#### B. Development Portal Policy Explicitly Non-Production
- **Invariant:** Packaged production (`app.isPackaged`) must NOT expand trust from `LAMPAS_ALLOWED_PORTAL_HOSTS` or `NODE_ENV`. Loopback portal destinations require explicit development policy. Fixture policy is supplied via main-only test/development construction (`PortalPolicy.configureDevelopmentPolicy`). Binding and invalidation behavior is identical across all modes. The native OAuth callback listener on loopback is fully preserved.
- **Implementation (`src/portal-policy.ts` & `src/main.ts`):**
  1. `PortalPolicy.isPackagedProduction()` checks `productionOverride !== null ? productionOverride : Boolean(app?.isPackaged)`.
  2. In packaged production, `PortalPolicy.isLoopbackAllowed()` unconditionally returns `false`, and `isApprovedRemoteHost()` strictly enforces `lampas.town` and `*.lampas.town`, immediately returning `false` for any other domain before consulting environment variables.
  3. In development/testing (`!app.isPackaged`), `main.ts` configures development policy via `PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true, allowedRemoteHosts: ... })`.
  4. `normalizePortalUrl()` rejects any loopback destination if `!PortalPolicy.isLoopbackAllowed()`.
- **Empirical Regressions:**
  - `security-boundary-characterization.ts` Test 11 & `security-regression-gates.test.ts` Phase 1 Gate: When `setProductionOverride(true)`, loopback destinations and env-expanded hosts (`LAMPAS_ALLOWED_PORTAL_HOSTS`, `NODE_ENV=development`) throw `PortalPolicyError`, while `dev.lampas.town` is permitted.

#### C. Known-Location Opener Authorization & Ancestor Validation
- **Invariant:** Opener targets must validate expected filesystem types (directory vs. file) and verify physical ancestry against canonical authorized roots before creation or OS opening. Escaping symlinks, junctions, and ancestor escapes must be rejected. Compatibility handlers must follow the same policy. Failed web links must never be reinterpreted as local paths.
- **Implementation (`src/main.ts`):**
  1. `findExistingAncestor(p)` traverses up `path.dirname` to find the nearest physically existing ancestor.
  2. `isPathWithinOrEqual(child, parent)` enforces canonical path containment with case-insensitive Windows normalization.
  3. Pre-creation check: The physical realpath of the nearest existing ancestor must be within the canonical authorized root (`canonicalGameDir` for `modsDir`/`minecraftLog`, `canonicalUserData` for `logsDir`, `canonicalLogsDir` for `launcherLog`).
  4. Post-creation / pre-opening check: `canonicalTarget = fs.realpathSync(targetPath)` must be within the authorized canonical root, and `fs.statSync(canonicalTarget)` must match expected type.
  5. Handlers pass `canonicalTarget` to `shell.openPath`.
  6. `utils:openPath` checks for URI schemes (`^[a-zA-Z][a-zA-Z0-9+.-]*:`) and validates via `validateWebUrl` without falling back to local path execution on error.
- **Empirical Regressions (`security-boundary-characterization.ts` Test 12):**
  - Disposable outside-root sentinels (`outsideSentinelDir`, `outsideSentinelFile`).
  - Escaping symlink at `<gameDir>/mods` pointing to `outsideSentinelDir`: rejected, `openedPaths.length === 0`.
  - Escaping ancestor at `<gameDir>/logs` pointing to `outsideSentinelDir`: rejected, `openedPaths.length === 0`.
  - Failed web link (`javascript:alert(1)`): rejected with `WebOpeningPolicyError`, never calls `shell.openPath`.
  - Direct outside sentinel path: rejected, `openedPaths.length === 0`.
  - Legitimate `modsDir`: succeeds and opens verified canonical path.

#### D. Repaired Regression Coverage & Independent Redirect Invariants
- **Invariant:** Distinguish refresh coverage from token exchange. Add real OAuth login/callback/exchange testing. Test verify, refresh, and exchange redirects using independent valid sessions and owned A/B fixtures asserting intended request at A and 0 requests at B. Exercise channel, release, manifest, and status redirects independently for 302, 307, and 308. Include valid local fallback fixtures to prove redirect denial cannot become fallback success. Preserve credential-free blob redirect test.
- **Implementation & Tests (`security-boundary-characterization.ts`):**
  1. **Renamed Refresh Test (Test 23):** Renamed previous "exchange" race test to `"Race safety: logout during in-flight refresh discards late tokens"`.
  2. **Real OAuth Login/Exchange (Test 14):** Tests full `loginWithPortal()` flow with local callback listener, code challenge, callback dispatch, and `/api/v1/auth/exchange` on Server A.
  3. **Independent Verify Redirect (Test 25):** 302, 307, 308 redirects on `/api/v1/auth/verify` tested with independent valid sessions; 1 request at Origin A, 0 requests at Destination B.
  4. **Independent Refresh Redirect (Test 26):** 302, 307, 308 redirects on `/api/v1/auth/refresh` tested with independent valid sessions; 1 request at Origin A, 0 requests at Destination B.
  5. **Independent Exchange Redirect (Test 27):** 302, 307, 308 redirects on `/api/v1/auth/exchange` tested; 1 request at Origin A, 0 requests at Destination B.
  6. **Independent Status Redirect (Test 28):** 302, 307, 308 redirects on `/api/v1/server/status` tested; 1 request at Origin A, 0 requests at Destination B.
  7. **Independent Channel Sync Redirect with Local Fallback (Test 29):** Valid local `.lampas/release.json` and `installation.json` placed on disk; 302, 307, 308 redirects on `/api/v1/channels/stable` rejected; sync fails closed without fallback success; 0 requests at Destination B.
  8. **Independent Release Sync Redirect with Local Fallback (Test 30):** Channel succeeds, release endpoint redirects 302, 307, 308; rejected; sync fails closed; 0 requests at Destination B.
  9. **Independent Manifest Sync Redirect with Local Fallback (Test 31):** Channel and release succeed, manifest endpoint (`/api/v1/releases/<ver>/client-manifest`) redirects 302, 307, 308; rejected; sync fails closed; 0 requests at Destination B.
  10. **Preserved Blob Redirect (Test 32):** Validates that non-metadata file blob downloads follow safe redirects to CDN without transmitting `Authorization` headers.

---

### 3. Environment & Test Suite Execution Results

All verification suites were executed in the Windows x64 environment:

| Command / Suite | Status | Execution Count & Outcome | Notes |
|---|---|---|---|
| `bun --version` | Passed | `1.4.2` | Matches CI environment pin |
| `node --version` | Passed | `v24.9.0` | Host Node.js |
| `bun install --frozen-lockfile` | Passed | 306 installs checked | Zero lockfile mutation; clean frozen lockfile |
| `bun run typecheck` | Passed | 0 errors | Full TypeScript check (`tsc --noEmit && tsc -p tsconfig.renderer.json --noEmit`) |
| `bun x tsc -p tsconfig.security-test.json --noEmit` | Passed | 0 errors | Dedicated strict security test typecheck |
| `bun run build` | Passed | 12 modules transformed | Production Vite build clean |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Passed | **33 passed, 0 failed, 0 outbound violations** | Isolated child process; 33/33 dynamic tests passing |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Passed | **16 passed, 0 failed, 76 expect() calls** | 15 unit/component + 1 child runner assertion |
| **Regression Gates (`security-regression-gates.test.ts`)** | Passed | **6 passed, 5 skipped, 9 todo, 0 failed** | Phase 1 gates unskipped & passing |
| **Launcher Settings Suite (`launcher-settings.test.ts`)** | Passed | **7 passed, 0 failed** | All 7 settings tests passing |
| **Server Status Suite (`server-status.test.ts`)** | Passed | **5 passed, 0 failed** | All 5 status client tests passing |

---

### 4. Separate Accounting: Parent-Process vs. Child-Process Tests

To maintain complete accounting integrity, parent-process test executions and child-process boundary executions are tracked separately:

#### A. Parent Process Test Suites
1. **Phase 1 Security Unit/Component Tests (15 passed in `test/security-characterization.test.ts`):**
   - URL normalization, HTTP lookalike rejection, scheme auto-upgrade.
   - Plaintext credential persistence characterization (SEC-03).
   - Path containment & ownership inconsistency characterizations (SEC-04).
   - Move recovery staging deletion characterization (SEC-05).
   - Executable verification fail-open characterizations (SEC-06).
   - Logging redaction gap characterizations (SEC-09).
2. **Child Process Execution Assertion (1 passed in `test/security-characterization.test.ts`):**
   - Spawns `test/security-boundary-characterization.ts` in isolated child process and asserts clean exit code 0 with 33/33 passed tests.
3. **Phase 1 Regression Gates (6 passed in `test/security-regression-gates.test.ts`):**
   - `normalizePortalUrl` HTTPS enforcement and HTTP lookalike rejection.
   - Production portal policy lockdown (loopback and env trust expansion rejected in packaged production).
   - Origin-change invalidation without established session (`sessionGeneration` advance).
   - Web link sink protocol rejection.
   - Session origin binding, forgery rejection, and unapproved origin invalidation.
   - Legacy unbound credential disk scrubbing on `ConfigManager.get()`.
4. **Other Unaffected Unit Suites Passing in Parent Process:**
   - `launcher-settings.test.ts` (7 passed)
   - `server-status.test.ts` (5 passed)
   - Pre-existing unaffected suites (261 baseline tests)

#### B. Child Process Boundary Runner (`security-boundary-characterization.ts`): 33 Passed Tests
Executed in a clean Bun child process with complete Electron mocks, outbound network request policy enforcement, child process execution traps, and bounded teardown:
1. `Registration harness confirms 37 handles and 1 on channel`
2. `utils:openPath rejects arbitrary local paths and never calls shell.openPath`
3. `utils:openPath calls shell.openExternal for HTTP(S) paths`
4. `config:set permits javaPath and javaArgs` (Phase 2 characterization)
5. `utils:openSourcePage opens valid web URLs and rejects file/dangerous protocols`
6. `utils:openKnownLocation opens approved locations and rejects arbitrary targets`
7. `[Service-Level] LauncherAuth.verifySession ignores caller portalUrl and protects bound session`
8. `[Service-Level] LauncherAuth.refreshSession ignores caller portalUrl and protects bound session`
9. `[IPC-Level] auth:verify ignores caller-supplied portalUrl and routes to bound portal`
10. `[IPC-Level] auth:refresh ignores caller-supplied portalUrl and routes to bound portal`
11. `[Policy] Packaged production rejects loopback destinations and ignores env trust expansion`
12. `[Opener] resolveAndValidateKnownLocation rejects escaping symlinks and ancestor escapes to outside sentinels`
13. `[Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B`
14. `[Regression Gate 1] Real OAuth login flow successfully completes code exchange and establishes session`
15. `[Regression Gate 1] Origin-change invalidation: Case 1 - Fresh logged-out login at A, settings A->B->A before callback`
16. `[Regression Gate 1] Origin-change invalidation: Case 2 - Fresh logged-out login at A, settings A->B->A during exchange`
17. `[Regression Gate 1] Origin-change invalidation: Case 3 - Fresh logged-out login at A, settings A->B without returning to A`
18. `[Regression Gate 1] Origin-change invalidation: Case 4 - Unchanged portal does not invalidate in-flight login`
19. `[Regression Gate 1] Origin-change invalidation: Case 5 - In-flight exchange while credentials exist`
20. `[Regression Gate 1] Origin-change invalidation: Case 6 - Refresh while origin changes`
21. `[Regression Gate 1] Race safety: portal A -> B switch during in-flight verify ignores late A completion`
22. `[Regression Gate 1] Race safety: rapid portal A -> B -> A switching rejects stale response`
23. `[Regression Gate 1] Race safety: logout during in-flight refresh discards late tokens`
24. `[Regression Gate 1] Race safety: old 401 failure arriving after new session establishment does not clear new credentials`
25. `[Regression Gate 1] Independent redirect: auth:verify rejects 302/307/308 redirects with 0 requests to B`
26. `[Regression Gate 1] Independent redirect: auth:refresh rejects 302/307/308 redirects with 0 requests to B`
27. `[Regression Gate 1] Independent redirect: auth token exchange rejects 302/307/308 redirects with 0 requests to B`
28. `[Regression Gate 1] Independent redirect: server status metadata endpoint rejects 302/307/308 redirects with 0 requests to B`
29. `[Regression Gate 1] Independent redirect: channel sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present`
30. `[Regression Gate 1] Independent redirect: release sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present`
31. `[Regression Gate 1] Independent redirect: manifest sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present`
32. `[Regression Gate 1] Legitimate file download follows safe redirect without auth headers`
33. `[Regression Gate 1] ConfigManager.get performs durable disk scrubbing of unbound tokens on disk`

---

### 5. Inbound IPC Channel Inventory (38 Channels Total)

Following Phase 1 hardening:
- **Total Registered Channels:** **38** (37 `ipcMain.handle` + 1 `ipcMain.on`)
- **Sender ID Validation:** 1 channel (`game:logAck` on line 134).
- **Frame / Document Validation:** Scheduled for Phase 2.

| # | IPC Channel | Registration Type | Line | Sender ID Check | Frame / Doc Validation | Expected Payload | Side Effects in Main Process | Actual Returned Shape |
|---|---|---|---|---|---|---|---|---|
| 1 | `game:logAck` | `on` | 134 | **Sender ID Checked** | None | `{ batchId?: number }` | Validates `event.sender.id === targetId`; advances log batch transport | None (event listener) |
| 2 | `window:minimize` | `handle` | 148 | None | None | None | Invokes `mainWindow.minimize()` | `void` |
| 3 | `window:maximize` | `handle` | 149 | None | None | None | Toggles `mainWindow.maximize()` / `unmaximize()` | `void` |
| 4 | `window:isMaximized` | `handle` | 156 | None | None | None | Queries `mainWindow.isMaximized()` | `boolean` |
| 5 | `window:close` | `handle` | 157 | None | None | None | Destroys window and terminates application | `void` |
| 6 | `utils:getAppVersion` | `handle` | 296 | None | None | None | Reads `app.getVersion()` | `string` |
| 7 | `utils:openPath` | `handle` | 297 | None | None | `targetPath: string` | **Hardened:** URI schemes validated via `validateWebUrl` -> `openExternal`. Local paths constrained to approved known locations (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`) with physical ancestry and canonical root validation -> `openPath`. All arbitrary paths rejected. Never falls back to local on web URL failure. | `string` |
| 8 | `utils:openSourcePage` | `handle` | 335 | None | None | `url: string` | Validates web URL via `validateWebUrl` and calls `shell.openExternal`. Rejects non-HTTP schemes. | `string` |
| 9 | `utils:openKnownLocation` | `handle` | 340 | None | None | `location: string` | Maps known identifier (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`), validates physical ancestry against canonical roots, verifies directory/file type on disk, and calls `shell.openPath`. Rejects escaping symlinks and arbitrary locations. | `string` |
| 10 | `utils:getLogPath` | `handle` | 345 | None | None | None | Resolves active `launcher.log` path | `string` |
| 11 | `utils:openLogsDir` | `handle` | 346 | None | None | None | Calls `resolveAndValidateKnownLocation("logsDir")` -> `shell.openPath` | `string` |
| 12 | `utils:openLogFile` | `handle` | 351 | None | None | None | Calls `resolveAndValidateKnownLocation("launcherLog")` -> `shell.openPath` | `string` |
| 13 | `utils:getMinecraftLogPath` | `handle` | 356 | None | None | None | Resolves `gameDir/logs/latest.log` path | `string` |
| 14 | `utils:openMinecraftLog` | `handle` | 360 | None | None | None | Calls `resolveAndValidateKnownLocation("minecraftLog")` -> `shell.openPath` | `string` |
| 15 | `config:get` | `handle` | 367 | None | None | None | Reads configuration; scrubs legacy unbound credentials from disk; strips tokens | `RendererSettingsDto` |
| 16 | `config:set` | `handle` | 368 | None | None | `newConfig: Partial<SettingsDto>` | **Hardened:** Strips `sessionPortalUrl` from patch to prevent binding forgery; wipes tokens on origin change based on trusted prior state; advances session generation on active origin change | `RendererSettingsDto` |
| 17 | `gameDir:getStatus` | `handle` | 382 | None | None | None | Queries filesystem existence and checks `.lampas` metadata | `GameDirStatusDto` |
| 18 | `gameDir:browse` | `handle` | 383 | None | None | `defaultPath?: string` | Displays native folder picker dialog | `{ canceled: boolean; filePaths: string[] }` |
| 19 | `gameDir:validate` | `handle` | 391 | None | None | `targetPath: string, currentPath?: string` | Checks directory syntax, drive roots, existence, writability | `GameDirValidationResult` |
| 20 | `gameDir:configure` | `handle` | 393 | None | None | `targetPath: string` | Creates target directory; updates `gameDir` in `config.json` | `RendererSettingsDto` |
| 21 | `gameDir:move` | `handle` | 398 | None | None | `targetPath: string` | Moves or copies game files; manages migration journals | `DirectoryMoveResult` |
| 22 | `auth:login` | `handle` | 416 | None | None | None | **Hardened:** Ignores caller overrides; uses canonical configured origin; binds session via generation epochs | `{ user: RendererUserProfile }` |
| 23 | `auth:logout` | `handle` | 420 | None | None | None | Clears auth state, config tokens, session portal binding, and increments generation | `void` |
| 24 | `auth:verify` | `handle` | 421 | None | None | None | **Hardened:** Ignores caller overrides; verifies with session portal; manual redirect; aborts on race | `{ valid: boolean; user?: RendererUserProfile }` |
| 25 | `auth:refresh` | `handle` | 425 | None | None | None | **Hardened:** Ignores caller overrides; refreshes with session portal; manual redirect; aborts on race | `{ valid: boolean; user?: RendererUserProfile }` |
| 26 | `server:getStatus` | `handle` | 431 | None | None | None | Queries Portal server status via `ServerStatusClient` with manual redirect | `ServerStatus` |
| 27 | `sync:start` | `handle` | 434 | None | None | None | Executes standard sync pipeline via `OperationCoordinator` | `SyncResult` |
| 28 | `sync:repair` | `handle` | 453 | None | None | None | Executes full hash audit and redownload via `OperationCoordinator` | `SyncResult` |
| 29 | `sync:getModCatalog` | `handle` | 473 | None | None | None | Reads mod catalog from Portal endpoint (`fetchPortalJsonWithRetry`, manual redirect, no disk fallback on rejection) | `ModCatalogItem[]` |
| 30 | `sync:getInstalledRuntime` | `handle` | 474 | None | None | None | Reads local `.lampas/release.json` and `.lampas/installation.json` | `InstalledRuntimeDto \| null` |
| 31 | `mods:browseAndAdd` | `handle` | 509 | None | None | None | Opens native open-file dialog; copies selected `.jar` files into `gameDir/mods/` | `ClientModState[]` |
| 32 | `mods:addPaths` | `handle` | 518 | None | None | `paths: string[]` | Copies arbitrary filesystem paths into `gameDir/mods/` | `ClientModState[]` |
| 33 | `mods:setOfficialEnabled` | `handle` | 522 | None | None | `id: string, enabled: boolean` | Updates `disabledClientMods` array in `config.json` | `string[]` |
| 34 | `mods:setCustomEnabled` | `handle` | 526 | None | None | `filename: string, enabled: boolean` | Renames file between `.jar` and `.jar.disabled` on disk | `ClientModState[]` |
| 35 | `mods:removeCustom` | `handle` | 530 | None | None | `filename: string` | Deletes file from `gameDir/mods/` | `ClientModState[]` |
| 36 | `game:launch` | `handle` | 536 | None | None | `user: UserProfile \| null, releaseOverride?: any` | Spawns Minecraft child process via `OperationCoordinator` | `boolean` |
| 37 | `game:kill` | `handle` | 557 | None | None | None | Terminates running Minecraft child process | `void` |
| 38 | `game:isRunning` | `handle` | 561 | None | None | None | Queries internal running process reference | `boolean` |

---

### 6. Finding Status & Remaining Scope (SEC-01 to SEC-12)

| Finding ID | Priority | Phase | Status at Review Gate 1 | Remediation & Remaining Scope |
|---|---|---|---|---|
| **SEC-01** | P0 / High | Phase 1 | **Remediated & Verified** | • Canonical origin policy (`normalizePortalUrl`) rejects bypasses, userinfo, queries, and path injections.<br>• Session origin binding via `sessionPortalUrl`; wiped on unapproved remote origin change.<br>• Renderer forgery of `sessionPortalUrl` via `config:set` closed; credentials only established via `ConfigManager.establishSession`.<br>• Origin-change invalidation without established session: advances `sessionGeneration` on any canonical portal change.<br>• Development portal policy explicitly non-production: packaged production rejects loopback and environment trust expansion.<br>• Race-safe invalidation via monotonic `sessionGeneration` epochs across login, verify, refresh, logout.<br>• Authenticated metadata fetches enforce `redirect: "manual"` and fail closed.<br>• Legacy unbound credentials scrubbed from disk on `ConfigManager.get()`.<br>• Dual-origin test harness confirms 0 Origin A credentials reach Origin B across all scenarios. |
| **SEC-02** | P0 / High | Phase 1 / Phase 2 | **Partially Remediated** (Link sink & openers hardened; IPC sender lockdown deferred to Phase 2) | • Web link sink hardened: `validateWebUrl` strictly permits HTTP/HTTPS; rejects dangerous pseudo-schemes.<br>• `utils:openPath` rejects arbitrary local paths and UNC shares; never falls back to local execution on web URL rejection.<br>• Added dedicated openers: `utils:openSourcePage` and `utils:openKnownLocation`.<br>• Opener targets validated against canonical directory roots with physical ancestry verification and escaping symlink rejection.<br>• *Remaining for Phase 2:* IPC sender frame origin validation and `config:set` strict allowlist schema. |
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

- **Phase 1 Production Scope Fully Implemented & Amended:**
  - `SEC-01` (portal destination constraint, session origin binding, forgery closure, origin-change invalidation without session, race safety, manual redirect rejection, legacy credential invalidation) is complete and dynamically verified.
  - `SEC-02` link-opening sink (`validateWebUrl`, local path restriction, path classification with physical ancestry and canonical root validation, dedicated openers, escaping symlink rejection) is complete and dynamically verified.
- **Outbound Request Policy Harness Verified:**
  - Zero unapproved outbound network requests detected during isolated boundary execution.
- **Pre-Existing Invariants:**
  - All baseline tests pass with zero regressions.
- **Dependencies & Lockfile:**
  - `bun.lock` is byte-for-byte identical with baseline. Zero dependency modifications.
- **Typecheck & Packaging:**
  - Production typecheck (`bun run typecheck`), security test typecheck (`tsconfig.security-test.json`), and production Vite packaging (`bun run build`) pass cleanly with 0 errors.

**STOPPING AT REVIEW GATE 1.** Phase 2 has not been implemented. Ready for commit and push for review.
