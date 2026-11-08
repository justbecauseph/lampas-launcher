import { describe, expect, test } from "bun:test";
import {
  createGameStartWatcher,
  isGameStartedLine,
} from "../src/game-start-watcher";
import type { GameLogEntry } from "../src/types";

const SOUND_ENGINE_STARTED =
  "[19:08:46] [Sound engine/INFO]: Sound engine started";
const SOUND_SYSTEM_ERROR =
  "[12:00:00] [Sound engine/ERROR]: Error starting SoundSystem. Turning off sounds & music";
const MOD_MID_MESSAGE_LINE =
  "[19:08:40] [Render thread/INFO]: [SoundPhysics] waiting until Sound engine started";
const LWJGL_LINE =
  "[15:20:36] [Render thread/INFO]: Backend library: LWJGL version 3.4.1-snapshot";
const SETTING_USER_LINE =
  "[19:06:05] [Render thread/INFO]: Setting user: someone";

function entry(message: string): GameLogEntry {
  return { timestamp: "19:08:46", level: "INFO", message };
}

describe("isGameStartedLine", () => {
  test("matches the sound engine line printed once the game has started", () => {
    expect(isGameStartedLine(SOUND_ENGINE_STARTED)).toBe(true);
  });

  test("matches the sound system error printed when no audio device works", () => {
    expect(isGameStartedLine(SOUND_SYSTEM_ERROR)).toBe(true);
  });

  test("ignores unrelated game output", () => {
    expect(isGameStartedLine(LWJGL_LINE)).toBe(false);
    expect(isGameStartedLine(SETTING_USER_LINE)).toBe(false);
    expect(isGameStartedLine("")).toBe(false);
  });

  test("ignores a mod line that mentions the phrase mid-message", () => {
    expect(isGameStartedLine(MOD_MID_MESSAGE_LINE)).toBe(false);
    expect(
      isGameStartedLine(
        "[19:08:40] [Render thread/INFO]: [SoundPhysics]: Sound engine started",
      ),
    ).toBe(false);
    expect(
      isGameStartedLine(
        "[19:08:40] [Render thread/INFO]: [Audio] Error starting SoundSystem",
      ),
    ).toBe(false);
  });

  test("ignores the phrase when it has no logger prefix", () => {
    expect(isGameStartedLine("Sound engine started")).toBe(false);
    expect(isGameStartedLine("Error starting SoundSystem.")).toBe(false);
  });
});

describe("createGameStartWatcher", () => {
  test("fires once across several matching entries", () => {
    let calls = 0;
    const watch = createGameStartWatcher(() => {
      calls += 1;
    });

    watch(entry(LWJGL_LINE));
    expect(calls).toBe(0);

    watch(entry(SOUND_ENGINE_STARTED));
    expect(calls).toBe(1);

    watch(entry(SOUND_SYSTEM_ERROR));
    watch(entry(SOUND_ENGINE_STARTED));
    watch(entry(SETTING_USER_LINE));
    expect(calls).toBe(1);
  });

  test("never fires when no entry matches", () => {
    let calls = 0;
    const watch = createGameStartWatcher(() => {
      calls += 1;
    });

    for (const message of [
      LWJGL_LINE,
      SETTING_USER_LINE,
      "Sound engine stopped",
    ]) {
      watch(entry(message));
    }
    expect(calls).toBe(0);
  });
});
