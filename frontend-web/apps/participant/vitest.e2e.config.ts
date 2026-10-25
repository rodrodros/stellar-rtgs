import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Against a running devnet: RTGS_DEVNET_RPC (default http://localhost:8300/rpc). The suite
// skips itself with a notice when RPC is not healthy.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "participant-e2e",
    // Node, with the DOM from e2e/dom.ts: see there why not "jsdom".
    environment: "node",
    setupFiles: ["e2e/dom.ts"],
    include: ["e2e/**/*.e2e.test.tsx"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
