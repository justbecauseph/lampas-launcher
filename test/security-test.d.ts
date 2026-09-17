declare module "bun:test" {
  export interface Test<T extends ReadonlyArray<unknown>> {
    (label: string): void;
  }
}
