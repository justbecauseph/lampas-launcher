import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initConsoleView } from "../ui/src/views/console-view";
import type { ConsoleViewInstance } from "../ui/src/views/console-view";

class MockDomElement {
  id: string = "";
  innerText: string = "";
  className: string = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  scrollTop: number = 0;
  scrollHeight: number = 0;
  childNodes: MockDomElement[] = [];
  isFragment = false;

  listeners: Record<string, ((ev?: any) => void)[]> = {};

  classList = {
    classes: new Set<string>(),
    add: (...c: string[]) =>
      c.forEach((cls) => this.classList.classes.add(cls)),
    remove: (...c: string[]) =>
      c.forEach((cls) => this.classList.classes.delete(cls)),
    contains: (cls: string) => this.classList.classes.has(cls),
  };

  // Assigning "" drops every child, matching the DOM's innerHTML behaviour.
  private html = "";
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    if (value === "") this.childNodes = [];
  }

  get firstChild(): MockDomElement | null {
    return this.childNodes[0] ?? null;
  }

  addEventListener(event: string, handler: (ev?: any) => void) {
    (this.listeners[event] ??= []).push(handler);
  }

  removeEventListener(event: string, handler: (ev?: any) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter(
      (h) => h !== handler,
    );
  }

  dispatchEvent(event: string) {
    for (const handler of this.listeners[event] ?? []) {
      handler({ target: this });
    }
  }

  // Like a DocumentFragment, appending one moves its children instead.
  appendChild(child: MockDomElement) {
    if (child.isFragment) {
      this.childNodes.push(...child.childNodes);
      child.childNodes = [];
    } else {
      this.childNodes.push(child);
    }
    this.scrollHeight += 20;
  }

  removeChild(child: MockDomElement) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
  }
}

describe("Console view clearing", () => {
  const prevDoc = (globalThis as any).document;
  const prevWin = (globalThis as any).window;

  let consoleOutput: MockDomElement;
  let consoleCount: MockDomElement;
  let btnClearLogs: MockDomElement;
  let toasts: Array<{ message: string; type: string }>;
  let unsubscribed: string[];
  let view: ConsoleViewInstance;

  beforeEach(() => {
    const elements = new Map<string, MockDomElement>();
    const reg = (id: string): MockDomElement => {
      const el = new MockDomElement();
      el.id = id;
      elements.set(id, el);
      return el;
    };
    consoleOutput = reg("console-output");
    consoleCount = reg("console-count");
    btnClearLogs = reg("btn-clear-logs");

    (globalThis as any).document = {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new MockDomElement(),
      createDocumentFragment: () => {
        const fragment = new MockDomElement();
        fragment.isFragment = true;
        return fragment;
      },
    };

    unsubscribed = [];
    (globalThis as any).window = {
      lampas: {
        game: {
          onLogBatch: () => () => {
            unsubscribed.push("onLogBatch");
          },
          onExit: () => () => {
            unsubscribed.push("onExit");
          },
        },
      },
    };

    toasts = [];
    view = initConsoleView({
      showToast: (message, type) => {
        toasts.push({ message, type });
      },
    });
  });

  afterEach(() => {
    view.dispose();
    (globalThis as any).document = prevDoc;
    (globalThis as any).window = prevWin;
  });

  test("appendLog adds a line to the output and updates the line counter", () => {
    expect(consoleOutput.childNodes).toHaveLength(0);

    view.appendLog("INFO", "hello");

    expect(consoleCount.innerText).toBe("1 line");
    expect(consoleOutput.childNodes).toHaveLength(1);
    expect(consoleOutput.childNodes[0].dataset.level).toBe("INFO");
  });

  test("window.clearConsoleLogs empties the output and resets the line counter", () => {
    view.appendLog("INFO", "old log from a previous game run");
    view.appendLog("WARN", "another old line");
    expect(consoleCount.innerText).toBe("2 lines");
    expect(consoleOutput.childNodes).toHaveLength(2);

    (globalThis as any).window.clearConsoleLogs();

    expect(consoleOutput.innerHTML).toBe("");
    expect(consoleOutput.childNodes).toHaveLength(0);
    expect(consoleCount.innerText).toBe("0 lines");
    // A silent clear, as the Play button does, shows no toast.
    expect(toasts).toHaveLength(0);

    // The counter restarts from zero rather than continuing from 2.
    view.appendLog("INFO", "fresh log");
    expect(consoleCount.innerText).toBe("1 line");
  });

  test("the clear button clears the console and shows a toast", () => {
    view.appendLog("ERROR", "something failed");
    expect(btnClearLogs.listeners["click"]).toHaveLength(1);

    btnClearLogs.dispatchEvent("click");

    expect(consoleOutput.childNodes).toHaveLength(0);
    expect(consoleCount.innerText).toBe("0 lines");
    expect(toasts).toEqual([{ message: "Cleared.", type: "info" }]);
  });

  test("dispose unsubscribes from game log and exit events", () => {
    view.dispose();

    expect(unsubscribed.sort()).toEqual(["onExit", "onLogBatch"]);
    expect(btnClearLogs.listeners["click"]).toHaveLength(0);
  });
});
