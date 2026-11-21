/**
 * Line-level rewrite for keybind patches on options.txt. It does not use the
 * properties adapter. A line matches key K when, after stripping trailing `\r`
 * characters, it matches `^[ \t]*K[ \t]*:` (see keyLinePattern). When one or
 * more lines match the value pattern, each of them is rewritten in place, so the
 * effective value is the patched one whether Minecraft reads the first or the
 * last occurrence. A key with no line at all is appended at the end of the file,
 * but only when an exact `version:<int>` line with a value of at least 1344
 * exists. Otherwise Minecraft's DataFixer reads the file as the pre-1.13 format,
 * so the append is deferred. A patch that sets a key twice uses the last value. A
 * key whose line fails the value pattern (for example, a lone `\r` inside the
 * value) is reported as malformedKey and never appended, which would duplicate
 * it. Every line keeps its original terminator, so CRLF, LF, and mixed files
 * survive.
 */

export interface KeybindUpdate {
  key: string;
  value: string;
}

export interface KeybindPlan {
  /**
   * First key with a line that contains `<key>:` but fails the value pattern.
   * When set, nothing is written.
   */
  malformedKey?: string;
  /**
   * First key with no line that needs appending, and no `version:<int>` line to
   * append it under. When set, nothing is written.
   */
  missingVersionForAppend?: string;
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

// Minecraft splits each line on the first `:` without trimming and parses the
// version with Integer.parseInt, falling back to 0. Only the exact form
// `version:<int>` counts. Below 1344 the DataFixer still runs the LWJGL3 key
// fix, which expects numeric key codes and cannot read `key.keyboard.*` values.
const VERSION_LINE_PATTERN = /^version:(\d+)$/;
const MIN_NAMED_KEY_VERSION = 1344;

function hasNamedKeyVersion(lines: SourceLine[]): boolean {
  return lines.some((line) => {
    const match = VERSION_LINE_PATTERN.exec(line.body);
    return match !== null && Number(match[1]) >= MIN_NAMED_KEY_VERSION;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Group 1 is the key, colon, and spacing before the value. Group 2 is the value.
// No `s` flag: `.` does not match a lone `\r`, so a line with one inside a value
// does not match this pattern.
function keyLinePattern(key: string): RegExp {
  return new RegExp(`^([ \\t]*${escapeRegExp(key)}[ \\t]*:[ \\t]*)(.*)$`);
}

// Matches a line that starts with the key, whether or not its value parses.
function keyPrefixPattern(key: string): RegExp {
  return new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*:`);
}

function splitLines(source: string): SourceLine[] {
  return source.split("\n").map((part) => {
    const body = part.replace(/\r+$/, "");
    return { body, carriageReturns: part.slice(body.length) };
  });
}

/**
 * Appends `key:value` as the last line. When the source ends with a newline,
 * the new line goes before the empty slot after that newline. When it does not,
 * the previously-last line receives the separator and the new line stays
 * unterminated, so trailing-newline presence matches the input.
 */
function appendKeyLine(
  lines: SourceLine[],
  key: string,
  value: string,
  crlf: boolean,
): void {
  const last = lines[lines.length - 1];
  const body = `${key}:${value}`;
  if (last.body === "" && last.carriageReturns === "") {
    lines.splice(lines.length - 1, 0, {
      body,
      carriageReturns: crlf ? "\r" : "",
    });
    return;
  }
  if (crlf && last.carriageReturns === "") last.carriageReturns = "\r";
  lines.push({ body, carriageReturns: "" });
}

/**
 * Computes the rewrite for `updates` without writing anything. Returns
 * `malformedKey` or `missingVersionForAppend` when a key cannot be safely
 * written. Otherwise `output` is the source with matching values rewritten and
 * absent keys appended, or the source unchanged. Any early return reports
 * `changed: false` and the original source, even if earlier updates changed lines.
 */
export function planKeybindRewrite(
  source: string,
  updates: KeybindUpdate[],
): KeybindPlan {
  // A key set more than once takes its last value, so a re-plan of the written
  // file reports no change.
  const lastValues = new Map<string, string>();
  for (const update of updates) lastValues.set(update.key, update.value);
  updates = [...lastValues].map(([key, value]) => ({ key, value }));

  const lines = splitLines(source);
  const crlf = source.includes("\r\n");
  const details: string[] = [];
  let changed = false;
  for (const update of updates) {
    const pattern = keyLinePattern(update.key);
    const prefix = keyPrefixPattern(update.key);
    // Checked before any rewrite: a malformed line for this key defers the patch
    // even when another line for the same key is valid.
    if (
      lines.some((line) => prefix.test(line.body) && !pattern.test(line.body))
    ) {
      return {
        malformedKey: update.key,
        changed: false,
        output: source,
        details: [],
      };
    }
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
    if (matches > 0) continue;

    if (!hasNamedKeyVersion(lines)) {
      return {
        missingVersionForAppend: update.key,
        changed: false,
        output: source,
        details: [],
      };
    }
    appendKeyLine(lines, update.key, update.value, crlf);
    details.push(`${update.key}: (unset) → ${update.value}`);
    changed = true;
  }
  return {
    changed,
    output: changed
      ? lines.map((line) => line.body + line.carriageReturns).join("\n")
      : source,
    details,
  };
}
