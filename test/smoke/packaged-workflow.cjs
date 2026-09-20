/*
 * Packaged module workflow smoke fixture.
 *
 * Run with the pinned Electron executable, an explicit app.asar, and a fresh
 * disposable profile. This loads the compiled modules from the ASAR and never
 * uses the installed/default profile or the user's real game directory.
 *
 *   electron.exe test/smoke/packaged-workflow.cjs \
 *     --asar=release/win-unpacked/resources/app.asar \
 *     --user-data-dir=%TEMP%\\lampas-packaged-workflow-...
 */

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { app } = require("electron");

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function fail(message) {
  throw new Error(`[packaged-workflow] ${message}`);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    Connection: "close",
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function loadPackagedModule(asarPath, name) {
  const modulePath = path.join(asarPath, "dist", `${name}.js`);
  if (!fs.existsSync(modulePath)) fail(`ASAR is missing dist/${name}.js`);
  return require(modulePath);
}

function assertFile(pathname, expected) {
  assert.equal(
    fs.readFileSync(pathname, "utf8"),
    expected,
    `unexpected contents for ${pathname}`,
  );
}

async function closeFixtureLogger(LauncherLogger) {
  try {
    await Promise.race([
      LauncherLogger.close(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {}
}

async function runChildMode(
  asarPath,
  mode,
  userDataDir,
  portalPolicy,
  configModule,
  syncModule,
  loggerModule,
) {
  const { ConfigManager } = configModule;
  const { LauncherSync } = syncModule;
  const { LauncherLogger } = loggerModule;
  const gameDir = path.join(userDataDir, "game");
  const portal = "http://127.0.0.1:45873";
  ConfigManager.resetForTesting();
  ConfigManager.get();
  ConfigManager.set({
    portalUrl: portal,
    selectedChannel: "stable",
    gameDir,
    gameDirConfigured: true,
    noSync: false,
  });

  if (mode === "crash-repair") {
    if (typeof LauncherSync.repairInstallationInternal !== "function") {
      fail(
        "packaged ASAR does not expose the repair boundary needed by the crash fixture",
      );
    }
    // This fault is deliberately installed at the private repair boundary. It
    // proves the public repair preflight has durable state before an abrupt
    // child-process exit; it does not pretend to be a full Java repair.
    const injectedRepair = async () => {
      process.stderr.write(
        "packaged-workflow: injected repair boundary reached\\n",
      );
      // Electron wraps process.exit while the app is alive. Terminate the
      // disposable child directly and keep this async frame pending so the
      // public repair catch cannot run first.
      process.kill(process.pid, "SIGTERM");
      await new Promise(() => {});
    };
    LauncherSync.repairInstallationInternal = injectedRepair;
    assert.equal(
      LauncherSync.repairInstallationInternal,
      injectedRepair,
      "repair boundary injection must replace the compiled method",
    );
    await LauncherSync.repairInstallation(() => {});
    fail(
      "crash-repair child returned without exiting at the injected boundary",
    );
  }

  if (mode === "admission-check") {
    const safetyModule = loadPackagedModule(asarPath, "sync-safety");
    try {
      safetyModule.assertSyncSafetyAdmission({
        origin: portal,
        channel: "stable",
        gameDir,
      });
      fail(
        "fresh process admitted synchronization after an interrupted repair",
      );
    } catch (error) {
      if (
        error?.name !== "SyncSafetyBlockError" ||
        error?.block?.reason !== "INTEGRITY"
      )
        throw error;
      process.stderr.write(
        `${JSON.stringify({ packagedWorkflowAdmission: "blocked", reason: error.block.reason })}\n`,
      );
    }
    await closeFixtureLogger(LauncherLogger);
    portalPolicy.PortalPolicy.resetForTesting();
    return;
  }

  fail(`unknown packaged workflow child mode '${mode}'`);
}

function runCrashRestartProbe(asarPath) {
  const crashProfile = path.join(
    os.tmpdir(),
    `lampas-packaged-workflow-crash-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(crashProfile, { recursive: true, mode: 0o700 });
  const childArgs = (mode) => [
    __filename,
    `--mode=${mode}`,
    `--asar=${asarPath}`,
    `--user-data-dir=${crashProfile}`,
    ...(process.platform === "linux" ? ["--password-store=basic"] : []),
  ];
  const crashed = spawnSync(process.execPath, childArgs("crash-repair"), {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  // Platform shutdown paths report different statuses. Assert the injected
  // boundary and durable state rather than depending on one exit code.
  assert.equal(
    crashed.error,
    undefined,
    `repair crash child must terminate before timeout: ${crashed.error}`,
  );
  assert.match(crashed.stderr || "", /injected repair boundary reached/);
  assert.doesNotMatch(crashed.stderr || "", /"packagedWorkflow":"failed"/);
  const markerPath = path.join(
    crashProfile,
    "game",
    ".lampas",
    "sync-safety.json",
  );
  assert.equal(
    fs.existsSync(markerPath),
    true,
    "repair crash child must durably publish sync-safety.json before exit",
  );
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(marker.reason, "INTEGRITY");
  const admission = spawnSync(process.execPath, childArgs("admission-check"), {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(
    admission.status,
    0,
    `fresh admission child must reject the durable repair marker (stderr: ${admission.stderr || ""})`,
  );
  assert.match(admission.stderr || "", /"packagedWorkflowAdmission":"blocked"/);
  return {
    markerPath,
    childExit: crashed.status,
    admissionExit: admission.status,
  };
}

async function run() {
  const asarPath = path.resolve(argument("asar"));
  const userDataDir = path.resolve(argument("user-data-dir"));
  if (!asarPath || !asarPath.endsWith(".asar") || !fs.existsSync(asarPath)) {
    fail("requires an existing --asar=/absolute/or/relative/app.asar");
  }
  if (
    !userDataDir ||
    !path.basename(userDataDir).startsWith("lampas-packaged-workflow-")
  ) {
    fail(
      "requires a fresh --user-data-dir whose basename starts with lampas-packaged-workflow-",
    );
  }
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  app.setPath("userData", userDataDir);

  await app.whenReady();

  // The loopback exception is an explicit fixture policy. It is scoped to this
  // process and cannot expand the production packaged Portal allowlist.
  const portalPolicy = loadPackagedModule(asarPath, "portal-policy");
  portalPolicy.PortalPolicy.configureDevelopmentPolicy({ allowLoopback: true });
  portalPolicy.PortalPolicy.setProductionOverride(false);

  const configModule = loadPackagedModule(asarPath, "config");
  const sessionModule = loadPackagedModule(asarPath, "session-manager");
  const authModule = loadPackagedModule(asarPath, "auth");
  const syncModule = loadPackagedModule(asarPath, "sync");
  const gameDirModule = loadPackagedModule(asarPath, "game-directory");
  const modsModule = loadPackagedModule(asarPath, "client-mods");
  const loggerModule = loadPackagedModule(asarPath, "logger");
  const { ConfigManager } = configModule;
  const { SessionManager } = sessionModule;
  const { LauncherAuth } = authModule;
  const { LauncherSync } = syncModule;
  const { GameDirectoryManager } = gameDirModule;
  const { ClientModManager } = modsModule;
  const { LauncherLogger } = loggerModule;

  const mode = argument("mode");
  if (mode) {
    await runChildMode(
      asarPath,
      mode,
      userDataDir,
      portalPolicy,
      configModule,
      syncModule,
      loggerModule,
    );
    return;
  }

  const artifact = Buffer.from(
    "lampas-packaged-workflow-artifact-v1\n",
    "utf8",
  );
  const artifactHash = crypto
    .createHash("sha256")
    .update(artifact)
    .digest("hex");
  const version = "9.9.9";
  const user = {
    id: "packaged-fixture-account",
    name: "Packaged Fixture User",
    minecraftUuid: "11111111-1111-4111-8111-111111111111",
    minecraftUsername: "PackagedFixture",
    minecraftAccessToken: "fixture-minecraft-access",
    isAdmin: false,
    isTech: false,
    roles: [],
    allowedChannels: ["stable"],
  };
  const requests = [];
  let activeToken = "fixture-token-v1";
  let refreshToken = "fixture-refresh-v1";

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    const body = req.method === "POST" ? await readRequestBody(req) : "";
    requests.push({
      method: req.method,
      path: requestUrl.pathname,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [
          key,
          String(value || ""),
        ]),
      ),
      body,
    });

    const portal = `http://127.0.0.1:${server.address().port}`;
    const release = {
      $schema: "https://example.invalid/lampas/release.schema.json",
      schemaVersion: 1,
      pack: "Packaged Fixture Pack",
      version,
      minecraft: "26.2",
      loader: { type: "fabric", version: "0.18.4" },
      minimumLauncherVersion: "1.0.0",
      protocol: 3,
      created: "2026-09-20T00:00:00.000Z",
      clientManifest: `${portal}/api/v1/releases/${version}/client-manifest`,
      serverManifest: `${portal}/api/v1/releases/${version}/server-manifest`,
      totalMods: 1,
      totalFiles: 1,
    };
    const manifest = {
      $schema: "https://example.invalid/lampas/client-manifest.schema.json",
      schemaVersion: 2,
      pack: release.pack,
      version,
      target: "client",
      minecraft: release.minecraft,
      loader: release.loader,
      protocol: release.protocol,
      mods: [
        {
          id: "fixture-mod",
          name: "Fixture Mod",
          side: "client",
          filename: "fixture.jar",
          size: artifact.length,
          description: "Synthetic packaged workflow artifact",
          categories: ["fixture"],
        },
      ],
      files: [
        {
          path: "mods/fixture.jar",
          size: artifact.length,
          hashes: { sha256: artifactHash },
          download: {
            url: `${portal}/artifacts/fixture.jar`,
            provider: "lampas",
          },
          policy: "MANAGED",
        },
      ],
      configPatches: [
        {
          id: "fixture-config",
          revision: 1,
          path: "config/fixture.json",
          adapter: "json",
          mode: "once",
          missingFile: "create",
          operations: [
            { op: "set", path: ["fixture", "enabled"], value: true },
          ],
        },
      ],
    };

    if (requestUrl.pathname === `/api/v1/channels/stable`) {
      return json(res, 200, {
        channel: "stable",
        version,
        release: `/api/v1/releases/${version}`,
      });
    }
    if (requestUrl.pathname === `/api/v1/releases/${version}`)
      return json(res, 200, release);
    if (requestUrl.pathname === `/api/v1/releases/${version}/client-manifest`)
      return json(res, 200, manifest);
    if (requestUrl.pathname === `/api/v1/releases/${version}/server-manifest`)
      return json(res, 200, { version });
    if (requestUrl.pathname === "/artifacts/fixture.jar") {
      res.writeHead(200, {
        "Content-Type": "application/java-archive",
        "Content-Length": String(artifact.length),
        Connection: "close",
      });
      return res.end(artifact);
    }
    if (requestUrl.pathname === "/api/v1/auth/verify") {
      if (req.headers.authorization !== `Bearer ${activeToken}`)
        return json(res, 401, { valid: false });
      return json(res, 200, {
        valid: true,
        user: { ...user, minecraftAccessToken: undefined },
      });
    }
    if (requestUrl.pathname === "/api/v1/auth/refresh") {
      if (req.headers.authorization !== `Bearer ${activeToken}`)
        return json(res, 401, { valid: false });
      const parsed = body ? JSON.parse(body) : {};
      if (parsed.refreshToken !== refreshToken)
        return json(res, 401, { valid: false });
      activeToken = "fixture-token-v2";
      refreshToken = "fixture-refresh-v2";
      return json(res, 200, { token: activeToken, refreshToken, user });
    }
    if (requestUrl.pathname === "/api/v1/auth/exchange") {
      return json(res, 200, { token: activeToken, refreshToken, user });
    }
    return json(res, 404, { error: "fixture route not found" });
  });

  let serverClosed = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const portal = `http://127.0.0.1:${server.address().port}`;
    const sourceGameDir = path.join(userDataDir, "game-source");
    const movedGameDir = path.join(userDataDir, "game-moved");
    const failedMoveTarget = path.join(userDataDir, "game-nonempty-target");
    const recoveryTarget = path.join(userDataDir, "game-recovery-target");
    const sourceMod = path.join(userDataDir, "fixture-custom.jar");

    ConfigManager.resetForTesting();
    const initial = ConfigManager.get();
    ConfigManager.set({
      portalUrl: portal,
      selectedChannel: "stable",
      gameDir: sourceGameDir,
      gameDirConfigured: true,
      noSync: false,
      externalImages: false,
    });

    // Seed only a validated fixture identity. Refresh, verify, and logout below
    // still traverse the compiled authenticated session and credential-store APIs.
    SessionManager.establishNewSession(
      portal,
      {
        token: activeToken,
        refreshToken,
        minecraftAccessToken: user.minecraftAccessToken,
        portalAccountId: user.id,
        portalUsername: user.name,
        minecraftUuid: user.minecraftUuid,
        minecraftUsername: user.minecraftUsername,
      },
      user,
    );
    const verified = await LauncherAuth.verifySession();
    assert.equal(
      verified.valid,
      true,
      "packaged verify must accept fixture session",
    );
    const refreshed = await LauncherAuth.refreshSession();
    assert.equal(
      refreshed.valid,
      true,
      "packaged refresh must accept fixture session",
    );
    assert.equal(SessionManager.getCredentials().token, "fixture-token-v2");

    const syncProgress = [];
    const synced = await LauncherSync.syncClient(
      (progress) => syncProgress.push(progress),
      "full",
    );
    assert.equal(synced.success, true);
    assert.equal(synced.version, version);
    assert.ok(syncProgress.some((item) => item.status === "complete"));
    assertFile(
      path.join(sourceGameDir, "mods", "fixture.jar"),
      artifact.toString("utf8"),
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(sourceGameDir, "config", "fixture.json"),
          "utf8",
        ),
      ),
      { fixture: { enabled: true } },
    );
    assert.ok(
      fs.existsSync(path.join(sourceGameDir, ".lampas", "installation.json")),
    );

    const catalog = await LauncherSync.getModCatalog();
    assert.equal(
      catalog.find((item) => item.id === "fixture-mod")?.enabled,
      true,
    );
    ClientModManager.setOfficialEnabled("fixture-mod", false);
    assert.equal(
      (await LauncherSync.getModCatalog()).find(
        (item) => item.id === "fixture-mod",
      )?.enabled,
      false,
    );
    await LauncherSync.syncClient(() => {}, "full");
    assert.equal(
      fs.existsSync(path.join(sourceGameDir, "mods", "fixture.jar")),
      false,
      "disabled official fixture must be removed from managed install",
    );
    ClientModManager.setOfficialEnabled("fixture-mod", true);
    await LauncherSync.syncClient(() => {}, "full");
    assert.equal(
      fs.existsSync(path.join(sourceGameDir, "mods", "fixture.jar")),
      true,
      "re-enabled official fixture must be restored",
    );

    fs.writeFileSync(sourceMod, "fixture-custom-mod\n", "utf8");
    ClientModManager.add([sourceMod]);
    assert.equal(
      fs.existsSync(path.join(sourceGameDir, "mods", "fixture-custom.jar")),
      true,
    );
    ClientModManager.setEnabled("fixture-custom.jar", false);
    assert.equal(
      fs.existsSync(
        path.join(sourceGameDir, "mods", "fixture-custom.jar.disabled"),
      ),
      true,
    );
    ClientModManager.setEnabled("fixture-custom.jar", true);
    ClientModManager.remove("fixture-custom.jar");
    assert.equal(
      fs.existsSync(path.join(sourceGameDir, "mods", "fixture-custom.jar")),
      false,
    );

    const validStatePath = path.join(
      sourceGameDir,
      ".lampas",
      "installation.json",
    );
    const validState = fs.readFileSync(validStatePath, "utf8");
    fs.writeFileSync(validStatePath, '{"files":"malformed"}\n', "utf8");
    let repairFailed = false;
    try {
      await LauncherSync.repairInstallation(() => {});
    } catch (error) {
      repairFailed = /installation state is malformed/i.test(
        String(error && error.message),
      );
    }
    assert.equal(
      repairFailed,
      true,
      "repair must fail closed on malformed managed state",
    );
    assert.equal(
      fs.existsSync(path.join(sourceGameDir, ".lampas", "sync-safety.json")),
      true,
      "failed repair must leave a durable sync safety marker",
    );
    fs.writeFileSync(validStatePath, validState, "utf8");
    await LauncherSync.syncClient(() => {}, "full");

    ConfigManager.set({ noSync: true });
    assert.equal(
      ConfigManager.get().noSync,
      true,
      "no-sync setting must persist in packaged config module",
    );
    ConfigManager.set({ noSync: false });

    const badTargetSentinel = path.join(failedMoveTarget, "sentinel.txt");
    fs.mkdirSync(failedMoveTarget, { recursive: true });
    fs.writeFileSync(badTargetSentinel, "preserve-me\n", "utf8");
    await assert.rejects(
      () => GameDirectoryManager.moveInstallation(failedMoveTarget),
      /not empty/i,
    );
    assertFile(badTargetSentinel, "preserve-me\n");

    const moved = await GameDirectoryManager.moveInstallation(movedGameDir);
    assert.equal(moved.success, true);
    assert.equal(ConfigManager.get().gameDir, path.resolve(movedGameDir));
    assert.equal(fs.existsSync(sourceGameDir), false);
    assertFile(
      path.join(movedGameDir, "mods", "fixture.jar"),
      artifact.toString("utf8"),
    );

    // Simulate a process restart after an earlier move phase. Recovery should
    // discard only the incomplete journal and preserve the configured source.
    const journalPath = path.join(userDataDir, "directory-move.json");
    const operationId = "fixture-recovery-1";
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        version: 2,
        operationId,
        source: path.resolve(movedGameDir),
        target: path.resolve(recoveryTarget),
        staging: path.join(userDataDir, `.lampas-moving-${operationId}`),
        phase: "copying",
        timestamp: new Date().toISOString(),
      }),
      "utf8",
    );
    await GameDirectoryManager.recoverInterruptedMove();
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(
      fs.existsSync(movedGameDir),
      true,
      "incomplete move recovery must preserve source",
    );

    const crashRestart = runCrashRestartProbe(asarPath);

    const artifactRequests = requests.filter(
      (request) => request.path === "/artifacts/fixture.jar",
    );
    assert.ok(
      artifactRequests.length >= 1,
      "fixture artifact must be fetched through packaged transfer code",
    );
    assert.ok(
      artifactRequests.every(
        (request) => !request.headers.authorization && !request.headers.cookie,
      ),
      "artifact requests must not carry credentials",
    );
    const metadataRequests = requests.filter((request) =>
      request.path.includes("/api/v1/"),
    );
    assert.ok(
      metadataRequests.some((request) =>
        request.path.endsWith("/channels/stable"),
      ),
    );
    assert.ok(
      metadataRequests.some(
        (request) =>
          request.headers.authorization === "Bearer fixture-token-v2" ||
          request.headers.authorization === "Bearer fixture-token-v1",
      ),
    );

    const logoutResult = LauncherAuth.logout();
    assert.equal(logoutResult.success, true);
    assert.equal(SessionManager.getCredentials(), null);
    assert.equal(ConfigManager.get().token, undefined);

    await LauncherLogger.flush();
    const diagnosticFiles = [path.join(userDataDir, "config.json")];
    const logDirectory = path.join(userDataDir, "logs");
    if (fs.existsSync(logDirectory)) {
      for (const name of fs.readdirSync(logDirectory)) {
        if (/^launcher(?:\.previous|\.older)?\.log$/.test(name))
          diagnosticFiles.push(path.join(logDirectory, name));
      }
    }
    for (const file of diagnosticFiles) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const secret of [
        "fixture-token-v1",
        "fixture-token-v2",
        "fixture-refresh-v1",
        "fixture-refresh-v2",
        "fixture-minecraft-access",
      ]) {
        assert.equal(
          text.includes(secret),
          false,
          `synthetic credential leaked into ${file}`,
        );
      }
    }

    process.stderr.write(
      `${JSON.stringify({
        packagedWorkflow: "passed",
        asar: asarPath,
        platform: process.platform,
        checks: [
          "authenticated verify/refresh/logout",
          "Portal metadata and credential-free artifact transfer",
          "sync, managed config patch, official mod toggle",
          "custom mod import/toggle/remove",
          "repair fail-closed malformed-state boundary",
          "no-sync settings persistence",
          "directory move destination error and success",
          "incomplete move restart recovery",
          "repair preflight crash durability and fresh-process admission block",
          "synthetic credentials absent from configuration and flushed launcher logs",
        ],
        crashRestart,
        requestCount: requests.length,
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    if (!serverClosed) {
      serverClosed = true;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    try {
      // A packaged smoke process must terminate even if Electron has already
      // begun shutting down a logger stream. The logger owns its own bounded
      // close path; this outer bound prevents a fixture failure from becoming
      // an orphaned Electron process.
      await Promise.race([
        LauncherLogger.close(),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {}
    try {
      portalPolicy.PortalPolicy.resetForTesting();
    } catch {}
  }
}

run()
  .then(() => app.exit(0))
  .catch(async (error) => {
    process.stderr.write(
      `${JSON.stringify({ packagedWorkflow: "failed", error: error?.stack || String(error) })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    app.exit(1);
  });
