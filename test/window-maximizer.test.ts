import { describe, expect, test } from "bun:test";
import {
  buildMaximizeScript,
  maximizeGameWindow,
} from "../src/window-maximizer";

describe("window maximizer", () => {
  test("embeds the target pid and matches only GLFW windows", () => {
    const script = buildMaximizeScript(4242);
    expect(script).toContain("Get-Process -Id 4242");
    expect(script).toContain("[LampasWindow]::Find(4242)");
    expect(script).toContain('"GLFW30"');
    expect(script).toContain("ShowWindow($hWnd, 3)");
  });

  test("rejects non-integer or non-positive pids", () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildMaximizeScript(pid)).toThrow("Invalid process id");
    }
  });

  test("does nothing without a pid", () => {
    expect(maximizeGameWindow(undefined, () => {})).toBeNull();
  });
});
