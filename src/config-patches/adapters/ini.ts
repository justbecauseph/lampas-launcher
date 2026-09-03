import type { ConfigOperation } from "../../types";
import type { ConfigPatchAdapter, PatchResult } from "../types";

export class IniConfigAdapter implements ConfigPatchAdapter {
  readonly canCreate = true;

  validate(source: string): void {
    if (source.includes("\0")) {
      throw new Error("Invalid INI file: null bytes detected");
    }
  }

  apply(source: string, operations: ConfigOperation[]): PatchResult {
    let current = source;
    let changed = false;
    const details: string[] = [];

    for (const op of operations) {
      if (op.op === "replaceLiteral") {
        throw new Error("INI adapter does not support 'replaceLiteral' operations");
      }
      if (op.path.length !== 1 && op.path.length !== 2) {
        throw new Error(
          `INI adapter requires path [section, key] or [key], got [${op.path.join(", ")}]`
        );
      }

      const section = op.path.length === 2 ? String(op.path[0]) : "";
      const key = op.path.length === 2 ? String(op.path[1]) : String(op.path[0]);
      const lines = current.split(/\r?\n/);

      let inSection = !section;
      let sectionFound = !section;
      let keyFound = false;
      let insertIndex = -1;

      if (op.op === "set") {
        const targetVal = String(op.value);
        const newLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const secMatch = line.match(/^[ \t]*\[([a-zA-Z0-9_.-]+)\]/);
          if (secMatch) {
            if (inSection && section && !keyFound) {
              insertIndex = newLines.length;
            }
            inSection = section ? secMatch[1].toLowerCase() === section.toLowerCase() : false;
            if (inSection) sectionFound = true;
          }

          if (inSection && !keyFound) {
            const kvMatch = line.match(/^([ \t]*)([^=:\s]+)([ \t]*[=:][ \t]*)(.*)$/);
            if (kvMatch && kvMatch[2].toLowerCase() === key.toLowerCase()) {
              keyFound = true;
              if (kvMatch[4].trim() === targetVal) {
                newLines.push(line);
                continue;
              }
              changed = true;
              details.push(
                `${section ? section + "." : ""}${key}: ${kvMatch[4].trim()} → ${targetVal}`
              );
              newLines.push(`${kvMatch[1]}${kvMatch[2]}${kvMatch[3]}${targetVal}`);
              continue;
            }
          }

          newLines.push(line);
        }

        if (sectionFound && !keyFound) {
          const newEntry = `${key}=${targetVal}`;
          if (insertIndex !== -1) {
            newLines.splice(insertIndex, 0, newEntry);
          } else {
            newLines.push(newEntry);
          }
          changed = true;
          details.push(`${section ? section + "." : ""}${key}: (unset) → ${targetVal}`);
        } else if (!sectionFound) {
          if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") {
            newLines.push("");
          }
          newLines.push(`[${section}]`);
          newLines.push(`${key}=${targetVal}`);
          changed = true;
          details.push(`${section ? section + "." : ""}${key}: (unset) → ${targetVal}`);
        }

        current = newLines.join("\n");
      } else if (op.op === "remove") {
        const newLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const secMatch = line.match(/^[ \t]*\[([a-zA-Z0-9_.-]+)\]/);
          if (secMatch) {
            inSection = section ? secMatch[1].toLowerCase() === section.toLowerCase() : false;
          }

          if (inSection && !keyFound) {
            const kvMatch = line.match(/^([ \t]*)([^=:\s]+)([ \t]*[=:][ \t]*)(.*)$/);
            if (kvMatch && kvMatch[2].toLowerCase() === key.toLowerCase()) {
              keyFound = true;
              changed = true;
              details.push(
                `${section ? section + "." : ""}${key}: removed (${kvMatch[4].trim()})`
              );
              continue;
            }
          }

          newLines.push(line);
        }
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

export const iniAdapter = new IniConfigAdapter();
