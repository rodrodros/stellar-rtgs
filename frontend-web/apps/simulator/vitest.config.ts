import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "simulator",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
