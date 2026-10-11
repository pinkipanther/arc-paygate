import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../docs so GitHub Pages (main branch, /docs folder) serves it.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../docs",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
