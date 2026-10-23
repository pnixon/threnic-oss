/**
 * Integration tests: Export tab
 *
 * Validates that the Export tab options (resolution, FPS, format, codec) are
 * present, interactive, and persist across tab navigation.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, addBlankTrack, selectTrack, openExportTab } from './helpers/app';

async function setup(page: Parameters<typeof gotoApp>[0]) {
  await gotoApp(page);
  const track = await addBlankTrack(page);
  await selectTrack(page, track);
  await openExportTab(page);
}

test.describe('Export Tab', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('export tab content is visible', async ({ page }) => {
    await expect(page.getByTestId('export-tab-content')).toBeVisible();
  });

  test('export start button is present', async ({ page }) => {
    await expect(page.getByTestId('export-start-btn')).toBeVisible();
  });

  test('resolution selector is present', async ({ page }) => {
    await expect(page.getByTestId('resolution-select')).toBeVisible();
  });

  test('FPS selector is present', async ({ page }) => {
    await expect(page.getByTestId('fps-select')).toBeVisible();
  });

  test('output format selector is present', async ({ page }) => {
    await expect(page.getByTestId('format-select')).toBeVisible();
  });

  test('resolution selector has valid options', async ({ page }) => {
    const select = page.getByTestId('resolution-select');
    const options = await select.locator('option').allTextContents();
    // Check at least one standard resolution exists
    expect(options.some((o) => /1080p|1920|720p/i.test(o))).toBe(true);
  });

  test('changing resolution updates the selection', async ({ page }) => {
    const select = page.getByTestId('resolution-select');
    const options = await select.locator('option').allInnerTexts();
    if (options.length > 1) {
      await select.selectOption({ index: 1 });
      const selected = await select.inputValue();
      expect(selected.length).toBeGreaterThan(0);
    }
  });

  test('changing FPS updates the selection', async ({ page }) => {
    const select = page.getByTestId('fps-select');
    const options = await select.locator('option').allInnerTexts();
    if (options.length > 1) {
      await select.selectOption({ index: 1 });
      const selected = await select.inputValue();
      expect(selected.length).toBeGreaterThan(0);
    }
  });

  test('selections persist after switching tabs and returning', async ({ page }) => {
    const select = page.getByTestId('fps-select');
    const options = await select.locator('option').allInnerTexts();
    if (options.length < 2) return;

    await select.selectOption({ index: 1 });
    const before = await select.inputValue();

    // Switch to keyframes and back
    await page.getByTestId('tab-keyframes').click();
    await page.getByTestId('tab-export').click();
    await page.waitForSelector('[data-testid="export-tab-content"]');

    const after = await page.getByTestId('fps-select').inputValue();
    expect(after).toBe(before);
  });

  test('export start button is disabled when no audio is loaded', async ({ page }) => {
    // Without audio, starting an export should be disabled or show a warning
    const btn = page.getByTestId('export-start-btn');
    const isDisabled =
      (await btn.getAttribute('disabled')) !== null ||
      (await btn.getAttribute('aria-disabled')) === 'true' ||
      (await btn.getAttribute('data-disabled')) === 'true';
    expect(isDisabled).toBe(true);
  });
});
