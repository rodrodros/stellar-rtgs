import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The observer is a static SPA: no backend, no keys. `@rtgs/core` is consumed as source.
export default defineConfig({
  plugins: [react()],
  server: { port: 5176 },
});
