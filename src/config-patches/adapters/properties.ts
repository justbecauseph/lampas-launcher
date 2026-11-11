import type { ConfigOperation } from "../../types";
import type { ConfigPatchAdapter, PatchResult } from "../types";

// A physical line continues onto the next line when it ends in an odd number
// of backslashes.
function endsWithContinuation(line: string): boolean {
  let backslashes = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

// Groups physical lines into logical lines, so a key and its continuation lines
// are replaced or removed together. Comment and blank lines never continue.
function groupLogicalLines(lines: string[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const group = [lines[i]];
    const trimmed = lines[i].trim();
    if (
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("!") &&
      trimmed !== ""
    ) {
      while (i + 1 < lines.length && endsWithContinuation(lines[i])) {
        i++;
        group.push(lines[i]);
      }
    }
    groups.push(group);
  }
  return groups;
}

export class PropertiesConfigAdapter implements ConfigPatchAdapter {
  readonly canCreate = true;

  validate(source: string): void {
    if (source.includes("\0")) {
      throw new Error("Invalid properties file: null bytes detected");
    }
  }

  apply(source: string, operations: ConfigOperation[]): PatchResult {
    let current = source;
    let changed = false;
    const details: string[] = [];
    const eol = source.includes("\r\n") ? "\r\n" : "\n";

    for (const op of operations) {
      if (op.op === "replaceLiteral") {
        throw new Error(
          "Properties adapter does not support 'replaceLiteral' operations",
        );
      }
      if (op.path.length !== 1) {
        throw new Error(
          `Properties adapter requires 1-element path [key], got [${op.path.join(", ")}]`,
        );
      }

      const key = String(op.path[0]);
      const lines = current.split(/\r?\n/);
      let keyFound = false;

      if (op.op === "set") {
        const targetVal = String(op.value);
        const newLines = groupLogicalLines(lines).flatMap((group) => {
          const line = group[0];
          const trimmed = line.trim();
          if (
            trimmed.startsWith("#") ||
            trimmed.startsWith("!") ||
            trimmed === ""
          ) {
            return group;
          }
          const match = line.match(
            /^([ \t]*)([^=: \t]+)([ \t]*[=:][ \t]*)(.*)$/,
          );
          if (match && match[2] === key) {
            keyFound = true;
            if (group.length === 1 && match[4].trim() === targetVal) {
              return group;
            }
            changed = true;
            details.push(`${key}: ${match[4].trim()} → ${targetVal}`);
            return [`${match[1]}${match[2]}${match[3]}${targetVal}`];
          }
          return group;
        });

        if (!keyFound) {
          newLines.push(`${key}=${targetVal}`);
          changed = true;
          details.push(`${key}: (unset) → ${targetVal}`);
        }

        current = newLines.join(eol);
      } else if (op.op === "remove") {
        const newLines = groupLogicalLines(lines).flatMap((group) => {
          const line = group[0];
          const trimmed = line.trim();
          if (
            trimmed.startsWith("#") ||
            trimmed.startsWith("!") ||
            trimmed === ""
          ) {
            return group;
          }
          const match = line.match(
            /^([ \t]*)([^=: \t]+)([ \t]*[=:][ \t]*)(.*)$/,
          );
          if (match && match[2] === key) {
            keyFound = true;
            changed = true;
            details.push(`${key}: removed (${match[4].trim()})`);
            return [];
          }
          return group;
        });

        current = newLines.join(eol);
      }
    }

    return {
      changed,
      output: current,
      details,
    };
  }
}

export const propertiesAdapter = new PropertiesConfigAdapter();
