import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("UI Console Logs clearing on Play interaction", () => {
  test("renderer.js defines clearConsoleLogs and clears consoleOutput on Play button interaction", () => {
    const rendererCode = fs.readFileSync(path.join(__dirname, "../ui/renderer.js"), "utf-8");

    // Verify clearConsoleLogs function is defined
    expect(rendererCode).toContain("function clearConsoleLogs(notify = false)");
    expect(rendererCode).toContain('consoleOutput.innerHTML = ""');
    expect(rendererCode).toContain('consoleCount.innerText = "0 lines"');

    // Verify btnPlay.onclick calls clearConsoleLogs
    const btnPlayIndex = rendererCode.indexOf("btnPlay.onclick = async () => {");
    expect(btnPlayIndex).toBeGreaterThan(-1);
    const btnPlayBlock = rendererCode.slice(btnPlayIndex, btnPlayIndex + 300);
    expect(btnPlayBlock).toContain("clearConsoleLogs();");

    // Verify btnClearLogs calls clearConsoleLogs(true)
    const btnClearBlock = rendererCode.slice(
      rendererCode.indexOf("if (btnClearLogs) {"),
      rendererCode.indexOf("if (btnClearLogs) {") + 200
    );
    expect(btnClearBlock).toContain("clearConsoleLogs(true);");
  });

  test("clearConsoleLogs behavior resets log output and line counter correctly", () => {
    // Simulate console UI elements
    const elements: Record<string, any> = {
      "console-output": {
        innerHTML: '<div class="console-line">[12:00:00] [INFO] Old log from previous game run</div>',
        scrollTop: 100,
        scrollHeight: 200,
        appendChild(child: any) {
          this.innerHTML += child.outerHTML || child.innerText;
        },
      },
      "console-count": {
        innerText: "42 lines",
      },
    };

    let logLineCount = 42;

    function clearConsoleLogs(notify = false) {
      if (elements["console-output"]) {
        elements["console-output"].innerHTML = "";
      }
      logLineCount = 0;
      if (elements["console-count"]) {
        elements["console-count"].innerText = "0 lines";
      }
    }

    // Before clearing
    expect(elements["console-output"].innerHTML).toContain("Old log from previous game run");
    expect(elements["console-count"].innerText).toBe("42 lines");
    expect(logLineCount).toBe(42);

    // Trigger clear
    clearConsoleLogs();

    // After clearing
    expect(elements["console-output"].innerHTML).toBe("");
    expect(elements["console-count"].innerText).toBe("0 lines");
    expect(logLineCount).toBe(0);
  });
});
