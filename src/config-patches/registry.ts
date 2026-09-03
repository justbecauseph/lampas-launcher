import type { ConfigPatchAdapter } from "./types";
import { jsonAdapter } from "./adapters/json";

export class AdapterRegistry {
  private static adapters = new Map<string, ConfigPatchAdapter>([
    ["json", jsonAdapter],
    ["jsonc", jsonAdapter],
  ]);

  static register(name: string, adapter: ConfigPatchAdapter): void {
    this.adapters.set(name, adapter);
  }

  static get(name: string): ConfigPatchAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      if (name === "json5") {
        throw new Error(
          `Adapter 'json5' is currently unsupported: safe comment/formatting preservation cannot be guaranteed.`
        );
      }
      throw new Error(`Unsupported config patch adapter '${name}'.`);
    }
    return adapter;
  }

  static has(name: string): boolean {
    return this.adapters.has(name);
  }

  static clear(): void {
    this.adapters.clear();
  }

  static resetDefaults(): void {
    this.adapters.clear();
    this.adapters.set("json", jsonAdapter);
    this.adapters.set("jsonc", jsonAdapter);
  }
}
