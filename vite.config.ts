import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "ui"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: false,
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
