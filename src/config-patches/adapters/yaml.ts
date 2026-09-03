import YAML from "yaml";
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

export class YamlConfigAdapter implements ConfigPatchAdapter {
  readonly canCreate = true;

  validate(source: string): void {
    if (source.trim() === "") return;
    const doc = YAML.parseDocument(source);
    if (doc.errors.length > 0) {
      throw new Error(`YAML parse error: ${doc.errors[0].message}`);
    }
  }

  apply(source: string, operations: ConfigOperation[]): PatchResult {
    const doc = YAML.parseDocument(source);
    if (doc.errors.length > 0) {
      throw new Error(`YAML parse error: ${doc.errors[0].message}`);
    }

    let changed = false;
    const details: string[] = [];

    for (const op of operations) {
      if (op.op === "replaceLiteral") {
        throw new Error("YAML adapter does not support 'replaceLiteral' operations");
      }

      const hasKey = doc.hasIn(op.path);
      const currentVal = hasKey ? doc.getIn(op.path) : undefined;

      if (op.op === "set") {
        if (hasKey && deepEqual(currentVal, op.value)) {
          continue;
        }
        details.push(
          `${op.path.join(".")}: ${hasKey ? JSON.stringify(currentVal) : "(unset)"} → ${JSON.stringify(op.value)}`
        );
        doc.setIn(op.path, op.value);
        changed = true;
      } else if (op.op === "remove") {
        if (!hasKey) {
          continue;
        }
        details.push(`${op.path.join(".")}: removed (${JSON.stringify(currentVal)})`);
        doc.deleteIn(op.path);
        changed = true;
      }
    }

    return {
      changed,
      output: changed ? doc.toString() : source,
      details,
    };
  }
}

export const yamlAdapter = new YamlConfigAdapter();
