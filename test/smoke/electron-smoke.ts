import { spawn } from "child_process";
import fs from "fs";
import path from "path";

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
    results.push({ name, passed: false, details: `Exception: ${err?.message || err}` });
  }
}

async function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 15000
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32" && cmd.endsWith(".cmd"),
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    });

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

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      stderr += err.message;
      resolve({ code: -1, stdout, stderr, timedOut });
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
    const mainExists = fs.existsSync(mainPath) && fs.statSync(mainPath).size > 1000;
    const preloadExists = fs.existsSync(preloadPath) && fs.statSync(preloadPath).size > 1000;
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
      return { passed: false, details: "dist/renderer/index.html does not exist" };
    }
    const htmlContent = fs.readFileSync(htmlPath, "utf-8");
    const hasScript = htmlContent.includes("<script type=\"module\"");
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

    const missingFonts = expectedFonts.filter((f) => !fs.existsSync(path.join(fontDir, f)));
    const licenseExists = fs.existsSync(licensePath);
    const licenseValid = licenseExists && fs.readFileSync(licensePath, "utf-8").includes("SIL OPEN FONT LICENSE");

    return {
      passed: missingFonts.length === 0 && licenseValid,
      details: missingFonts.length === 0 && licenseValid
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
    const hasRemoteHtml = html.includes("fonts.googleapis.com") || html.includes("fonts.gstatic.com");
    const hasRemoteCss = css.includes("fonts.googleapis.com") || css.includes("fonts.gstatic.com");

    return {
      passed: !hasRemoteHtml && !hasRemoteCss,
      details: `Remote links in index.html: ${hasRemoteHtml ? "FOUND (FAIL)" : "NONE"}, in styles.css: ${hasRemoteCss ? "FOUND (FAIL)" : "NONE"}`,
    };
  });

  const isStrict = process.argv.includes("--strict");

  // Check 5: Real Electron Unpacked Process Execution
  const electronBin = process.platform === "win32"
    ? path.join(rootDir, "node_modules/electron/dist/electron.exe")
    : path.join(rootDir, "node_modules/.bin/electron");

  if (fs.existsSync(electronBin)) {
    console.log(`[Executing Real Electron Smoke Test via ${path.basename(electronBin)}...]`);
    const electronResult = await runProcess(electronBin, [".", "--smoke-test"], rootDir, 12000);
    const combinedOutput = electronResult.stdout + "\n" + electronResult.stderr;
    const initialized = combinedOutput.includes("Lampas Launcher initialized");
    const handlersReady = combinedOutput.includes("[Smoke Test] All handlers registered; initiating graceful shutdown");
    const roundTripPassed = combinedOutput.includes("[Smoke Test] Renderer & preload verification round-trip passed");
    const cleanExit = electronResult.code === 0 && !electronResult.timedOut;

    results.push({
      name: "Real Electron Execution: Unpacked dev/dist execution",
      passed: cleanExit && initialized && handlersReady && roundTripPassed,
      details: `Exit code: ${electronResult.code}, timedOut: ${electronResult.timedOut}, init: ${initialized}, handlers: ${handlersReady}, roundTrip: ${roundTripPassed}`,
    });
  } else {
    results.push({
      name: "Real Electron Execution: Unpacked dev/dist execution",
      passed: false,
      details: `Electron binary not found at ${electronBin}`,
    });
  }

  // Check 6: Packaged Distribution (if exists, or required in strict mode)
  const packagedExe = process.platform === "win32"
    ? path.join(rootDir, "release/win-unpacked/Lampas Launcher.exe")
    : path.join(rootDir, "release/linux-unpacked/lampas-launcher");

  const asarPath = process.platform === "win32"
    ? path.join(rootDir, "release/win-unpacked/resources/app.asar")
    : path.join(rootDir, "release/linux-unpacked/resources/app.asar");

  if (fs.existsSync(packagedExe)) {
    console.log(`[Executing Packaged Binary Smoke Test via ${path.basename(packagedExe)}...]`);
    const asarValid = fs.existsSync(asarPath) && fs.statSync(asarPath).size > 1000000;
    const pkgResult = await runProcess(packagedExe, ["--smoke-test"], rootDir, 12000);
    const combinedPkg = pkgResult.stdout + "\n" + pkgResult.stderr;
    const pkgInit = combinedPkg.includes("Lampas Launcher initialized");
    const pkgReady = combinedPkg.includes("[Smoke Test] All handlers registered; initiating graceful shutdown");
    const pkgRoundTrip = combinedPkg.includes("[Smoke Test] Renderer & preload verification round-trip passed");
    const pkgClean = pkgResult.code === 0 && !pkgResult.timedOut;

    results.push({
      name: "Packaged Distribution: Execution & ASAR verification",
      passed: asarValid && pkgClean && pkgInit && pkgReady && pkgRoundTrip,
      details: `ASAR size: ${(fs.statSync(asarPath).size / (1024 * 1024)).toFixed(2)} MB, exit code: ${pkgResult.code}, init: ${pkgInit}, handlers: ${pkgReady}, roundTrip: ${pkgRoundTrip}`,
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
    const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    const workflowPath = path.join(rootDir, ".github/workflows/release-pack.yml");
    const workflow = fs.readFileSync(workflowPath, "utf-8");

    const publishNeverInScripts = Object.values(pkgJson.scripts || {}).every(
      (script: any) => !script.includes("electron-builder") || script.includes("--publish never")
    );
    const publishNullInConfig = pkgJson.build?.publish === null;
    const ciErrorOnMissing = workflow.includes("if-no-files-found: error");
    const ciIncludesLinux = workflow.includes("*.AppImage") && workflow.includes("*.tar.gz");

    return {
      passed: publishNeverInScripts && publishNullInConfig && ciErrorOnMissing && ciIncludesLinux,
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
