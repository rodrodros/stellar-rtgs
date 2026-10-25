import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A static SPA: no server. `envDir` is the workspace root, where `.env.example` lists every
// VITE_RTGS_* setting core reads. 5174 sits next to the participant (5175) and the observer
// (5176), so `pnpm dev` at the root runs all three; `--port` overrides it.
export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  // The Stellar SDK alone is most of the main chunk; the wallet kit is already split out.
  build: { target: "es2023", chunkSizeWarningLimit: 1500 },
  server: { port: 5174 },
  preview: { port: 5174 },
});
