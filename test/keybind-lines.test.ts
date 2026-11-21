import { describe, expect, test } from "bun:test";
import { planKeybindRewrite } from "../src/config-patches/keybind-lines";

const X = "key.keyboard.x";
const Y = "key.keyboard.y";

describe("planKeybindRewrite: version line required for an append", () => {
  test("appends under an exact version line of at least 1344", () => {
    const plan = planKeybindRewrite("version:1344\n", [
      { key: "key_a", value: X },
    ]);
    expect(plan.output).toBe(`version:1344\nkey_a:${X}\n`);
    expect(plan.changed).toBe(true);
  });

  // Minecraft does not trim around the colon and reads these as version 0.
  for (const versionLine of [
    "version: 4903",
    " version:4903",
    "version :4903",
    "version:4903 ",
    "version:1343",
    "version:",
  ]) {
    test(`defers the append for ${JSON.stringify(versionLine)}`, () => {
      const source = `${versionLine}\nguiScale:2\n`;
      const plan = planKeybindRewrite(source, [{ key: "key_a", value: X }]);
      expect(plan.missingVersionForAppend).toBe("key_a");
      expect(plan.changed).toBe(false);
      expect(plan.output).toBe(source);
    });
  }

  test("rewrites an existing line without a version line", () => {
    const plan = planKeybindRewrite(`key_a:${Y}\n`, [
      { key: "key_a", value: X },
    ]);
    expect(plan.output).toBe(`key_a:${X}\n`);
  });
});

describe("planKeybindRewrite: a key set twice in one patch", () => {
  const updates = [
    { key: "key_a", value: X },
    { key: "key_a", value: Y },
  ];

  test("appends the last value and a re-plan reports no change", () => {
    const plan = planKeybindRewrite("version:4903\n", updates);
    expect(plan.output).toBe(`version:4903\nkey_a:${Y}\n`);
    const again = planKeybindRewrite(plan.output, updates);
    expect(again.changed).toBe(false);
    expect(again.output).toBe(plan.output);
  });

  test("rewrites an existing line to the last value and a re-plan reports no change", () => {
    const plan = planKeybindRewrite(
      "version:4903\nkey_a:key.keyboard.q\n",
      updates,
    );
    expect(plan.output).toBe(`version:4903\nkey_a:${Y}\n`);
    expect(planKeybindRewrite(plan.output, updates).changed).toBe(false);
  });
});

describe("planKeybindRewrite: malformed line next to a valid one", () => {
  test("defers and leaves the source unchanged", () => {
    const source = `version:4903\nkey_a:key.keyboard.a\nkey_a:key.keyboard.b\rjunk\n`;
    const plan = planKeybindRewrite(source, [{ key: "key_a", value: X }]);
    expect(plan.malformedKey).toBe("key_a");
    expect(plan.changed).toBe(false);
    expect(plan.output).toBe(source);
  });
});
