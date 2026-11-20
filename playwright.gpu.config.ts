import { defineConfig, devices } from '@playwright/test';

/**
 * GPU rendering tests: every effect and visualizer, on every renderer.
 *
 *   chrome-webgpu   Chromium with real WebGPU — the reference renderer.
 *   chrome-webgl2   Chromium pinned to the WebGL2 compatibility backend.
 *   firefox-webgl2  Firefox, which has no WebGPU on Linux and so uses the
 *                   WebGL2 compatibility backend by default.
 *
 * Run against a production build (`npm run build`) served on GPU_E2E_PORT;
 * `npm run test:gpu` does both. Set GPU_E2E_URL to test a deployed site.
 */
const PORT = Number(process.env.GPU_E2E_PORT ?? 3217);
const BASE_URL = process.env.GPU_E2E_URL ?? `http://localhost:${PORT}`;

// Chromium has to be told to expose WebGPU on Linux. Headless Chromium only
// offers the SwiftShader software adapter, which is what CI uses; on a
// machine with a GPU, GPU_E2E_HEADED=1 runs a real (off-screen) window so
// WebGPU and WebGL2 both use the actual graphics card.
const HEADED = !!process.env.GPU_E2E_HEADED;
const CHROME_GPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  ...(HEADED
    ? ['--ozone-platform=x11', '--window-position=-3000,-3000']
    : ['--use-webgpu-adapter=swiftshader']),
];

export default defineConfig({
  testDir: './src/test/gpu',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-gpu', open: 'never' }]],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/gpu',

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1600, height: 900 },
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chrome-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 900 },
        channel: 'chromium',
        headless: !HEADED,
        launchOptions: { args: CHROME_GPU_ARGS },
      },
      metadata: { backend: 'webgpu' },
    },
    {
      name: 'chrome-webgl2',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 900 },
        channel: 'chromium',
        headless: !HEADED,
        launchOptions: { args: CHROME_GPU_ARGS },
      },
      metadata: { backend: 'webgl2', forceCompat: true },
    },
    {
      name: 'firefox-webgl2',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1600, height: 900 },
        // Always headless: Playwright's Firefox build crashes on some Wayland desktops.
        headless: true,
        launchOptions: {
          firefoxUserPrefs: { 'media.autoplay.default': 0, 'webgl.force-enabled': true },
        },
      },
      metadata: { backend: 'webgl2' },
    },
  ],

  webServer: process.env.GPU_E2E_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
