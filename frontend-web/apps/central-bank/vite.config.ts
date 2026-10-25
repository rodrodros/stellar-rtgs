import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A static SPA: no server. `envDir` is the workspace root, where `.env.example` lists every
// VITE_RTGS_* setting core reads.
export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  // The Stellar SDK alone is most of the main chunk; the wallet kit is already split out.
  build: { target: "es2023", chunkSizeWarningLimit: 1500 },
});
