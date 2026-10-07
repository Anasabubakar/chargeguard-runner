import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Scenario tests spawn real worker processes; run files one at a time so timing stays honest on a small machine.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
