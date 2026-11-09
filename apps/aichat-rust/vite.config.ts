import { defineConfig } from "vite";
import { resolve } from "node:path";

// Three desktop windows: main fallback/shell, floating pet, and update center.
export default defineConfig({
  clearScreen: false,
  server: { port: 1430, strictPort: true },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html"),
        updates: resolve(__dirname, "updates.html"),
      },
    },
  },
});
