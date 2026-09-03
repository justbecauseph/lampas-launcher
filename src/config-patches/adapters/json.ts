import {
  parse,
  modify,
  applyEdits,
  findNodeAtLocation,
  parseTree,
  getNodeValue,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
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

export class JsonConfigAdapter implements ConfigPatchAdapter {
  readonly canCreate = true;

  validate(source: string): void {
    if (source.trim() === "") return;
    const errors: ParseError[] = [];
    parse(source, errors);
    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(
        `JSON parse error: ${printParseErrorCode(first.error)} at offset ${first.offset}`
      );
    }
  }

  apply(source: string, operations: ConfigOperation[]): PatchResult {
    let current = source.trim() === "" ? "{}" : source;
    let changed = false;
    const details: string[] = [];

    for (const op of operations) {
      if (op.op === "replaceLiteral") {
        throw new Error("JSON adapter does not support 'replaceLiteral' operations");
      }

      const tree = parseTree(current);
      const targetNode = tree ? findNodeAtLocation(tree, op.path) : undefined;

      if (op.op === "set") {
        if (targetNode !== undefined) {
          const currentVal = getNodeValue(targetNode);
          if (deepEqual(currentVal, op.value)) {
            continue;
          }
          details.push(
            `${op.path.join(".")}: ${JSON.stringify(currentVal)} → ${JSON.stringify(op.value)}`
          );
        } else {
          details.push(`${op.path.join(".")}: (unset) → ${JSON.stringify(op.value)}`);
        }

        const edits = modify(current, op.path, op.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        });
        current = applyEdits(current, edits);
        changed = true;
      } else if (op.op === "remove") {
        if (targetNode === undefined) {
          continue;
        }
        const currentVal = getNodeValue(targetNode);
        details.push(`${op.path.join(".")}: removed (${JSON.stringify(currentVal)})`);

        const edits = modify(current, op.path, undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        });
        current = applyEdits(current, edits);
        changed = true;
      }
    }

    return {
      changed,
      output: current,
      details,
    };
  }
}

export const jsonAdapter = new JsonConfigAdapter();
