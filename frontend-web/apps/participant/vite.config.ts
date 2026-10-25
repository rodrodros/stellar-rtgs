import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 5175 keeps clear of the other apps' dev servers; `--port` overrides it.
export default defineConfig({
  plugins: [react()],
  // @stellar/stellar-sdk alone is about 900 kB minified; the wallet kit is split out by core.
  build: { chunkSizeWarningLimit: 1500 },
  server: { port: 5175 },
  preview: { port: 5175 },
});
