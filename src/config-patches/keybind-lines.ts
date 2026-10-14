/**
 * Line-level rewrite for keybind patches on options.txt. It does not use the
 * properties adapter. A line matches key K when, after stripping trailing `\r`
 * characters, it matches `^[ \t]*K[ \t]*:` (see keyLinePattern). A key is
 * present when at least one line matches. The value of every matching line is
 * rewritten, so the effective value is the patched one whether Minecraft reads
 * the first or the last occurrence. No line is ever appended. Every line keeps
 * its original terminator, so CRLF, LF, and mixed files survive.
 */

export interface KeybindUpdate {
  key: string;
  value: string;
}

export interface KeybindPlan {
  /** First key that has no matching line. When set, nothing is written. */
  missingKey?: string;
  changed: boolean;
  output: string;
  details: string[];
}

interface SourceLine {
  /** Line text without trailing `\r` characters. */
  body: string;
  /** Trailing `\r` characters. The `\n` separator is added on rebuild. */
  carriageReturns: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Group 1 is the key, colon, and spacing before the value. Group 2 is the value.
// No `s` flag: `.` does not match a lone `\r`, so a line with one inside a value
// does not match and the key counts as missing.
function keyLinePattern(key: string): RegExp {
  return new RegExp(`^([ \\t]*${escapeRegExp(key)}[ \\t]*:[ \\t]*)(.*)$`);
}

function splitLines(source: string): SourceLine[] {
  return source.split("\n").map((part) => {
    const body = part.replace(/\r+$/, "");
    return { body, carriageReturns: part.slice(body.length) };
  });
}

/**
 * Computes the rewrite for `updates` without writing anything. Returns
 * `missingKey` when any key has no matching line. Otherwise `output` is the
 * source with the value of every matching line replaced, or the source unchanged.
 */
export function planKeybindRewrite(
  source: string,
  updates: KeybindUpdate[],
): KeybindPlan {
  const lines = splitLines(source);
  const details: string[] = [];
  let changed = false;
  for (const update of updates) {
    const pattern = keyLinePattern(update.key);
    let matches = 0;
    for (const line of lines) {
      const match = pattern.exec(line.body);
      if (!match) continue;
      matches++;
      if (match[2] !== update.value) {
        line.body = match[1] + update.value;
        details.push(`${update.key}: ${match[2]} → ${update.value}`);
        changed = true;
      }
    }
    if (matches === 0) {
      return {
        missingKey: update.key,
        changed: false,
        output: source,
        details: [],
      };
    }
  }
  return {
    changed,
    output: changed
      ? lines.map((line) => line.body + line.carriageReturns).join("\n")
      : source,
    details,
  };
}
