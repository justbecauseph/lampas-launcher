import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lampas-session-test-"));
const userDataDir = path.join(testRoot, "user-data");

mock.module("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openExternal: async () => undefined },
}));

const {
  classifyGameSession,
  clearGameSession,
  findAdoptableGame,
  getGameSessionPath,
  newGameSessionId,
  readGameSession,
  sessionMarkerArg,
  systemProcessProbe,
  writeGameSession,
} = await import("../src/game-session");
import type { GameSessionRecord, ProcessProbe } from "../src/game-session";

const sessionFile = path.join(userDataDir, "game-session.json");
const validId = "0123456789abcdef0123456789abcdef";

function validRecord(): GameSessionRecord {
  return {
    version: 1,
    pid: 4242,
    sessionId: validId,
    startedAt: "2026-01-02T03:04:05.000Z",
    gameDir: path.join(testRoot, "game"),
  };
}

function writeRaw(content: string): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(sessionFile, content);
}

beforeEach(() => {
  fs.rmSync(sessionFile, { recursive: true, force: true });
});

afterAll(() => {
  if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("game session record", () => {
  test("is stored as game-session.json under the user data directory", () => {
    expect(getGameSessionPath()).toBe(sessionFile);
  });

  test("returns null when no record exists", () => {
    expect(readGameSession()).toBeNull();
  });

  test("round-trips a written record", () => {
    const record = validRecord();

    writeGameSession(record);

    expect(readGameSession()).toEqual(record);
    expect(fs.existsSync(sessionFile)).toBe(true);
  });

  test("returns null and deletes a malformed JSON record", () => {
    writeRaw("{ not json");

    expect(readGameSession()).toBeNull();
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  test("returns null and deletes a record with the wrong version", () => {
    writeRaw(JSON.stringify({ ...validRecord(), version: 2 }));

    expect(readGameSession()).toBeNull();
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  test("returns null and deletes a record whose sessionId is not 32 lowercase hex characters", () => {
    for (const sessionId of [
      "z".repeat(32),
      "A".repeat(32),
      "a".repeat(31),
      "a".repeat(33),
      42,
    ]) {
      writeRaw(JSON.stringify({ ...validRecord(), sessionId }));

      expect(readGameSession()).toBeNull();
      expect(fs.existsSync(sessionFile)).toBe(false);
    }
  });

  test("returns null and deletes a record with an invalid pid", () => {
    for (const pid of [0, -1, 1.5, "4242", null, 2 ** 60]) {
      writeRaw(JSON.stringify({ ...validRecord(), pid }));

      expect(readGameSession()).toBeNull();
      expect(fs.existsSync(sessionFile)).toBe(false);
    }
  });

  test("returns null and deletes a record missing startedAt or gameDir", () => {
    const { startedAt: _startedAt, ...withoutStartedAt } = validRecord();
    const { gameDir: _gameDir, ...withoutGameDir } = validRecord();
    for (const record of [withoutStartedAt, withoutGameDir]) {
      writeRaw(JSON.stringify(record));

      expect(readGameSession()).toBeNull();
      expect(fs.existsSync(sessionFile)).toBe(false);
    }
  });

  test("returns null and deletes a record that is not a JSON object", () => {
    for (const text of ["null", "[]", '"text"', "7"]) {
      writeRaw(text);

      expect(readGameSession()).toBeNull();
      expect(fs.existsSync(sessionFile)).toBe(false);
    }
  });

  test("returns null and deletes an oversize record", () => {
    writeRaw(
      JSON.stringify({ ...validRecord(), gameDir: "x".repeat(16 * 1024) }),
    );

    expect(readGameSession()).toBeNull();
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  test("returns null without throwing when the record path is not a regular file", () => {
    fs.mkdirSync(sessionFile, { recursive: true });

    expect(readGameSession()).toBeNull();
  });
});

describe("session marker", () => {
  test("generates 32 lowercase hex characters, different each time", () => {
    const first = newGameSessionId();
    const second = newGameSessionId();

    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(second).toMatch(/^[a-f0-9]{32}$/);
    expect(first).not.toBe(second);
  });

  test("is passed to the JVM as a lampas.launcher.session system property", () => {
    expect(sessionMarkerArg(validId)).toBe(
      `-Dlampas.launcher.session=${validId}`,
    );
  });
});

describe("findAdoptableGame", () => {
  function fakeProbe(alive: boolean, commandLine: string | null) {
    let commandLineReads = 0;
    const probe: ProcessProbe = {
      isAlive: () => alive,
      readCommandLine: async () => {
        commandLineReads++;
        return commandLine;
      },
      terminate: () => {},
    };
    return { probe, reads: () => commandLineReads };
  }

  test("accepts a live process whose command line contains the marker", async () => {
    const { probe } = fakeProbe(
      true,
      `java.exe -Xmx4G -Dlampas.launcher.session=${validId} -cp x Main`,
    );

    expect(await findAdoptableGame(validRecord(), probe)).toBe(true);
  });

  test("rejects a live process without the marker", async () => {
    const { probe } = fakeProbe(true, "java.exe -Xmx4G -cp x Main");

    expect(await findAdoptableGame(validRecord(), probe)).toBe(false);
  });

  test("rejects a live process carrying a different session marker", async () => {
    const { probe } = fakeProbe(
      true,
      "java.exe -Dlampas.launcher.session=fedcba9876543210fedcba9876543210 -cp x",
    );

    expect(await findAdoptableGame(validRecord(), probe)).toBe(false);
  });

  test("rejects a live process whose command line cannot be read", async () => {
    const { probe } = fakeProbe(true, null);

    expect(await findAdoptableGame(validRecord(), probe)).toBe(false);
  });

  test("rejects a dead process without reading its command line", async () => {
    const { probe, reads } = fakeProbe(
      false,
      `java.exe -Dlampas.launcher.session=${validId}`,
    );

    expect(await findAdoptableGame(validRecord(), probe)).toBe(false);
    expect(reads()).toBe(0);
  });
});

describe("systemProcessProbe", () => {
  test("reports the current process as alive", () => {
    expect(systemProcessProbe.isAlive(process.pid)).toBe(true);
  });
});

describe("classifyGameSession", () => {
  function probeWith(
    alive: boolean,
    commandLine: (() => Promise<string | null>) | null,
  ): ProcessProbe {
    return {
      isAlive: () => alive,
      readCommandLine:
        commandLine ??
        (async () => {
          throw new Error("java.exe --accessToken super-secret-token");
        }),
      terminate: () => {},
    };
  }

  test("a dead process is 'dead'", async () => {
    expect(
      await classifyGameSession(
        validRecord(),
        probeWith(false, async () => `java.exe ${sessionMarkerArg(validId)}`),
      ),
    ).toBe("dead");
  });

  test("a live process carrying the marker is 'adoptable'", async () => {
    expect(
      await classifyGameSession(
        validRecord(),
        probeWith(true, async () => `java.exe ${sessionMarkerArg(validId)}`),
      ),
    ).toBe("adoptable");
  });

  test("a live process without the marker is 'mismatch'", async () => {
    expect(
      await classifyGameSession(
        validRecord(),
        probeWith(true, async () => "notepad.exe"),
      ),
    ).toBe("mismatch");
  });

  test("a live process whose command line cannot be read is 'unknown'", async () => {
    expect(
      await classifyGameSession(
        validRecord(),
        probeWith(true, async () => null),
      ),
    ).toBe("unknown");
    expect(
      await classifyGameSession(validRecord(), probeWith(true, null)),
    ).toBe("unknown");
  });
});

describe("clearGameSession scoped to a session id", () => {
  test("leaves a record that belongs to a different session in place", () => {
    writeGameSession(validRecord());
    const other = "ffffffffffffffffffffffffffffffff";

    expect(clearGameSession(other)).toBe(false);
    expect(fs.existsSync(sessionFile)).toBe(true);
    expect(readGameSession()?.sessionId).toBe(validId);
  });

  test("removes the record when the id matches, and when no id is given", () => {
    writeGameSession(validRecord());
    expect(clearGameSession(validId)).toBe(true);
    expect(fs.existsSync(sessionFile)).toBe(false);

    writeGameSession(validRecord());
    expect(clearGameSession()).toBe(true);
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  test("returns false without error when there is no record", () => {
    fs.rmSync(sessionFile, { force: true });
    expect(clearGameSession(validId)).toBe(false);
  });
});
