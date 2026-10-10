import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:5173", channel: "msedge", headless: true },
  reporter: "list",
  outputDir: "test-results",
});
