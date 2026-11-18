import { defineConfig } from "vite";
import { resolve } from "node:path";
import { createRequire } from "node:module";

// Keep this CommonJS helper outside Vite's bundled ESM configuration.
const devServer = createRequire(import.meta.url)("./scripts/dev-server.cjs");
// A reviewed host record pins experiment resources before either dev serving or bundling.
createRequire(import.meta.url)("./scripts/check-ainiang-assets.cjs").verifyAiniangAssets();

// Three desktop windows: main fallback/shell, floating pet, and update center.
export default defineConfig({
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1430, strictPort: true },
  plugins: [devServer.devIdentityPlugin(__dirname)],
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
        remoteVoice: resolve(__dirname, "remote-voice.html"),
      },
    },
  },
});
