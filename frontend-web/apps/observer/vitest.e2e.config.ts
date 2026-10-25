import { defineConfig } from "vitest/config";

// Against a running devnet: RTGS_DEVNET_RPC (default http://localhost:8300/rpc). The suite
// skips itself with a notice when RPC is not healthy.
export default defineConfig({
  test: {
    name: "observer-e2e",
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
