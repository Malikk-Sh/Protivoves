import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  timeout: 40_000,
  expect: { timeout: 12_000 },
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      executablePath: process.env.PROTIVOVES_CHROMIUM || undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
});
