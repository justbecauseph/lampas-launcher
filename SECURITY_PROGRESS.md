# Lampas Launcher — Security Hardening Progress

## Review Gate 0 — Baseline Characterization, Threat Inventory, and Finding Reproductions

- **Execution Date:** 16 September 2026
- **Status:** Complete (Review Gate 0 reached; stopped before Phase 1)
- **Assessed Baseline Commit:** `3950e155a25c9effc004e2355dffa1722e46a6cc`
- **Current HEAD:** `3950e155a25c9effc004e2355dffa1722e46a6cc`
- **Branch:** `feat/security`
- **Working Tree State:** Clean; baseline test suite and fixtures passing; packaging validated.

---

### 1. Code Drift & Baseline Comparison

A bit-for-bit comparison was performed between the current checkout and the assessed baseline commit `3950e155a25c9effc004e2355dffa1722e46a6cc`:

| Metric | Assessed Baseline | Current Checkout | Drift |
|---|---|---|---|
| Commit SHA | `3950e155a25c9effc004e2355dffa1722e46a6cc` | `3950e155a25c9effc004e2355dffa1722e46a6cc` | **None (0 commits)** |
| `git diff <baseline> HEAD` | — | Empty (no diff) | **None (0 lines)** |
| Lockfile (`bun.lock`) SHA-256 | `51834981EAA1925B2234E14295E5B733BDEBC72697E575EFB2046479821E4B3A` | `51834981EAA1925B2234E14295E5B733BDEBC72697E575EFB2046479821E4B3A` | **Byte-identical** |
| Lockfile Git Blob SHA | `540abf99f9323d25b8856fe88e611c887c0fa726` | `540abf99f9323d25b8856fe88e611c887c0fa726` | **Identical** |
| Package Version | `1.3.0` | `1.3.0` | **Identical** |

**Ignore Rules & Tracking Assessment:**
`git check-ignore -v PLAN.md PROGRESS.md SECURITY_PLAN.md SECURITY_PROGRESS.md docs/` confirms:
- `PLAN.md` is ignored by `.gitignore:6:PLAN.md`
- `PROGRESS.md` is ignored by `.gitignore:7:PROGRESS.md`
- `docs/` is ignored by `.gitignore:4:docs/`
- `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md` are **not ignored** and are tracked under git.

---

### 2. Environment & Command Execution Results

The repository commands were executed on the supported development environment (Windows x64):

| Command | Status | Exact Outcome / Metrics |
|---|---|---|
| `bun --version` | Passed | `1.4.2` (exact match with CI pin) |
| `node --version` | Passed | `v24.9.0` (Electron bundled Node: `24.18.1`) |
| `bun install --frozen-lockfile` | Passed | 15 packages installed cleanly in `1.62s` (0 script side effects) |
| `bun run typecheck` | Passed | `tsc --noEmit && tsc -p tsconfig.renderer.json --noEmit` exited `0` |
| `bun run build` | Passed | `tsc && vite build` built renderer bundle in `140ms` (12 modules transformed) |
| `bun run test` | Passed | **279 passed**, **14 skipped** (target security gates), **0 failed** across 34 files in `3.31s` |
| `bun run smoke` | Passed | **7/7 passed**: main/preload JS, renderer bundle, fonts/license, font CDN isolation, unpacked Electron execution, packaged ASAR execution (`3.07 MB`), publishing safety |
| `bun run benchmark` | Passed | All 5 scenarios benchmarked: Warm Sync `28.61ms`, Full Repair `34.20ms`, Relocation Rename `7.40ms` / Copy `109.12ms`, Log Storm `104.21ms` (`191,920` lines/s), Mod Search `1.59ms` |
| `bun audit` | Passed | Checked 311 packages; 0 known vulnerabilities found |

**Package Lifecycle Scripts Audit:**
Inspected `package.json` scripts: no `preinstall`, `install`, `postinstall`, or `prepare` scripts exist. Running `bun install --frozen-lockfile` executes no untrusted code.

---

### 3. Finding-by-Finding Reproduction & Characterization (SEC-01 to SEC-12)

All twelve assessment findings were analyzed, characterized, and reproduced against the baseline code:

| Finding ID | Priority | Description | Reproduction Status | Concrete Source Evidence & Root Cause |
|---|---|---|---|---|
| **SEC-01** | P0 / High | Credential destination controlled by caller | **Reproduced** | `preload.ts` exposes `auth.verify(portalUrl?)` and `auth.refresh(portalUrl?)`. `main.ts` forwards `portalUrl`. `normalizePortalUrl()` has 3 confirmed bypasses (`localhost.attacker.invalid`, embedded `127.0.0.1` in query, and uppercase `HTTP://`). |
| **SEC-02** | P0 / High | Privileged IPC & generic OS opening too broad | **Reproduced** | `utils:openPath` calls `shell.openPath(targetPath)` for non-HTTP URLs; mod catalog `sourceUrl` clicks trigger `window.lampas.utils.openPath(mod.sourceUrl)`. All IPC channels except `game:logAck` lack sender validation. `config:set` permits setting `javaPath` and `javaArgs`. |
| **SEC-03** | P1 / High | Credentials persist as plain JSON | **Reproduced** | `ConfigManager.set()` serializes `token`, `refreshToken`, and `minecraftAccessToken` into `userData/config.json` via plaintext `fs.writeFileSync`. |
| **SEC-04** | P0 / High | Paths checked inconsistently across reads/writes/deletions | **Reproduced** | `isSafeRelativePath` normalizes `..` while `isPathProtected` does not, allowing `mods/../saves/world.txt` to bypass protection. Windows case variants (`Saves/`) bypass protection. `.lampas/` is not reserved. `sync.ts` obsolete deletion unlinks unvalidated `prevState.files` paths. |
| **SEC-05** | P1 / Med-High | Recovery journal can authorize unrelated deletions | **Reproduced** | In `GameDirectoryManager.recoverInterruptedMove()`, journal phase `"preparing"` triggers recursive deletion of `journal.staging` with zero validation that `staging` is inside launcher control. |
| **SEC-06** | P1 / High-Cond | Executable integrity checks fail open | **Reproduced** | `FabricMetaResolver.fetchSidecarChecksum` catches 404s and returns `{}`; `validateFabricRuntimeMetadata` accepts missing checksums. `downloadVerified` without `expectedHash` writes files without hash check. `checkJavaVersion` executes `-version` on local Java before full repair verifies hashes. |
| **SEC-07** | P1 / High-Cond | Local fallback swallows REVOKED refusals | **Reproduced** | `syncClient()` wraps channel, release, and manifest retrieval in a broad catch; HTTP 410 ("REVOKED") is swallowed and attempts fallback to `manifest/client-manifest.json`. |
| **SEC-08** | P1 / Medium | Auth lifecycle has races and cancellation gaps | **Reproduced** | Stray callback on loopback listener closes the server and terminates login. Unknown callback paths hang without response. 3-minute timeout is not cleared upon success. Browser renders success page before code exchange. No session epochs on logout. |
| **SEC-09** | P1 / Medium | Logs retain secrets despite redaction | **Reproduced** | `LauncherLoggerService.sanitize` misses underscore fields (`refresh_token`, `access_token`), URL query codes (`?code=...`), and CLI args (`--accessToken`). `ProcessLogFramer` truncates before sanitizing, leaking split-quote token prefixes. |
| **SEC-10** | P2 / Med-Priv | Avatars and images disclose identifiers | **Reproduced** | `ui/src/views/auth-view.ts` automatically requests `mc-heads.net/avatar/<identifier>/64` without consent. Mod catalog icons load arbitrary metadata URLs directly in `<img>` tags. |
| **SEC-11** | P2 / Medium | Ingestion boundaries lack resource budgets | **Reproduced** | `asyncUnzip` in `ensureNatives` expands entire archives into memory with no decompression budget or entry count limit; duplicate native basenames overwrite silently. Provisioning workers use uncoordinated `Promise.all`. |
| **SEC-12** | P2 / Medium | Release workflow has excessive build permissions | **Reproduced** | `.github/workflows/release-pack.yml` grants global `contents: write` to all jobs including build steps; uses unpinned action tags; lacks pre-release CI validation gates. |

---

### 4. Threat & Data-Flow Inventory

#### A. IPC Channels & Sender Policy

All 23 IPC channels exposed across `preload.ts` and registered in `main.ts`:

| IPC Channel | Invocation | Sender Validation | Payload Shape | Main Process Side Effects | Sensitive Output / Response |
|---|---|---|---|---|---|
| `auth:login` | `invoke` | **None** | `portalUrl?: string` | Opens system browser to OAuth URL, spins up loopback HTTP listener on ephemeral port, exchanges token, writes plaintext to config | User profile (name, UUID) |
| `auth:logout` | `invoke` | **None** | None | Clears in-memory and on-disk config credentials | None |
| `auth:verify` | `invoke` | **None** | `portalUrl?: string` | Sends stored bearer token to caller-specified endpoint | User profile |
| `auth:refresh` | `invoke` | **None** | `portalUrl?: string` | Sends stored refresh & bearer token to caller-specified endpoint | User profile |
| `server:getStatus` | `invoke` | **None** | None | Fetches server presence from Portal | Player count, MOTD |
| `sync:start` | `invoke` | **None** | None | Downloads and modifies game files under `gameDir`, updates `installation.json` | SyncResult |
| `sync:repair` | `invoke` | **None** | None | Full SHA-256 verification and re-download of corrupted files | SyncResult |
| `sync:getModCatalog` | `invoke` | **None** | None | Reads mod catalog from Portal or disk | Mod catalog array |
| `sync:getInstalledRuntime` | `invoke` | **None** | None | Reads `.lampas/release.json` and `.lampas/installation.json` | Runtime info |
| `mods:browseAndAdd` | `invoke` | **None** | None | Displays native open file dialog, copies selected JARs to `mods/` | Mod list |
| `mods:addPaths` | `invoke` | **None** | `paths: string[]` | Copies arbitrary file paths to `mods/` | Mod list |
| `mods:setOfficialEnabled` | `invoke` | **None** | `id: string, enabled: boolean` | Updates `disabledClientMods` in config | Updated mod list |
| `mods:setCustomEnabled` | `invoke` | **None** | `filename: string, enabled: boolean` | Renames `.jar` to `.jar.disabled` | Updated mod list |
| `mods:removeCustom` | `invoke` | **None** | `filename: string` | Deletes file from `mods/` directory | Updated mod list |
| `game:launch` | `invoke` | **None** | `user, releaseOverride?` | Spawns Java process with command-line arguments including session tokens | Boolean |
| `game:kill` | `invoke` | **None** | None | Sends SIGKILL / taskkill to running Minecraft child process | None |
| `game:isRunning` | `invoke` | **None** | None | Probes internal process state | Boolean |
| `gameDir:getStatus` | `invoke` | **None** | None | Inspects filesystem existence and `.lampas` metadata | Directory status |
| `gameDir:browse` | `invoke` | **None** | `defaultPath?: string` | Shows native folder selection dialog | Chosen file paths |
| `gameDir:validate` | `invoke` | **None** | `targetPath, currentPath?` | Checks path syntax, drive roots, and directory writability | Validation result |
| `gameDir:configure` | `invoke` | **None** | `targetPath: string` | Creates target directory and sets `gameDir` in config | Settings DTO |
| `gameDir:move` | `invoke` | **None** | `targetPath: string` | Moves or copies entire game directory; creates/cleans journals | Move result |
| `config:get` | `invoke` | **None** | None | Reads `ConfigManager.get()`, filters out tokens | Settings DTO |
| `config:set` | `invoke` | **None** | `newConfig: Partial<SettingsDto>` | Updates configuration; filters 5 keys but accepts `javaPath`, `javaArgs` | Settings DTO |
| `window:*` | `invoke` | **None** | None | Minimizes, maximizes, or closes mainWindow | Window state |
| `utils:getAppVersion` | `invoke` | **None** | None | Reads `app.getVersion()` | Version string |
| `utils:openPath` | `invoke` | **None** | `targetPath: string` | If HTTP: `shell.openExternal`; **Else: `shell.openPath`** | None |
| `utils:getLogPath` | `invoke` | **None** | None | Resolves current log file path | Log file path |
| `utils:openLogsDir` | `invoke` | **None** | None | Opens log directory via `shell.openPath` | Logs directory |
| `utils:openLogFile` | `invoke` | **None** | None | Opens log file via `shell.openPath` | Log file path |
| `utils:getMinecraftLogPath` | `invoke` | **None** | None | Resolves `logs/latest.log` | Log file path |
| `utils:openMinecraftLog` | `invoke` | **None** | None | Opens `logs/latest.log` via `shell.openPath` | Log file path |
| `game:logAck` | `send` | **Validated** | `{ batchId: number }` | Checks `event.sender.id === targetId`; advances batch transport queue | None |

#### B. Sinks & Trust Boundaries

- **`fetch()` Sinks:**
  - `src/auth.ts`: Exchanges PKCE code (`POST ${portalUrl}/api/v1/auth/exchange`); verifies session (`POST ${portalUrl}/api/v1/auth/verify`); refreshes session (`POST ${portalUrl}/api/v1/auth/refresh`).
  - `src/sync.ts`: Fetches channel pointers, releases, client manifests, and blob downloads (`/api/v1/blobs/<sha256>`).
  - `src/fabric-meta.ts`: Fetches loader metadata (`meta.fabricmc.net`) and Maven sidecar checksums (`maven.fabricmc.net`).
  - `src/java-runtime.ts`: Fetches Mojang runtime manifests (`piston-meta.mojang.com`) and individual runtime files.
- **`shell` Opener Sinks:**
  - `src/main.ts` (`utils:openPath`): Generic sink calling `shell.openPath` for any non-HTTP string.
  - `src/auth.ts`: Opens default system browser for OAuth PKCE login.
- **Process Spawning Sinks:**
  - `src/game-runner.ts`: Spawns Java process via `child_process.spawn` with argument array.
  - `src/java-runtime.ts`: Probes Java version via `child_process.execFile(path, ["-version"])`.
- **Filesystem Writes & Deletions:**
  - `src/config.ts`: Serializes `config.json` via `writeAtomicFileSync`.
  - `src/sync.ts`: Writes blobs to cache, copies to destination, unlinks obsolete files in `prevState.files`.
  - `src/game-directory.ts`: Reads/writes `directory-move.json`, performs staged copy, recursively deletes staging on recovery.
  - `src/logger.ts`: Appends log entries to `launcher.log`.
- **Credential Storage:**
  - Plaintext persistence in `userData/config.json`.
- **Cosmetic Disclosures:**
  - `ui/src/views/auth-view.ts`: Automatic avatar fetch from `https://mc-heads.net/avatar/<uuid>/64`.
  - `ui/src/views/mods-view.ts`: Mod icons rendered directly from catalogue metadata.

---

### 5. Test Files Added & Planned Test Locations

#### A. Added in Phase 0

1. [`test/security-characterization.test.ts`](file:///C:/Users/markj/source/repos/lampas-launcher/test/security-characterization.test.ts):
   - 17 executable characterization tests reproducing SEC-01 through SEC-09 baseline behaviors.
   - All 17 tests pass against the baseline code.
2. [`test/security-regression-gates.test.ts`](file:///C:/Users/markj/source/repos/lampas-launcher/test/security-regression-gates.test.ts):
   - 14 regression gate specifications for Phases 1 through 6.
   - Marked `test.skip` during Phase 0 to keep the baseline test suite green.
3. [`SECURITY_PLAN.md`](file:///C:/Users/markj/source/repos/lampas-launcher/SECURITY_PLAN.md):
   - Tracked security hardening plan and assessment documentation.
4. [`SECURITY_PROGRESS.md`](file:///C:/Users/markj/source/repos/lampas-launcher/SECURITY_PROGRESS.md):
   - Tracked Phase 0 review gate and threat inventory artifact.

#### B. Planned Future Phase Test Locations

| Phase | Target Module | Planned Test File | Target Invariants |
|---|---|---|---|
| **Phase 1** | `src/config.ts`, `src/auth.ts`, `src/main.ts` | `test/url-policy.test.ts`, `test/web-sink.test.ts` | Parser-driven HTTPS enforcement, lookalike rejection, removal of renderer destination overrides, web sink path rejection. |
| **Phase 2** | `src/main.ts`, `src/preload.ts`, `ui/` | `test/ipc-isolation.test.ts`, `test/csp-navigation.test.ts` | Sender frame/document validation, schema allowlisting on `config:set`, native user approval for JVM arguments. |
| **Phase 3** | `src/auth.ts`, `src/config.ts`, credential store | `test/credential-store.test.ts`, `test/auth-lifecycle.test.ts` | OS-backed safeStorage, session-only memory fallback, session epochs, race-safe callback server. |
| **Phase 4** | `src/sync.ts`, `src/game-directory.ts` | `test/path-containment.test.ts`, `test/recovery-safety.test.ts` | Canonical dot-alias normalization, Windows case insensitivity, `.lampas` reservation, validated recovery staging. |
| **Phase 5** | `src/fabric-meta.ts`, `src/file-transfer.ts` | `test/integrity-fail-closed.test.ts`, `test/resource-limits.test.ts` | Sidecar 404 fail-closed, required expected hashes for executables, rejection of 410 REVOKED local fallback, unzip budgets. |
| **Phase 6** | `src/logger.ts`, `src/game-log-stream.ts`, `ui/` | `test/log-redaction.test.ts`, `test/privacy-avatar.test.ts` | Redaction of underscore tokens/URL queries/CLI flags, redact-before-truncate in framer, local initials avatar default. |
| **Phase 7** | `.github/workflows/` | CI workflow audit | Least-privilege workflow permissions, pinned action SHAs, exact-tag release gates. |

---

### 6. Documented Unsupported / Pending Checks

The following checks could not be completed on the current environment and remain documented as pending or unverified:

1. **Linux Keyring / Secret Service Acceptance:** Currently executing on a Windows x64 host. Verification of Linux `safeStorage` behavior (`basic_text` vs `libsecret`) is pending native Linux test execution.
2. **Packaged Distribution Installers (`package:win` NSIS / `package:linux` AppImage):** Running full NSIS compressor packages was omitted during Phase 0 baseline to prevent multi-minute builds; `package:dir` verified the complete application bundle, ASAR archive, and binary smoke test.
3. **Cross-Device EXDEV on Physical Partitions:** Executing on a single-volume local system. EXDEV cross-volume copy-and-verify fallback was verified via simulated EXDEV injection in benchmark and characterization tests.
4. **Binary Code Signing & Provenance Attestation:** No external Windows Authenticode certificate is provisioned in the local environment; unsigned binary status is documented.
5. **Dynamic Proxy Network Capture:** Dynamic proxy telemetry audit recorded as pending Phase 6 network verification.

---

### 7. Review Gate 0 Decision & Conclusion

- **Baseline Established:** Yes. The repository builds cleanly, all 279 baseline tests pass, smoke tests pass, and performance benchmarks are recorded.
- **Drift from Baseline Commit:** Zero. HEAD matches `3950e155a25c9effc004e2355dffa1722e46a6cc` exactly.
- **Finding Reproductions:** All 12 findings characterized and confirmed with source references; 17 executable reproduction tests added.
- **Invariants Preserved:** Architecture, lockfile, existing optimization work, and supported platforms intact.
- **Next Phase:** Phase 1 (Constrain credential destinations and web-link opening).

**STOPPING AT REVIEW GATE 0.** No Phase 1 production changes have been applied. Awaiting human review before proceeding.
