// 画面の自動テスト（Playwright）。お試しモードで動かすので、AWSにはつながない。
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "スマホ", use: { ...devices["Pixel 7"] } },
    { name: "パソコン", use: { ...devices["Desktop Chrome"] } },
  ],
  // 本番と同じ「書き出したHTML」で試す（e2e の前に npm run build:mock しておく）
  webServer: {
    command: "npm run serve:out",
    url: `http://localhost:${PORT}/login/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
