import path from "node:path";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [workflow()],
  test: {
    environment: "node",
    include: ["src/**/*.workflow.test.ts"],
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
