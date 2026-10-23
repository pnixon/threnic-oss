/**
 * Custom Playwright fixtures for Threnic E2E tests.
 *
 * The key fixture here is an overridden `context` that creates a NEW browser
 * context for every test, giving true IndexedDB / localStorage isolation
 * without needing a dedicated test server port.
 */

/* eslint-disable react-hooks/rules-of-hooks */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

export { expect };

type IsolatedFixtures = {
  context: BrowserContext;
  page: Page;
};

export const test = base.extend<IsolatedFixtures>({
  // Create a fresh browser context for every single test.
  // This wipes IndexedDB, localStorage, cookies, and everything else.

  context: async ({ browser }, use) => {
    const ctx = await browser.newContext({
      // Start with an empty storage state
      storageState: { cookies: [], origins: [] },
    });
    await use(ctx);
    await ctx.close();
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    // page is closed when context closes
  },
});
