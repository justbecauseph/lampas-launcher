# Lampas Launcher architecture

Technical reference for building, releasing and maintaining Lampas Launcher. For players, see the [README](README.md).

## Platforms and tooling

- **Windows (x64):** Windows 10 and 11. GitHub Releases ship an NSIS installer and a portable `.exe`. The Microsoft Store AppX needs Windows 10 version 1809 (build 17763) or later (`appx.minVersion` `10.0.17763.0`).
- **Linux (x64):** AppImage and `.tar.gz` for glibc distributions.
- **Bun** `1.4.2` (pinned in CI), **Electron** `44.9.3`, **Vite** `^6.4.5` (renderer bundler), **TypeScript** `^5.8.2`, **electron-builder** `^26.15.3`.
- **Node.js** is not pinned. CI uses the runner's preinstalled `node` for the Electron install script, the fuse check and the packaged workflow test.

A Bun override pins electron-builder's `app-builder-lib` to `@electron/get` `5.1.0`, which removes the vulnerable `got`/`cacheable-request`/`http-cache-semantics` chain. Direct networking with default checksums is the intended configuration; custom Got proxy, TLS or `downloadOptions` settings are untested.

## Developer commands

```bash
bun install --frozen-lockfile
bun run typecheck        # main/preload (tsconfig.json) and renderer (tsconfig.renderer.json)
bun run format:check     # Prettier, as CI runs it
bun test                 # unit and integration tests
bun run smoke            # Electron smoke test (assets, fonts, preload, execution)
bun run benchmark        # warm sync, repair, move, logging, catalog search
bun run dev              # TypeScript watch + Vite + Electron
bun run build            # compile main/preload and bundle the renderer
bun run package:dir      # unpacked build, for testing packaged paths
bun run package:win      # Windows installer and portable exe
bun run package:appx     # Microsoft Store AppX (unsigned; the Store signs it)
bun run package:msix     # alias of package:appx
bun run package:linux    # AppImage and tar.gz
bun run package:all      # every platform
bun run package:test     # build the AppX, sign it with devcert.pfx and install it (Windows, pwsh)
```

`scripts/package-and-test.ps1` builds the AppX, signs it with `devcert.pfx` from the repository root (gitignored) using the password in `LAMPAS_DEVCERT_PASSWORD`, and installs it with `Add-AppxPackage`. It finds `signtool.exe` under `%LOCALAPPDATA%\electron-builder` and stops if `LAMPAS_DEVCERT_PASSWORD` is unset. The certificate must be trusted on the machine for the install to succeed.

## CI

`validate.yml` runs on pushes and pull requests to `main`, on Windows and Ubuntu: `bun audit`, `format:check`, typecheck, build, tests, `package:dir`, the fuse check (`scripts/verify-fuses.cjs`), the packaged smoke test and the packaged module workflow test. Packaging steps stop after 20 minutes.

Tests run under Bun, whose `node:http` differs from Electron's Node in places. For example, closing a server while a large response is still being sent cuts that response off under Bun but not under Node.

## Releases

Pushing a `v*` tag runs `release-pack.yml`: it validates and packages on Windows and Ubuntu, publishes the GitHub Release, posts to Discord and submits the AppX to the Microsoft Store. Running the workflow manually builds and uploads artifacts without publishing a release.

- Windows packages built by GitHub Actions are unsigned, so Windows may show a publisher warning. Microsoft signs the Store AppX during certification.
- Each release includes a CycloneDX SBOM per platform and `SHA256SUMS` files. The hashes do not prove publisher identity.
- GitHub artifact attestations are generated because the repository is public. A private repository generates them only when the `ENABLE_ARTIFACT_ATTESTATIONS` repository variable is `true`.
- Build artifacts are kept for 7 days, except tag-build Windows artifacts, which are kept for 90 days so a manual Store publish can use the AppX later.
- The `release` and `store` jobs post to Discord through the `DISCORD_WEBHOOK_URL` secret as **Releases**. A missing secret logs a warning, and a Discord error never fails a job.

### Microsoft Store

The Windows build also produces `LampasLauncher-<version>-Windows.appx`. It is checksummed with the other artifacts but not attached to the GitHub Release. After the GitHub Release is published, the `store` job submits it to the Microsoft Store (product ID `9P9WWSV7L7RS`) with the Microsoft Store Developer CLI. Certification takes from a few hours to a few days.

- Before submitting, the job runs `.github/scripts/store-preflight.sh`. It checks that there is exactly one AppX for this version and that it matches `SHA256SUMS`, that the Store credentials are set and accepted, the Partner Center submission status, and the Store's public version. On any failed check it skips the submission, posts the reason to Discord and still succeeds. Skips happen when a submission is still in certification or processing, when `msstore submission status` output isn't recognized, when the credentials are missing or rejected, or when the Store already has this version or a newer one.
- To submit a skipped release after certification finishes, run **Actions → Microsoft Store Status → Run workflow** from `main` with `action` set to `publish`. Leave `tag` empty for the latest GitHub release, or enter one such as `v1.6.2`. It runs the same preflight, but any skip fails the run. It needs a published, non-prerelease release whose `release-pack.yml` tag run succeeded, and it takes the AppX from that run's artifact.
- The Store steps need the secrets `AZURE_AD_TENANT_ID`, `AZURE_AD_APPLICATION_CLIENT_ID`, `AZURE_AD_APPLICATION_SECRET` and `SELLER_ID`. The Entra application needs the **Manager** role under Partner Center → User management → Microsoft Entra applications.
- `msstore publish` accepts only `.msix`, `.msixbundle` and `.msixupload`, so the job uploads the AppX under an `.msix` name. Partner Center rejects MSIX uploads with a `MinVersion` of `10.0.17134.0` or lower, so `appx.minVersion` must stay at `10.0.17763.0` or higher.
- The job replaces a pending submission created through the API, but fails if a draft started in the Partner Center web UI exists. Submit or delete such drafts before tagging.
- Every Store upload needs a higher package version. electron-builder maps `X.Y.Z` to `X.Y.Z.0`.
- Store installs don't show the launcher's GitHub update notice, because the Store delivers updates.
- `store-status.yml` runs every 6 hours (`0 */6 * * *` UTC) and only reports. It compares the latest release with the Store's Display Catalog and, when the four Store secrets are set, the Partner Center submission status. It posts once per tag when the version becomes installable or its submission fails, using Actions caches named `store-notified-<tag>-live` and `store-notified-<tag>-failed` as one-time markers, so run it from the default branch.

### Store installs and AppData redirection

Windows redirects files and folders that a Store (MSIX) app creates under `%APPDATA%` or `%LOCALAPPDATA%` into the package's private folder (`%LOCALAPPDATA%\Packages\<package family name>\LocalCache\Roaming` or `\Local`). Only the app sees the redirected copy. Programs outside the package, such as the game's Java, Explorer and Notepad, see the real path. Changes to files that already existed in the real folder are written in place.

The launcher handles this as follows:

- The default game folder for Store installs is `LocalCache\.minecraft-lampas` in the package folder, written directly so every program sees it. Windows deletes it on uninstall. The Play footer shows it as **Default location**, and first-run setup explains it.
- If a configured game folder under AppData has a redirected copy that holds an install, the launcher switches to that copy's real path at startup and again before launch (`resolveStoreGameDir`).
- Paths opened in Explorer or Notepad (game folder, mods, logs) go through `toExternalPath`, which picks the redirected copy when one exists.
- A Store install can't move its game folder into AppData, or create a new one there during setup. Setup can still adopt an AppData folder that already exists for real, such as one left by a non-Store build.
- When **Remove game files** deletes a launcher-created folder, the Store build switches to its own default folder.

## Sync and repair

- **Fast sync** runs before every launch. A managed file whose size and modification time match the record in `.lampas/installation.json` is accepted without hashing. Downloads are SHA-256 verified while streaming and placed atomically.
- **Full repair** (**Repair game files** on the Mods tab, **Repair game files** in Settings, or **Repair and try again** after a failed launch) hashes every managed mod, config and asset with SHA-256. It checks the Minecraft client jar, libraries, natives and asset index against the SHA-1 digests in the bundled `version-meta-26.2.json`, and Fabric libraries against the `.sha256` sidecars on the Fabric Maven repository (falling back to `.sha1`). It replaces anything that doesn't match.
- A hash or size mismatch on download is retried only when the body has the wrong size, since CDNs sometimes return an empty or truncated body. Wrong bytes of the right size fail at once, and the error stays classified as an integrity failure.

### File ownership

- **`MANAGED`:** Lampas owns the whole file. It is synchronized and verified, and removed when the pack drops it.
- **`PRESERVE`:** the player or the mod owns the file. Lampas only seeds it when missing.
- **Config patch, `enforce`:** the player owns the file; Lampas keeps the declared properties set and leaves everything else, comments and formatting intact.
- **Config patch, `once`:** Lampas sets recommended values once, then leaves them alone.
- **Pack seeds** (`options.txt`, `servers.dat`) are placed only when the player has none, and are never recorded as managed.
- **Player data** is never synchronized over: `saves/`, `screenshots/`, `logs/`, `crash-reports/`, `options.txt`, `servers.dat`, `usercache.json`, `hotbar.nbt` and `realms_persistence.json` (`PROTECTED_PLAYER_DATA` in `src/path-policy.ts`). Keybind patches change only the declared key lines in `options.txt`, once.

## Fabric runtime

- The release descriptor and client manifest name the exact Minecraft and Fabric Loader versions (`runtime: { minecraft, loader: { type: "fabric", version } }`). The launcher never chooses a loader version, and checks that both agree before any download or deletion.
- `FabricMetaResolver` (`src/fabric-meta.ts`) asks the Fabric Meta API (`/v2/versions/loader/{minecraft}/{loader}`) for the loader, intermediary and libraries, and the client main class.
- The classpath contains only the active loader's libraries, so older loaders left on disk never load.
- Client bootstrap supports Minecraft `26.2` only.
- Launch, sync and repair use the same manifest-defined runtime.
- Java: a configured Java path is used if it is Java 25 or newer, then a managed runtime in the game folder, then Java 25 found on the system; otherwise the launcher downloads Mojang's Java runtime.

## Moving the game folder

- A move on the same drive is a rename. Across drives, `scanDirectoryAsync` inventories the source and `streamCopyAndHash` copies into a staging folder with up to 6 concurrent streams, then reads the copies back to verify them. Empty folders are kept. Symlinks and junctions fail the move before anything is deleted.
- Before promoting the staging folder or deleting the source, the launcher rescans the source and stops if anything changed during the copy.
- The move journal records each phase (`preparing`, `renaming`, `copying`, `verifying`, `finalizing`, `cleaning`). After a crash or power loss, `recoverInterruptedMove` runs at startup before anything else can change files: it removes an incomplete staging folder or promotes a verified one. An invalid journal is quarantined and nothing is deleted.

## Game process

- The game is spawned detached, so it keeps running when the launcher closes. The launcher records the session and adopts the running game on its next start. Live console output isn't available for an adopted game; the Minecraft log is.
- **Stop** sends `SIGTERM`, then `SIGKILL` after 5 seconds. On Windows, `SIGTERM` already ends the process immediately.

## Sign-in

- Sign-in uses a loopback OAuth callback with PKCE. The local server accepts only `GET /callback` with the expected host and state, answers once, and closes after the response has been sent (capped at 1 second). The callback pages inline their fonts because the server is gone by the time the browser could fetch them.
- The game launches only with a Minecraft access token from a Microsoft sign-in, passed with `--userType msa`. The token comes from the Lampas Portal session. `minecraftTokenProblem` (`src/game-runner.ts`) requires a JWT whose payload decodes and whose `exp`, when present, hasn't passed (with one minute of clock allowance); the launcher can't verify the signature. A missing, malformed or expired token stops the launch with `AuthRequiredError` before Java is prepared. There is no offline-mode fallback.
- **Play** first calls `game:checkReady`, which refreshes the session and runs the same identity check (`resolveLaunchIdentity`) without syncing anything. A player who can't launch sees what to fix before any download, and **Repair and try again** isn't offered for it. `game:launch` checks again.
- Sign-in errors that the player has to act on (`AuthRequiredError`) reach the renderer with their message, capped at 120 characters. Other unexpected errors show a generic message.
- A game that an older launcher started in legacy mode can still be adopted after an upgrade; adoption attaches to a running process and never starts one.

## Logging and console

- `src/logger.ts` writes `launcher.log` through an asynchronous queue capped at 5 MB or 10,000 records, rotates at 5 MB into `launcher.previous.log` and `launcher.older.log`, and limits a record to 16 KB. Secret fields such as `token`, `refreshToken` and `minecraftAccessToken` are replaced with `[REDACTED]` before a record is written or sent to the renderer.
- `src/game-log-stream.ts` decodes the game's stdout and stderr as streaming UTF-8 and truncates lines at 16,384 characters. Lines go to the renderer in batches of up to 64 KB, one batch in flight at a time; the queue holds up to 2,000 lines or 2 MB while the renderer hasn't acknowledged the last batch.
- The console view keeps the last 1,000 lines, appends through a `DocumentFragment`, and scrolls to new lines while the **Auto-scroll** checkbox is on.
- **Launcher log** opens `launcher.log`; **Minecraft log** opens the game folder's `logs/latest.log`.
