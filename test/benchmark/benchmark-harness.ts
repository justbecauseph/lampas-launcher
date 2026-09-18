import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { mock } from "bun:test";

// Benchmarks use temporary directories
const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-bench-"));
const userDataDir = path.join(benchRoot, "user-data");
const gameDir = path.join(benchRoot, "game");

fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(gameDir, { recursive: true });

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
    getName: () => "Lampas Launcher",
    getVersion: () => "2.0.0",
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [] }) },
}));

const { LauncherLogger } = await import("../../src/logger");
const { ConfigManager } = await import("../../src/config");
const { LauncherSync } = await import("../../src/sync");
const { GameDirectoryManager } = await import("../../src/game-directory");
const { hashFile } = await import("../../src/file-transfer");

LauncherLogger.init();

export interface BenchmarkResult {
  scenario: string;
  durationMs: number;
  details: Record<string, any>;
}

async function runWarmSyncBenchmark(): Promise<BenchmarkResult> {
  const fileCount = 100;
  const modsDir = path.join(gameDir, "mods");
  fs.mkdirSync(modsDir, { recursive: true });

  const manifestFiles: any[] = [];
  const stateFiles: Record<string, any> = {};

  for (let i = 0; i < fileCount; i++) {
    const filename = `mod-${i.toString().padStart(3, "0")}.jar`;
    const relPath = `mods/${filename}`;
    const content = Buffer.from(`mock-content-for-benchmark-file-${i}`);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const filePath = path.join(modsDir, filename);
    fs.writeFileSync(filePath, content);
    const stat = fs.statSync(filePath);

    manifestFiles.push({
      path: relPath,
      hashes: { sha256 },
      size: content.length,
      download: { url: `/blobs/${sha256}` },
      policy: "MANAGED",
    });

    stateFiles[relPath] = {
      sha256,
      size: content.length,
      mtimeMs: stat.mtimeMs,
      policy: "MANAGED",
    };
  }

  const stateDir = path.join(gameDir, ".lampas");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "installation.json"),
    JSON.stringify({ pack: "Lampas 2", version: "2.0.0", files: stateFiles })
  );

  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requestCount++;
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/channels/stable") {
        return Response.json({ channel: "stable", version: "2.0.0" });
      }
      if (url.pathname === "/api/v1/releases/2.0.0") {
        return Response.json({
          pack: "Lampas 2",
          version: "2.0.0",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
        });
      }
      if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
        return Response.json({
          pack: "Lampas 2",
          version: "2.0.0",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          files: manifestFiles,
          mods: [],
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  ConfigManager.set({
    portalUrl: `http://127.0.0.1:${server.port}`,
    selectedChannel: "stable",
    gameDir,
  });
  ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, { token: "bench-token" });

  try {
    // Warm run
    const start = performance.now();
    const result = await LauncherSync.syncClient(() => {}, "fast");
    const end = performance.now();

    return {
      scenario: "Warm Sync (100 managed files, fast mode, identical metadata)",
      durationMs: end - start,
      details: {
        success: result.success,
        fileCount,
        requestCount,
        wallTimeMs: Math.round((end - start) * 100) / 100,
      },
    };
  } finally {
    server.stop(true);
  }
}

async function runFullRepairBenchmark(): Promise<BenchmarkResult> {
  const fileCount = 100;
  const modsDir = path.join(gameDir, "mods");

  let totalBytes = 0;
  for (let i = 0; i < fileCount; i++) {
    const filename = `mod-${i.toString().padStart(3, "0")}.jar`;
    const filePath = path.join(modsDir, filename);
    if (fs.existsSync(filePath)) {
      totalBytes += fs.statSync(filePath).size;
    }
  }

  const manifestFiles: any[] = [];
  for (let i = 0; i < fileCount; i++) {
    const filename = `mod-${i.toString().padStart(3, "0")}.jar`;
    const relPath = `mods/${filename}`;
    const filePath = path.join(modsDir, filename);
    const content = fs.readFileSync(filePath);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    manifestFiles.push({
      path: relPath,
      hashes: { sha256 },
      size: content.length,
      download: { url: `/blobs/${sha256}` },
      policy: "MANAGED",
    });
  }

  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requestCount++;
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/channels/stable") {
        return Response.json({ channel: "stable", version: "2.0.0" });
      }
      if (url.pathname === "/api/v1/releases/2.0.0") {
        return Response.json({
          pack: "Lampas 2",
          version: "2.0.0",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
        });
      }
      if (url.pathname === "/api/v1/releases/2.0.0/client-manifest") {
        return Response.json({
          pack: "Lampas 2",
          version: "2.0.0",
          minecraft: "26.2",
          loader: { type: "fabric", version: "0.19.3" },
          files: manifestFiles,
          mods: [],
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  ConfigManager.set({
    portalUrl: `http://127.0.0.1:${server.port}`,
    selectedChannel: "stable",
    gameDir,
  });
  ConfigManager.establishSession(`http://127.0.0.1:${server.port}`, { token: "bench-token" });

  try {
    const start = performance.now();
    const result = await LauncherSync.syncClient(() => {}, "full");
    const end = performance.now();

    return {
      scenario: "Full Repair / Sync (100 managed files, full sha256 hash mode)",
      durationMs: end - start,
      details: {
        success: result.success,
        fileCount,
        totalBytesHashed: totalBytes,
        requestCount,
        wallTimeMs: Math.round((end - start) * 100) / 100,
      },
    };
  } finally {
    server.stop(true);
  }
}

async function runDirectoryMoveBenchmark(): Promise<BenchmarkResult> {
  const moveSrc = path.join(benchRoot, "dir-move-src");
  const moveDstRename = path.join(benchRoot, "dir-move-dst-rename");
  const moveDstCopy = path.join(benchRoot, "dir-move-dst-copy");

  fs.mkdirSync(path.join(moveSrc, "mods"), { recursive: true });
  fs.mkdirSync(path.join(moveSrc, "saves", "World1"), { recursive: true });
  fs.mkdirSync(path.join(moveSrc, "screenshots"), { recursive: true });

  const fileCount = 150;
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(moveSrc, "mods", `item-${i}.jar`), `jar-data-${i}-`.repeat(50));
  }
  fs.writeFileSync(path.join(moveSrc, "options.txt"), "gamma:1.0\nfov:90\n");
  fs.writeFileSync(path.join(moveSrc, "servers.dat"), "server-data-bytes");

  // Benchmark 1: fast-path same filesystem rename
  ConfigManager.set({ gameDir: moveSrc, gameDirConfigured: true });
  const startRename = performance.now();
  await GameDirectoryManager.moveInstallation(moveDstRename);
  const endRename = performance.now();
  const renameDuration = endRename - startRename;

  // Benchmark 2: simulated EXDEV copy + verify fallback
  ConfigManager.set({ gameDir: moveDstRename, gameDirConfigured: true });
  GameDirectoryManager._renameFn = (src: string, dst: string) => {
    if (src === path.resolve(moveDstRename)) {
      const err: any = new Error("EXDEV");
      err.code = "EXDEV";
      throw err;
    }
    return fs.renameSync(src, dst);
  };

  const startCopy = performance.now();
  await GameDirectoryManager.moveInstallation(moveDstCopy);
  const endCopy = performance.now();
  const copyDuration = endCopy - startCopy;

  GameDirectoryManager.resetForTesting();

  return {
    scenario: "Directory Relocation (150 files across subdirectories)",
    durationMs: copyDuration,
    details: {
      fileCount,
      renameWallTimeMs: Math.round(renameDuration * 100) / 100,
      copyVerifyWallTimeMs: Math.round(copyDuration * 100) / 100,
    },
  };
}

async function runLogStormBenchmark(iterations = 3): Promise<BenchmarkResult> {
  const lineCount = 20_000;
  const logDir = path.join(benchRoot, "log-bench");
  fs.mkdirSync(logDir, { recursive: true });

  const origConsoleLog = console.log;
  console.log = () => {}; // suppress stdout during benchmark

  const rawRuns: Array<{
    run: number;
    producerWallTimeMs: number;
    flushWallTimeMs: number;
    totalWallTimeMs: number;
    linesPerSec: number;
    eventLoopLagMaxMs: number;
    eventLoopDelayP99Ms: number;
    produced: number;
    written: number;
    dropped: number;
    errors: number;
  }> = [];

  for (let r = 1; r <= iterations; r++) {
    LauncherLogger.resetForTesting();
    LauncherLogger.init(path.join(logDir, `run-${r}`));

    const ald = monitorEventLoopDelay({ resolution: 10 });
    ald.enable();

    let maxImmediateLagMs = 0;
    let samplingActive = true;
    const sampleLoop = () => {
      if (!samplingActive) return;
      const t0 = performance.now();
      setImmediate(() => {
        const diff = performance.now() - t0;
        if (diff > maxImmediateLagMs) maxImmediateLagMs = diff;
        if (samplingActive) sampleLoop();
      });
    };
    sampleLoop();

    const pStart = performance.now();
    for (let i = 0; i < lineCount; i++) {
      LauncherLogger.info(`[Game Log Worker ${i % 4}] Server tick took ${(i % 50).toFixed(2)}ms, entities: ${i * 2}`);
    }
    const pEnd = performance.now();
    const producerMs = pEnd - pStart;

    const fStart = performance.now();
    await LauncherLogger.flush();
    const fEnd = performance.now();
    const flushMs = fEnd - fStart;

    samplingActive = false;
    ald.disable();
    const metrics = LauncherLogger.getMetrics();
    await LauncherLogger.close();

    const totalMs = producerMs + flushMs;
    const p99 = Math.round((ald.percentile(99) / 1_000_000) * 100) / 100;
    const maxLag = Math.round(Math.max(maxImmediateLagMs, ald.max / 1_000_000) * 100) / 100;

    rawRuns.push({
      run: r,
      producerWallTimeMs: Math.round(producerMs * 100) / 100,
      flushWallTimeMs: Math.round(flushMs * 100) / 100,
      totalWallTimeMs: Math.round(totalMs * 100) / 100,
      linesPerSec: Math.round(lineCount / (totalMs / 1000)),
      eventLoopLagMaxMs: maxLag,
      eventLoopDelayP99Ms: p99,
      produced: metrics.producedCount,
      written: metrics.writtenCount,
      dropped: metrics.droppedCount,
      errors: metrics.errorCount,
    });
  }

  console.log = origConsoleLog;

  const avgProducer = Math.round((rawRuns.reduce((s, r) => s + r.producerWallTimeMs, 0) / rawRuns.length) * 100) / 100;
  const avgFlush = Math.round((rawRuns.reduce((s, r) => s + r.flushWallTimeMs, 0) / rawRuns.length) * 100) / 100;
  const avgTotal = Math.round((rawRuns.reduce((s, r) => s + r.totalWallTimeMs, 0) / rawRuns.length) * 100) / 100;
  const avgLinesPerSec = Math.round(lineCount / (avgTotal / 1000));

  return {
    scenario: "Log Storm (20,000 entries: separated producer latency & completed disk writes)",
    durationMs: avgTotal,
    details: {
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      runtime: `Node ${process.version} / Bun ${Bun.version}`,
      lineCount,
      iterations,
      avgProducerWallTimeMs: avgProducer,
      avgFlushWallTimeMs: avgFlush,
      avgTotalWallTimeMs: avgTotal,
      avgLinesPerSec,
      rawRuns,
    },
  };
}

async function runModCatalogSearchBenchmark(): Promise<BenchmarkResult> {
  // Generate 2,000 synthetic mod catalog entries
  const count = 2000;
  const catalog: any[] = [];
  for (let i = 0; i < count; i++) {
    catalog.push({
      id: `mod-${i}`,
      name: `Performance Optimization Mod ${i}`,
      description: `Essential FPS boosting and memory management tool number ${i} for Lampas SMP.`,
      filename: `mod-${i}.jar`,
      categories: [i % 3 === 0 ? "performance" : i % 3 === 1 ? "visual" : "utility"],
      required: i < 20,
      enabled: true,
      author: `Author ${i % 50}`,
    });
  }

  const searchQueries = ["perf", "fps", "opt", "boost", "util", "50", "99", "nomatch"];

  // 1. Baseline naive search (repeated lowercase allocation on keystroke)
  const startNaive = performance.now();
  let naiveMatches = 0;
  for (let rep = 0; rep < 5; rep++) {
    for (const q of searchQueries) {
      const lower = q.toLowerCase();
      const matches = catalog.filter(
        (m) =>
          m.name.toLowerCase().includes(lower) ||
          m.description.toLowerCase().includes(lower) ||
          m.author.toLowerCase().includes(lower)
      );
      naiveMatches += matches.length;
    }
  }
  const endNaive = performance.now();
  const naiveDuration = endNaive - startNaive;

  // 2. Production indexed search: precompute _searchKey on ingestion (as in mods-view.ts)
  const startPrecompute = performance.now();
  const indexedCatalog = catalog.map((m) => ({
    ...m,
    _searchKey: [
      m.name || "",
      m.id || "",
      m.filename || "",
      m.description || "",
      ...(m.categories || []),
    ].join(" ").toLowerCase(),
  }));
  const endPrecompute = performance.now();
  const precomputeDuration = endPrecompute - startPrecompute;

  // Measure production search execution over 40 searches using _searchKey
  const startSearchKey = performance.now();
  let indexedMatches = 0;
  for (let rep = 0; rep < 5; rep++) {
    for (const q of searchQueries) {
      const lower = q.toLowerCase();
      const matches = indexedCatalog.filter((m) => m._searchKey.includes(lower));
      indexedMatches += matches.length;
    }
  }
  const endSearchKey = performance.now();
  const searchKeyDuration = endSearchKey - startSearchKey;

  return {
    scenario: "Mod Catalog Search (2,000 entries, 40 un-debounced searches: baseline vs _searchKey index)",
    durationMs: searchKeyDuration,
    details: {
      catalogSize: count,
      searchRepetitions: 40,
      matchesFound: indexedMatches,
      baselineNaiveWallTimeMs: Math.round(naiveDuration * 100) / 100,
      precomputeIndexMs: Math.round(precomputeDuration * 100) / 100,
      searchKeyWallTimeMs: Math.round(searchKeyDuration * 100) / 100,
      searchKeyAvgPerSearchMs: Math.round((searchKeyDuration / 40) * 100) / 100,
      speedup: `${(naiveDuration / searchKeyDuration).toFixed(1)}x`,
    },
  };
}

export async function runAllBenchmarks(): Promise<BenchmarkResult[]> {
  console.log("=== Lampas Launcher Baseline Benchmarks ===");
  console.log(`OS: ${os.platform()} ${os.release()} (${os.arch()})`);
  console.log(`CPU: ${os.cpus()[0]?.model} (${os.cpus().length} threads)`);
  console.log(`Node: ${process.version} | Bun: ${Bun.version}\n`);

  const results: BenchmarkResult[] = [];

  const warmSyncRes = await runWarmSyncBenchmark();
  results.push(warmSyncRes);
  console.log(`[1/5] ${warmSyncRes.scenario}: ${warmSyncRes.details.wallTimeMs} ms`);

  const fullRepairRes = await runFullRepairBenchmark();
  results.push(fullRepairRes);
  console.log(`[2/5] ${fullRepairRes.scenario}: ${fullRepairRes.details.wallTimeMs} ms`);

  const moveRes = await runDirectoryMoveBenchmark();
  results.push(moveRes);
  console.log(`[3/5] ${moveRes.scenario}: Rename ${moveRes.details.renameWallTimeMs} ms | Copy+Verify ${moveRes.details.copyVerifyWallTimeMs} ms`);

  const logStormRes = await runLogStormBenchmark(3);
  results.push(logStormRes);
  console.log(`[4/5] ${logStormRes.scenario}:`);
  console.log(`      Producer Enqueue Avg: ${logStormRes.details.avgProducerWallTimeMs} ms`);
  console.log(`      Disk Flush Avg:       ${logStormRes.details.avgFlushWallTimeMs} ms`);
  console.log(`      Total Wall Time Avg:  ${logStormRes.details.avgTotalWallTimeMs} ms (${logStormRes.details.avgLinesPerSec} lines/sec)`);
  console.log(`      Raw Runs (3 reps):`);
  for (const r of logStormRes.details.rawRuns) {
    console.log(`        Run ${r.run}: producer=${r.producerWallTimeMs}ms, flush=${r.flushWallTimeMs}ms, total=${r.totalWallTimeMs}ms, produced=${r.produced}, written=${r.written}, dropped=${r.dropped}, maxLag=${r.eventLoopLagMaxMs}ms`);
  }

  const catalogRes = await runModCatalogSearchBenchmark();
  results.push(catalogRes);
  console.log(`[5/5] ${catalogRes.scenario}:`);
  console.log(`      Baseline Naive Search:    ${catalogRes.details.baselineNaiveWallTimeMs} ms`);
  console.log(`      Ingestion Precompute:     ${catalogRes.details.precomputeIndexMs} ms`);
  console.log(`      Production _searchKey:   ${catalogRes.details.searchKeyWallTimeMs} ms (avg ${catalogRes.details.searchKeyAvgPerSearchMs} ms/search, ${catalogRes.details.speedup} faster)`);

  // Cleanup bench directory
  try {
    if (path.resolve(benchRoot).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(benchRoot, { recursive: true, force: true });
    }
  } catch {}

  console.log("\n=== Benchmarks Complete ===");
  return results;
}

if (import.meta.main) {
  await runAllBenchmarks();
}
