import type { ConfigOperation } from "../../types";
import type { ConfigPatchAdapter, PatchResult } from "../types";

export class TextConfigAdapter implements ConfigPatchAdapter {
  readonly canCreate = false;

  validate(source: string): void {
    if (source.includes("\0")) {
      throw new Error("Invalid text file: null bytes detected");
    }
  }

  apply(source: string, operations: ConfigOperation[]): PatchResult {
    let current = source;
    let changed = false;
    const details: string[] = [];

    for (const op of operations) {
      if (op.op !== "replaceLiteral") {
        throw new Error(
          `Text adapter only supports 'replaceLiteral' operations, got '${(op as any).op}'`
        );
      }

      const { search, replacement, expectedMatches } = op;
      if (!search) {
        throw new Error("replaceLiteral requires a non-empty 'search' string");
      }
      if (typeof expectedMatches !== "number" || expectedMatches < 1) {
        throw new Error("replaceLiteral requires 'expectedMatches' to be an integer >= 1");
      }

      let count = 0;
      let pos = 0;
      while ((pos = current.indexOf(search, pos)) !== -1) {
        count++;
        pos += search.length;
      }

      if (count === 0) {
        let repCount = 0;
        let rPos = 0;
        while ((rPos = current.indexOf(replacement, rPos)) !== -1) {
          repCount++;
          rPos += replacement.length;
        }

        if (repCount >= expectedMatches) {
          continue;
        }

        throw new Error(
          `replaceLiteral expected ${expectedMatches} matches for '${search}', but found 0 (and replacement not present)`
        );
      }

      if (count !== expectedMatches) {
        throw new Error(
          `replaceLiteral expected ${expectedMatches} matches for '${search}', but found ${count}`
        );
      }

      current = current.replaceAll(search, replacement);
      changed = true;
      details.push(`'${search}' → '${replacement}' (${count} match${count > 1 ? "es" : ""})`);
    }

    return {
      changed,
      output: current,
      details,
    };
  }
}

export const textAdapter = new TextConfigAdapter();
