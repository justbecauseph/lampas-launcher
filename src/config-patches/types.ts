import type { ConfigOperation, ConfigPatch } from "../types";

export interface PatchResult {
  changed: boolean;
  output: string;
  details?: string[];
}

export interface ConfigPatchAdapter {
  apply(source: string, operations: ConfigOperation[]): PatchResult;
  validate(source: string): void;
  canCreate: boolean;
}
