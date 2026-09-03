import type { ConfigOperation } from "../../types";
import type { ConfigPatchAdapter, PatchResult } from "../types";

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

    for (const op of operations) {
      if (op.op === "replaceLiteral") {
        throw new Error("Properties adapter does not support 'replaceLiteral' operations");
      }
      if (op.path.length !== 1) {
        throw new Error(`Properties adapter requires 1-element path [key], got [${op.path.join(", ")}]`);
      }

      const key = String(op.path[0]);
      const lines = current.split(/\r?\n/);
      let keyFound = false;

      if (op.op === "set") {
        const targetVal = String(op.value);
        const newLines = lines.map((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("#") || trimmed.startsWith("!") || trimmed === "") {
            return line;
          }
          const match = line.match(/^([ \t]*)([^=: \t]+)([ \t]*[=:][ \t]*)(.*)$/);
          if (match && match[2] === key) {
            keyFound = true;
            if (match[4].trim() === targetVal) {
              return line;
            }
            changed = true;
            details.push(`${key}: ${match[4].trim()} → ${targetVal}`);
            return `${match[1]}${match[2]}${match[3]}${targetVal}`;
          }
          return line;
        });

        if (!keyFound) {
          newLines.push(`${key}=${targetVal}`);
          changed = true;
          details.push(`${key}: (unset) → ${targetVal}`);
        }

        current = newLines.join("\n");
      } else if (op.op === "remove") {
        const newLines = lines.filter((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("#") || trimmed.startsWith("!") || trimmed === "") {
            return true;
          }
          const match = line.match(/^([ \t]*)([^=: \t]+)([ \t]*[=:][ \t]*)(.*)$/);
          if (match && match[2] === key) {
            keyFound = true;
            changed = true;
            details.push(`${key}: removed (${match[4].trim()})`);
            return false;
          }
          return true;
        });

        current = newLines.join("\n");
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
