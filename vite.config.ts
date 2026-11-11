import { defineConfig } from "vite-plus";
import path from "node:path";

export default defineConfig({
  staged: {
    "**/*": "vp fmt --no-error-on-unmatched-pattern",
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    // Type checking stays with `bun run typecheck` (tsc over tsconfig.json and
    // tsconfig.renderer.json). test/ has no covering tsconfig, so typeCheck
    // here reports bun:test imports as unresolved.
    options: { typeAware: true, typeCheck: false },
  },
  fmt: {
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    bracketSpacing: true,
    arrowParens: "always",
    endOfLine: "lf",
    proseWrap: "preserve",
    sortPackageJson: false,
    ignorePatterns: [
      "node_modules/",
      ".git/",
      "dist/",
      "release/",
      "build/",
      "coverage/",
      "*.tsbuildinfo",
      "bun.lock",
      ".serena/",
      "*.log",
    ],
  },
  root: path.resolve(__dirname, "ui"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: path.resolve(__dirname, "ui/index.html"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
