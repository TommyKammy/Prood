import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "db-contracts",
          include: ["tests/contracts/**/*.test.ts"],
          environment: "node",
          testTimeout: 15000,
        },
      },
    ],
  },
});
