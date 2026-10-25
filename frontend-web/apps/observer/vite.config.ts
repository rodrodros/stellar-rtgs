import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The observer is a static SPA: no backend, no keys. `@rtgs/core` is consumed as source.
// `envDir` is the workspace root, so one `.env` there configures every app.
export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  server: { port: 5176 },
  preview: { port: 5176 },
});
