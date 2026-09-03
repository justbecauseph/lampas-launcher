import * as smolToml from "smol-toml";
import type { ConfigOperation } from "../../types";
import type { ConfigPatchAdapter, PatchResult } from "../types";

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function formatTomlValue(val: any): string {
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return JSON.stringify(val);
  if (Array.isArray(val)) return JSON.stringify(val);
  return JSON.stringify(val);
}

function getNested(obj: any, path: Array<string | number>): any {
  let cur = obj;
  for (const part of path) {
    if (cur === undefined || cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class TomlConfigAdapter implements ConfigPatchAdapter {
  readonly canCreate = true;

  validate(source: string): void {
    if (source.trim() === "") return;
    try {
      smolToml.parse(source);
    } catch (err: any) {
      throw new Error(`TOML parse error: ${err.message}`);
    }
  }

  apply(source: string, operations: ConfigOperation[]): PatchResult {
    let current = source;
    let changed = false;
    const details: string[] = [];

    // Validate original document before any modification
    if (current.trim() !== "") {
      try {
        smolToml.parse(current);
      } catch (err: any) {
        throw new Error(`TOML parse error: ${err.message}`);
      }
    }

    for (const op of operations) {
      if (op.op === "replaceLiteral") {
        throw new Error("TOML adapter does not support 'replaceLiteral' operations");
      }
      if (op.path.length === 0) {
        throw new Error("TOML operation path must not be empty");
      }

      const parsed = current.trim() === "" ? {} : (smolToml.parse(current) as any);
      const existingVal = getNested(parsed, op.path);

      if (op.op === "set") {
        if (existingVal !== undefined && deepEqual(existingVal, op.value)) {
          continue;
        }
        details.push(
          `${op.path.join(".")}: ${existingVal !== undefined ? JSON.stringify(existingVal) : "(unset)"} → ${JSON.stringify(op.value)}`
        );
      } else if (op.op === "remove") {
        if (existingVal === undefined) {
          continue;
        }
        details.push(`${op.path.join(".")}: removed (${JSON.stringify(existingVal)})`);
      }

      const key = String(op.path[op.path.length - 1]);
      const sectionParts = op.path.slice(0, -1);
      const sectionName = sectionParts.join(".");
      const formattedVal = op.op === "set" ? formatTomlValue(op.value) : "";

      const lines = current.split(/\r?\n/);
      let sectionStart = -1;
      let sectionEnd = lines.length;

      if (sectionParts.length === 0) {
        sectionStart = 0;
        for (let i = 0; i < lines.length; i++) {
          if (/^[ \t]*\[/.test(lines[i])) {
            sectionEnd = i;
            break;
          }
        }
      } else {
        const secRegex = new RegExp(`^[ \t]*\\[[ \t]*${escapeRegex(sectionName)}[ \t]*\\]`);
        for (let i = 0; i < lines.length; i++) {
          if (secRegex.test(lines[i])) {
            sectionStart = i;
            for (let j = i + 1; j < lines.length; j++) {
              if (/^[ \t]*\[/.test(lines[j])) {
                sectionEnd = j;
                break;
              }
            }
            break;
          }
        }
      }

      if (sectionStart === -1) {
        if (op.op === "set") {
          const newSection = `\n[${sectionName}]\n${key} = ${formattedVal}\n`;
          current = current + (current.endsWith("\n") ? "" : "\n") + newSection;
          changed = true;
        }
        continue;
      }

      const keyRegex = new RegExp(
        `^([ \t]*(?:"${escapeRegex(key)}"|'${escapeRegex(key)}'|${escapeRegex(key)})[ \t]*=[ \t]*)([^#]*?)([ \t]*(?:#.*)?)$`
      );

      let keyLineIdx = -1;
      for (let i = sectionStart; i < sectionEnd; i++) {
        if (keyRegex.test(lines[i])) {
          keyLineIdx = i;
          break;
        }
      }

      if (keyLineIdx !== -1) {
        if (op.op === "set") {
          const match = lines[keyLineIdx].match(keyRegex)!;
          lines[keyLineIdx] = `${match[1]}${formattedVal}${match[3]}`;
          current = lines.join("\n");
          changed = true;
        } else if (op.op === "remove") {
          lines.splice(keyLineIdx, 1);
          current = lines.join("\n");
          changed = true;
        }
      } else {
        if (op.op === "set") {
          lines.splice(sectionEnd, 0, `${key} = ${formattedVal}`);
          current = lines.join("\n");
          changed = true;
        }
      }

      // Safe validation: parse modified document and check targeted property
      let reParsed: any;
      try {
        reParsed = smolToml.parse(current);
      } catch (parseErr: any) {
        throw new Error(
          `Cannot safely modify TOML document: targeted edit resulted in invalid syntax (${parseErr.message})`
        );
      }

      if (op.op === "set") {
        const check = getNested(reParsed, op.path);
        if (!deepEqual(check, op.value)) {
          throw new Error(
            `Cannot safely modify TOML document: targeted edit failed to apply expected value`
          );
        }
      } else if (op.op === "remove") {
        const check = getNested(reParsed, op.path);
        if (check !== undefined) {
          throw new Error(
            `Cannot safely modify TOML document: targeted edit failed to remove property`
          );
        }
      }
    }

    return {
      changed,
      output: current,
      details,
    };
  }
}

export const tomlAdapter = new TomlConfigAdapter();
