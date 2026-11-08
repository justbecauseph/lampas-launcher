import type { GameLogEntry } from "./types";

/**
 * Game log lines that mark Minecraft as started. The vanilla client prints
 * "Sound engine started" near the end of the first resource reload. With no
 * working audio device it prints "Error starting SoundSystem" in that place
 * instead. Each marker must come right after the logger prefix
 * "[time] [thread/LEVEL]: ", so a mod that repeats the phrase mid-message does
 * not match.
 */
const GAME_STARTED_MARKERS: readonly RegExp[] = [
  /^\[[^\]]*\] \[[^\]]*\]: Sound engine started\s*$/,
  /^\[[^\]]*\] \[[^\]]*\]: Error starting SoundSystem\b/,
];

export function isGameStartedLine(message: string): boolean {
  return GAME_STARTED_MARKERS.some((marker) => marker.test(message));
}

/**
 * Returns a log sink for one game launch. It calls onStarted the first time a
 * matching line arrives and ignores every later line.
 */
export function createGameStartWatcher(
  onStarted: () => void,
): (entry: GameLogEntry) => void {
  let started = false;
  return (entry) => {
    if (started || !isGameStartedLine(entry.message)) return;
    started = true;
    onStarted();
  };
}
