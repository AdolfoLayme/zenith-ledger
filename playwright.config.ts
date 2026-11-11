import { defineConfig } from '@playwright/test';

// UI tests run the real app with scripted stand-ins for both models (VITE_DEMO_FAKE_AI=1).
// Any Chromium-based browser works; set BROWSER_PATH if yours is not /usr/bin/brave.
const PORT = 5421;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.BROWSER_PATH ?? '/usr/bin/brave' },
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    env: { VITE_DEMO_FAKE_AI: '1' },
    reuseExistingServer: false,
  },
});
