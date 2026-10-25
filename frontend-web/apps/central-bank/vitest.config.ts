import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "central-bank",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
  },
});
