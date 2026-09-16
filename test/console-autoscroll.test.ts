import { describe, expect, test } from "bun:test";
import { initConsoleView } from "../ui/src/views/console-view";
import type { GameLogEntry } from "../ui/src/types";

class MockDomElement {
  id: string = "";
  value: string = "";
  innerText: string = "";
  innerHTML: string = "";
  className: string = "";
  style: Record<string, string> = {};
  disabled: boolean = false;
  checked: boolean = true;
  dataset: Record<string, string> = {};
  scrollTop: number = 0;
  scrollHeight: number = 500;
  childNodes: MockDomElement[] = [];

  listeners: Record<string, ((ev?: any) => void)[]> = {};

  classList = {
    classes: new Set<string>(),
    add: (...c: string[]) => c.forEach((cls) => this.classList.classes.add(cls)),
    remove: (...c: string[]) => c.forEach((cls) => this.classList.classes.delete(cls)),
    contains: (cls: string) => this.classList.classes.has(cls),
  };

  addEventListener(event: string, handler: (ev?: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  removeEventListener(event: string, handler: (ev?: any) => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((h) => h !== handler);
  }

  dispatchEvent(event: string) {
    if (this.listeners[event]) {
      for (const h of this.listeners[event]) {
        h({ target: this });
      }
    }
  }

  append(...nodes: (MockDomElement | string)[]) {
    for (const node of nodes) {
      if (typeof node === "string") {
        const textNode = new MockDomElement();
        textNode.innerText = node;
        this.childNodes.push(textNode);
      } else {
        this.childNodes.push(node);
      }
    }
  }

  appendChild(child: MockDomElement) {
    this.childNodes.push(child);
    this.scrollHeight += 20; // Simulate height growth on new content
  }

  removeChild(child: MockDomElement) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
  }

  querySelectorAll(selector: string): MockDomElement[] {
    if (selector === ".console-line") {
      return this.childNodes.filter((c) => c.className.includes("console-line"));
    }
    return [];
  }
}

describe("Console View Auto-Scroll and Controls", () => {
  test("auto-scroll checkbox is respected: scrolls when checked, does NOT scroll when unchecked", () => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;

    const elements = new Map<string, MockDomElement>();
    const reg = (id: string): MockDomElement => {
      const el = new MockDomElement();
      el.id = id;
      elements.set(id, el);
      return el;
    };

    const consoleOutput = reg("console-output");
    const consoleCount = reg("console-count");
    const consoleAutoscroll = reg("console-autoscroll");
    consoleAutoscroll.checked = true;

    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tag: string) => {
        const el = new MockDomElement();
        return el;
      },
    };

    let logBatchCallback: ((batch: { entries: GameLogEntry[] }) => void) | null = null;
    (globalThis as any).window = {
      lampas: {
        game: {
          onLogBatch: (cb: any) => {
            logBatchCallback = cb;
            return () => {};
          },
        },
      },
    };

    const consoleView = initConsoleView({
      showToast: () => {},
    });

    expect(consoleView.isAutoScroll()).toBe(true);

    // Initial state: scrollTop is 0, scrollHeight is 500
    consoleOutput.scrollTop = 0;
    consoleOutput.scrollHeight = 600;

    // 1. Append log when auto-scroll is CHECKED -> Should scroll to bottom
    consoleView.appendLog("INFO", "First message while autoscroll enabled");
    expect(consoleOutput.scrollTop).toBe(consoleOutput.scrollHeight);
    expect(consoleCount.innerText).toBe("1 line");

    // Reset scrollTop to represent user reading higher up
    consoleOutput.scrollTop = 150;

    // 2. UNCHECK the auto-scroll checkbox
    consoleAutoscroll.checked = false;
    consoleAutoscroll.dispatchEvent("change");

    expect(consoleView.isAutoScroll()).toBe(false);

    // Appending a launcher log while unchecked -> scrollTop must remain at 150
    consoleView.appendLog("INFO", "Second message while autoscroll disabled");
    expect(consoleOutput.scrollTop).toBe(150);
    expect(consoleCount.innerText).toBe("2 lines");

    // Game process batch logs while unchecked -> scrollTop must still remain at 150
    if (logBatchCallback) {
      (logBatchCallback as any)({
        entries: [
          { timestamp: "12:00:01", level: "INFO", message: "Batch game line 1" },
          { timestamp: "12:00:02", level: "WARN", message: "Batch game line 2" },
        ],
      });
    }
    expect(consoleOutput.scrollTop).toBe(150);
    expect(consoleCount.innerText).toBe("4 lines");

    // 3. RE-CHECK the auto-scroll checkbox -> Should immediately snap to scrollHeight
    consoleAutoscroll.checked = true;
    consoleAutoscroll.dispatchEvent("change");

    expect(consoleView.isAutoScroll()).toBe(true);
    expect(consoleOutput.scrollTop).toBe(consoleOutput.scrollHeight);

    // 4. Appending another log while re-checked -> Should scroll
    consoleOutput.scrollTop = 0;
    consoleView.appendLog("INFO", "Third message while autoscroll re-enabled");
    expect(consoleOutput.scrollTop).toBe(consoleOutput.scrollHeight);

    consoleView.dispose();
    (globalThis as any).document = prevDoc;
    (globalThis as any).window = prevWin;
  });

  test("log level filter respects auto-scroll state", () => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;

    const elements = new Map<string, MockDomElement>();
    const reg = (id: string): MockDomElement => {
      const el = new MockDomElement();
      el.id = id;
      elements.set(id, el);
      return el;
    };

    const consoleOutput = reg("console-output");
    reg("console-count");
    const consoleAutoscroll = reg("console-autoscroll");
    const logFilterLevel = reg("log-filter-level");

    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new MockDomElement(),
    };
    (globalThis as any).window = {
      lampas: {},
    };

    const consoleView = initConsoleView({
      showToast: () => {},
    });

    // Populate lines
    consoleView.appendLog("INFO", "Info line");
    consoleView.appendLog("ERROR", "Error line");

    // With auto-scroll disabled, changing filter should not scroll
    consoleAutoscroll.checked = false;
    consoleAutoscroll.dispatchEvent("change");

    consoleOutput.scrollTop = 50;
    consoleOutput.scrollHeight = 800;

    logFilterLevel.value = "ERROR";
    logFilterLevel.dispatchEvent("change");

    expect(consoleOutput.scrollTop).toBe(50);

    // With auto-scroll enabled, changing filter should scroll
    consoleAutoscroll.checked = true;
    consoleAutoscroll.dispatchEvent("change");

    consoleOutput.scrollTop = 50;
    logFilterLevel.value = "ALL";
    logFilterLevel.dispatchEvent("change");

    expect(consoleOutput.scrollTop).toBe(consoleOutput.scrollHeight);

    consoleView.dispose();
    (globalThis as any).document = prevDoc;
    (globalThis as any).window = prevWin;
  });

  test("btn-console-stop calls window.lampas.game.kill() and setGameStatus updates indicator", async () => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;

    const elements = new Map<string, MockDomElement>();
    const reg = (id: string): MockDomElement => {
      const el = new MockDomElement();
      el.id = id;
      elements.set(id, el);
      return el;
    };

    reg("console-output");
    reg("console-count");
    reg("console-autoscroll");
    const btnConsoleStop = reg("btn-console-stop");
    const consoleGameStatus = reg("console-game-status");
    const consoleStatusDot = reg("console-status-dot");
    const consoleStatusText = reg("console-status-text");

    let killCalled = false;
    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new MockDomElement(),
    };
    (globalThis as any).window = {
      lampas: {
        game: {
          kill: async () => {
            killCalled = true;
          },
        },
      },
    };

    const consoleView = initConsoleView({
      showToast: () => {},
    });

    // Initially idle -> stop button hidden
    consoleView.setGameStatus("idle");
    expect(consoleStatusText.innerText).toBe("IDLE");
    expect(btnConsoleStop.classList.contains("hidden")).toBe(true);

    // Running -> stop button shown
    consoleView.setGameStatus("running");
    expect(consoleStatusText.innerText).toBe("GAME RUNNING");
    expect(consoleStatusDot.className).toContain("status-dot-running");
    expect(btnConsoleStop.classList.contains("hidden")).toBe(false);

    // Click stop button
    btnConsoleStop.dispatchEvent("click");
    await Promise.resolve(); // allow microtask

    expect(killCalled).toBe(true);

    consoleView.dispose();
    (globalThis as any).document = prevDoc;
    (globalThis as any).window = prevWin;
  });
});
