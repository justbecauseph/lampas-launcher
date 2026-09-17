# Lampas Launcher — Security Hardening Progress

## Review Gate 1 (Amended) — Constrain Credential Destinations and Web-Link Opening (SEC-01, SEC-02)

- **Execution Date:** 17 September 2026
- **Status:** Complete (Review Gate 1 final narrow amendment verified; Phase 1 production implementation hardened; stopped before Phase 2)
- **Accepted Baseline Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc`
- **Initial Phase 1 Submission Checkpoint:** `49e49dc4b6ed2cf65f1bab88fb9998d7bdb91518`
- **First Amendment Checkpoint:** `d635eba0e39b98a12d2ebb4458f9d054a3641e0d`
- **Reviewed Target Checkpoint (Starting Checkpoint for this Final Narrow Amendment):** `5c24c84b4eb89b805f92754e0827cae4bfe5ff01`
- **Amended Review Gate 1 Ending Checkpoint:** `HEAD` on branch `feat/security`
- **Current Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 1 ("Constrain credential destinations and web-link opening"). Phase 2 (sender frame validation, IPC argument allowlist schemas), Phase 3 (OS keyring/DPAPI), and subsequent phases remain paused. Acceptance does not close any production security finding or authorize merging, tagging, or publication.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A complete audit of changes was performed against the accepted baseline checkpoint (`149f10021efce2939c6c12150a3a07dd61b622dc`), the prior amendments (`d635eba0e39b98a12d2ebb4458f9d054a3641e0d`, `5c24c84b4eb89b805f92754e0827cae4bfe5ff01`), and the final Review Gate 1 working tree:

| Dimension | Assessed Baseline (`3950e15`) | Accepted RG 0.1 (`149f100`) | Reviewed Amendment (`5c24c84`) | Final Amended RG 1 (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline | Pristine baseline (`0 lines`) | 8 production files modified, 1 added (`src/portal-policy.ts`) | 8 production files modified, 1 added (`src/portal-policy.ts`) | **Constrained strictly to Phase 1 fixes & Review Gate 1 corrections** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical (zero package mutations)** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Absent | 8 passed (RG 0.1) | 33 passed | **38 passed, 0 failed, 0 outbound violations, 0 skipped** | **+5 dynamic regression tests (4 launcherLog authorization cases + 1 local fallback positive control)** |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Absent | 16 passed | 16 passed | **16 passed (15 unit/component + 1 child runner assertion verifying all 38)** | **16/16 passing** |
| **Full Test Suite (`bun test`)** | 261 passed | 277 passed | 277 passed | **283 passed, 0 failed, 5 skipped, 9 todo across 34 files** | **All 10 loopback suites cleanly migrated to explicit development policy** |
| **Regression Gates (`test/regression-gates.test.ts`)** | Absent | 4 passed | 4 passed | **4 passed, 0 failed** | **Keyring and path gates properly preserved** |
| **Security Test Typecheck** | Absent | 0 errors | 0 errors | **0 errors (`tsconfig.security-test.json`)** | **0 errors** |
| **Production Typecheck & Build** | Clean | Clean | Clean | **0 errors (`tsc && vite build`)** | **0 errors** |

**Documentation and Ignore Invariants:**
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **tracked under git** (not ignored).

---

### 2. Review Gate 1 Amendment Corrections & Technical Invariants

During Review Gate 1 review and final narrow amendment, the following implementations were completed and verified:

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
  Deterministic latching using `RequestBarrier` was implemented specifically for the asynchronous race scenarios:
  1. **Case 1 (Test 19):** Fresh logged-out login at A, settings change A→B→A before callback. Local callback server rejects with 400, login rejects, zero credentials established.
  2. **Case 2 (Test 20):** Fresh logged-out login at A, settings change A→B→A during token exchange (held deterministically by `RequestBarrier`). Post-await generation check detects mismatch, exchange aborts, zero credentials established.
  3. **Case 3 (Test 21):** Fresh logged-out login at A, settings change A→B without returning to A. Token exchange aborts, zero credentials established for B.
  4. **Case 4 (Test 22):** Unchanged portal (settings change updating `allocatedRamGb: 6` with identical canonical `portalUrl`). Generation does not advance; login and exchange succeed normally.
  5. **Case 5 (Test 23):** In-flight exchange while credentials exist (held by `RequestBarrier`). Settings change to B wipes credentials and advances generation; exchange rejects, credentials remain wiped.
  6. **Case 6 (Test 24):** Refresh while origin changes (held deterministically by `RequestBarrier`). Post-await snapshot check detects generation mismatch; refresh returns `{ valid: false }`, tokens not published.

#### B. Development Portal Policy Explicitly Non-Production
- **Invariant:** Packaged production (`app.isPackaged`) must NOT expand trust from `LAMPAS_ALLOWED_PORTAL_HOSTS` or `NODE_ENV`. Loopback portal destinations require explicit development policy. Fixture policy is supplied via main-only test/development construction (`PortalPolicy.configureDevelopmentPolicy`). Binding and invalidation behavior is identical across all modes. The native OAuth callback listener on loopback is fully preserved.
- **Implementation (`src/portal-policy.ts` & `src/main.ts`):**
  1. `PortalPolicy.isPackagedProduction()` checks `productionOverride !== null ? productionOverride : Boolean(app?.isPackaged)`.
  2. In packaged production, `PortalPolicy.isLoopbackAllowed()` unconditionally returns `false`, and `isApprovedRemoteHost()` strictly enforces `lampas.town` and `*.lampas.town`, immediately returning `false` for any other domain before consulting environment variables.
  3. In development/testing (`!app.isPackaged`), `main.ts` configures development policy via `PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true, allowedRemoteHosts: ... })`.
  4. `normalizePortalUrl()` rejects any loopback destination if `!PortalPolicy.isLoopbackAllowed()`.
- **Empirical Regressions:**
  - `security-boundary-characterization.ts` Test 11: When `setProductionOverride(true)`, loopback destinations and env-expanded hosts (`LAMPAS_ALLOWED_PORTAL_HOSTS`, `NODE_ENV=development`) throw `PortalPolicyError`, while `dev.lampas.town` is permitted.

#### C. Known-Location Opener Authorization & Ancestor Validation
- **Invariant:** Opener targets must validate expected filesystem types (directory vs. file) and verify physical ancestry against canonical authorized roots before creation or OS opening. Escaping symlinks, junctions, and ancestor escapes must be rejected. Compatibility handlers must follow the same policy. Failed web links must never be reinterpreted as local paths.
- **Implementation (`src/main.ts`):**
  1. `findExistingAncestor(p)` traverses up `path.dirname` to find the nearest physically existing ancestor.
  2. `isPathWithinOrEqual(child, parent)` enforces canonical path containment with case-insensitive Windows normalization.
  3. Pre-creation check: The physical realpath of the nearest existing ancestor must be within the canonical authorized root (`canonicalGameDir` for `modsDir`/`minecraftLog`, `canonicalUserData` for `logsDir`, `canonicalAuthorizedRoot` for `launcherLog`).
  4. Post-creation / pre-opening check: `canonicalTarget = fs.realpathSync(targetPath)` must be within the authorized canonical root, and `fs.statSync(canonicalTarget)` must match expected type.
  5. Handlers pass `canonicalTarget` to `shell.openPath`.
  6. `utils:openPath` checks for URI schemes (`^[a-zA-Z][a-zA-Z0-9+.-]*:`) and validates via `validateWebUrl` without falling back to local path execution on error.

#### D. Hardened `launcherLog` Authorization
- **Invariant:** Anchor launcher-log paths to independently trusted canonical `userData`. Validate the logs directory against that root before treating it as an authorized parent. Do not derive the trust anchor solely from `realpath(logsDir)`. Apply the same validation to `openLogFile`, `openKnownLocation`, and `openPath`.
- **Implementation (`src/main.ts`):**
  In `resolveAndValidateKnownLocation("launcherLog")`:
  ```ts
  const rawUserData = app.getPath("userData");
  const canonicalAuthorizedRoot = fs.realpathSync(rawUserData);

  const rawLogsDir = path.join(rawUserData, "logs");
  const nearestExistingLogsDir = findExistingAncestor(rawLogsDir);
  const canonicalNearestLogs = fs.realpathSync(nearestExistingLogsDir);
  if (!isPathWithinOrEqual(canonicalNearestLogs, canonicalAuthorizedRoot)) {
    throw new Error(`Unauthorized ancestor path escape detected for logs directory: ${rawLogsDir}`);
  }

  if (!fs.existsSync(rawLogsDir)) {
    fs.mkdirSync(rawLogsDir, { recursive: true });
  }
  const canonicalLogsDir = fs.realpathSync(rawLogsDir);
  if (!isPathWithinOrEqual(canonicalLogsDir, canonicalAuthorizedRoot)) {
    throw new Error(`Unauthorized logs directory target outside userData root: ${rawLogsDir}`);
  }

  const rawLogPath = path.join(rawLogsDir, "launcher.log");
  // ... verifies file target physical realpath is within canonicalAuthorizedRoot and matches File type
  ```
- **Empirical Regressions (`security-boundary-characterization.ts` Tests 13–16):**
  - **Test 13:** Normal launcher log opens successfully across registered handlers (`utils:openLogFile`, `utils:openKnownLocation("launcherLog")`, `utils:openPath(logPath)`).
  - **Test 14:** `userData/logs` linked or junctioned to an outside directory is rejected across registered handlers with 0 opener calls.
  - **Test 15:** `launcher.log` file linked outside the authorized root is rejected across registered handlers with 0 opener calls.
  - **Test 16:** Missing-target and wrong-file-type cases (e.g., directory where file expected) are rejected across registered handlers with 0 opener calls.
  - **Platform symlink tracking:** Any environment inability to create links/junctions records explicitly as `skippedPlatformCoverage`, never as a passed escape test.

#### E. Local Fallback Regression Fixture & Positive Control
- **Invariant:** Production fallback reads `../../manifest/client-manifest.json` and `../../manifest/release.json` relative to executing module. Controlled file-access fixture intercepts these module-relative paths without touching workspace sibling directories. Positive control proves the fallback fixture is valid, reachable, and succeeds on non-redirect error. Independent redirect cases assert: request reached Origin A, failed with `PortalRedirectPolicyError`, 0 requests to Destination B, and no fallback success or installation mutation.
- **Implementation & Tests (`security-boundary-characterization.ts` Tests 33–37):**
  - **Controlled File-Access Fixture:** Intercepts `node:fs` calls (`existsSync`, `readFileSync`) inside `test/security-boundary-characterization.ts` for module-relative manifest and release paths, serving valid JSON payloads only when enabled.
  - **Positive Control (Test 33):** Server A returns HTTP 500 on channel metadata. `fetchPortalJsonWithRetry` retries 3 times on Origin A, fails, enters offline local fallback, loads the controlled fallback manifest and release, writes `.lampas/installation.json` with version `2.0.0-offline`, and returns success. Proves fallback fixture is valid, reachable, and works on legitimate offline errors.
  - **Channel Redirect with Fallback (Test 34):** Server A redirects `/api/v1/channels/stable` with 302, 307, 308 to Destination B with fallback fixture enabled. Asserts: request reached Origin A, failed with `PortalRedirectPolicyError`, 0 requests reached B, and no fallback success or `.lampas/installation.json` creation occurred.
  - **Release Redirect with Fallback (Test 35):** Channel succeeds, release endpoint redirects 302, 307, 308 to B with fallback fixture enabled. Asserts: `PortalRedirectPolicyError`, 0 requests to B, no fallback success or installation mutation.
  - **Manifest Redirect with Fallback (Test 36):** Channel and release succeed, manifest endpoint redirects 302, 307, 308 to B with fallback fixture enabled. Asserts: `PortalRedirectPolicyError`, 0 requests to B, no fallback success or installation mutation.
  - **Legitimate File Download Safe Redirect (Test 37):** Proves non-metadata blob downloads follow safe redirects without `Authorization` headers.

#### F. Loopback Test Fixture Migration to Explicit Development Policy
- **Invariant:** Review all test suites using loopback servers. Each isolated suite must establish and reset its own fixture policy; establish synthetic sessions with the main-only session API (`ConfigManager.establishSession`); and never rely on shared policy state left by another test file.
- **Implementation:**
  Migrated 10 test suites:
  1. `test/sync-client.test.ts`
  2. `test/characterization.test.ts`
  3. `test/config-patches-sync.test.ts`
  4. `test/minecraft-bootstrap.test.ts`
  5. `test/regression-gates.test.ts`
  6. `test/java-runtime.test.ts`
  7. `test/repair.test.ts`
  8. `test/sync-contract.test.ts`
  9. `test/sync-logging.test.ts`
  10. `test/sync-state-publication.test.ts`
  Each suite now includes:
  - `beforeEach`: `PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true })` and `ConfigManager.establishSession(portalUrl, { token, ... })`
  - `afterAll`: `PortalPolicy.resetForTesting()`
  - Zero cross-file state leakage; verified by running suites in alternating execution orders.

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
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Passed | **38 passed, 0 failed, 0 outbound violations, 0 skipped** | Isolated child process; 38/38 dynamic tests passing |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Passed | **16 passed, 0 failed, 82 expect() calls** | 15 unit/component + 1 child runner assertion |
| **Regression Gates (`test/regression-gates.test.ts`)** | Passed | **4 passed, 0 failed, 5 expect() calls** | Keyring & path gates |
| **Complete Suite (`bun test`)** | Passed | **283 passed, 5 skipped, 9 todo, 0 failed across 34 files** | Complete launcher test suite green |

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
   - Spawns `test/security-boundary-characterization.ts` in isolated child process and asserts clean exit code 0 with 38/38 passed tests and 0 skipped.
3. **Regression Gates (4 passed in `test/regression-gates.test.ts`):**
   - Mod mutator guard during game running / installation.
   - Kill game process settlement retention.
   - Asset index corruption repair replacement.
   - Native marker file bypass re-extraction.
4. **Migrated Integration Suites Passing in Parent Process (263 passed tests):**
   - `test/sync-client.test.ts` (5 passed)
   - `test/characterization.test.ts` (7 passed)
   - `test/config-patches-sync.test.ts` (5 passed)
   - `test/minecraft-bootstrap.test.ts` (7 passed)
   - `test/java-runtime.test.ts` (10 passed)
   - `test/repair.test.ts` (1 passed)
   - `test/sync-contract.test.ts` (7 passed)
   - `test/sync-logging.test.ts` (4 passed)
   - `test/sync-state-publication.test.ts` (7 passed)
   - Pre-existing unaffected suites (200+ passed)

#### B. Child Process Boundary Runner (`security-boundary-characterization.ts`): 38 Passed Tests
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
13. `[Opener: launcherLog] Normal launcher log opens successfully via registered handlers`
14. `[Opener: launcherLog] userData/logs linked or junctioned to an outside directory is rejected across registered handlers`
15. `[Opener: launcherLog] launcher-log file linked outside authorized root is rejected across registered handlers`
16. `[Opener: launcherLog] Missing-target and wrong-file-type cases are rejected across registered handlers`
17. `[Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B`
18. `[Regression Gate 1] Real OAuth login flow successfully completes code exchange and establishes session`
19. `[Regression Gate 1] Origin-change invalidation: Case 1 - Fresh logged-out login at A, settings A->B->A before callback`
20. `[Regression Gate 1] Origin-change invalidation: Case 2 - Fresh logged-out login at A, settings A->B->A during exchange`
21. `[Regression Gate 1] Origin-change invalidation: Case 3 - Fresh logged-out login at A, settings A->B without returning to A`
22. `[Regression Gate 1] Origin-change invalidation: Case 4 - Unchanged portal does not invalidate in-flight login`
23. `[Regression Gate 1] Origin-change invalidation: Case 5 - In-flight exchange while credentials exist`
24. `[Regression Gate 1] Origin-change invalidation: Case 6 - Refresh while origin changes`
25. `[Regression Gate 1] Race safety: portal A -> B switch during in-flight verify ignores late A completion`
26. `[Regression Gate 1] Race safety: rapid portal A -> B -> A switching rejects stale response`
27. `[Regression Gate 1] Race safety: logout during in-flight refresh discards late tokens`
28. `[Regression Gate 1] Race safety: old 401 failure arriving after new session establishment does not clear new credentials`
29. `[Regression Gate 1] Independent redirect: auth:verify rejects 302/307/308 redirects with 0 requests to B`
30. `[Regression Gate 1] Independent redirect: auth:refresh rejects 302/307/308 redirects with 0 requests to B`
31. `[Regression Gate 1] Independent redirect: auth token exchange rejects 302/307/308 redirects with 0 requests to B`
32. `[Regression Gate 1] Independent redirect: server status metadata endpoint rejects 302/307/308 redirects with 0 requests to B`
33. `[Regression Gate 1] Local fallback fixture: positive control proves fallback is valid, reachable, and succeeds on non-redirect error`
34. `[Regression Gate 1] Independent redirect: channel sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present`
35. `[Regression Gate 1] Independent redirect: release sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present`
36. `[Regression Gate 1] Independent redirect: manifest sync metadata endpoint rejects 302/307/308 redirects with valid local fallback fixture present`
37. `[Regression Gate 1] Legitimate file download follows safe redirect without auth headers`
38. `[Regression Gate 1] ConfigManager.get performs durable disk scrubbing of unbound tokens on disk`

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
| 6 | `utils:getAppVersion` | `handle` | 307 | None | None | None | Reads `app.getVersion()` | `string` |
| 7 | `utils:openPath` | `handle` | 308 | None | None | `targetPath: string` | **Hardened:** URI schemes validated via `validateWebUrl` -> `openExternal`. Local paths constrained to approved known locations (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`) with canonical root anchoring, logs directory validation, physical ancestry and canonical root validation -> `openPath`. All arbitrary paths rejected. Never falls back to local on web URL failure. | `string` |
| 8 | `utils:openSourcePage` | `handle` | 344 | None | None | `url: string` | Validates web URL via `validateWebUrl` and calls `shell.openExternal`. Rejects non-HTTP schemes. | `string` |
| 9 | `utils:openKnownLocation` | `handle` | 349 | None | None | `location: string` | Maps known identifier (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`), validates logs directory and physical ancestry against canonical roots, verifies directory/file type on disk, and calls `shell.openPath`. Rejects escaping symlinks and arbitrary locations. | `string` |
| 10 | `utils:getLogPath` | `handle` | 354 | None | None | None | Resolves active `launcher.log` path | `string` |
| 11 | `utils:openLogsDir` | `handle` | 355 | None | None | None | Calls `resolveAndValidateKnownLocation("logsDir")` -> `shell.openPath` | `string` |
| 12 | `utils:openLogFile` | `handle` | 360 | None | None | None | Calls `resolveAndValidateKnownLocation("launcherLog")` with canonical root anchoring -> `shell.openPath` | `string` |
| 13 | `utils:getMinecraftLogPath` | `handle` | 365 | None | None | None | Resolves `gameDir/logs/latest.log` path | `string` |
| 14 | `utils:openMinecraftLog` | `handle` | 369 | None | None | None | Calls `resolveAndValidateKnownLocation("minecraftLog")` -> `shell.openPath` | `string` |
| 15 | `config:get` | `handle` | 376 | None | None | None | Reads configuration; scrubs legacy unbound credentials from disk; strips tokens | `RendererSettingsDto` |
| 16 | `config:set` | `handle` | 377 | None | None | `newConfig: Partial<SettingsDto>` | **Hardened:** Strips `sessionPortalUrl` from patch to prevent binding forgery; wipes tokens on origin change based on trusted prior state; advances session generation on active origin change | `RendererSettingsDto` |
| 17 | `gameDir:getStatus` | `handle` | 391 | None | None | None | Queries filesystem existence and checks `.lampas` metadata | `GameDirStatusDto` |
| 18 | `gameDir:browse` | `handle` | 392 | None | None | `defaultPath?: string` | Displays native folder picker dialog | `{ canceled: boolean; filePaths: string[] }` |
| 19 | `gameDir:validate` | `handle` | 400 | None | None | `targetPath: string, currentPath?: string` | Checks directory syntax, drive roots, existence, writability | `GameDirValidationResult` |
| 20 | `gameDir:configure` | `handle` | 402 | None | None | `targetPath: string` | Creates target directory; updates `gameDir` in `config.json` | `RendererSettingsDto` |
| 21 | `gameDir:move` | `handle` | 407 | None | None | `targetPath: string` | Moves or copies game files; manages migration journals | `DirectoryMoveResult` |
| 22 | `auth:login` | `handle` | 425 | None | None | None | **Hardened:** Ignores caller overrides; uses canonical configured origin; binds session via generation epochs | `{ user: RendererUserProfile }` |
| 23 | `auth:logout` | `handle` | 429 | None | None | None | Clears auth state, config tokens, session portal binding, and increments generation | `void` |
| 24 | `auth:verify` | `handle` | 430 | None | None | None | **Hardened:** Ignores caller overrides; verifies with session portal; manual redirect; aborts on race | `{ valid: boolean; user?: RendererUserProfile }` |
| 25 | `auth:refresh` | `handle` | 434 | None | None | None | **Hardened:** Ignores caller overrides; refreshes with session portal; manual redirect; aborts on race | `{ valid: boolean; user?: RendererUserProfile }` |
| 26 | `server:getStatus` | `handle` | 440 | None | None | None | Queries Portal server status via `ServerStatusClient` with manual redirect | `ServerStatus` |
| 27 | `sync:start` | `handle` | 443 | None | None | None | Executes standard sync pipeline via `OperationCoordinator` | `SyncResult` |
| 28 | `sync:repair` | `handle` | 462 | None | None | None | Executes full hash audit and redownload via `OperationCoordinator` | `SyncResult` |
| 29 | `sync:getModCatalog` | `handle` | 482 | None | None | None | Reads mod catalog from Portal endpoint (`fetchPortalJsonWithRetry`, manual redirect, no disk fallback on rejection) | `ModCatalogItem[]` |
| 30 | `sync:getInstalledRuntime` | `handle` | 483 | None | None | None | Reads local `.lampas/release.json` and `.lampas/installation.json` | `InstalledRuntimeDto \| null` |
| 31 | `mods:browseAndAdd` | `handle` | 518 | None | None | None | Opens native open-file dialog; copies selected `.jar` files into `gameDir/mods/` | `ClientModState[]` |
| 32 | `mods:addPaths` | `handle` | 527 | None | None | `paths: string[]` | Copies arbitrary filesystem paths into `gameDir/mods/` | `ClientModState[]` |
| 33 | `mods:setOfficialEnabled` | `handle` | 531 | None | None | `id: string, enabled: boolean` | Updates `disabledClientMods` array in `config.json` | `string[]` |
| 34 | `mods:setCustomEnabled` | `handle` | 535 | None | None | `filename: string, enabled: boolean` | Renames file between `.jar` and `.jar.disabled` on disk | `ClientModState[]` |
| 35 | `mods:removeCustom` | `handle` | 539 | None | None | `filename: string` | Deletes file from `gameDir/mods/` | `ClientModState[]` |
| 36 | `game:launch` | `handle` | 545 | None | None | `user: UserProfile \| null, releaseOverride?: any` | Spawns Minecraft child process via `OperationCoordinator` | `boolean` |
| 37 | `game:kill` | `handle` | 566 | None | None | None | Terminates running Minecraft child process | `void` |
| 38 | `game:isRunning` | `handle` | 570 | None | None | None | Queries internal running process reference | `boolean` |

---

### 6. Finding Status & Remaining Scope (SEC-01 to SEC-12)

| Finding ID | Priority | Phase | Status at Review Gate 1 | Remediation & Remaining Scope |
|---|---|---|---|---|
| **SEC-01** | P0 / High | Phase 1 | **Remediated & Verified** | • Canonical origin policy (`normalizePortalUrl`) rejects bypasses, userinfo, queries, and path injections.<br>• Session origin binding via `sessionPortalUrl`; wiped on unapproved remote origin change.<br>• Renderer forgery of `sessionPortalUrl` via `config:set` closed; credentials only established via `ConfigManager.establishSession`.<br>• Origin-change invalidation without established session: advances `sessionGeneration` on any canonical portal change.<br>• Development portal policy explicitly non-production: packaged production rejects loopback and environment trust expansion.<br>• Race-safe invalidation via monotonic `sessionGeneration` epochs across login, verify, refresh, logout.<br>• Authenticated metadata fetches enforce `redirect: "manual"` and fail closed.<br>• Legacy unbound credentials scrubbed from disk on `ConfigManager.get()`.<br>• Dual-origin test harness confirms 0 Origin A credentials reach Origin B across all scenarios. |
| **SEC-02** | P0 / High | Phase 1 / Phase 2 | **Partially Remediated** (Link sink & openers hardened; IPC sender lockdown deferred to Phase 2) | • Web link sink hardened: `validateWebUrl` strictly permits HTTP/HTTPS; rejects dangerous pseudo-schemes.<br>• `utils:openPath` rejects arbitrary local paths and UNC shares; never falls back to local execution on web URL rejection.<br>• Added dedicated openers: `utils:openSourcePage` and `utils:openKnownLocation`.<br>• Opener targets validated against canonical directory roots with physical ancestry verification and escaping symlink rejection.<br>• Hardened `launcherLog` authorization independently anchored to trusted `userData` with logs directory canonical validation.<br>• *Remaining for Phase 2:* IPC sender frame origin validation and `config:set` strict allowlist schema. |
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

### 7. Remaining Packaged / Platform Gaps

- **Platform Symlink Privileges:** On Windows environments without Developer Mode or elevated privileges enabled, creation of file symlinks or directory junctions may throw `EPERM`. The test harness explicitly records such occurrences under `skippedPlatformCoverage` array (currently `0` skipped in this test execution). An inability to construct an escape link is never counted as a passed escape test.
- **Packaged Production Policy:** Loopback portal connectivity is strictly prohibited when `app.isPackaged` is true (or `productionOverride === true`). The local loopback callback server for native OAuth login remains active and preserved in all modes.

---

### 8. Review Gate 1 Acceptance Confirmation

- **Phase 1 Production Scope Fully Implemented & Amended:**
  - `SEC-01` (portal destination constraint, session origin binding, forgery closure, origin-change invalidation without session, race safety, manual redirect rejection, legacy credential invalidation) is complete and dynamically verified.
  - `SEC-02` link-opening sink (`validateWebUrl`, local path restriction, path classification with physical ancestry and canonical root validation, dedicated openers, escaping symlink rejection, and independent `userData`-anchored `launcherLog` authorization) is complete and dynamically verified.
- **Outbound Request Policy Harness Verified:**
  - Zero unapproved outbound network requests detected during isolated boundary execution.
- **Pre-Existing Invariants:**
  - All baseline tests pass with zero regressions (283 passed across 34 test files).
- **Dependencies & Lockfile:**
  - `bun.lock` is byte-for-byte identical with baseline. Zero dependency modifications.
- **Typecheck & Packaging:**
  - Production typecheck (`bun run typecheck`), security test typecheck (`tsconfig.security-test.json`), and production Vite packaging (`bun run build`) pass cleanly with 0 errors.

**STOPPING AT REVIEW GATE 1.** Phase 2 has not been implemented. Ready for commit and push for review.
