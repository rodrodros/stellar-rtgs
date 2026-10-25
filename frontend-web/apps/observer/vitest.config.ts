import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "observer",
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
