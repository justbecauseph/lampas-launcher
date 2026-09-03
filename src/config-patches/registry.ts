import type { ConfigPatchAdapter } from "./types";
import { jsonAdapter } from "./adapters/json";
import { yamlAdapter } from "./adapters/yaml";
import { propertiesAdapter } from "./adapters/properties";
import { iniAdapter } from "./adapters/ini";
import { textAdapter } from "./adapters/text";

export class AdapterRegistry {
  private static adapters = new Map<string, ConfigPatchAdapter>([
    ["json", jsonAdapter],
    ["jsonc", jsonAdapter],
    ["yaml", yamlAdapter],
    ["properties", propertiesAdapter],
    ["ini", iniAdapter],
    ["text", textAdapter],
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
    this.adapters.set("yaml", yamlAdapter);
    this.adapters.set("properties", propertiesAdapter);
    this.adapters.set("ini", iniAdapter);
    this.adapters.set("text", textAdapter);
  }
}
