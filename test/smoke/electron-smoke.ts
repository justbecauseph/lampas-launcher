import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { sanitizeLogText } from "../../src/privacy";

interface SmokeCheckResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: SmokeCheckResult[] = [];

function check(name: string, fn: () => { passed: boolean; details: string }) {
  try {
    const res = fn();
    results.push({ name, ...res });
  } catch (err: any) {
    results.push({
      name,
      passed: false,
      details: `Exception: ${err?.message || err}`,
    });
  }
}

async function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 15000,
  extraEnv: Record<string, string> = {},
  prepareProfile?: (profile: string) => void,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  profile: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Each Electron invocation gets an empty profile, including packaged runs.
    // Never read or migrate the developer's real credentials during a smoke test.
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "lampas-electron-smoke-"),
    );
    const profile = path.join(fixtureRoot, "user-data");
    prepareProfile?.(profile);
    console.log(`[Disposable smoke profile: ${fixtureRoot}]`);

    const proc = spawn(
      cmd,
      [...args, `--user-data-dir=${path.join(fixtureRoot, "user-data")}`],
      {
        cwd,
        shell: process.platform === "win32" && cmd.endsWith(".cmd"),
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: "1",
          LAMPAS_DEFAULT_GAME_DIR: path.join(fixtureRoot, "game"),
          ...extraEnv,
        },
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });

    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      // The Windows portable wrapper does not forward its child console. Read
      // only this invocation's fresh profile so its actual application events
      // provide the same evidence as an unpacked executable's stdout.
      const logPath = path.join(
        fixtureRoot,
        "user-data",
        "logs",
        "launcher.log",
      );
      if (fs.existsSync(logPath))
        stdout += "\n" + fs.readFileSync(logPath, "utf8");
      if (code !== 0 || timedOut) {
        console.error(
          `[Smoke process failed: ${path.basename(cmd)}, exit=${code}, signal=${signal}, timedOut=${timedOut}]`,
        );
        console.error(sanitizeLogText((stdout + "\n" + stderr).slice(-16000)));
      }
      resolve({ code, stdout, stderr, timedOut, profile });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      stderr += err.message;
      resolve({ code: -1, stdout, stderr, timedOut, profile });
    });
  });
}

async function main() {
  console.log("=== Lampas Launcher Smoke Test Harness ===\n");
  const rootDir = path.resolve(__dirname, "../..");

  // Check 1: Emitted Build Artifacts
  check("Build Artifacts: Main and Preload JS", () => {
    const mainPath = path.join(rootDir, "dist/main.js");
    const preloadPath = path.join(rootDir, "dist/preload.js");
    const mainExists =
      fs.existsSync(mainPath) && fs.statSync(mainPath).size > 1000;
    const preloadExists =
      fs.existsSync(preloadPath) && fs.statSync(preloadPath).size > 1000;
    return {
      passed: mainExists && preloadExists,
      details: `main.js: ${mainExists ? "OK" : "MISSING"}, preload.js: ${preloadExists ? "OK" : "MISSING"}`,
    };
  });

  // Check 2: Bundled Renderer Assets
  check("Build Artifacts: Renderer HTML, Bundled JS/CSS", () => {
    const htmlPath = path.join(rootDir, "dist/renderer/index.html");
    const assetsDir = path.join(rootDir, "dist/renderer/assets");
    if (!fs.existsSync(htmlPath)) {
      return {
        passed: false,
        details: "dist/renderer/index.html does not exist",
      };
    }
    const htmlContent = fs.readFileSync(htmlPath, "utf-8");
    const hasScript = htmlContent.includes('<script type="module"');
    const assetsExist = fs.existsSync(assetsDir);
    const assetFiles = assetsExist ? fs.readdirSync(assetsDir) : [];
    const hasJs = assetFiles.some((f) => f.endsWith(".js"));
    const hasCss = assetFiles.some((f) => f.endsWith(".css"));

    return {
      passed: hasScript && hasJs && hasCss,
      details: `index.html script module: ${hasScript}, bundle js: ${hasJs}, bundle css: ${hasCss} (${assetFiles.length} assets total)`,
    };
  });

  // Check 3: Bundled Fonts and License
  check("Font Packaging: Local WOFF2 subsets and OFL 1.1 License", () => {
    const fontDir = path.join(rootDir, "ui/assets/fonts");
    const licensePath = path.join(fontDir, "LICENSE.txt");
    const expectedFonts = [
      "IBMPlexMono-Regular.woff2",
      "IBMPlexMono-Medium.woff2",
      "IBMPlexMono-SemiBold.woff2",
      "IBMPlexSans-Regular.woff2",
      "IBMPlexSans-Medium.woff2",
      "IBMPlexSans-SemiBold.woff2",
      "IBMPlexSans-Bold.woff2",
      "Rajdhani-SemiBold.woff2",
      "Rajdhani-Bold.woff2",
    ];

    const missingFonts = expectedFonts.filter(
      (f) => !fs.existsSync(path.join(fontDir, f)),
    );
    const licenseExists = fs.existsSync(licensePath);
    const licenseValid =
      licenseExists &&
      fs.readFileSync(licensePath, "utf-8").includes("SIL OPEN FONT LICENSE");

    return {
      passed: missingFonts.length === 0 && licenseValid,
      details:
        missingFonts.length === 0 && licenseValid
          ? `All 9 WOFF2 fonts present with valid SIL Open Font License 1.1`
          : `Missing fonts: ${missingFonts.join(", ") || "none"}, License valid: ${licenseValid}`,
    };
  });

  // Check 4: Remote CDN Font Isolation
  check("Font Isolation: Zero Google Fonts remote links in UI", () => {
    const htmlPath = path.join(rootDir, "ui/index.html");
    const cssPath = path.join(rootDir, "ui/styles.css");
    const html = fs.readFileSync(htmlPath, "utf-8");
    const css = fs.readFileSync(cssPath, "utf-8");
    const hasRemoteHtml =
      html.includes("fonts.googleapis.com") ||
      html.includes("fonts.gstatic.com");
    const hasRemoteCss =
      css.includes("fonts.googleapis.com") || css.includes("fonts.gstatic.com");

    return {
      passed: !hasRemoteHtml && !hasRemoteCss,
      details: `Remote links in index.html: ${hasRemoteHtml ? "FOUND (FAIL)" : "NONE"}, in styles.css: ${hasRemoteCss ? "FOUND (FAIL)" : "NONE"}`,
    };
  });

  const isStrict = process.argv.includes("--strict");
  const javaArgument = process.argv.find((argument) =>
    argument.startsWith("--smoke-java="),
  );
  const smokeArguments = [
    "--smoke-test",
    ...(javaArgument ? [javaArgument] : []),
  ];

  let electronBin =
    process.platform === "win32"
      ? path.join(rootDir, "node_modules/electron/dist/electron.exe")
      : path.join(rootDir, "node_modules/.bin/electron");

  if (!fs.existsSync(electronBin)) {
    try {
      const resolved = require("electron");
      if (typeof resolved === "string" && fs.existsSync(resolved)) {
        electronBin = resolved;
      }
    } catch {}
  }

  if (fs.existsSync(electronBin)) {
    console.log(
      `[Executing Real Electron Smoke Test via ${path.basename(electronBin)}...]`,
    );
    const electronResult = await runProcess(
      electronBin,
      [".", ...smokeArguments],
      rootDir,
      12000,
    );
    const combinedOutput = electronResult.stdout + "\n" + electronResult.stderr;
    const initialized = combinedOutput.includes("Lampas Launcher initialized");
    const handlersReady = combinedOutput.includes(
      "[Smoke Test] All handlers registered; initiating graceful shutdown",
    );
    const roundTripPassed = combinedOutput.includes(
      "[Smoke Test] Renderer & preload verification round-trip passed",
    );
    const adversarialPassed = combinedOutput.includes(
      "[Smoke Test] Real Electron adversarial boundary checks passed",
    );
    const cleanExit = electronResult.code === 0 && !electronResult.timedOut;

    results.push({
      name: "Real Electron Execution: Unpacked dev/dist execution",
      passed:
        cleanExit &&
        initialized &&
        handlersReady &&
        roundTripPassed &&
        adversarialPassed,
      details: `Exit code: ${electronResult.code}, timedOut: ${electronResult.timedOut}, init: ${initialized}, handlers: ${handlersReady}, roundTrip: ${roundTripPassed}, adversarial: ${adversarialPassed}`,
    });
  } else {
    results.push({
      name: "Real Electron Execution: Unpacked dev/dist execution",
      passed: false,
      details: `Electron binary not found at ${electronBin}`,
    });
  }

  // Check 6: Packaged Distribution (if exists, or required in strict mode)
  const distribution = process.argv
    .find((arg) => arg.startsWith("--distribution="))
    ?.slice("--distribution=".length);
  const packagedExe =
    distribution ||
    (process.platform === "win32"
      ? path.join(rootDir, "release/win-unpacked/Lampas Launcher.exe")
      : path.join(rootDir, "release/linux-unpacked/lampas-launcher"));

  const asarPath =
    process.platform === "win32"
      ? path.join(rootDir, "release/win-unpacked/resources/app.asar")
      : path.join(rootDir, "release/linux-unpacked/resources/app.asar");

  if (fs.existsSync(packagedExe)) {
    console.log(
      `[Executing Packaged Binary Smoke Test via ${path.basename(packagedExe)}...]`,
    );
    const asarValid =
      fs.existsSync(asarPath) && fs.statSync(asarPath).size > 1000000;
    const pkgResult = await runProcess(
      packagedExe,
      smokeArguments,
      rootDir,
      12000,
    );
    const combinedPkg = pkgResult.stdout + "\n" + pkgResult.stderr;
    const pkgInit = combinedPkg.includes("Lampas Launcher initialized");
    const pkgReady = combinedPkg.includes(
      "[Smoke Test] All handlers registered; initiating graceful shutdown",
    );
    const pkgRoundTrip = combinedPkg.includes(
      "[Smoke Test] Renderer & preload verification round-trip passed",
    );
    const pkgAdversarial = combinedPkg.includes(
      "[Smoke Test] Real Electron adversarial boundary checks passed",
    );
    const pkgClean = pkgResult.code === 0 && !pkgResult.timedOut;

    results.push({
      name: "Packaged Distribution: Execution & ASAR verification",
      passed:
        asarValid &&
        pkgClean &&
        pkgInit &&
        pkgReady &&
        pkgRoundTrip &&
        pkgAdversarial,
      details: `ASAR size: ${(fs.statSync(asarPath).size / (1024 * 1024)).toFixed(2)} MB, exit code: ${pkgResult.code}, init: ${pkgInit}, handlers: ${pkgReady}, roundTrip: ${pkgRoundTrip}, adversarial: ${pkgAdversarial}`,
    });
    const environmentResult = await runProcess(
      packagedExe,
      [...smokeArguments, "--inspect=0"],
      rootDir,
      20000,
      {
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require=lampas-nonexistent-security-sentinel",
      },
    );
    const environmentOutput =
      environmentResult.stdout + environmentResult.stderr;
    results.push({
      name: "Packaged Distribution: Developer environment and inspector cannot replace application startup",
      passed:
        environmentResult.code === 0 &&
        !environmentResult.timedOut &&
        environmentOutput.includes(
          "[Smoke Test] Real Electron adversarial boundary checks passed",
        ) &&
        !environmentOutput.includes("Debugger listening"),
      details: `Exit code: ${environmentResult.code}, timedOut: ${environmentResult.timedOut}, adversarial checks: ${environmentOutput.includes("[Smoke Test] Real Electron adversarial boundary checks passed")}`,
    });
    if (javaArgument)
      results.push({
        name: "Packaged Distribution: Java 25 subprocess remains available with hardened fuses",
        passed:
          combinedPkg.includes(
            "[Smoke Test] Java 25 subprocess verification passed",
          ) &&
          environmentOutput.includes(
            "[Smoke Test] Java 25 subprocess verification passed",
          ),
        details:
          "Actual main-process Java probe in normal and hostile developer environments",
      });
    const legacySecret = "synthetic-legacy-smoke-token-should-disappear";
    const upgrade = await runProcess(
      packagedExe,
      smokeArguments,
      rootDir,
      20000,
      {},
      (profile) => {
        fs.mkdirSync(profile, { recursive: true });
        fs.writeFileSync(
          path.join(profile, "config.json"),
          JSON.stringify({
            portalUrl: "https://dev.lampas.town",
            token: legacySecret,
            refreshToken: legacySecret,
            minecraftAccessToken: legacySecret,
          }),
        );
      },
    );
    const upgradedConfig = fs.readFileSync(
      path.join(upgrade.profile, "config.json"),
      "utf8",
    );
    const upgradeOutput = upgrade.stdout + upgrade.stderr;
    results.push({
      name: "Packaged Distribution: Legacy plaintext credentials require reauthentication and are scrubbed",
      passed:
        upgrade.code === 0 &&
        !upgrade.timedOut &&
        upgradeOutput.includes(
          "[Smoke Test] Real Electron adversarial boundary checks passed",
        ) &&
        !upgradedConfig.includes(legacySecret) &&
        !upgradeOutput.includes(legacySecret) &&
        !fs.existsSync(path.join(upgrade.profile, "credentials.enc")),
      details:
        "Synthetic unbound legacy tokens removed from config, absent from console/log output and encrypted-session file",
    });
  } else {
    results.push({
      name: "Packaged Distribution: Execution & ASAR verification",
      passed: !isStrict,
      details: isStrict
        ? `FAILURE: Packaged binary not found at ${packagedExe} (strict mode enabled)`
        : "Skipped: packaged binary not yet generated in release/win-unpacked (run bun run package:dir first)",
    });
  }

  // Check 7: Workflow & Publishing Safety
  check("Publishing Safety: Publish never and CI artifact guarantees", () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"),
    );
    const workflowPath = path.join(
      rootDir,
      ".github/workflows/release-pack.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf-8");

    const publishNeverInScripts = Object.values(pkgJson.scripts || {}).every(
      (script: any) =>
        !script.includes("electron-builder") ||
        script.includes("--publish never"),
    );
    const publishNullInConfig = pkgJson.build?.publish === null;
    const ciErrorOnMissing = workflow.includes("if-no-files-found: error");
    const ciIncludesLinux =
      workflow.includes("*.AppImage") && workflow.includes("*.tar.gz");

    return {
      passed:
        publishNeverInScripts &&
        publishNullInConfig &&
        ciErrorOnMissing &&
        ciIncludesLinux,
      details: `Scripts publish never: ${publishNeverInScripts}, build.publish null: ${publishNullInConfig}, CI if-no-files-found error: ${ciErrorOnMissing}, CI Linux artifacts: ${ciIncludesLinux}`,
    };
  });

  // Display summary
  console.log("\n--- Smoke Test Results ---");
  let allPassed = true;
  for (const r of results) {
    const symbol = r.passed ? "✓ PASS" : "✗ FAIL";
    console.log(`${symbol} [${r.name}]`);
    console.log(`       ${r.details}`);
    if (!r.passed) allPassed = false;
  }
  console.log("--------------------------\n");

  if (!allPassed) {
    console.error("❌ Smoke test suite failed.");
    process.exit(1);
  } else {
    console.log("✅ All smoke tests passed successfully!");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error in smoke test runner:", err);
  process.exit(1);
});
