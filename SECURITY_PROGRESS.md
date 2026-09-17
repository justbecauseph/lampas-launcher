# Lampas Launcher — Security Hardening Progress

## Review Gate 1 (Amended) — Constrain Credential Destinations and Web-Link Opening (SEC-01, SEC-02)

- **Execution Date:** 17 September 2026
- **Status:** Complete (Review Gate 1 amended & verified; Phase 1 production implementation hardened; stopped before Phase 2)
- **Reviewed Target Commit:** `49e49dc4b6ed2cf65f1bab88fb9998d7bdb91518` (amended in-place)
- **Accepted Baseline Review Checkpoint:** `149f10021efce2939c6c12150a3a07dd61b622dc`
- **Initial Test Preparation Pass Commit:** `d87775863de4d825ac7e90e67574282d21cfff62`
- **Current Branch:** `feat/security`
- **Scope Restriction:** Strictly restricted to Phase 1 ("Constrain credential destinations and web-link opening"). Phase 2 (sender frame validation, IPC argument allowlist schemas), Phase 3 (OS keyring/DPAPI), and subsequent phases remain paused.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A complete audit of changes was performed against the accepted baseline checkpoint (`149f10021efce2939c6c12150a3a07dd61b622dc`), the initial Phase 1 commit (`49e49dc4b6ed2cf65f1bab88fb9998d7bdb91518`), and the amended Review Gate 1 working tree:

| Dimension | Assessed Baseline (`3950e15`) | Accepted RG 0.1 (`149f100`) | Reviewed Commit (`49e49dc`) | Amended RG 1 (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline | Pristine baseline (`0 lines`) | 8 production files modified, 1 added (`src/portal-policy.ts`) | 8 production files modified, 1 added (`src/portal-policy.ts`) | **Constrained strictly to Phase 1 fixes & Review Gate 1 corrections** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical (zero package mutations)** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Absent | 8 passed (RG 0.1) | 11 passed | **20 passed, 0 failed, 0 outbound violations** | **+9 dynamic regression tests for binding forgery, races, redirects, disk scrubbing, openers** |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Absent | 16 passed | 16 passed | **16 passed (15 unit/component + 1 child runner assertion verifying all 20)** | **16/16 passing** |
| **Regression Gates (`security-regression-gates.test.ts`)** | Absent | 6 skipped, 10 todo | 4 passed, 5 skipped, 9 todo | **4 passed, 5 skipped, 9 todo, 0 failed** | **Phase 1 gates verify binding forgery rejection and durable disk scrubbing** |
| **Full Combined Suite (`bun test`)** | 261 passed | 277 passed | 281 passed | **281 passed, 5 skipped, 9 todo, 0 failed** across 34 files | **All 261 baseline tests pass; 0 regressions** |
| **Security Test Typecheck** | Absent | 0 errors | 0 errors | **0 errors (`tsconfig.security-test.json`)** | **0 errors** |
| **Production Typecheck & Build** | Clean | Clean | Clean | **0 errors (`tsc && vite build`)** | **0 errors** |

**Documentation and Ignore Invariants:**
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **tracked under git** (not ignored).

---

### 2. Review Gate 1 Amendment Corrections & Rationale

During Review Gate 1 review, several gaps and architectural deficiencies were identified. Each was addressed with production code hardening and proven with empirical regressions:

#### A. Renderer-Controlled Session-Binding Forgery Closed
- **Vulnerability:** Previously, `ConfigManager.set()` accepted `sessionPortalUrl` in its caller patch, allowing renderer input via `config:set` to forge the session origin binding and cause credentials from Origin A to be routed to Origin B.
- **Remediation:**
  1. `ConfigManager.set()` strips `sessionPortalUrl` unconditionally from any caller input.
  2. Origin changes invalidate credentials based exclusively on trusted prior state (`current.sessionPortalUrl`), not caller-editable binding values.
  3. Authenticated credentials can only be established through a dedicated main-only operation: `ConfigManager.establishSession(issuingOrigin, credentials, extraConfig)`, which explicitly binds credentials to `issuingOrigin`.
  4. Tested with regression test 12: Starting with Origin A's session, renderer calls `config:set` with `portalUrl=B, sessionPortalUrl=B`, then invokes `verifySession`, `refreshSession`, `ServerStatusClient.getStatus`, and `LauncherSync.syncClient`. Proven that:
     - `sessionPortalUrl` is stripped and credentials are wiped.
     - `verifySession` and `refreshSession` reject without contacting Origin B.
     - `ServerStatusClient.getStatus` fails closed with `"Portal session is not available"`.
     - `syncClient` throws `"Authentication required"`.
     - Exactly 0 requests containing Origin A credentials reach Origin B.
     - The rejection occurs within production policy (credentials wiped, origin mismatch), not merely a harness guard.

#### B. Removed Production Test-Mode Security Exceptions
- **Deficiency:** Previously, `ConfigManager.set()` bypassed credential invalidation if `process.env.NODE_ENV === "test"` or `typeof Bun !== "undefined"` when switching loopback ports. Unconditional `.test` and `.example` allowances were also present in `isApprovedRemoteHost`.
- **Remediation:**
  1. Completely deleted test-mode credential-preserving rebindings. Different loopback ports (`127.0.0.1:portA` vs `127.0.0.1:portB`) are strictly different origins in all modes.
  2. Updated all test suites (`config-patches-sync.test.ts`, `repair.test.ts`, `sync-client.test.ts`, `sync-contract.test.ts`, `sync-logging.test.ts`, `sync-state-publication.test.ts`, `server-status.test.ts`) to establish independent fixture sessions via `ConfigManager.establishSession` instead of preserving tokens across dynamic fixture ports.
  3. Removed unconditional `.test` and `.example` allowances from `isApprovedRemoteHost`. Production approved hosts are strictly `lampas.town` and `*.lampas.town`. Explicit dev portal host testing is supported exclusively via `process.env.LAMPAS_ALLOWED_PORTAL_HOSTS`.

#### C. Race-Safe Invalidation with Generation Epochs
- **Race Risk:** Concurrent `portalUrl` updates, verification requests, and background sync could leave credentials bound to one origin while containing tokens from another, or late responses could resurrect credentials for an invalidated origin or after logout.
- **Remediation:**
  1. Added `sessionGeneration` monotonic counter in `ConfigManager`, incremented on every origin change, `establishSession`, and `clearSession`.
  2. In `LauncherAuth.loginWithPortal`, `refreshSession`, `verifySession`, and `logout`:
     - A snapshot of `generationSnapshot = ConfigManager.getSessionGeneration()` and `issuingOrigin = normalizePortalUrl(config.portalUrl)` is captured at operation initiation.
     - After network await and before publishing or clearing credentials, the active state is verified:
       ```ts
       if (ConfigManager.getSessionGeneration() !== generationSnapshot || normalizePortalUrl(ConfigManager.get().portalUrl) !== issuingOrigin) {
         return { valid: false }; // Abort without publishing or corrupting active session
       }
       ```
  3. Added comprehensive race-safety regressions in `test/security-boundary-characterization.ts`:
     - **Test 13:** Portal A -> B switch during in-flight verify/refresh ignores late A completion; does not overwrite B's session.
     - **Test 14:** Rapid portal A -> B -> A switching rejects stale responses from generation 1 without overwriting generation 3.
     - **Test 15:** Logout during in-flight exchange discards late refreshed tokens; session remains logged out.
     - **Test 16:** Old 401 failure response arriving after a new session is established does not clear the new session credentials.

#### D. Authenticated Metadata Redirect Policy Enforced
- **Policy Risk:** Metadata fetches in `sync.ts` could follow HTTP 3xx redirects to arbitrary origins, potentially disclosing auth headers or poisoning local manifest caches.
- **Remediation:**
  1. Replaced metadata fetches in `sync.ts` and `getModCatalog` with `fetchPortalJsonWithRetry`, which wraps `portalFetch` with `redirect: "manual"`.
  2. If a metadata request responds with 3xx, `portalFetch` throws `PortalRedirectPolicyError`.
  3. In `sync.ts`, `catch (portalErr)` explicitly checks for `PortalRedirectPolicyError` and `PortalPolicyError` and rethrows immediately, preventing fallback to local disk caches on a policy rejection.
  4. Preserved credential-free object storage redirects in `downloadVerified` for verified file blobs.
  5. Added regressions using owned Origin A and Origin B servers:
     - **Test 17:** Metadata 302, 307, and 308 redirects from A to B are rejected; Origin A recorded the request; Destination B received 0 requests; no token leaked; fails closed without local disk fallback.
     - **Test 18:** Legitimate file downloads via `downloadVerified` follow safe 302 redirects to CDN blob storage without transmitting `Authorization` headers.

#### E. Narrow Opener Handling & Durable Disk Scrubbing
- **Hardening:**
  1. Implemented `resolveAndValidateKnownLocation(locationId)` in `src/main.ts`:
     - Maps approved location keys (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`) to canonical absolute paths.
     - Enforces filesystem type validation: verifies directory targets are directories (`stat.isDirectory()`) and file targets are files (`stat.isFile()`).
     - Rejects non-existent files or mismatched directory types.
  2. Aligned compatibility handlers (`utils:openLogsDir`, `utils:openLogFile`, `utils:openMinecraftLog`, `utils:openKnownLocation`, `utils:openPath`) with strict validation rules.
  3. Web URLs passed to `utils:openPath` validate against `validateWebUrl` and invoke `shell.openExternal`. If invalid or rejected, they throw an Error and NEVER fall back to `shell.openPath`.
  4. Implemented durable disk scrubbing: When `ConfigManager.get()` detects unbound credentials in `config.json` on disk, it nullifies them in memory AND immediately writes the scrubbed configuration atomically back to disk (`writeAtomicFileSync`).
  5. Verified in Test 19 (durable disk scrubbing) and Test 20 (narrow opener helpers).

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
| **Pre-Existing Baseline Suite** | Passed | **261 passed, 0 failed** across 32 files | Zero regressions against pre-existing test suite |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Passed | **20 passed, 0 failed, 0 outbound violations** | Isolated child process; 20/20 dynamic tests passing |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Passed | **16 passed, 0 failed, 63 expect() calls** | 15 unit/component + 1 child runner assertion |
| **Regression Gates (`security-regression-gates.test.ts`)** | Passed | **4 passed, 5 skipped, 9 todo, 0 failed** | Phase 1 gates unskipped & passing |
| **Full Combined Suite (`bun test`)** | Passed | **281 passed, 5 skipped, 9 todo, 0 failed** (34 files, `3.99s`) | 1070 total assertions; 0 failures |

---

### 4. Separate Accounting: Parent-Process vs. Child-Process Tests

To maintain complete accounting integrity, parent-process test executions and child-process boundary executions are tracked separately:

#### A. Parent Process Suite (`bun test`): 281 Passed Tests
1. **Pre-Existing Baseline Tests (261 passed):**
   - Modpack sync, client runtime contract, game launching, mod management, config patch application, logger redaction, and UI utilities.
2. **Phase 1 Security Unit/Component Tests (15 passed in `test/security-characterization.test.ts`):**
   - URL normalization, HTTP lookalike rejection, scheme auto-upgrade.
   - Plaintext credential persistence characterization (SEC-03).
   - Path containment & ownership inconsistency characterizations (SEC-04).
   - Move recovery staging deletion characterization (SEC-05).
   - Executable verification fail-open characterizations (SEC-06).
   - Logging redaction gap characterizations (SEC-09).
3. **Child Process Execution Assertion (1 passed in `test/security-characterization.test.ts`):**
   - Spawns `test/security-boundary-characterization.ts` in isolated child process and asserts clean exit code 0 with 20/20 passed tests.
4. **Phase 1 Regression Gates (4 passed in `test/security-regression-gates.test.ts`):**
   - `normalizePortalUrl` HTTPS enforcement and HTTP lookalike rejection.
   - Web link sink protocol rejection.
   - Session origin binding, forgery rejection, and unapproved origin invalidation.
   - Legacy unbound credential disk scrubbing on `ConfigManager.get()`.

#### B. Child Process Boundary Runner (`security-boundary-characterization.ts`): 20 Passed Tests
Executed in a fresh Bun child process with complete Electron mocks, outbound network request policy enforcement, child process execution traps, and bounded teardown:
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
11. `[Service-Level] LauncherAuth.verifySession & refreshSession reject 3xx redirects`
12. `[Regression Gate 1] Renderer-controlled session-binding forgery via config:set is rejected and leaks 0 credentials to origin B`
13. `[Regression Gate 1] Race safety: portal A -> B switch during in-flight verify ignores late A completion`
14. `[Regression Gate 1] Race safety: rapid portal A -> B -> A switching rejects stale response`
15. `[Regression Gate 1] Race safety: logout during in-flight exchange discards late tokens`
16. `[Regression Gate 1] Race safety: old 401 failure arriving after new session establishment does not clear new credentials`
17. `[Regression Gate 1] Sync metadata 302/307/308 redirects from A to B are rejected with 0 requests to B and no cache fallback`
18. `[Regression Gate 1] Legitimate file download follows safe redirect without auth headers`
19. `[Regression Gate 1] ConfigManager.get performs durable disk scrubbing of unbound tokens on disk`
20. `[Regression Gate 1] Narrow opener helpers validate paths against approved roots and reject escape attempts`

---

### 5. Inbound IPC Channel Inventory (38 Channels Total)

Following Phase 1 hardening:
- **Total Registered Channels:** **38** (37 `ipcMain.handle` + 1 `ipcMain.on`)
- **Sender ID Validation:** 1 channel (`game:logAck` on line 125).
- **Frame / Document Validation:** Scheduled for Phase 2.

| # | IPC Channel | Registration Type | Line | Sender ID Check | Frame / Doc Validation | Expected Payload | Side Effects in Main Process | Actual Returned Shape |
|---|---|---|---|---|---|---|---|---|
| 1 | `game:logAck` | `on` | 125 | **Sender ID Checked** | None | `{ batchId?: number }` | Validates `event.sender.id === targetId`; advances log batch transport | None (event listener) |
| 2 | `window:minimize` | `handle` | 139 | None | None | None | Invokes `mainWindow.minimize()` | `void` |
| 3 | `window:maximize` | `handle` | 140 | None | None | None | Toggles `mainWindow.maximize()` / `unmaximize()` | `void` |
| 4 | `window:isMaximized` | `handle` | 147 | None | None | None | Queries `mainWindow.isMaximized()` | `boolean` |
| 5 | `window:close` | `handle` | 148 | None | None | None | Destroys window and terminates application | `void` |
| 6 | `utils:getAppVersion` | `handle` | 216 | None | None | None | Reads `app.getVersion()` | `string` |
| 7 | `utils:openPath` | `handle` | 217 | None | None | `targetPath: string` | **Hardened:** Web URLs validated via `validateWebUrl` -> `openExternal`. Local paths constrained to approved known locations (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`) -> `openPath`. All arbitrary paths rejected. Never falls back to local on web URL failure. | `string` |
| 8 | `utils:openSourcePage` | `handle` | 255 | None | None | `url: string` | **New (Phase 1):** Validates web URL via `validateWebUrl` and calls `shell.openExternal`. Rejects non-HTTP schemes. | `string` |
| 9 | `utils:openKnownLocation` | `handle` | 260 | None | None | `location: string` | **New (Phase 1):** Maps known identifier (`gameDir`, `modsDir`, `logsDir`, `launcherLog`, `minecraftLog`), validates directory/file type on disk, and calls `shell.openPath`. Rejects arbitrary locations. | `string` |
| 10 | `utils:getLogPath` | `handle` | 291 | None | None | None | Resolves active `launcher.log` path | `string` |
| 11 | `utils:openLogsDir` | `handle` | 292 | None | None | None | Calls `resolveAndValidateKnownLocation("logsDir")` -> `shell.openPath` | `string` |
| 12 | `utils:openLogFile` | `handle` | 297 | None | None | None | Calls `resolveAndValidateKnownLocation("launcherLog")` -> `shell.openPath` | `string` |
| 13 | `utils:getMinecraftLogPath` | `handle` | 302 | None | None | None | Resolves `gameDir/logs/latest.log` path | `string` |
| 14 | `utils:openMinecraftLog` | `handle` | 306 | None | None | None | Calls `resolveAndValidateKnownLocation("minecraftLog")` -> `shell.openPath` | `string` |
| 15 | `config:get` | `handle` | 317 | None | None | None | Reads configuration; scrubs legacy unbound credentials from disk; strips tokens | `RendererSettingsDto` |
| 16 | `config:set` | `handle` | 318 | None | None | `newConfig: Partial<SettingsDto>` | **Hardened:** Strips `sessionPortalUrl` from patch to prevent binding forgery; wipes tokens on origin change based on trusted prior state | `RendererSettingsDto` |
| 17 | `gameDir:getStatus` | `handle` | 331 | None | None | None | Queries filesystem existence and checks `.lampas` metadata | `GameDirStatusDto` |
| 18 | `gameDir:browse` | `handle` | 332 | None | None | `defaultPath?: string` | Displays native folder picker dialog | `{ canceled: boolean; filePaths: string[] }` |
| 19 | `gameDir:validate` | `handle` | 340 | None | None | `targetPath: string, currentPath?: string` | Checks directory syntax, drive roots, existence, writability | `GameDirValidationResult` |
| 20 | `gameDir:configure` | `handle` | 342 | None | None | `targetPath: string` | Creates target directory; updates `gameDir` in `config.json` | `RendererSettingsDto` |
| 21 | `gameDir:move` | `handle` | 347 | None | None | `targetPath: string` | Moves or copies game files; manages migration journals | `DirectoryMoveResult` |
| 22 | `auth:login` | `handle` | 365 | None | None | None | **Hardened:** Ignores caller overrides; uses canonical configured origin; binds session via generation epochs | `{ user: RendererUserProfile }` |
| 23 | `auth:logout` | `handle` | 369 | None | None | None | Clears auth state, config tokens, session portal binding, and increments generation | `void` |
| 24 | `auth:verify` | `handle` | 370 | None | None | None | **Hardened:** Ignores caller overrides; verifies with session portal; manual redirect; aborts on race | `{ valid: boolean; user?: RendererUserProfile }` |
| 25 | `auth:refresh` | `handle` | 374 | None | None | None | **Hardened:** Ignores caller overrides; refreshes with session portal; manual redirect; aborts on race | `{ valid: boolean; user?: RendererUserProfile }` |
| 26 | `server:getStatus` | `handle` | 380 | None | None | None | Queries Portal server status via `ServerStatusClient` with manual redirect | `ServerStatus` |
| 27 | `sync:start` | `handle` | 383 | None | None | None | Executes standard sync pipeline via `OperationCoordinator` | `SyncResult` |
| 28 | `sync:repair` | `handle` | 402 | None | None | None | Executes full hash audit and redownload via `OperationCoordinator` | `SyncResult` |
| 29 | `sync:getModCatalog` | `handle` | 422 | None | None | None | Reads mod catalog from Portal endpoint (`fetchPortalJsonWithRetry`, manual redirect, no disk fallback on rejection) | `ModCatalogItem[]` |
| 30 | `sync:getInstalledRuntime` | `handle` | 423 | None | None | None | Reads local `.lampas/release.json` and `.lampas/installation.json` | `InstalledRuntimeDto \| null` |
| 31 | `mods:browseAndAdd` | `handle` | 458 | None | None | None | Opens native open-file dialog; copies selected `.jar` files into `gameDir/mods/` | `ClientModState[]` |
| 32 | `mods:addPaths` | `handle` | 467 | None | None | `paths: string[]` | Copies arbitrary filesystem paths into `gameDir/mods/` | `ClientModState[]` |
| 33 | `mods:setOfficialEnabled` | `handle` | 471 | None | None | `id: string, enabled: boolean` | Updates `disabledClientMods` array in `config.json` | `string[]` |
| 34 | `mods:setCustomEnabled` | `handle` | 475 | None | None | `filename: string, enabled: boolean` | Renames file between `.jar` and `.jar.disabled` on disk | `ClientModState[]` |
| 35 | `mods:removeCustom` | `handle` | 479 | None | None | `filename: string` | Deletes file from `gameDir/mods/` | `ClientModState[]` |
| 36 | `game:launch` | `handle` | 485 | None | None | `user: UserProfile \| null, releaseOverride?: any` | Spawns Minecraft child process via `OperationCoordinator` | `boolean` |
| 37 | `game:kill` | `handle` | 506 | None | None | None | Terminates running Minecraft child process | `void` |
| 38 | `game:isRunning` | `handle` | 510 | None | None | None | Queries internal running process reference | `boolean` |

---

### 6. Finding Status & Remaining Scope (SEC-01 to SEC-12)

| Finding ID | Priority | Phase | Status at Review Gate 1 | Remediation & Remaining Scope |
|---|---|---|---|---|
| **SEC-01** | P0 / High | Phase 1 | **Remediated & Verified** | • Canonical origin policy (`normalizePortalUrl`) rejects bypasses, userinfo, queries, and path injections.<br>• Session origin binding via `sessionPortalUrl`; wiped on unapproved remote origin change.<br>• Renderer forgery of `sessionPortalUrl` via `config:set` closed; credentials only established via `ConfigManager.establishSession`.<br>• Test-mode bypasses deleted; all loopback ports treated as independent origins.<br>• Race-safe invalidation via monotonic `sessionGeneration` epochs across login, verify, refresh, logout.<br>• Authenticated metadata fetches enforce `redirect: "manual"` and fail closed.<br>• Legacy unbound credentials scrubbed from disk on `ConfigManager.get()`.<br>• Dual-origin test harness confirms 0 Origin A credentials reach Origin B across all scenarios. |
| **SEC-02** | P0 / High | Phase 1 / Phase 2 | **Partially Remediated** (Link sink & openers hardened; IPC sender lockdown deferred to Phase 2) | • Web link sink hardened: `validateWebUrl` strictly permits HTTP/HTTPS; rejects dangerous pseudo-schemes.<br>• `utils:openPath` rejects arbitrary local paths and UNC shares; never falls back to local execution on web URL rejection.<br>• Added dedicated openers: `utils:openSourcePage` and `utils:openKnownLocation`.<br>• Opener targets validated against canonical directory roots with filesystem type verification.<br>• *Remaining for Phase 2:* IPC sender frame origin validation and `config:set` strict allowlist schema. |
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
  - `SEC-01` (portal destination constraint, session origin binding, forgery closure, race safety, manual redirect rejection, legacy credential invalidation) is complete and dynamically verified.
  - `SEC-02` link-opening sink (`validateWebUrl`, local path restriction, path classification with type validation, dedicated openers) is complete and dynamically verified.
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
