import { defineConfig } from "vitest/config";

// Each package and app is a Vitest project with its own config.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
