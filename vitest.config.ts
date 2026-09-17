import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tst/**/*Test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 },
    },
  },
});
