import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // unit tests live next to source under src/__tests__/.
    // Exclude Playwright E2E specs in e2e/ from vitest.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    environment: "node",
  },
});
