# Lampas Launcher — Security Hardening Progress

## Review Gate 0.1 — Corrected Baseline Characterization, Threat Inventory, and Finding Evidence

- **Execution Date:** 17 September 2026
- **Status:** Complete (Review Gate 0.1 reached; Phase 0.1 evidence-and-test correction pass amended; stopped before Phase 1)
- **Assessed Baseline Commit:** `3950e155a25c9effc004e2355dffa1722e46a6cc`
- **Reviewed Commit Target:** `224c697bb140ff619d7efbe68a042e6adc81598e` (prior review checkpoint: `8089c691d38513d804b0fabc7ebaee22685d6a3f`)
- **Current Branch:** `feat/security`
- **Production Code Drift:** **Zero diff (`0 lines`)** against baseline commit `3950e155a25c9effc004e2355dffa1722e46a6cc` and reviewed commit `224c697bb140ff619d7efbe68a042e6adc81598e` across all production paths (`src/`, `ui/`). All modifications are strictly restricted to security characterization tests, regression gate specifications, test typing configs, and progress documentation.

---

### 1. Code Drift, Commit Hierarchy & Baseline Verification

A rigorous comparison was conducted distinguishing the starting baseline, previous review checkpoints, and the amended working tree:

| Dimension | Assessed Baseline (`3950e15`) | Reviewed Target (`224c697`) | Current Working Tree (`HEAD`) | Drift Evaluation |
|---|---|---|---|---|
| **Production Code (`src/`, `ui/`)** | Pristine baseline | Pristine baseline | Pristine baseline | **0 lines modified (zero drift)** |
| **Dependencies (`bun.lock`, `package.json`)** | Pinned | Pinned (identical) | Pinned (identical) | **Byte-identical lockfile & package versions** |
| **Lockfile SHA-256** | `51834981...E4B3A` | `51834981...E4B3A` | `51834981...E4B3A` | **Byte-identical** |
| **Package Version** | `1.3.0` | `1.3.0` | `1.3.0` | **Byte-identical** |
| **Isolated Boundary Harness** | Absent | Flawed in-process module tampering | Dedicated child process (`test/security-boundary-characterization.ts`) | **8/8 passing in child runner** |
| **Characterization Suite** | Absent | 23 tests (in-process) | 16 tests (15 unit/component + 1 child runner test) | **16/16 passing in parent runner** |
| **Regression Gates** | Absent | Nonexistent `save()` call, loose todo | Verified `ConfigManager.set` fixture, honest helper names, 10 `test.todo` | **6 skipped, 10 todo, 0 failed** |
| **Security Test Typecheck** | Absent | Absent | Dedicated `tsconfig.security-test.json` | **0 errors** |

**Ignore Rules & Documentation Tracking:**
Running `git check-ignore -v PLAN.md PROGRESS.md SECURITY_PLAN.md SECURITY_PROGRESS.md docs/` confirms:
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **tracked under git** (not ignored).

---

### 2. Dependency Lifecycle Scripts & Bun Trust Policy Audit

A factual, empirical audit was performed inspecting package lifecycle scripts and Bun trust configurations:

1. **Root `package.json` Lifecycle Scripts:**
   The project root `package.json` defines zero lifecycle hooks (`preinstall`, `install`, `postinstall`, `prepare`).
2. **Built-in Bun Trust Defaults (`bun pm default-trusted`):**
   Inspection via `bun pm default-trusted` demonstrates that Bun ships with a built-in allowlist containing **367 default-trusted packages**. Crucially:
   - `electron-winstaller` is present in `bun pm default-trusted`.
   - `esbuild` is present in `bun pm default-trusted`.
3. **Untrusted Dependencies Check (`bun pm untrusted`):**
   Running `bun pm untrusted` outputs:
   ```text
   Found 0 untrusted dependencies with scripts.
   This means all packages with scripts are in "trustedDependencies" or none of your dependencies have scripts.
   ```
4. **Execution Reality vs. Inferred Assumptions:**
   - It is incorrect to infer that an absent `trustedDependencies` section in `package.json` universally suppresses every lifecycle script in Bun, because packages on the built-in default-trusted list are trusted by default.
   - Running `bun install --frozen-lockfile --verbose` on this Windows x64 host checked 306 installs across 341 packages in 39ms:
     - Architecture and OS mismatches (such as Linux/Darwin binaries and `fsevents`) were appropriately skipped.
     - Zero unexpected script execution or file mutation took place.
     - The lockfile remained completely clean and byte-identical.

---

### 3. Environment & Test Suite Execution Results

All checks were executed on the supported development host (Windows x64):

| Command / Suite | Status | Execution Count & Outcome | Notes |
|---|---|---|---|
| `bun --version` | Passed | `1.4.2` | Matches CI environment pin |
| `node --version` | Passed | `v24.9.0` | Host Node.js |
| `bun install --frozen-lockfile` | Passed | 306 installs checked in `39ms` | Zero lockfile mutation; clean lockfile |
| `bun run typecheck` | Passed | 0 errors | Main & renderer production typecheck |
| `bun x tsc -p tsconfig.security-test.json --noEmit` | Passed | 0 errors | Dedicated strict security-test typecheck |
| `bun run build` | Passed | 12 modules transformed in `287ms` | Clean Vite production build |
| `bun run smoke` | Reference | 7/7 checks passed | Validated at commit `8089c691d38513d804b0fabc7ebaee22685d6a3f` |
| `bun run benchmark` | Reference | 5/5 scenarios passed | Warm Sync `28.6ms`, Log Storm `104.2ms` (191k lines/s) at commit `8089c691d38513d804b0fabc7ebaee22685d6a3f` |
| **Pre-Existing Test Suite** | Passed | **261 passed, 0 failed** across 32 files | Unchanged; zero regression |
| **Child Boundary Runner (`security-boundary-characterization.ts`)** | Passed | **8 passed, 0 failed** | Clean child process; unchanged `main.ts` & `auth.ts` |
| **Parent Characterization Suite (`security-characterization.test.ts`)** | Passed | **16 passed, 0 failed, 51 expect() calls** | 15 unit/component tests + 1 child runner assertion |
| **Regression Gates (`security-regression-gates.test.ts`)** | Passed | **0 pass, 6 skipped, 10 todo, 0 failed** | Negative credential gate verified separately |
| **Full Combined Suite (`bun test`)** | Passed | **277 passed, 6 skipped, 10 todo, 0 failed** (34 files, `3.70s`) | 1027 total assertions; 0 failures |

**Verification of Negative Credential Gate:**
The Phase 3 regression gate (`[Phase 3 Gate] Persistence: config.json on disk contains no plaintext tokens or credentials`) was executed separately against the baseline implementation to verify its negative behavior:
- Setup writes synthetic credentials using the real baseline API: `ConfigManager.set({ token: "syn-test-bearer-token-12345", ... })`.
- Fixture setup succeeds and confirms written token matches synthetic input.
- The failure occurs precisely at the plaintext-disclosure assertion:
  ```text
  expect(received).not.toContain(expected)
  Expected to not contain: "syn-test-bearer-token-12345"
  Received: "{\n  \"portalUrl\": \"https://dev.lampas.town\",\n ... \"token\": \"syn-test-bearer-token-12345\" ... }"
  ```
- No import errors, missing method errors (`save`), or `TypeError`s occur.

---

### 4. Granular Finding Reproduction & Evidence Classification (SEC-01 to SEC-12)

Every finding and architectural subclaim is classified under four strict categories:
- **Implementation-Executed:** Dynamically asserted against live production classes, methods, or IPC handlers in test executions.
- **Component / Partial Reproduction:** Exercised at component level (e.g. mock HTTP transport sink or synthetic sentinel traversal) without full GUI/end-to-end integration.
- **Source-Inspected:** Verified through static source code analysis, AST parsing, or workflow file inspection.
- **Pending:** Deferred to subsequent hardening phases (e.g. cross-platform Linux Secret Service validation).

| Finding ID | Priority | Classification | Characterization & Reproduction Evidence |
|---|---|---|---|
| **SEC-01** | P0 / High | **Implementation-Executed** (URL bypasses & service/IPC credential routing) / **Source-Inspected** (GUI OAuth dance) | • `normalizePortalUrl` allows HTTP bypass when `localhost` is a subdomain (`http://localhost.attacker.invalid`), when `127.0.0.1` is in query/path, and on uppercase `HTTP://` (*Implementation-Executed* in `test/security-characterization.test.ts`).<br>• `LauncherAuth.verifySession` routes bearer token to caller-supplied `portalUrl` override at transport sink (*Implementation-Executed* in `test/security-boundary-characterization.ts`).<br>• `LauncherAuth.refreshSession` routes refresh token & bearer credentials to caller-supplied `portalUrl` override at transport sink (*Implementation-Executed* in `test/security-boundary-characterization.ts`).<br>• Production `auth:verify` and `auth:refresh` IPC handlers forward caller-supplied overrides to transport sink (*Implementation-Executed* in `test/security-boundary-characterization.ts`).<br>• Renderer GUI PKCE initiation exposing `portalUrl` to arbitrary remote browser navigations (*Source-Inspected* in `src/main.ts` & `src/auth.ts`). |
| **SEC-02** | P0 / High | **Implementation-Executed** (Production `utils:openPath` & `config:set` handlers) / **Source-Inspected** (Renderer mod catalog sink) | • Production `utils:openPath` handler passes non-HTTP paths to `shell.openPath` via registration harness (*Implementation-Executed* in `test/security-boundary-characterization.ts`).<br>• Production `utils:openPath` handler passes HTTP(S) paths to `shell.openExternal` via registration harness (*Implementation-Executed* in `test/security-boundary-characterization.ts`).<br>• Production `config:set` handler permits unvalidated arbitrary fields (`javaPath`, `javaArgs`) into configuration (*Implementation-Executed* in `test/security-boundary-characterization.ts`).<br>• Complete registration harness confirms exactly 35 `ipcMain.handle` and 1 `ipcMain.on` channels (*Implementation-Executed* in `test/security-boundary-characterization.ts`).<br>• Renderer mod catalog `sourceUrl` clicks invoking `utils.openPath` without scheme check (*Source-Inspected* in `ui/src/views/mods-view.ts:144`). |
| **SEC-03** | P1 / High | **Implementation-Executed** (Plaintext disk persistence) / **Source-Inspected** (Keyring absence) | • `ConfigManager.set` writes `token`, `refreshToken`, and `minecraftAccessToken` in unencrypted cleartext JSON to `userData/config.json` (*Implementation-Executed* in `test/security-characterization.test.ts`).<br>• Absence of Electron `safeStorage` or OS keyring integration (*Source-Inspected* in `src/config.ts`). |
| **SEC-04** | P0 / High | **Implementation-Executed** (Dot-alias, Windows casing, `.lampas` reservation) / **Component Reproduction** (Obsolete deletion traversal) | • `isSafeRelativePath` normalizes `..` while `isPathProtected` does not, allowing `mods/../saves/world-data.txt` to pass containment but evade protection (*Implementation-Executed* in `test/security-characterization.test.ts`).<br>• `isPathProtected` fails on Windows case variants `Saves/level.dat`, `SAVES/level.dat`, `Screenshots/1.png` (*Implementation-Executed* in `test/security-characterization.test.ts`).<br>• Internal state directory `.lampas/` is unreserved and unprotected from pack manifests (*Implementation-Executed* in `test/security-characterization.test.ts`).<br>• `sync.ts` obsolete deletion loop unlinks unvalidated relative keys in `prevState.files` that resolve outside `gameDir` (*Component Reproduction* via sentinel file traversal in `test/security-characterization.test.ts`). |
| **SEC-05** | P1 / Med-High | **Implementation-Executed** | • `GameDirectoryManager.recoverInterruptedMove()` recursively deletes arbitrary unvalidated filesystem paths specified in `journal.staging` during the `"preparing"` phase (*Implementation-Executed* against outside victim directory in `test/security-characterization.test.ts`). |
| **SEC-06** | P1 / High-Cond | **Implementation-Executed** (Sidecar 404 & missing hash) / **Source-Inspected** (Java version probe) | • `FabricMetaResolver` omits checksums when Maven `.sha256` / `.sha1` sidecars return 404 (*Implementation-Executed* via mock fetch in `test/security-characterization.test.ts`).<br>• `downloadVerified` downloads and writes unverified payloads when `expectedHash` is undefined (*Implementation-Executed* via loopback HTTP server in `test/security-characterization.test.ts`).<br>• `checkJavaVersion` runs `child_process.execFile` (`-version`) on local Java executables before full repair verifies checksums (*Source-Inspected* in `src/java-runtime.ts:86-98`). |
| **SEC-07** | P1 / High-Cond | **Source-Inspected** | • `syncClient` wraps channel, release, and client manifest retrieval in broad `try/catch` blocks that catch HTTP 410 ("REVOKED") and fall back to local disk manifests without status code discrimination (*Source-Inspected* in `src/sync.ts:270-305`). |
| **SEC-08** | P1 / Medium | **Source-Inspected** | • In `src/auth.ts`, any unauthenticated stray HTTP request to the loopback callback server terminates the server and fails the login.<br>• Unrecognized callback paths leave the browser connection hanging.<br>• 3-minute safety timeout is not cancelled on successful OAuth exchange.<br>• Browser displays success HTML before token exchange completes.<br>• Logout does not increment session epoch or cancel pending auth requests (*Source-Inspected* in `src/auth.ts:32-154`). |
| **SEC-09** | P1 / Medium | **Implementation-Executed** | • `LauncherLoggerService.sanitize` redacts camelCase tokens but leaves underscore fields (`refresh_token`, `access_token`) intact (*Implementation-Executed* in `test/security-characterization.test.ts`).<br>• `LauncherLoggerService.sanitize` does not redact OAuth authorization codes in URL query strings (*Implementation-Executed* in `test/security-characterization.test.ts`).<br>• `LauncherLoggerService.sanitize` does not redact CLI command arguments like `--accessToken` (*Implementation-Executed* in `test/security-characterization.test.ts`).<br>• `ProcessLogFramer` truncates lines before sanitization, breaking JSON quoting and leaking split token secrets (*Implementation-Executed* in `test/security-characterization.test.ts`). |
| **SEC-10** | P2 / Med-Priv | **Source-Inspected** | • `ui/src/views/auth-view.ts` automatically contacts third-party `mc-heads.net` with player UUID without user consent (*Source-Inspected* in `ui/src/views/auth-view.ts:124`).<br>• Mod catalog icons render unvalidated third-party image URLs directly (*Source-Inspected* in `ui/src/views/mods-view.ts`). |
| **SEC-11** | P2 / Medium | **Source-Inspected** | • Worker concurrency is **already bounded** in the reviewed codebase via `runBoundedPool` (`src/async-pool.ts`), which enforces concurrency limits and cooperative abort handling across file downloads and verification.<br>• However, **decompression ingestion budgets** remain unconstrained: `asyncUnzip` in `ensureNatives` expands entire zip archives into memory buffers without entry count or uncompressed byte size limits (*Source-Inspected* in `src/minecraft-bootstrap.ts:145-165`).<br>• Cancellation quiescence: individual long-running stream transfers and child processes require explicit abort propagation to ensure graceful quiescence upon operation cancellation. |
| **SEC-12** | P2 / Medium | **Source-Inspected** | • `.github/workflows/release-pack.yml` assigns global `contents: write` permissions across all jobs.<br>• External actions (`actions/checkout@v4`, `softprops/action-gh-release@v2`) are pinned to mutable tags rather than immutable commit SHAs.<br>• CI workflow lacks pre-release gate validation (*Source-Inspected* in `.github/workflows/release-pack.yml`). |

---

### 5. Comprehensive Inbound IPC Channel Inventory

Every IPC channel registered in `src/main.ts` was audited directly against the reviewed source code and verified through the isolated Electron registration harness:
- **Total Registered Channels:** **36** (35 `ipcMain.handle` + 1 `ipcMain.on`)
- **Sender ID Validation:** Only **1 channel** (`game:logAck` on line 125) checks sender process ID (`event.sender.id !== targetId`).
- **Frame / Document Validation:** **Zero channels (0/36)** validate the top-level frame origin, `frame.url`, webContents loading state, or document navigation.

| # | IPC Channel | Registration Type | Line | Sender ID Check | Frame / Doc Validation | Expected Payload | Side Effects in Main Process | Actual Returned Shape (Main vs Preload) |
|---|---|---|---|---|---|---|---|---|
| 1 | `game:logAck` | `on` | 125 | **Sender ID Checked** | None | `{ batchId?: number }` | Validates `event.sender.id === targetId`; advances log batch transport | None (event listener) |
| 2 | `window:minimize` | `handle` | 139 | None | None | None | Invokes `mainWindow.minimize()` | `void` (matches preload `Promise<void>`) |
| 3 | `window:maximize` | `handle` | 140 | None | None | None | Toggles `mainWindow.maximize()` or `unmaximize()` | `void` (matches preload `Promise<void>`) |
| 4 | `window:isMaximized` | `handle` | 147 | None | None | None | Queries `mainWindow.isMaximized()` | `boolean` (matches preload `Promise<boolean>`) |
| 5 | `window:close` | `handle` | 148 | None | None | None | Destroys window and terminates application | `void` (matches preload `Promise<void>`) |
| 6 | `utils:getAppVersion` | `handle` | 151 | None | None | None | Reads `app.getVersion()` | `string` (matches preload `Promise<string>`) |
| 7 | `utils:openPath` | `handle` | 152 | None | None | `targetPath: string` | If HTTP/HTTPS: calls `shell.openExternal`; Otherwise: calls `shell.openPath` | **Divergence:** Main returns `undefined` (`void`), preload declares `Promise<string>` |
| 8 | `utils:getLogPath` | `handle` | 158 | None | None | None | Resolves active `launcher.log` path | `string` (matches preload `Promise<string>`) |
| 9 | `utils:openLogsDir` | `handle` | 159 | None | None | None | Calls `shell.openPath(logsDir)` | `string` (matches preload `Promise<string>`) |
| 10 | `utils:openLogFile` | `handle` | 164 | None | None | None | Calls `shell.openPath(logPath)` | `string` (matches preload `Promise<string>`) |
| 11 | `utils:getMinecraftLogPath` | `handle` | 169 | None | None | None | Resolves `gameDir/logs/latest.log` path | `string` (matches preload `Promise<string>`) |
| 12 | `utils:openMinecraftLog` | `handle` | 173 | None | None | None | Calls `shell.openPath(latestLog)` | `string` (matches preload `Promise<string>`) |
| 13 | `config:get` | `handle` | 184 | None | None | None | Reads configuration from disk/cache; strips tokens | `RendererSettingsDto` (matches preload) |
| 14 | `config:set` | `handle` | 185 | None | None | `newConfig: Partial<SettingsDto>` | Filters out tokens, but permits arbitrary runtime settings (`javaPath`, `javaArgs`) | `RendererSettingsDto` (matches preload) |
| 15 | `gameDir:getStatus` | `handle` | 198 | None | None | None | Queries filesystem existence and checks `.lampas` metadata | `GameDirStatusDto` (matches preload) |
| 16 | `gameDir:browse` | `handle` | 199 | None | None | `defaultPath?: string` | Displays native folder picker dialog | **Returned Shape:** `{ canceled: boolean; filePaths: string[] }` (matches preload) |
| 17 | `gameDir:validate` | `handle` | 207 | None | None | `targetPath: string, currentPath?: string` | Checks directory syntax, drive roots, existence, writability | `GameDirValidationResult` (matches preload) |
| 18 | `gameDir:configure` | `handle` | 209 | None | None | `targetPath: string` | Creates target directory; updates `gameDir` and `gameDirConfigured` in `config.json` | `RendererSettingsDto` (matches preload) |
| 19 | `gameDir:move` | `handle` | 214 | None | None | `targetPath: string` | Moves or copies game files; manages migration journals | `DirectoryMoveResult` (matches preload) |
| 20 | `auth:login` | `handle` | 232 | None | None | `portalUrl?: string` | Launches OS browser; binds loopback HTTP server; exchanges PKCE; writes tokens | `{ user: RendererUserProfile }` (matches preload) |
| 21 | `auth:logout` | `handle` | 236 | None | None | None | Clears auth state and config tokens | `void` (matches preload `Promise<void>`) |
| 22 | `auth:verify` | `handle` | 237 | None | None | `portalUrl?: string` | Issues POST with stored bearer token to caller-specified endpoint | **Returned Shape:** `{ valid: boolean; user?: RendererUserProfile }` (matches preload) |
| 23 | `auth:refresh` | `handle` | 241 | None | None | `portalUrl?: string` | Issues POST with refresh token & bearer header to caller-specified endpoint; persists new tokens | **Returned Shape:** `{ valid: boolean; user?: RendererUserProfile }` (matches preload) |
| 24 | `server:getStatus` | `handle` | 247 | None | None | None | Issues HTTP query to Portal server status endpoint via `ServerStatusClient` | `ServerStatus` (matches preload) |
| 25 | `sync:start` | `handle` | 250 | None | None | None | Executes standard sync pipeline via `OperationCoordinator` | `SyncResult` (matches preload) |
| 26 | `sync:repair` | `handle` | 269 | None | None | None | Executes full hash audit and redownload via `OperationCoordinator` | `SyncResult` (matches preload) |
| 27 | `sync:getModCatalog` | `handle` | 289 | None | None | None | Reads mod catalog from Portal endpoint or cached release | `ModCatalogItem[]` (matches preload) |
| 28 | `sync:getInstalledRuntime` | `handle` | 290 | None | None | None | Reads local `.lampas/release.json` and `.lampas/installation.json` | `InstalledRuntimeDto \| null` (matches preload) |
| 29 | `mods:browseAndAdd` | `handle` | 325 | None | None | None | Opens native open-file dialog; copies selected `.jar` files into `gameDir/mods/` | `ClientModState[]` (matches preload) |
| 30 | `mods:addPaths` | `handle` | 334 | None | None | `paths: string[]` | Copies arbitrary filesystem paths into `gameDir/mods/` | `ClientModState[]` (matches preload) |
| 31 | `mods:setOfficialEnabled` | `handle` | 338 | None | None | `id: string, enabled: boolean` | Updates `disabledClientMods` array in `config.json` | **Divergence:** Main returns `string[]` (disabled mod IDs), preload declares `Promise<void>` |
| 32 | `mods:setCustomEnabled` | `handle` | 342 | None | None | `filename: string, enabled: boolean` | Renames file between `.jar` and `.jar.disabled` on disk | `ClientModState[]` (matches preload) |
| 33 | `mods:removeCustom` | `handle` | 346 | None | None | `filename: string` | Deletes file from `gameDir/mods/` | `ClientModState[]` (matches preload) |
| 34 | `game:launch` | `handle` | 352 | None | None | `user: UserProfile \| null, releaseOverride?: any` | Spawns Minecraft child process via `OperationCoordinator` | `boolean` (matches preload `Promise<boolean>`) |
| 35 | `game:kill` | `handle` | 373 | None | None | None | Terminates running Minecraft child process | `void` (matches preload `Promise<void>`) |
| 36 | `game:isRunning` | `handle` | 377 | None | None | None | Queries internal running process reference | `boolean` (matches preload `Promise<boolean>`) |

---

### 6. Test Suite Architecture & Hardened Isolation

To resolve Bun process-wide module-mock caching and prevent cross-suite contamination, the security verification architecture was restructured into clean isolation tiers:

1. **Child-Process Boundary Characterization (`test/security-boundary-characterization.ts`):**
   - Executes in a dedicated child process spawned by Bun.
   - Loads production `src/main.ts` and `src/auth.ts` **completely unmodified** without string replacement or file copying.
   - Registers a comprehensive Electron mock prior to import, providing `app`, `BrowserWindow`, `dialog.showOpenDialog`, `shell.openPath`, `shell.openExternal`, and `ipcMain`.
   - Uses deterministic readiness polling (waiting until all 35 handles and 1 listener are registered) rather than fixed sleep intervals.
   - Completely isolates global module mocks so pre-existing test files (`bootstrap.test.ts`, `game-runner.test.ts`) cannot poison `electron` or `../src/auth` exports.
   - Safe OS opener sinks: `shell.openPath` and `shell.openExternal` are mocked so boundary tests never launch applications or spawn host processes.
2. **Explicitly Owned Network & Process Fixtures:**
   - Loopback HTTP fixtures bind strictly to `127.0.0.1` on ephemeral port `0`.
   - Requests are verified with exact assertions (exact count, method, URL path, authorization headers, and request body contents).
   - Servers and file streams are explicitly closed in `finally` blocks before cleaning up disposable test directories, eliminating Windows file-locking errors (`EBUSY` / `EPERM`).
3. **Honest Regression Gates & Strict Typing (`test/security-regression-gates.test.ts`):**
   - Helper-level tests are accurately labeled as path/URL/redaction helpers rather than false mutation authorization tests.
   - Operation-level security controls (e.g. client sync pipeline blocking mutations, move recovery staging validation, session epoch revocation) are preserved as explicit `test.todo` specifications rather than weakened tests.
   - Test-only type validation is enforced via `tsconfig.security-test.json` and `test/security-test.d.ts`.

---

### 7. Review Gate 0.1 Decision & Confirmation

- **Evidence Base Corrected & Verified:** Yes. All metrics, IPC line numbers, return shapes, finding classifications, and Bun trust behaviors reflect verified empirical facts.
- **Production Code Drift:** **Zero lines (0 diff)** against baseline commit `3950e155a25c9effc004e2355dffa1722e46a6cc` and reviewed commit `224c697bb140ff619d7efbe68a042e6adc81598e`.
- **Pre-Existing Invariants:** All 261 pre-existing tests pass with zero regressions; full combined suite passes with 277 passed, 6 skipped, 10 todo, 0 failed.
- **Packaging & Build Verification:** Production TypeScript compilation (`bun run typecheck`), security test typecheck (`tsconfig.security-test.json`), and production Vite packaging (`bun run build`) all pass with 0 errors.
- **Negative Fixture Verified:** Verified separately that the credential gate fails strictly at the plaintext disclosure assertion without runtime errors or setup failures.
- **Next Phase:** Phase 1 (Constrain credential destinations and web-link opening).

**STOPPING AT REVIEW GATE 0.1.** No Phase 1 security fixes have been implemented. Ready for commit and push for review.
