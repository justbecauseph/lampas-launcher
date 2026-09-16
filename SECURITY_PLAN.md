# Lampas Launcher — Security Hardening Plan for Agent Execution

**Plan date:** 16 September 2026
**Assessed repository:** `justbecauseph/lampas-launcher`
**Assessment baseline:** `3950e155a25c9effc004e2355dffa1722e46a6cc`
**Application:** `1.3.0`, Windows x64 / Linux x64
**Companion:** `LAMPAS_LAUNCHER_SECURITY_ASSESSMENT.md`
**Execution model:** One phase at a time, with an explicit human review gate after every phase.

## 1. Objective and authorization boundary

Harden the existing launcher against credential redirection, renderer-to-main privilege abuse, unsafe filesystem mutation, integrity downgrade, and avoidable disclosure of player data. Preserve the optimized launcher architecture and existing legitimate workflows.

This document authorizes planning, not immediate repository mutation or release. When instructed to execute it, start at Phase 0. Do not infer authorization for later phases, cross-repository changes, production API calls using real credentials, merging, tagging, signing, or publication. A later phase begins only after its preceding gate is accepted.

The assessment contains confirmed source behaviors and conditional risks, not an assertion of a production compromise. Revalidate findings against the current checkout. Do not claim any issue fixed until a regression test exercises the real implementation, not a copied helper.

## 2. Non-negotiable invariants

Keep Minecraft 26.2, the existing Java 25 policy, manifest-defined Fabric versions, Electron/main/preload separation, the current TypeScript renderer, and the established Windows/Linux packaging targets. Do not introduce a framework rewrite, a new launcher updater, a different authentication provider, or a broad dependency upgrade as part of an unrelated phase.

Keep Portal credentials in main. The launcher is a native public client; do not embed a Microsoft client secret, S3 credential, Portal management secret, or RCON credential. Preserve the external browser, S256 PKCE and loopback callback. Portal-side Microsoft OAuth and launcher-to-Portal PKCE remain separate concerns.

Keep artifact selection and version pinning in the pipeline. Preserve the existing Portal blob contract, including legitimate redirects from `/api/v1/blobs/<sha256>` to object storage. Credential-bearing auth requests and credential-free artifact downloads need different redirect policies. Do not forward Portal credentials to object storage.

Preserve `MANAGED` and `PRESERVE` ownership, explicitly authorized configuration patches (`once`/`enforce`), protected player data, and imported client mods. A file path resolving inside the game directory does not automatically grant permission to mutate it. No security phase may silently delete saves, screenshots, Minecraft logs, crash reports, options, server lists, or imported mods.

Preserve operation coordination, bounded concurrency, worker quiescence after failure, deterministic classpath order, verified staged downloads, durable state publication, and conservative directory recovery. Security changes must not restore the performance problems fixed by the optimization work.

Do not equate cryptographic hashes with a trustworthy publisher. Do not promise a sandbox against malicious mods or processes running as the same OS user. Do not replace a missing OS keyring with hardcoded encryption, an embedded key, or silent plaintext persistence.

## 3. Working rules and review output

Never reset, overwrite, or clean unrelated user changes. Record the branch and commit before editing. Prefer a dedicated security branch when authorized. Keep commits phase-scoped; do not push, merge, tag, or publish without an explicit instruction. Do not edit ignored planning files and then imply they were committed: check `.gitignore` first. Prefer deliberately tracked `SECURITY_PLAN.md` and `SECURITY_PROGRESS.md`, or obtain agreement before changing ignore rules for `PLAN.md`, `PROGRESS.md`, or `docs/`.

Every review gate must report: starting/ending SHA; changed files; mapped finding IDs; implemented behavior; tests with exact commands and actual results; new failing tests before the fix and passing results after it; skipped/blocked coverage; compatibility/performance effects; remaining risks; and rollback notes. A skipped test is not a pass. A mocked OS keyring is not a packaged keyring test. Source-only review is not a binary signing verification.

If a phase exposes an unexpected destructive behavior, keep user data intact, stop the affected action, and report it. Do not bypass the failing protection to make a benchmark or smoke test green. Do not use `--no-sandbox` as an acceptance workaround.

Rollback must not restore plaintext credentials, unsafe credential routing, or unvalidated destructive cleanup. When a storage/schema downgrade is unsafe, require reauthentication or a supported recovery path instead.

## 4. Target component boundaries

The following are proposed responsibilities, not mandatory filenames. Reuse suitable existing modules rather than adding layers solely to match these names.

| Responsibility | Main-process contract |
|---|---|
| Portal origin policy | Owns canonical allowed origins and development exceptions; renderer cannot choose a credential destination |
| Auth/session service | Owns account identity, origin binding, credential access, refresh single-flight, logout cancellation and session epoch |
| Credential store | Provides read/write/delete for an origin-bound encrypted session or explicitly memory-only session |
| IPC registration layer | Validates sender, main frame, document, payload, operation permission, and safe error DTO |
| Instance path policy | Validates canonical path, physical ancestry, ownership namespace and operation type before filesystem access |
| Metadata validators | Validate complete manifests, saved state, runtime metadata and journals before mutation |
| Transport policy | Separates authenticated Portal requests, public metadata and artifact/image downloads; enforces redirect and resource limits |
| Privacy/log policy | Minimizes collection at source and sanitizes bounded records before any user-visible or persistent output |

Example narrowed interfaces: `auth.verify()` and `auth.refresh()` take no origin; `game.launch()` resolves the installed release in main; `utils.openSourcePage(validatedUrl)` never opens a local file; `utils.openKnownLocation(kind)` accepts a small enum. Advanced executable/argument changes use a native confirmation that displays the actual requested value and cannot be granted by a renderer-supplied boolean.

## 5. Phase map

| Phase | Primary findings | Exit artifact |
|---|---|---|
| 0 | All: baseline and scope | Reproducible baseline, threat/data-flow inventory, drift report |
| 1 | SEC-01, immediate SEC-02 link sink | Main-owned credential destinations and safe web opening |
| 2 | SEC-02 | Narrow IPC, runtime-validated inputs, production renderer controls |
| 3 | SEC-03, SEC-08 | Secure/session-only credential store and race-safe auth lifecycle |
| 4 | SEC-04, SEC-05 | Unified path/ownership validation and safe recovery |
| 5 | SEC-06, SEC-07, SEC-11 | Verified bounded provisioning and explicit fallback policy |
| 6 | SEC-09, SEC-10 | Minimal, bounded logs and optional cosmetic disclosures |
| 7 | SEC-12 | Least-privilege, validated release pipeline and dependency evidence |
| 8 | All | Packaged adversarial acceptance report and release recommendation |

Phases are sequential by default. Parallel work is safe only after contracts are agreed and file ownership is separated. Do not run multiple agents concurrently against `main.ts`, `config.ts`, `auth.ts`, or the shared transfer/path policy without coordination.

## Phase 0 — Establish the baseline and reproduce findings

**Change scope:** Investigation, test fixtures and review documentation only. No dependency updates, production fixes, release publication, or architecture changes.

Record `git status --short`, `git rev-parse HEAD`, `git log -1 --oneline`, resolved runtime versions and lockfile identity. Compare the checkout to the assessed commit; a newer checkout must be reviewed for material changes rather than forcibly reset to the old SHA. Inspect `git check-ignore` results for planned documentation; its normal no-match exit status is not a build failure.

Run the existing commands on a supported development/test environment:

```sh
bun --version
node --version
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
bun run smoke
bun run benchmark
```

Record actual command support and output; distinguish environment failures from source regressions. The assessed CI pins Bun 1.4.2. Use the repository's current approved pins after recording drift; do not silently install arbitrary “latest” tooling. Review package lifecycle scripts before running dependencies in an environment containing credentials. Use synthetic Portal sessions and a disposable game directory for all security tests.

Map each IPC channel to sender policy, input shape, side effects and sensitive output. Map every `fetch`, `shell` open, process launch, filesystem write/delete, credential persistence and log call to its trust boundary. Inventory renderer storage, Electron session caches, network destinations, and automatic requests before/after login. A code search result alone is not proof of no telemetry; record dynamic capture as pending until performed.

Add negative fixtures for the assessment's URL, path and logging cases. Use `node:path.win32` and `node:path.posix` unit cases, then native platform integration later. For deletion/link tests use only disposable temp trees and outside-instance sentinel files. Mock `shell` and process execution rather than opening real executables. Convert the supplied isolated observations into tests of actual exported module behavior when practical; keep known-failing security regressions separate from baseline pass counts until their fix phase.

**Review Gate 0:** Deliver the command results, code-drift analysis, finding-by-finding reproduction status, threat/data-flow inventory, planned test locations and documented unsupported checks. Stop. Do not implement Phase 1 yet.

## Phase 1 — Constrain credential destinations and web-link opening

**Files:** `src/config.ts`, `src/auth.ts`, `src/preload.ts`, `src/main.ts`, `src/types.ts`, affected auth/settings/catalogue views; a shared URL-policy module if useful.

Replace substring portal normalization with a parser-driven policy. Decide explicitly whether the supported contract permits only an origin or an approved base path; current calls append `/api/v1/...`, so origin-only is the default proposal. Reject userinfo and unexpected query/fragment. Canonicalize scheme/host/port consistently. Require HTTPS for remote portals. Allow HTTP only for deliberately enabled, exact loopback development endpoints; never use substring matching, and never infer an allowed production endpoint from an inherited environment variable.

Remove URL overrides from credential-bearing renderer methods. Main chooses the active trusted portal. Introduce session-origin binding immediately; unknown-origin legacy sessions must not be sent to a changed or unapproved origin. Until Phase 3 migrates storage, fail safely with reauthentication. A portal change must explicitly invalidate/isolate the old session and pending auth operations; do not postpone the cross-origin protection until vault work.

For auth/verify/refresh/exchange requests, reject redirects by default. If the existing Portal requires a same-origin redirect, document its exact necessity and explicitly enforce that restriction at every hop. Cross-origin 307/308 body forwarding must never expose token, refresh token, authorization code or verifier. Do not rely solely on automatic removal of `Authorization` headers.

Split `openSourcePage` from `openKnownLocation`. Validate web URLs in main and reject local/UNC paths, `file:`, custom handlers, control characters, userinfo and all unsupported protocols. Never reinterpret a rejected URL as a file path. Known-location opening resolves app/game/log paths in main, checks their expected type and ownership, and does not accept arbitrary renderer filesystem paths.

**Tests:** Preserve normal approved HTTPS login; reject the three reproduced HTTP bypasses, lookalike hosts, credentials in URLs and malformed inputs. Simulate origins A and B with synthetic tokens and assert that no A credential reaches B through verify, refresh, settings changes or redirects. A catalogue source value that resembles a local executable must never invoke either an OS file opener or a process spawn. Approved source HTTPS links and explicit known-folder buttons must still work.

**Review Gate 1:** Provide the allowed-origin/base-path decision, API compatibility diff, sink-level request/open mocks, and any Portal dependency. Stop. Do not loosen a policy merely because a development fixture previously relied on an unsafe URL.

## Phase 2 — Narrow IPC capabilities and lock down the renderer

**Files:** `src/main.ts`, `src/preload.ts`, `src/types.ts`, `src/game-runner.ts`, configuration handlers, `ui/index.html`, current `ui/src/` views, `vite.config.*` as present.

Introduce a common IPC registration wrapper that validates the expected BrowserWindow/webContents, the actual top-level sender frame, and the exact loaded application document. For development, only the explicitly configured loopback dev origin is eligible. `event.sender.id` alone is not sufficient; subframes and navigated documents must fail. Apply checks to all channels, including one-way messages and read operations exposing paths/identity. Use bounded, stable errors rather than serializing raw backend exceptions into the renderer.

Replace the settings blacklist with strict allowlisted schemas and reject unknown keys, wrong types and excessive lengths/counts. Store only settings the operation owns. Generic settings cannot write credential fields, directory state, mod-import receipts, release descriptors or privileged bookkeeping. Main must validate RAM bounds, channels, identifiers, booleans and high-risk argument settings. Bind directory configuration/moves and local imports to an approved native selection or native confirmation of the exact target, rather than accepting a renderer-supplied approval flag; expire operation-specific capabilities after use. UI validation remains helpful but is not authority.

Change the launch API so main reads its own authenticated user and installed release. Remove caller-selected release descriptors and the resulting installed-generation bypass. Preserve validated no-sync behavior; it skips synchronization, not authentication or a known failed integrity state. Determine optional-mod authority from the validated catalogue, not a renderer boolean or forged config record.

Retain legitimate custom Java and tuning support through explicit native user approval/selection. Classify executable paths, agents, argument files, classpath/main-class replacement and other code-loading flags as privileged changes. A renderer checkbox must not stand in for approval. Show the actual resolved executable/arguments to the user. Parsing must remain shell-free; the purpose is trust/intent enforcement, not substituting string escaping for process argument arrays.

In packaged builds ignore `VITE_DEV_SERVER_URL` and unsupported test/environment hooks. Load only the packaged renderer and fail clearly if it is absent rather than loading a legacy fallback with different security behavior. Add main-window navigation/redirect denial, deny unexpected child windows/webviews and permissions, and explicitly preserve sandbox/context-isolation settings. External auth continues in the system browser.

Add a production CSP compatible with actual built assets: restrict scripts to packaged sources, disallow unsafe evaluation/inline script, block objects and unexpected frames, and constrain connect/image/font destinations. Account for existing style usage without weakening script restrictions. Prefer an approved application origin/protocol if needed; test exact `file:` document handling rather than broadly trusting all local files. Package the active renderer only; remove unused legacy UI from shipped files after checking it has no supported purpose.

**Tests:** Exercise valid main-frame calls, wrong windows, child frames, navigated documents, destroyed senders and malformed structured inputs in Electron. Test CSP and blocked navigation/popups/permissions. A renderer script must not cause arbitrary OS execution, choose a new credential destination, replace an installed runtime, or mutate arbitrary settings. Verify normal login, mods drag/drop, launch, repair, folder selection, console and approved tuning workflows.

**Review Gate 2:** Deliver the IPC allowlist/schema inventory and packaged boundary tests, including a statement of what remains possible to a compromised legitimate renderer. Stop. Do not claim sender checking alone contains that renderer.

## Phase 3 — Separate secrets and make authentication race-safe

**Files:** `src/auth.ts`, `src/config.ts`, credential/session service, logger hooks, auth/settings UI, app lifecycle tests.

Create a main-only credential store outside the game directory. Keep settings JSON token-free. Bind stored secrets and their decrypted payload to the trusted portal origin and account. Check the actual OS encryption backend and API behavior supported by Electron 44.0.0 before choosing sync/async APIs; current documentation alone is not exact-version proof.

On Windows, use supported OS-backed storage and verify private user-data ACL behavior. On Linux, require an acceptable keyring backend. Unavailable encryption, locked/unusable keyrings, and `basic_text` produce a visible **session-only** mode; never silently persist equivalent plaintext. Use owner-only directories/files on POSIX and secure atomic/exclusive writes appropriate for credential material. No credentials in crash reports, renderer storage, installation directories, exported settings or debug logs.

Specify migration as a state machine. Legacy plaintext with no trustworthy issuer binding defaults to cleared/ineligible credentials plus reauthentication. Where trusted migration is possible, write and validate the encrypted record before removing plaintext; handle each crash boundary deterministically. Encryption/read failures must not resurrect old plaintext or create plaintext backups. Do not promise removal from historical user backups. Test duplicate/stale records and failed Windows replacement cases.

Implement one active login and a refresh single-flight per session. Increment an epoch on logout, account/portal change and superseding login. Every asynchronous continuation checks that epoch before publishing credentials or user state. Abort outstanding network work where possible; ignoring a late response is still mandatory when abort races with completion.

Keep the loopback listener ephemeral and loopback-bound. Validate method/path/Host and impose request/header/time limits. Respond to unknown routes and reject invalid callbacks without closing the valid login flow. Exchange a valid state/code at most once. Clear timers/listeners in one cleanup path and close on cancel, success, error and app shutdown. Display browser success only after successful, schema-validated exchange; never reflect raw error/code values into HTML.

Differentiate unauthenticated/revoked results from temporary connectivity failure. Logout clears memory and persistent secrets and prevents delayed resurrection. Do not claim it terminates an already running Minecraft session or clears the system browser's login cookies. Inspect an existing Portal revocation capability before adding remote revocation; report missing server support separately rather than inventing an endpoint.

**Tests:** Secure-store round trips, corrupt ciphertext, wrong origin/account, missing/locked Linux keyring, `basic_text`, migration failures at every checkpoint, restart and permission behavior. Test login/logout/refresh interleavings, concurrent requests, callback noise/replay, timeout cleanup, 401/403 versus 5xx/timeouts, and late responses after logout. Assert that serialized config, IPC responses and fixture logs contain no synthetic credentials.

**Review Gate 3:** Deliver migration/recovery behavior, native-platform storage evidence, session race tests and honest logout semantics. Stop. A secure-storage mock alone cannot close platform acceptance.

## Phase 4 — Unify metadata, path ownership and safe recovery

**Files:** `src/sync.ts`, `src/file-transfer.ts`, `src/config-patches/reconciler.ts`, adapters as needed, `src/client-mods.ts`, `src/game-directory.ts`, `src/java-runtime.ts`, `src/minecraft-bootstrap.ts`, shared schemas/path policy.

Validate complete channel/release/manifest/state objects before mutations. Bound schemas, protocols, sizes, digest formats, counts, strings and revisions. Check release/manifest identity and runtime consistency, not only individual fields. Treat cached metadata and previous installation state as untrusted input too. Reject prototype-sensitive keys where object maps/adapters would otherwise interpret them, without assuming every adapter currently has an exploitable prototype-pollution bug.

Establish one canonical relative-path representation. Reject traversal/dot aliases rather than allowing two code paths to interpret them differently. Reject absolute, drive-relative, UNC/device, NUL/control, Windows ADS and trailing-dot/space ambiguity as applicable. Handle case-equivalent and separator-equivalent destinations consistently on supported platforms. Validate digest strings before using them as cache path components.

Reserve launcher internal namespaces, including `.lampas`, from remote pack writes. Enforce protected player-data namespaces for every read/write/delete/patch operation according to a documented ownership matrix. Explicit config patch authority is narrower than general pack-file authority: allow only approved configuration locations/operations and detect conflicts with whole-file management. Preserve supported `once`, `enforce`, defer/create and idempotency semantics. Do not globally prohibit a legitimate explicitly authorized config operation without a compatibility decision.

Validate previous-state paths before even considering deletion. Reject or quarantine malformed state; do not interpret it as an instruction to clean arbitrary files. Detect duplicate destinations, conflicting policies, patch-ID collisions and runtime/internal-file collisions before downloading or modifying the installation.

Before opening an existing destination or creating its parents, check its physical ancestry and file type. Reject symlink/junction escapes and special files. Use exclusive staging, safe replacement and no-follow/handle-based operations where the platform allows them; avoid predictable `.importing` destinations that follow preexisting links. Account for hardlink/in-place-write risks and checks immediately before promotion/deletion. Document the remaining race boundary with an actively malicious same-user process rather than promising a universal filesystem sandbox.

For recovery, strictly validate journal version/phase, operation ID, canonical source/target/staging, disjointness and allowed relationships. Bind staging to a launcher-created location and operation, not just a name prefix. Compare with the configured instance and appropriate trusted operation state. Treat receipts as crash-consistency evidence, not self-authenticating permission to delete. Do not invent a same-user-readable HMAC key and claim it authenticates state against an attacker with that same access. Unknown/ambiguous journals are quarantined and block mutations. Re-establish target completeness before destructive source cleanup where a crash makes prior verification stale. Preserve original data on doubt.

**Tests:** Real-module tests for the supplied aliases and internal-state path, malformed hashes and previous-state traversal. Use temp-tree sentinels to verify no outside-instance write/delete. Test Windows native junctions plus Linux symlinks, links in every ancestor, case collisions, devices/ADS, path replacement races, fixed-temp symlinks, invalid patch destinations, and corrupt saved state. Exercise every recovery phase with unrelated staging paths, missing/mismatched receipts, stale content, occupied target and valid successful same-/cross-volume flows.

**Review Gate 4:** Supply the ownership matrix, preflight ordering, filesystem test evidence and recovery matrix. State unavailable native tests explicitly. Stop. No automatic deletion is acceptable when the affected path cannot be proven authorized.

## Phase 5 — Make provisioning bounded and integrity checks explicit

**Files:** `src/file-transfer.ts`, `src/fabric-meta.ts`, `src/minecraft-bootstrap.ts`, `src/java-runtime.ts`, `src/sync.ts`, `src/resource-packs.ts`, worker-pool integrations and tests.

Separate credential-bearing Portal transport, public metadata, artifact downloads and cosmetic images. Require approved HTTPS origins for remote content and validate every redirect. Keep Portal blob-to-object-storage 302 behavior using credential-free artifact requests. Never propagate Portal authorization/cookies to artifact destinations. Restrict private/loopback/link-local destinations for untrusted remote download metadata; a hostname-only check is insufficient if a policy claims to resist DNS rebinding. Where network-level pinning is unavailable, use the approved-domain model and state its limits. Developer fixtures use explicit test policy, not production exceptions.

Require valid expected digests for managed executable artifacts before publication. A missing/failed checksum sidecar is not successful verification. A previously verified cache may be used only when its digest/source/artifact identity remains eligible under the documented policy; otherwise stop with a repairable error. Do not invent a checksum or label a download verified without one. Continue supporting official SHA-1 metadata where upstream publishes it; require SHA-256 for the existing pack protocol where it is already specified.

Bind subordinate metadata to upstream expected hashes/sizes where the upstream contract provides them. Validate runtime manifest paths and asset digests before filesystem access. Distinguish managed runtime verification from deliberately selected user/system Java. In full managed repair, establish Java file integrity before any `-version` execution. A version string from an executable is not proof of its trustworthiness.

Keep fast-mode checks as documented performance optimizations. They must not bypass failed prior verification or accept new artifacts without hashes. Full repair must enforce its promised checks; report any explicitly unmanaged component rather than saying every byte is verified. Review native receipts, collisions and stale outputs: publish only validated expected native files and remove obsolete managed natives only when their ownership is established. Never delete unrelated files speculatively.

Define calibrated response/artifact/operation limits using baseline manifests, with headroom for legitimate game assets. Enforce limits while streaming; reject overlong bodies even with absent or lying Content-Length. Bound JSON before parsing, checksum sidecar text, image dimensions/size, decompressed archive totals, per-entry size, entry count, and duplicate native basenames. If the unzip API cannot enforce expansion bounds before allocation, use a suitable streaming/worker approach rather than post-hoc checking a fully expanded archive. Abort, remove only owned staging, and wait for all workers to settle before releasing the coordinator.

Classify fallback errors explicitly. 401/403, 410 revocation, unsupported schema/protocol, invalid metadata and checksum/signature failure must never become a local-fallback success. A transient outage may use a validated, explicitly permitted cache/local-development path. Document production availability versus freshness policy. Existing no-sync semantics must not bypass known denial/integrity state. Do not implement a new signing format, revocation endpoint or trust-root protocol without a separately reviewed Portal/pipeline change.

**Tests:** Missing/bad hashes and checksum sidecar outages; valid upstream SHA-1; exact trusted-cache eligibility; artifact redirects without credential leakage; auth redirects still rejected; HTTP/private-destination denial; late/oversized/chunked bodies; stalled streams; archive bombs/collisions; worker error with no writes after lock release. Test 401/403/410 with an adjacent fallback manifest and assert no mutation. Test full repair of a modified managed Java executable without probing it first. Preserve successful installation, local development, full repair and bounded fast-path performance.

**Review Gate 5:** Provide the transport/redirect matrix, integrity/cache/fallback policy, actual budget values, verification coverage and failure-quiescence tests. Stop. Any missing Portal/pipeline support is a separate explicit dependency, not permission to downgrade verification.

## Phase 6 — Minimize logs and optional network disclosures

**Files:** `src/logger.ts`, `src/game-log-stream.ts`, auth/config/API call sites, `ui/src/views/auth-view.ts`, `ui/src/views/mods-view.ts`, settings and disclosure documentation.

Replace default auth-response logging with minimal events: outcome, safe status/reason, duration and a non-secret request identifier where available. Do not log complete user records, UUIDs/names by default, token endpoints' bodies, arbitrary config values or URL queries. Keep useful operational diagnostics without making every session a profile dump. Sensitive source values should never reach the logger in the first place.

Use shared structured-field and URL/error sanitation, covering camelCase and underscore credential keys, cookies/authorization, authorization codes/verifiers, supplied signed-URL query fields and supported CLI token forms. Apply it before serialized error DTOs, disk output and live IPC. Where useful, redact current known secret values as additional defense, with bounded lifetime and tests; this is not a replacement for minimizing collection.

Fix the line-framing order: assemble a bounded complete record, sanitize it, and only then truncate emitted safe text. If a raw line exceeds the safe assembly budget, discard the full line and emit a constant marker instead of leaking its prefix or tail. Retain UTF-8 correctness, backpressure, queue budgets and ACK accounting. Do not claim arbitrary malicious mod output can be perfectly sanitized under every encoding.

Implement launcher-log size/age retention with explicit defaults. Proposed starting policy: 5 MiB per file, at most three launcher log files, seven-day age expiry, adjustable after the baseline review. Apply only to launcher-owned logs, never Minecraft logs, saves or crash reports. Enforce private access. Avoid automatic log upload; any future diagnostic export must use a preview/confirmation, describe omissions and not claim perfect anonymization.

Default the profile avatar to local initials. Optional external avatars require a clear choice explaining the UUID/name, IP and request-timing disclosure. Restrict catalogue icon destinations and provide a local fallback when remote images are disabled or invalid. Cache cosmetic assets within bounded retention. A Portal image proxy is a separate design decision with its own SSRF/cache/privacy implications, not an assumed existing API.

Publish a data-flow notice distinguishing necessary Portal authentication/status and Minecraft/Fabric/download traffic from optional cosmetic requests. State where launcher logs/settings/credentials live, retention, local logout behavior, and the separate behavior of Minecraft/mod logs and the system browser. Do not infer complete telemetry disablement from a single JVM flag. Clear sensitive in-memory UI/cache state on logout while retaining non-sensitive user settings as documented.

**Tests:** Replay synthetic secrets in structured records, URLs, error chains, config strings and CLI output. Split relevant lines at every byte/chunk boundary, including UTF-8 and oversized/truncated input; inspect both live IPC and disk. Test retention over long sessions/restarts and confirm only launcher-owned files are removed. Capture requests with avatars/images disabled, enabled and after logout using test accounts: disabled optional features must make no provider requests.

**Review Gate 6:** Deliver the data-flow/retention notice, positive/negative redaction evidence, network capture summary and residual privacy limitations. Stop. No assertion of legal compliance or complete anonymization without separate evidence.

## Phase 7 — Harden dependency and release assurance

**Files:** `.github/workflows/validate.yml`, `.github/workflows/release-pack.yml`, `package.json`, `bun.lock`, packaging hooks and tracked security documentation.

Start from the established lockfile baseline. Run the supported advisory audit and record resolved packages, affected ranges, exploit preconditions, runtime versus build exposure, and remediation. `bun audit` sends dependency information to advisory services; use approved registry/network policy. Do not expose private source, credentials or complete user data to external scanners. A tool failure or unsupported registry is incomplete coverage, not “no vulnerabilities.” Upgrade only justified packages in a dedicated reviewed change and rerun compatibility tests.

Set default workflow token permissions to read-only or narrower; grant `contents: write` only to the publication job that needs it. Disable persisted checkout credentials in build jobs where not needed. Pin action versions to reviewed full commit SHAs using authoritative release information; do not fabricate hashes. Isolate untrusted PR code from release secrets and privileged environments.

Make release depend on successful typecheck, tests and security/package smoke checks for the exact tag commit on Windows and Linux. An unrelated main-branch green check is insufficient. Keep frozen installs and fail-on-missing-artifacts. Verify version/tag/artifact consistency and explicitly handle manually dispatched build-only workflows rather than implying they publish a channel.

Generate reproducible artifact checksums, an SBOM and supported provenance evidence. Inspect real packaged Windows signatures and Linux verification metadata. Add signing only with authorized credentials and documented key custody; pin any tool/service versions involved. Missing signing access blocks the signing/release-assurance task, not independent source hardening. Do not insert a placeholder key, auto-create a signing identity, or label artifacts signed without verifying them.

Evaluate Electron fuses supported by the pinned runtime and packaging tool: disable unnecessary RunAsNode, Node options and inspection entry points; evaluate packaged-ASAR-only loading and integrity on the platforms where supported. Apply fuses before signing and verify the actual packaged result. Do not claim an unsupported Linux integrity fuse provides Windows/macOS behavior. Test that legitimate Java subprocess launch still works and that inherited developer/debug environment variables do not subvert packaged execution.

Review tracked-file/package contents for test fixtures, logs, credentials and unused renderer sources. Document supported platforms, reporting process and accepted threat-model limits in tracked security/privacy docs. Repository rules/settings or external code signing that cannot be inspected must be listed as unverified, not assumed disabled.

**Review Gate 7:** Deliver actual advisory results/triage, permission diff, exact-SHA release gates, artifact/SBOM/provenance evidence, fuse tests and signed/unsigned status with proof. Stop before publishing any release.

## Phase 8 — Packaged adversarial acceptance and handoff

**Scope:** Cross-platform verification and handoff; no new features or unreviewed protocol changes.

Run the repository's actual checks again. Build Windows packages on Windows with `bun run package:win` and Linux packages on Linux with `bun run package:linux`; use `bun run package:dir` when an unpacked app is appropriate for an additional smoke step. The existing `bun run smoke` is a starting point, not proof that every security scenario is covered. Test both unpacked and representative distributed package forms. Never use a real user's default game/config directory.

Run an isolated synthetic Portal/artifact fixture and disposable installation that exercise login, refresh/logout, source links, mod imports/toggles, sync, repair, no-sync, directory move/recovery, and errors. Include wrong-window/frame IPC, portal-origin change, external navigation, malicious metadata paths, poisoned previous state, missing checksum sidecars, revocation with local fallback, symlink/junction ancestors, oversized content, log-secret boundaries and unavailable keyring behavior. Make expected denial occur before the dangerous sink or filesystem mutation.

Test fresh installation and upgrade from legacy config, crash boundaries, restart after failed repair/move, Windows and Linux path differences, and keyring/backend differences. Confirm that corrupt managed Java is not executed to prove its own validity during repair. Confirm that a published verification receipt cannot turn unknown code into trusted code. Explicitly document intentionally trusted user-selected runtimes/mods.

Compare startup/warm launch, full repair, sync and log-stream responsiveness against Phase 0 under comparable inputs and hardware. Keep genuine security costs visible and agree any thresholds from the baseline rather than inventing an arbitrary percentage. Preserve deterministic classpath ordering and operation exclusion during failure. No success report while background workers continue mutating.

Inspect emitted IPC, disk files and fixture request logs for synthetic credentials and unnecessary identity data. Confirm log retention boundaries, optional-image opt-out, origin-bound storage, invalidation of late auth results, and package signing/provenance/fuse state. Complete a finding disposition table: fixed with tests, mitigated with residual risk, explicitly accepted, or blocked/unverified.

**Final Review Gate 8:** Deliver a phase-by-phase progress record, exact commit and commands, Windows/Linux evidence, upgrade/recovery instructions, residual-risk register and release recommendation. The recommendation does not itself authorize merge, tags or publication. Stop for human review.

## 6. Minimum release-blocking acceptance criteria

The agent must produce evidence that credentials cannot leave their bound trusted portal through IPC, configuration changes or redirects; privileged operations reject untrusted senders and invalid payloads; source links cannot open local files; and packaged content cannot navigate into an equally privileged remote document.

There must be no plaintext credential persistence or silent weak-backend fallback. Logout must prevent in-flight authentication from restoring a session. Expected metadata and saved-state paths must not authorize outside-instance or protected-data mutations. Unproven journal paths must never be recursively deleted.

Managed executable downloads must not be called verified without expected digest evidence; full repair must uphold its stated verification contract. A known authorization/revocation/integrity failure cannot turn into local-fallback success. Resource-limit failures must leave owned staging cleaned and workers quiescent.

Supported synthetic secrets must not appear in persisted or live logs; oversized raw log lines must not emit secret fragments. Optional cosmetic requests must remain off when disabled. Release checks must apply to the exact artifact-producing commit with least-privilege build credentials. Both Windows and Linux acceptance must be either completed or explicitly reported as blocking/unverified—not quietly omitted.

## 7. Deferred or separately authorized work

A new signed manifest protocol, independent update trust root, key rotation, online revocation policy, Portal image proxy, server token-revocation endpoint, or changes to Microsoft account token custody require a separate Portal/pipeline architecture review. Record the requirement and owner, but do not invent compatible endpoints or formats in the launcher.

A hostile same-user mod/process remains outside the protection that renderer isolation or OS credential storage can guarantee. The Minecraft access token's process argument exposure requires a launch-protocol-specific assessment; moving it to a plaintext argument file is not automatically an improvement. No security claim should imply that arbitrary mod code is sandboxed.

## 8. Initial instruction to the execution agent

```text
Read LAMPAS_LAUNCHER_SECURITY_PLAN.md and the companion assessment.
Execute Phase 0 only against the current checkout of justbecauseph/lampas-launcher.
Compare the checkout with assessed commit 3950e155a25c9effc004e2355dffa1722e46a6cc.
Preserve unrelated changes, architecture, supported platforms, and the lockfile.
Use synthetic credentials and disposable installation directories.
Report actual baseline results, code drift, finding reproductions, and missing coverage.
Stop at Review Gate 0. Do not implement later phases, merge, tag, or publish.
```

## 9. Reference guidance

Use the pinned source index in the assessment for repository evidence. Consult official Electron security, safeStorage and fuse documentation, RFC 8252, GitHub Actions secure-use guidance and Bun audit documentation for implementation details. Verify APIs against the exact dependency versions before use. Do not substitute generic guidance or copied probe helpers for tests of the actual packaged launcher.

# Lampas Launcher — Security and Privacy Assessment

**Assessment date:** 16 September 2026
**Repository:** `justbecauseph/lampas-launcher`
**Reviewed revision:** `3950e155a25c9effc004e2355dffa1722e46a6cc`
**Application version:** `1.3.0`
**Platforms in scope:** Windows x64 and Linux x64
**Status:** Read-only source review and isolated helper probes; no remediation applied.

## Executive assessment

Prioritize a security-hardening release before further distribution. The most important problems are not missing cryptographic algorithms; they are places where less-trusted input can choose a credential destination, invoke privileged desktop capabilities, or determine filesystem mutations.

The source supports several concrete findings: existing credentials can be sent to a renderer-supplied portal URL; credentials are persisted in ordinary JSON; catalogue links reach a generic OS file opener; saved installation paths are trusted during deletion; and some executable downloads can proceed without an expected checksum. Privacy concerns include identifiable third-party avatar requests and gaps in logging redaction.

**No account compromise, successful zero-click exploit, or compromise of the deployed Portal is established by this review.** Several high-impact paths require a compromised renderer, malicious remote metadata, or modification of local state. Severity below reflects impact and the boundary being crossed, not a demonstrated attack on production.

## Scope and evidence limits

The review examined the Electron main/preload boundary, authentication and configuration, sync and transfer code, Minecraft/Fabric/Java provisioning, config patch reconciliation, client mod operations, directory-move recovery, log handling, selected current renderer views, packaging, and the release workflow. References are pinned to the reviewed commit rather than a moving branch.

Eleven no-network helper probes were executed with Node.js `v22.16.0`. They manually reproduce small source functions or path expressions and confirm their observable behavior. They are **not** repository tests, end-to-end exploits, or Electron integration tests. The results file uses `passed` to mean “the observed weakness matched the expected observation,” not “security passed.” No files outside the evidence directory were mutated by the probes; the deletion-path probe only computed a path.

The repository was not built or run in Electron in this environment. Bun was unavailable and a direct clone could not resolve GitHub. Connected GitHub reads nevertheless provided the reviewed source. No dependency advisory audit, installed-binary signature examination, production network capture, Portal implementation audit, account-token revocation test, or repository-protection/settings audit was performed. This review is not a complete secret-history scan or a legal compliance determination.

## Existing protections to retain

The main window enables context isolation and disables Node integration. Preload exposes individual methods rather than unrestricted IPC. Renderer-facing settings and user DTOs omit credentials. Login uses an external browser, random state, S256 PKCE, and a listener bound to `127.0.0.1`. Java launches/probes use argument arrays rather than a command shell.

Managed pack transfers already support hash/size checks and staged publication. Sync preserves explicitly imported client mods. The cross-volume directory scanner rejects symlinks and special files. Runtime coordinate checks, operation coordination, bounded log framing/IPC queues, and full-repair paths are useful existing foundations. These should not be discarded to simplify remediation.

Evidence: pinned source references S1–S11 below. The companion plan identifies the exact modules to preserve and extend.

## Findings at a glance

| ID | Priority / severity | Finding | Principal prerequisite or qualification |
|---|---|---|---|
| SEC-01 | P0 / High | Existing credentials can be sent to an arbitrary portal destination | Compromised renderer or changed portal configuration; HTTP normalization additionally has bypasses |
| SEC-02 | P0 / High | Privileged IPC and generic OS opening are too broad | Catalogue link requires a click; other capabilities require renderer execution or another eligible sender |
| SEC-03 | P1 / High | Portal and Minecraft credentials are stored in plaintext | Access to launcher configuration, backups, or the user's files |
| SEC-04 | P0 / High | Manifest/state paths do not consistently enforce containment and ownership | Malformed/hostile metadata, tampered saved state, or filesystem links |
| SEC-05 | P1 / Medium, high impact | Recovery journal can authorize unrelated recursive deletions | Local journal/state tampering; not an independent privilege escalation |
| SEC-06 | P1 / High, conditional | Executable integrity checks can fail open | Missing checksum sidecars, poisoned local executables, or hostile metadata |
| SEC-07 | P1 / High, conditional | Local fallback can swallow authorization/revocation failures | Adjacent fallback manifest must exist |
| SEC-08 | P1 / Medium | Authentication lifecycle has races and cancellation gaps | In-flight requests, stray callbacks, repeated login/logout, or network failure |
| SEC-09 | P1 / Medium | Logs can retain secrets/identity data despite redaction | Relevant response/output format, long-line truncation, or log sharing |
| SEC-10 | P2 / Medium privacy | Avatars and catalogue images disclose identifiers/network activity | Normal use of remote avatar/image features |
| SEC-11 | P2 / Medium | Downloads and extraction lack sufficient input-resource budgets | Oversized or malformed remote content; worker-failure concurrency |
| SEC-12 | P2 / Medium | Release workflow has excessive build privileges and missing release gates | Build/action compromise or publication of an unvalidated tag |

P0 means fix first; it does not mean a CVSS Critical rating. These priorities are recommendations for this project, not independently assigned vulnerability scores.

## SEC-01 — Credential destination is controlled by the caller

**Evidence.** `preload.ts` exposes `auth.verify(portalUrl?)` and `auth.refresh(portalUrl?)`. Main-process handlers forward the supplied URL. In `auth.ts`, `refreshSession()` sends the existing portal bearer token and the existing refresh token to the chosen `/api/v1/auth/refresh` endpoint. `verifySession()` similarly sends the current bearer credential to the chosen verify endpoint. Credentials do not have a stored issuer/origin binding. Changing the configured portal does not automatically isolate or discard the old credentials. See S1–S4.

A compromised renderer therefore does not have to read the credential through IPC: it can ask the privileged process to transmit it elsewhere. Keeping token fields out of renderer DTOs does not close this path.

`normalizePortalUrl()` also identifies loopback using substrings rather than a parsed hostname and checks the HTTP prefix case-sensitively. The isolated probes show that `http://localhost.attacker.invalid`, a remote URL with `127.0.0.1` in its path, and uppercase `HTTP://` bypass the upgrade rule. These are synthetic `.invalid` examples and were not contacted.

**Remediation.** Use a main-owned, validated portal origin; remove arbitrary destination arguments from credential-bearing IPC; bind sessions to origin/account; and require fresh authentication on portal changes. Parse URLs using `URL`, reject userinfo and inappropriate paths/query/fragment, and distinguish external HTTPS from deliberately enabled loopback development. Reject credential-endpoint redirects unless a narrowly defined same-origin policy is explicitly required. Test 307/308 credential-body redirects as well as headers. Do not ban the legitimate native OAuth loopback callback itself.

## SEC-02 — Renderer capabilities exceed their intended purpose

**Evidence.** Most `ipcMain.handle()` registrations ignore the sender; the log ACK handler is a notable exception. There is no common runtime input validator. `config:set` removes several dangerous keys but accepts the remainder, including executable/runtime-related settings. `game:launch` accepts a `releaseOverride`; `GameRunner` skips installed generation/version cross-checks for that override. `VITE_DEV_SERVER_URL` is honored without a packaged-build gate. Main-window creation has no explicit navigation/window-opening guard or permissions policy, and the inspected HTML head contains no CSP. See S1, S2, S5, S12.

The strongest direct metadata flow is `manifest.mods[].sourceUrl` → catalogue “View” click → `window.lampas.utils.openPath()` → `shell.openPath()` for any value that does not begin with HTTP(S). A supposedly web-only link can therefore request an OS file open. The result depends on the target file, operating system, and default association; this review did not execute an unsafe file. This chain does not require an HTML-injection finding. See S1, S13, S14.

**Remediation.** Split web-link opening from app-owned folder/log operations. Validate protocol and destination in main; never fall back from an invalid web URL to opening a file. Validate webContents identity, top-level sender frame, and the exact approved document for all privileged IPC. Use strict allowlisted payload schemas and small, purpose-specific operations. Move installed release resolution entirely to main. Preserve advanced JVM tuning through explicit trusted-user approval rather than an unrestricted renderer-controlled executable path/argument configuration.

Sender validation alone is insufficient against compromise of the legitimate renderer: it must be combined with narrowed capabilities and trusted native confirmation for high-risk actions. Shell-free spawning prevents shell parsing, but it does not make arbitrary Java agents, argument files, or executable paths safe.

**Qualification.** Node integration is already disabled and context isolation is enabled. An omitted explicit `sandbox: true` is not evidence that the renderer is unsandboxed. `GameRunner` refreshes the user from the Portal, so the renderer-supplied `user` is not, by itself, a demonstrated identity-spoofing bypass.

## SEC-03 — Credentials persist as plain JSON

**Evidence.** Login/refresh write `token`, `refreshToken`, and `minecraftAccessToken` to `ConfigManager`. `ConfigManager.set()` serializes the whole merged object into `userData/config.json` using an ordinary file writer. These paths do not encrypt secrets or explicitly establish owner-only file permissions. Atomic replacement addresses write consistency, not confidentiality. See S3, S4, S6.

**Remediation.** Separate non-secret settings from an origin-bound main-process credential store. Use the OS-backed storage available to the supported Electron version, verify its actual backend, and use session-only memory storage when an acceptable secure backend is unavailable. Linux `basic_text` must not be described as encrypted secure storage. Enforce private file/directory permissions and validate Windows ACL assumptions.

Legacy credentials have no reliable issuer binding. Default to reauthentication rather than silently trusting the editable current portal URL. Migrate only when the trusted origin can be established; remove plaintext remnants after successful migration or explicit invalidation. Do not implement a plaintext fallback on encryption failure.

**Limit.** OS-backed storage reduces exposure from copied files and other users; it does not make the launcher or Minecraft immune to malware/mods running as the same OS user. Do not claim secure deletion from old backups or SSD storage.

## SEC-04 — Paths are checked inconsistently across reads, writes, and deletion

**Evidence.** `isSafeRelativePath()` and `isPathProtected()` use different normalization rules. The probes show that `mods/../saves/demo.txt` is accepted as safe while missing protected-path detection. Windows case variants have the same ownership issue. `.lampas/installation.json` is accepted as a manifest path rather than reserved as launcher state. See S7.

Obsolete-file deletion trusts the keys of `prevState.files` and directly calls `unlinkSync(path.join(gameDir, relPath))` without validating them. The harmless expression probe shows that a `../../` key can resolve outside the instance. This is a saved-state trust issue, not proof that an ordinary Portal request can directly write that state. See S8.

Managed destination writes and config patches check lexical paths, not symlink/junction ancestors. Hash strings are used to construct cache paths without a full digest schema at that entry boundary. Java runtime manifest paths and asset-object metadata likewise need stricter schemas. Fixed local-mod import staging names also need link-safe handling. See S6–S10, S15, S16, S24, S25.

**Remediation.** Establish one canonical instance-path and ownership policy, reserve internal state, validate old state before deletion, and preflight all metadata before mutations. Detect duplicate/case-equivalent destinations and conflicts between whole-file ownership and patches. Resolve/check physical ancestors and reject unsafe links/special files; use exclusive safe staging and no-follow/handle-based operations where supported. Include Windows drive/UNC/device paths, alternate data streams, trailing dots/spaces, and separator aliases in tests. Do not represent a string-prefix check as a filesystem sandbox.

## SEC-05 — Move-recovery metadata can authorize unrelated deletion

**Evidence.** `recoverInterruptedMove()` parses `directory-move.json` and initially requires only truthy source/target values. Multiple branches recursively remove `journal.staging`; some also remove `journal.source` after a loosely checked receipt. Earlier-phase cleanup can act on an arbitrary staging path without proving it is a launcher-created staging directory. This executes at startup. See S17.

The cross-volume scanner's link rejection is valuable, but it does not validate a subsequently loaded journal. A boolean `stagingVerified` and matching operation identifier are not independent proof of path authority or current byte equality.

**Remediation.** Validate journal versions/phases, canonical paths and their permitted relationships, operation-bound staging ownership, and consistency with the configured instance. Quarantine ambiguous metadata and block mutations while preserving data. Where deletion of the source is contemplated after a crash, re-establish the required target verification instead of trusting a stale boolean. No automatic recursive deletion of an unproven path.

**Qualification.** Exploitation requires local state modification. An attacker who already has arbitrary same-user filesystem access has substantial existing power; this finding primarily prevents the launcher from acting as a destructive deputy or mishandling corrupt state.

## SEC-06 — Executable verification is not consistently fail-closed

**Evidence.** Fabric sidecar lookup returns an empty result after checksum failures. `validateFabricRuntimeMetadata()` accepts absent checksums. `MinecraftBootstrap.ensureFile()` accepts an optional expected hash and may download a library without one, including during full repair. Fast mode accepts some existing artifacts based on size alone; for Fabric libraries no size is supplied. See S9, S10.

Managed Java validation calls `checkJavaVersion(localRuntimeJava)` before a full runtime repair establishes file integrity. That executes the potentially modified executable to ask whether it is Java. The remote Java manifest also supplies file paths and optional hashes without complete boundary validation. See S15.

**Remediation.** Require an authenticated expected digest for managed executable artifacts, or an explicitly documented trusted cache record bound to the same artifact identity. Missing checksum evidence must not silently become a successful verified download. Preserve official upstream SHA-1 metadata where that is the defined protocol; do not invent unsupported SHA-256 metadata. Verify managed Java before executing it in full-repair mode. Treat deliberately selected system/custom Java separately as a trusted-user decision.

**Limit.** A checksum from the same compromised publisher as the artifact does not authenticate benign code. Cached mtime/size checks are performance hints, not a defense against an active same-user attacker. Repository/manifest signing needs a coordinated trust-root and key-management design; do not improvise a launcher-only signature format in this hardening pass.

## SEC-07 — Local fallback can override a definitive Portal refusal

**Evidence.** `syncClient()` wraps channel, release, and manifest retrieval in one broad catch. A release HTTP 410 is converted into a “REVOKED” error inside that try, then caught by the fallback that loads `../../manifest/client-manifest.json`. Authorization failures take the same catch path. See S7.

**Qualification.** This behavior needs a local fallback manifest to exist. The reviewed package file list does not explicitly include that manifest, so this is not asserted to occur in every packaged installation. See S18.

**Remediation.** Separate transport unavailability from authentication failure, authorization refusal, revocation, malformed metadata, and unsupported protocol. Definitive refusals and failed integrity must never trigger a trust downgrade. Keep local-pipeline/development fallback explicit, with validated metadata and a visible mode. Do not turn no-sync into an authentication or known-revocation bypass.

## SEC-08 — Authentication lifecycle and callback handling need explicit state

**Evidence.** A missing-code or wrong-state callback terminates the active login. Unknown paths receive no response. The three-minute timeout is not cleared after success. The browser displays success before token exchange completes. Requests have no auth-specific deadlines, and there is no session generation or cancellation mechanism to prevent an old refresh/login from repopulating credentials after logout. Logout only clears local configuration; server revocation was not verified. See S4.

**Remediation.** Introduce a single-flight authentication state machine with an operation/session epoch. Discard late results after logout, portal change, or replacement login. Bound callback methods/paths/headers and request duration; ignore invalid callbacks without consuming the valid flow; consume a matching code once; close listeners and clear timers in a single cleanup path. Display success only after exchange validation. Distinguish temporary network failure from revoked credentials. Add server-side revocation only after inspecting an existing, authorized Portal contract.

## SEC-09 — Redaction and retention do not fully protect logs

**Evidence.** Auth methods pass response objects to API logging. Expected token fields are redacted, but user identity/profile fields remain eligible for logging. The text sanitizer misses underscore token fields, query-string authorization codes, and opaque command-line-form access tokens. `ProcessLogFramer` truncates/splits oversized lines before redaction, so an incomplete quoted secret may survive. All four cases have isolated reproductions. See S4, S19–S21.

The logger rotates the previous session at startup, but does not impose a session file-size or age limit. Its bounded in-memory queue does not bound disk retention during a long-running session. Transfer errors/requests include supplied raw URLs, which may contain sensitive query values. This does not establish that the final object-storage redirect URL is currently logged. See S6, S19, S20.

**Remediation.** Do not log auth response bodies or sensitive configuration values by default. Centralize URL/error/structured-field redaction. Redact complete bounded records before any emitted truncation; drop oversized raw lines with a constant marker rather than emitting secret prefixes. Test chunk boundaries and malformed/truncated records. Apply owner-only access and bounded retention to launcher-owned logs only. Document that manually shared Minecraft/mod logs may contain chat and identifiers and cannot be promised perfectly sanitized.

## SEC-10 — Automatic third-party requests disclose player identifiers

**Evidence.** `auth-view.ts` automatically requests `mc-heads.net/avatar/<UUID-or-name>/64`. The provider necessarily receives that identifier and the network connection, including the requesting IP address. Mod catalogue icons use metadata-supplied URLs directly. These are real request paths, not evidence of a hidden analytics SDK or a provider's retention policy. See S13, S22.

**Remediation.** Use local initials by default; offer a clearly explained opt-in for third-party avatars/images, or separately review a narrowly scoped Portal-proxy design. Restrict image origins, schemes, formats, sizes, redirects, and caching. Document mandatory Portal/game downloads separately from optional cosmetic requests. Do not claim the JVM telemetry flag disables every third-party mod's networking.

## SEC-11 — Resource limits are incomplete at ingestion boundaries

**Evidence.** Verified transfers count bytes but compare expected size after the complete body is written. JSON fetches parse unrestricted response bodies. Native archives are fully decompressed in memory without visible expanded-size/entry-count budgets; duplicate native basenames can overwrite one another. Several provisioning workers use `Promise.all` over worker loops rather than the project's quiescent failure coordination. See S6, S9, S10, S15, S16.

**Remediation.** Apply per-response, per-artifact, per-operation and decompression budgets. Enforce caps during streaming, not after allocation. Validate archive entries and detect basename collisions before publication. On a worker error, cancel remaining work and await every worker before releasing the operation lock. Keep bounded concurrency and successful classpath ordering.

**Qualification.** Extraction uses `path.basename()` for native outputs; a straightforward archive-entry `../` traversal is not demonstrated. The problem here is bounded resource consumption, collisions, and complete failure coordination—not an assumed ZIP-slip vulnerability.

## SEC-12 — Release assurance needs a stronger workflow boundary

**Evidence.** The release workflow sets global `contents: write`, including the dependency-install/build jobs. Third-party actions are referenced by mutable version tags. Publication depends on build artifacts, not a required typecheck/test/security-smoke job for the same tag SHA. Package settings and this workflow show no explicit signing/provenance steps. Frozen dependency installation and failure on missing artifacts are good existing controls. See S18, S23.

**Remediation.** Give build jobs read-only permissions, disable unnecessary checkout credential persistence, pin reviewed action commits, and gate publication on the exact release commit's checks. Audit the resolved lockfile and triage actual advisories rather than claiming vulnerable packages from version strings. Inspect actual Windows signatures and Linux provenance/checksums; implement signing only with approved key custody. Evaluate supported Electron fuses before signing. Preserve the existing packaging scope; no auto-updater is proposed.

**Qualification.** Branch protections, existing external signing, release binaries, and organization settings were not inspected. Their absence is not established. An unavailable signing credential is an explicit release-assurance dependency, not a reason to pretend signing succeeded or to block independent code fixes.

## Remediation order

Close credential-destination and generic OS-opening paths first. Then narrow IPC and lock down packaged navigation. Add secure session storage/lifecycle, fix shared path/schema boundaries and recovery, make artifact verification/fallback fail-closed, minimize logging/network disclosures, and harden CI/release validation. The companion plan provides phase gates, regression requirements, and the exact initial agent instruction.

## Evidence files

`evidence/source-behavior-probes.cjs` and `evidence/source-behavior-results.json` in the ZIP reproduce the eleven observations. Run the probes in a disposable working directory using Node; they write their results alongside the script. Convert the cases to tests of the actual modules during implementation. Do not import this copied vulnerable-helper code into production or count these observations as repaired tests.

## Pinned source index

- **S1:** [`src/main.ts` — `createWindow / IPC handlers`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/main.ts)
- **S2:** [`src/preload.ts` — `exposed LampasApi`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/preload.ts)
- **S3:** [`src/config.ts` — `normalizePortalUrl / ConfigManager`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/config.ts)
- **S4:** [`src/auth.ts` — `loginWithPortal / refreshSession / verifySession / logout`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/auth.ts)
- **S5:** [`src/game-runner.ts` — `launchGame / parseJavaArgs`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/game-runner.ts)
- **S6:** [`src/file-transfer.ts` — `fetchJsonWithRetry / streamVerified / downloadVerified / atomic writers`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/file-transfer.ts)
- **S7:** [`src/sync.ts` — `path validation / protected paths / portal fallback`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/sync.ts)
- **S8:** [`src/sync.ts` — `obsolete-file deletion / cache and publication`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/sync.ts)
- **S9:** [`src/fabric-meta.ts` — `metadata validation / sidecar resolution`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/fabric-meta.ts)
- **S10:** [`src/minecraft-bootstrap.ts` — `ensureFile / runtime provisioning`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/minecraft-bootstrap.ts)
- **S11:** [`src/game-directory.ts` — `scanDirectoryAsync / staged move`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/game-directory.ts)
- **S12:** [`ui/index.html` — `document head`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/ui/index.html)
- **S13:** [`ui/src/views/mods-view.ts` — `catalogue images and source links`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/ui/src/views/mods-view.ts)
- **S14:** [`src/sync.ts` — `getModCatalog / decorateModCatalog`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/sync.ts)
- **S15:** [`src/java-runtime.ts` — `checkJavaVersion / ensureJava25`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/java-runtime.ts)
- **S16:** [`src/minecraft-bootstrap.ts` — `native extraction / asset index handling`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/minecraft-bootstrap.ts)
- **S17:** [`src/game-directory.ts` — `readMoveReceipt / recoverInterruptedMove`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/game-directory.ts)
- **S18:** [`package.json` — `scripts / dependencies / build`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/package.json)
- **S19:** [`src/logger.ts` — `safeBoundedClone / init / log`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/logger.ts)
- **S20:** [`src/logger.ts` — `formatPayloadPreview / sanitize / API logging`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/logger.ts)
- **S21:** [`src/game-log-stream.ts` — `ProcessLogFramer`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/game-log-stream.ts)
- **S22:** [`ui/src/views/auth-view.ts` — `updateUserUI`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/ui/src/views/auth-view.ts)
- **S23:** [`.github/workflows/release-pack.yml` — `permissions / build / release`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/.github/workflows/release-pack.yml)
- **S24:** [`src/config-patches/reconciler.ts` — `isSafeConfigPatchPath / reconcileConfigPatches`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/config-patches/reconciler.ts)
- **S25:** [`src/client-mods.ts` — `modPath / add / setEnabled / remove`](https://github.com/justbecauseph/lampas-launcher/blob/3950e155a25c9effc004e2355dffa1722e46a6cc/src/client-mods.ts)

## Primary guidance used

- [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security): renderer isolation, sender validation, navigation, CSP and external opening.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage): backend behavior and limits, including Linux `basic_text` and same-user limitations.
- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html): external browser and native loopback redirect context.
- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) and [electron-builder fuse integration](https://www.electron.build/docs/tutorials/adding-electron-fuses): packaging controls to validate before signing.
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use): least privilege and action pinning.
- [Bun audit](https://bun.com/docs/pm/cli/audit): lockfile-based advisory checks; running it sends dependency information to advisory services.

These are reference guidance, not evidence that every current API is available in Electron 44.0.0. Confirm exact-version support before implementation.
