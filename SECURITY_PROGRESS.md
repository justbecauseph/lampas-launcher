# Lampas Launcher — Security Hardening Progress

## Review Gate 0.1 — Corrected Baseline Characterization, Threat Inventory, and Finding Evidence

- **Execution Date:** 17 September 2026
- **Status:** Complete (Review Gate 0.1 reached; Phase 0.1 evidence-and-test correction pass complete; stopped before Phase 1)
- **Assessed Baseline Commit:** `3950e155a25c9effc004e2355dffa1722e46a6cc`
- **Review Commit Target:** `8089c691d38513d804b0fabc7ebaee22685d6a3f`
- **Current Branch:** `feat/security`
- **Production Code Drift:** **Zero diff (`0 lines`)** against baseline commit `3950e15` across all production paths (`src/`, `ui/`). All modifications are strictly restricted to security characterization tests, regression gate specifications, and documentation.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A rigorous comparison was conducted distinguishing the starting baseline, the initial review commit, and the current working tree:

| Dimension | Assessed Baseline (`3950e15`) | Review Target (`8089c69`) | Current Working Tree (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline | Pristine baseline | Pristine baseline | **0 lines modified (zero drift)** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Characterization Suite** | Absent | 17 tests (flawed harness / counts) | 23 tests (hardened harness, mock-cached safe) | **Reconciled & passing (23/23)** |
| **Regression Gates** | Absent | 14 tests (`test.skip` with comment stubs) | 15 tests (6 runnable failing gates + 9 `test.todo`) | **Repaired specifications** |

**Ignore Rules & Documentation Tracking:**
Running `git check-ignore -v PLAN.md PROGRESS.md SECURITY_PLAN.md SECURITY_PROGRESS.md docs/` confirms:
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **tracked under git** (not ignored).

---

### 2. Dependency Lifecycle Scripts & Bun Trust Policy Audit

A comprehensive audit of dependency lifecycle scripts was conducted across the dependency tree:

- **Root `package.json` Audit:**
  The project root `package.json` contains no lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`).
- **Transitive Dependency Audit:**
  Dependencies in `node_modules` contain native build/install lifecycle scripts:
  - `electron-winstaller`: `"install": "node ./script/select-7z-arch.js"`
  - `esbuild`: `"postinstall": "node install.js"`
- **Bun Trust Policy & Execution Reality:**
  Under Node/npm/yarn, these scripts would automatically execute during package installation. However, **Bun enforces a strict default trust policy**: lifecycle scripts for dependencies are blocked unless explicitly allowed in the `trustedDependencies` array in root `package.json`.
  Executing `bun install --frozen-lockfile --verbose` explicitly confirms:
  ```text
  [0.00ms] "electron-winstaller" has an install script, but it was not run because it is not trusted.
  [0.00ms] "esbuild" has an install script, but it was not run because it is not trusted.
  ```
  Because `trustedDependencies` is absent in `package.json`, Bun suppresses all dependency lifecycle scripts.
  > **Assessment:** The absence of script execution during `bun install` is enforced by Bun's security policy, not because the dependency graph is devoid of install scripts.

---

### 3. Environment & Test Suite Execution Results

All checks were executed on the supported development host (Windows x64):

| Command / Suite | Status | Execution Count & Outcome | Notes |
|---|---|---|---|
| `bun --version` | Passed | `1.4.2` | Matches CI environment pin |
| `node --version` | Passed | `v24.9.0` | Electron runtime bundled: `24.18.1` |
| `bun install --frozen-lockfile` | Passed | 15 packages in `1.62s` | Zero script side-effects (Bun trust policy) |
| `bun run typecheck` | Passed | 0 errors | TypeScript strict check on main & renderer |
| `bun run build` | Passed | 12 modules transformed in `252ms` | Clean Vite production build |
| `bun run smoke` | Passed | **7/7 checks passed** | Real unpacked Electron + packaged ASAR validated |
| `bun run benchmark` | Passed | 5/5 scenarios passed | Warm Sync `28.6ms`, Log Storm `104.2ms` (191k lines/s) |
| **Pre-Existing Test Suite** | Passed | **261 passed, 0 failed** across 32 files | Completely preserved; zero regression |
| **Characterization Suite (`security-characterization.test.ts`)** | Passed | **23 passed, 0 failed, 60 expect() calls** | Isolated & full-suite safe; real IPC harness |
| **Regression Gates (`security-regression-gates.test.ts`)** | Passed | **0 pass, 6 skipped, 9 todo, 0 failed** | Runnable failing gates if unskipped against baseline |
| **Full Combined Suite (`bun test`)** | Passed | **284 passed, 6 skipped, 9 todo, 0 failed** (34 files, `3.43s`) | 1036 total assertions; 0 failures |

---

### 4. Granular Finding Reproduction & Evidence Classification (SEC-01 to SEC-12)

Every finding and architectural subclaim is classified under four strict categories:
- **Implementation-Executed:** Dynamically asserted against live production classes, methods, or IPC handlers in test executions.
- **Component / Partial Reproduction:** Exercised at component level (e.g. mock HTTP transport sink or synthetic sentinel traversal) without full GUI/end-to-end integration.
- **Source-Inspected:** Verified through static source code analysis, AST parsing, or workflow file inspection.
- **Pending:** Deferred to subsequent hardening phases (e.g. cross-platform Linux Secret Service validation).

| Finding ID | Priority | Classification | Characterization & Reproduction Evidence |
|---|---|---|---|
| **SEC-01** | P0 / High | **Implementation-Executed** (URL bypasses & service/IPC credential routing) / **Source-Inspected** (GUI OAuth dance) | • `normalizePortalUrl` allows HTTP bypass when `localhost` is a subdomain (`http://localhost.attacker.invalid`), when `127.0.0.1` is in query/path, and on uppercase `HTTP://` (*Implementation-Executed*).<br>• `LauncherAuth.verifySession` routes bearer token to caller-supplied `portalUrl` override at transport sink (*Implementation-Executed*).<br>• `LauncherAuth.refreshSession` routes refresh token & bearer credentials to caller-supplied `portalUrl` override at transport sink (*Implementation-Executed*).<br>• Production `auth:verify` and `auth:refresh` IPC handlers forward caller-supplied overrides to transport sink (*Implementation-Executed*).<br>• Renderer GUI PKCE initiation exposing `portalUrl` to arbitrary remote browser navigations (*Source-Inspected* in `src/main.ts` & `src/auth.ts`). |
| **SEC-02** | P0 / High | **Implementation-Executed** (Production `utils:openPath` & `config:set` handlers) / **Source-Inspected** (Renderer mod catalog sink) | • Production `utils:openPath` handler passes non-HTTP paths to `shell.openPath` via registration harness (*Implementation-Executed*).<br>• Production `utils:openPath` handler passes HTTP(S) paths to `shell.openExternal` via registration harness (*Implementation-Executed*).<br>• Production `config:set` handler permits unvalidated arbitrary fields (`javaPath`, `javaArgs`) into configuration (*Implementation-Executed*).<br>• Complete registration harness confirms exactly 35 `ipcMain.handle` and 1 `ipcMain.on` channels (*Implementation-Executed*).<br>• Renderer mod catalog `sourceUrl` clicks invoking `utils.openPath` without scheme check (*Source-Inspected* in `ui/src/views/mods-view.ts:144`). |
| **SEC-03** | P1 / High | **Implementation-Executed** (Plaintext disk persistence) / **Source-Inspected** (Keyring absence) | • `ConfigManager.set` / `ConfigManager.save` writes `token`, `refreshToken`, and `minecraftAccessToken` in unencrypted cleartext JSON to `userData/config.json` (*Implementation-Executed*).<br>• Absence of Electron `safeStorage` or OS keyring integration (*Source-Inspected* in `src/config.ts`). |
| **SEC-04** | P0 / High | **Implementation-Executed** (Dot-alias, Windows casing, `.lampas` reservation) / **Component Reproduction** (Obsolete deletion traversal) | • `isSafeRelativePath` normalizes `..` while `isPathProtected` does not, allowing `mods/../saves/world-data.txt` to pass containment but evade protection (*Implementation-Executed*).<br>• `isPathProtected` fails on Windows case variants `Saves/level.dat`, `SAVES/level.dat`, `Screenshots/1.png` (*Implementation-Executed*).<br>• Internal state directory `.lampas/` is unreserved and unprotected from pack manifests (*Implementation-Executed*).<br>• `sync.ts` obsolete deletion loop unlinks unvalidated relative keys in `prevState.files` that resolve outside `gameDir` (*Component Reproduction* via sentinel file traversal). |
| **SEC-05** | P1 / Med-High | **Implementation-Executed** | • `GameDirectoryManager.recoverInterruptedMove()` recursively deletes arbitrary unvalidated filesystem paths specified in `journal.staging` during the `"preparing"` phase (*Implementation-Executed* against outside victim directory). |
| **SEC-06** | P1 / High-Cond | **Implementation-Executed** (Sidecar 404 & missing hash) / **Source-Inspected** (Java version probe) | • `FabricMetaResolver` omits checksums when Maven `.sha256` / `.sha1` sidecars return 404 (*Implementation-Executed* via mock fetch).<br>• `downloadVerified` downloads and writes unverified payloads when `expectedHash` is undefined (*Implementation-Executed* via loopback HTTP server).<br>• `checkJavaVersion` runs `child_process.execFile` (`-version`) on local Java executables before full repair verifies checksums (*Source-Inspected* in `src/java-runtime.ts:86-98`). |
| **SEC-07** | P1 / High-Cond | **Source-Inspected** | • `syncClient` wraps channel, release, and client manifest retrieval in broad `try/catch` blocks that catch HTTP 410 ("REVOKED") and fall back to local disk manifests without status code discrimination (*Source-Inspected* in `src/sync.ts:270-305`). |
| **SEC-08** | P1 / Medium | **Source-Inspected** | • In `src/auth.ts`, any unauthenticated stray HTTP request to the loopback callback server terminates the server and fails the login.<br>• Unrecognized callback paths leave the browser connection hanging.<br>• 3-minute safety timeout is not cancelled on successful OAuth exchange.<br>• Browser displays success HTML before token exchange completes.<br>• Logout does not increment session epoch or cancel pending auth requests (*Source-Inspected* in `src/auth.ts:32-154`). |
| **SEC-09** | P1 / Medium | **Implementation-Executed** | • `LauncherLoggerService.sanitize` redacts camelCase tokens but leaves underscore fields (`refresh_token`, `access_token`) intact (*Implementation-Executed*).<br>• `LauncherLoggerService.sanitize` does not redact OAuth authorization codes in URL query strings (*Implementation-Executed*).<br>• `LauncherLoggerService.sanitize` does not redact CLI command arguments like `--accessToken` (*Implementation-Executed*).<br>• `ProcessLogFramer` truncates lines before sanitization, breaking JSON quoting and leaking split token secrets (*Implementation-Executed*). |
| **SEC-10** | P2 / Med-Priv | **Source-Inspected** | • `ui/src/views/auth-view.ts` automatically contacts third-party `mc-heads.net` with player UUID without user consent (*Source-Inspected* in `ui/src/views/auth-view.ts:124`).<br>• Mod catalog icons render unvalidated third-party image URLs directly (*Source-Inspected* in `ui/src/views/mods-view.ts`). |
| **SEC-11** | P2 / Medium | **Source-Inspected** | • `asyncUnzip` in `ensureNatives` expands entire zip archives into memory buffers without decompression size budgets or entry count limits (*Source-Inspected* in `src/minecraft-bootstrap.ts:145-165`).<br>• Provisioning uses uncoordinated `Promise.all` without concurrency throttling (*Source-Inspected* in `src/minecraft-bootstrap.ts` & `src/sync.ts`). |
| **SEC-12** | P2 / Medium | **Source-Inspected** | • `.github/workflows/release-pack.yml` assigns global `contents: write` permissions across all jobs.<br>• External actions (`actions/checkout@v4`, `softprops/action-gh-release@v2`) are pinned to mutable tags rather than immutable commit SHAs.<br>• CI workflow lacks pre-release gate validation (*Source-Inspected* in `.github/workflows/release-pack.yml`). |

---

### 5. Comprehensive Inbound IPC Channel Inventory

Every IPC channel registered in `src/main.ts` was audited directly from source code and verified through the Electron registration harness:
- **Total Registered Channels:** **36** (35 `ipcMain.handle` + 1 `ipcMain.on`)
- **Sender ID Validation:** Only **1 channel** (`game:logAck`) checks sender process ID (`event.sender.id !== targetId`).
- **Frame / Document Validation:** **Zero channels (0/36)** validate the top-level frame origin, `frame.url`, webContents loading state, or document navigation.

| # | IPC Channel | Registration Type | Line | Sender ID Check | Frame / Doc Validation | Expected Payload | Side Effects in Main Process | Returned DTO |
|---|---|---|---|---|---|---|---|---|
| 1 | `auth:login` | `handle` | 88 | None | None | `portalUrl?: string` | Launches OS browser to OAuth URL; binds loopback HTTP server; exchanges PKCE code; persists plaintext tokens to `config.json` | `UserProfile` |
| 2 | `auth:logout` | `handle` | 96 | None | None | None | Clears in-memory auth state; removes tokens from `config.json` | `void` |
| 3 | `auth:verify` | `handle` | 101 | None | None | `portalUrl?: string` | Issues POST with stored bearer token to caller-specified endpoint | `UserProfile \| null` |
| 4 | `auth:refresh` | `handle` | 106 | None | None | `portalUrl?: string` | Issues POST with refresh token & bearer header to caller-specified endpoint; persists new tokens | `UserProfile \| null` |
| 5 | `server:getStatus` | `handle` | 111 | None | None | None | Issues HTTP query to Portal server status endpoint via `ServerStatusClient` | `ServerStatus` |
| 6 | `sync:start` | `handle` | 116 | None | None | None | Executes standard sync pipeline via `OperationCoordinator`; downloads blobs; updates `installation.json` | `SyncResult` |
| 7 | `sync:repair` | `handle` | 125 | None | None | None | Executes full hash audit and redownload via `OperationCoordinator` | `SyncResult` |
| 8 | `sync:getModCatalog` | `handle` | 134 | None | None | None | Reads mod catalog from Portal endpoint or cached release | `ModCatalogItem[]` |
| 9 | `sync:getInstalledRuntime` | `handle` | 139 | None | None | None | Reads local `.lampas/release.json` and `.lampas/installation.json` | `InstalledRuntimeDto \| null` |
| 10 | `mods:browseAndAdd` | `handle` | 144 | None | None | None | Opens native open-file dialog; copies selected `.jar` files into `gameDir/mods/` | `ClientModState[]` |
| 11 | `mods:addPaths` | `handle` | 155 | None | None | `filePaths: string[]` | Copies arbitrary filesystem paths into `gameDir/mods/` | `ClientModState[]` |
| 12 | `mods:setOfficialEnabled` | `handle` | 160 | None | None | `modId: string, enabled: boolean` | Updates `disabledClientMods` array in `config.json` | `ClientModState[]` |
| 13 | `mods:setCustomEnabled` | `handle` | 165 | None | None | `filename: string, enabled: boolean` | Renames file between `.jar` and `.jar.disabled` on disk | `ClientModState[]` |
| 14 | `mods:removeCustom` | `handle` | 170 | None | None | `filename: string` | Deletes file from `gameDir/mods/` | `ClientModState[]` |
| 15 | `game:launch` | `handle` | 175 | None | None | `user: UserProfile, releaseOverride?: PackRelease` | Spawns Minecraft Java child process with JVM args (including tokens) via `OperationCoordinator`; attaches log stream | `boolean` |
| 16 | `game:kill` | `handle` | 185 | None | None | None | Sends termination signal / taskkill to running Minecraft child process | `void` |
| 17 | `game:isRunning` | `handle` | 190 | None | None | None | Queries internal running process reference | `boolean` |
| 18 | `gameDir:getStatus` | `handle` | 195 | None | None | None | Queries filesystem existence and checks `.lampas` metadata | `GameDirStatusDto` |
| 19 | `gameDir:browse` | `handle` | 200 | None | None | `defaultPath?: string` | Displays native folder picker dialog | `string \| null` |
| 20 | `gameDir:validate` | `handle` | 209 | None | None | `targetPath: string, currentPath?: string` | Checks directory syntax, drive roots, existence, and filesystem writability | `GameDirValidationResult` |
| 21 | `gameDir:configure` | `handle` | 214 | None | None | `targetPath: string` | Creates target directory; updates `gameDir` and `gameDirConfigured` in `config.json` | `RendererSettingsDto` |
| 22 | `gameDir:move` | `handle` | 231 | None | None | `targetPath: string` | Moves or copies game files; manages migration journals | `DirectoryMoveResult` |
| 23 | `config:get` | `handle` | 249 | None | None | None | Reads configuration from disk/cache; strips authentication tokens | `RendererSettingsDto` |
| 24 | `config:set` | `handle` | 254 | None | None | `newConfig: Partial<SettingsDto>` | Filters out tokens, but permits arbitrary runtime settings (`javaPath`, `javaArgs`) to be written to `config.json` | `RendererSettingsDto` |
| 25 | `window:minimize` | `handle` | 269 | None | None | None | Invokes `mainWindow.minimize()` | `void` |
| 26 | `window:maximize` | `handle` | 273 | None | None | None | Toggles `mainWindow.maximize()` or `unmaximize()` | `void` |
| 27 | `window:close` | `handle` | 281 | None | None | None | Destroys window and terminates application via `app.quit()` | `void` |
| 28 | `window:isMaximized` | `handle` | 288 | None | None | None | Queries `mainWindow.isMaximized()` | `boolean` |
| 29 | `utils:getAppVersion` | `handle` | 292 | None | None | None | Reads `app.getVersion()` | `string` |
| 30 | `utils:openPath` | `handle` | 296 | None | None | `targetPath: string` | If HTTP/HTTPS: calls `shell.openExternal`; Otherwise: calls `shell.openPath` on arbitrary local path | `string` |
| 31 | `utils:getLogPath` | `handle` | 304 | None | None | None | Resolves active `launcher.log` path | `string` |
| 32 | `utils:openLogsDir` | `handle` | 308 | None | None | None | Invokes `shell.openPath` on log directory | `string` |
| 33 | `utils:openLogFile` | `handle` | 312 | None | None | None | Invokes `shell.openPath` on `launcher.log` file | `string` |
| 34 | `utils:getMinecraftLogPath` | `handle` | 316 | None | None | None | Resolves `gameDir/logs/latest.log` path | `string` |
| 35 | `utils:openMinecraftLog` | `handle` | 321 | None | None | None | Invokes `shell.openPath` on `logs/latest.log` | `string` |
| 36 | `game:logAck` | `on` | 386 | **Sender ID Checked** | None | `{ batchId: number }` | Validates `event.sender.id === targetId`; advances batch transport; emits next log batch | None (listener) |

---

### 6. Test Suite Architecture & Hardened Isolation

To resolve Bun process-wide module-mock caching and prevent cross-suite contamination, the test harnesses were hardened:

1. **Bun Module-Mock Caching Protection:**
   - Pre-existing suites (`test/bootstrap.test.ts`, `test/game-runner.test.ts`) install persistent `mock.module` entries for `"electron"` and `"../src/auth"`.
   - In Bun, once a module is mocked in a process, subsequent `mock.module` calls cannot add new named exports.
   - `test/security-characterization.test.ts` loads `src/main.ts` and `src/auth.ts` via dedicated isolated runner files in disposable temporary directories with mapped mock harness bindings (`mock-electron-sec-harness`). This preserves genuine production execution while preventing static import failures (`BrowserWindow`, `dialog`, etc.) when running in a single process alongside the full test suite.
2. **Mock Cleanup in Regression Gates:**
   - Unnecessary mocks (`shell`, `dialog`) were excised from `test/security-regression-gates.test.ts`.
   - Empty comment-only test callbacks were converted to explicit `test.todo(...)` specifications.
   - Runnable gates (`test.skip`) make meaningful failing assertions if unskipped against baseline (e.g. establishing synthetic session and asserting absence of plaintext tokens, or testing dot-alias traversal authorization).
3. **Transport Sink & Fixture Isolation:**
   - All network test fixtures bind strictly to loopback (`127.0.0.1`) on ephemeral ports.
   - HTTP servers are actively tracked and forcibly closed in `afterEach` and `afterAll`.
   - `LauncherLogger` file streams and mock windows are safely closed before deleting temporary test directories, preventing Windows file-lock errors (`EBUSY` / `EPERM`).

---

### 7. Review Gate 0.1 Decision & Confirmation

- **Evidence Base Corrected:** Yes. All metrics, tables, test counts, and finding classifications reflect genuine dynamic and source-audited reality.
- **Production Code Drift:** **Zero lines (0 diff)** against baseline commit `3950e155a25c9effc004e2355dffa1722e46a6cc`.
- **Pre-Existing Invariants:** All 261 pre-existing tests pass with zero regressions; full suite passes with 284 passed, 6 skipped, 9 todo, 0 failed.
- **Packaging & Smoke Verification:** Clean build, typecheck, and binary smoke tests confirmed on Windows x64.
- **Next Phase:** Phase 1 (Constrain credential destinations and web-link opening).

**STOPPING AT REVIEW GATE 0.1.** No Phase 1 security fixes have been implemented. Ready for commit and push for review.
