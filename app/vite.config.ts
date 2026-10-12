import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../docs; Vercel serves that folder (see ../vercel.json).
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
