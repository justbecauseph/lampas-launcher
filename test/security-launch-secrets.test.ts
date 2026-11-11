import {
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-"));

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

const {
  quoteArgfileToken,
  writeLaunchArgfile,
  sweepStaleLaunchArgfiles,
  scrubJvmCrashFiles,
} = await import("../src/launch-secrets");
const { buildLaunchArguments, buildLaunchArgumentParts } =
  await import("../src/game-runner");

afterAll(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

let scratch = "";

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-test-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("quoteArgfileToken", () => {
  test("wraps a value in double quotes, keeping spaces", () => {
    expect(quoteArgfileToken("a b")).toBe('"a b"');
  });

  test("doubles every backslash", () => {
    expect(quoteArgfileToken("C:\\Users\\x\\")).toBe('"C:\\\\Users\\\\x\\\\"');
  });

  test("escapes every double quote", () => {
    expect(quoteArgfileToken('x"y')).toBe('"x\\"y"');
  });

  test("quotes the empty string", () => {
    expect(quoteArgfileToken("")).toBe('""');
  });

  test("rejects line breaks and NUL", () => {
    for (const value of ["a\nb", "a\rb", "a\0b"]) {
      expect(() => quoteArgfileToken(value)).toThrow(
        "Launch argument contains a line break or NUL",
      );
    }
  });
});

describe("writeLaunchArgfile", () => {
  test("writes one quoted argument per line into its own directory", () => {
    const argfile = writeLaunchArgfile(
      ["Main", "--accessToken", "secret tok"],
      scratch,
    );

    expect(fs.existsSync(argfile.path)).toBe(true);
    const dir = path.dirname(argfile.path);
    expect(path.dirname(dir)).toBe(scratch);
    expect(path.basename(dir).startsWith("lampas-launch-")).toBe(true);
    expect(fs.readFileSync(argfile.path, "utf8")).toBe(
      '"Main"\n"--accessToken"\n"secret tok"\n',
    );

    if (process.platform !== "win32") {
      expect(fs.statSync(argfile.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }

    argfile.dispose();
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => argfile.dispose()).not.toThrow();
  });

  test("leaves no directory behind when an argument cannot be quoted", () => {
    expect(() => writeLaunchArgfile(["a\nb"], scratch)).toThrow(
      "Launch argument contains a line break or NUL",
    );
    expect(fs.readdirSync(scratch)).toEqual([]);
  });
});

describe("sweepStaleLaunchArgfiles", () => {
  test("removes only old argfile directories", () => {
    const past = new Date(Date.now() - 60_000);

    const stale = path.join(scratch, "lampas-launch-old");
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, "args"), "x");
    fs.utimesSync(stale, past, past);

    const unrelated = path.join(scratch, "other-dir");
    fs.mkdirSync(unrelated);

    const regularFile = path.join(scratch, "lampas-launch-file");
    fs.writeFileSync(regularFile, "x");
    fs.utimesSync(regularFile, past, past);

    sweepStaleLaunchArgfiles(scratch, 0);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(regularFile)).toBe(true);
  });

  test("keeps old argfile directories when maxAgeMs is large", () => {
    const past = new Date(Date.now() - 60_000);
    const stale = path.join(scratch, "lampas-launch-old");
    fs.mkdirSync(stale);
    fs.utimesSync(stale, past, past);

    sweepStaleLaunchArgfiles(scratch, 365 * 24 * 60 * 60 * 1000);

    expect(fs.existsSync(stale)).toBe(true);
  });
});

describe("scrubJvmCrashFiles", () => {
  const crashLog = [
    "# A fatal error has been detected by the Java Runtime Environment:",
    "Command Line: -Xmx4G net.fabricmc.Main --username Bob --accessToken eyJ.abc.def --userType msa",
    "java_command: net.fabricmc.Main --accessToken eyJ.abc.def --userType msa",
    "",
  ].join("\n");

  test("redacts the token in crash logs in the game folder and crash-reports", () => {
    fs.mkdirSync(path.join(scratch, "crash-reports"));
    const rootLog = path.join(scratch, "hs_err_pid123.log");
    const reportLog = path.join(scratch, "crash-reports", "hs_err_pid9.log");
    fs.writeFileSync(rootLog, crashLog);
    fs.writeFileSync(reportLog, crashLog);

    expect(scrubJvmCrashFiles(scratch)).toBe(2);

    for (const file of [rootLog, reportLog]) {
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toContain("eyJ.abc.def");
      expect(text).toContain("--accessToken [REDACTED] --userType msa");
      expect(text).toBe(crashLog.replaceAll("eyJ.abc.def", "[REDACTED]"));
    }
  });

  test("returns 0 once the logs are already redacted", () => {
    fs.writeFileSync(path.join(scratch, "hs_err_pid123.log"), crashLog);
    expect(scrubJvmCrashFiles(scratch)).toBe(1);
    expect(scrubJvmCrashFiles(scratch)).toBe(0);
  });

  test("leaves files whose names are not JVM crash logs alone", () => {
    const notes = path.join(scratch, "notes.log");
    fs.writeFileSync(notes, crashLog);

    expect(scrubJvmCrashFiles(scratch)).toBe(0);
    expect(fs.readFileSync(notes, "utf8")).toBe(crashLog);
  });

  test("returns 0 for a game folder that does not exist", () => {
    expect(scrubJvmCrashFiles(path.join(scratch, "missing"))).toBe(0);
  });
});

describe("buildLaunchArgumentParts", () => {
  const TOKEN = "eyJ-launch-token-under-test.abc.def";

  function launchOptions() {
    return {
      gameDir: path.join(scratch, "game"),
      ramGb: 4,
      runtime: { minecraft: "26.2" },
      assetIndex: "26.2",
      username: "TestPlayer",
      uuid: "11111111222233334444555555555555",
      token: TOKEN,
      userType: "msa" as const,
      customJavaArgs: ["-Dcustom.arg=1"],
      mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
      classpathString: "a.jar",
    };
  }

  test("keeps the token out of the JVM part", () => {
    const { jvm } = buildLaunchArgumentParts(launchOptions());
    expect(jvm.some((arg) => arg.includes(TOKEN))).toBe(false);
  });

  test("starts the app part with the main class and passes the token after --accessToken", () => {
    const options = launchOptions();
    const { app } = buildLaunchArgumentParts(options);
    expect(app[0]).toBe(options.mainClass);
    const index = app.indexOf("--accessToken");
    expect(index).not.toBe(-1);
    expect(app[index + 1]).toBe(TOKEN);
  });

  test("joins back to the same command line buildLaunchArguments returns", () => {
    const options = launchOptions();
    const { jvm, app } = buildLaunchArgumentParts(options);
    expect([...jvm, ...app]).toEqual(buildLaunchArguments(options));
  });

  test("points the JVM error file into crash-reports, before the custom arguments", () => {
    const options = launchOptions();
    const { jvm } = buildLaunchArgumentParts(options);
    const expected = `-XX:ErrorFile=${path.join(options.gameDir, "crash-reports", "hs_err_pid%p.log")}`;
    expect(jvm).toContain(expected);
    expect(jvm.indexOf(expected)).toBeLessThan(jvm.indexOf("-Dcustom.arg=1"));
  });

  test("keeps only the custom error file when custom arguments set one", () => {
    const { jvm } = buildLaunchArgumentParts({
      ...launchOptions(),
      customJavaArgs: ["-XX:ErrorFile=/x/y.log"],
    });
    expect(jvm.filter((arg) => arg.startsWith("-XX:ErrorFile="))).toEqual([
      "-XX:ErrorFile=/x/y.log",
    ]);
  });
});
