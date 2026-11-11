import { defineConfig } from "@playwright/test";

// TINY_DESK_PORT lets two runs of the bench use the machine at once; the app's own scripts use 5817.
const port = Number(process.env.TINY_DESK_PORT ?? 5817);

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  reporter: [["dot"]],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
