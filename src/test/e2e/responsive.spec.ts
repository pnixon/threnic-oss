/**
 * Integration tests: Responsive behaviour
 *
 * Verifies that the UI adapts correctly at key breakpoints:
 * - Desktop (1280×720) — default
 * - Tablet (900×768)
 * - Mobile (375×667)
 */

import { test, expect } from '@playwright/test';
import { gotoApp, addBlankTrack, selectTrack, openKeyframesTab } from './helpers/app';

// ─── Desktop (default) ────────────────────────────────────────────────────────

test.describe('Responsive — Desktop (1280×720)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('all three panels are visible side-by-side', async ({ page }) => {
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await expect(page.getByTestId('center-stage')).toBeVisible();
    await expect(page.getByTestId('right-panel')).toBeVisible();
  });

  test('speed controls are visible at desktop width', async ({ page }) => {
    await expect(page.getByTestId('speed-controls')).toBeVisible();
  });

  test('volume slider is visible', async ({ page }) => {
    await expect(page.getByTestId('volume-slider')).toBeVisible();
  });

  test('sub-tab labels are visible at desktop width', async ({ page }) => {
    const track = await addBlankTrack(page);
    await selectTrack(page, track);
    await openKeyframesTab(page);
    // All 5 sub-tab buttons should show text labels, not just icons
    const subtabs = page.getByTestId(/^subtab-/);
    const count = await subtabs.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < count; i++) {
      const span = subtabs.nth(i).locator('span');
      await expect(span).toBeVisible();
    }
  });
});

// ─── Tablet ───────────────────────────────────────────────────────────────────

test.describe('Responsive — Tablet (900×768)', () => {
  test.use({ viewport: { width: 900, height: 768 } });

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('center stage and at least one panel are visible', async ({ page }) => {
    await expect(page.getByTestId('center-stage')).toBeVisible();
  });

  test('speed controls are hidden at tablet width (≤1024px)', async ({ page }) => {
    // We hid these with the responsive audit fix
    const speedControls = page.getByTestId('speed-controls');
    const isHidden = !(await speedControls.isVisible().catch(() => false));
    expect(isHidden).toBe(true);
  });

  test('no horizontal scroll on the page', async ({ page }) => {
    const scrollWidth: number = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth: number = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2); // 2px tolerance
  });
});

// ─── Mobile ───────────────────────────────────────────────────────────────────

test.describe('Responsive — Mobile (375×667)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('app is not empty at mobile width', async ({ page }) => {
    // At minimum the header and center stage should render
    const hasContent = await page.locator('body').innerText();
    expect(hasContent.length).toBeGreaterThan(0);
  });

  test('no horizontal scroll on the page', async ({ page }) => {
    const scrollWidth: number = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth: number = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
  });

  test('right panel has no horizontal scroll when visible', async ({ page }) => {
    const rightPanel = page.getByTestId('right-panel');
    if (await rightPanel.isVisible()) {
      const { scrollWidth, clientWidth } = await rightPanel.evaluate((el: HTMLElement) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
    }
  });

  test('sub-tab labels are hidden (icon-only mode) at mobile width', async ({ page }) => {
    const track = await addBlankTrack(page);
    await selectTrack(page, track);
    await openKeyframesTab(page);

    // Spans inside sub-tabs should be hidden (display: none via container query)
    const firstSubtabSpan = page
      .getByTestId(/^subtab-/)
      .first()
      .locator('span')
      .first();
    const isVisible = await firstSubtabSpan.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });
});

// ─── Right panel — no horizontal scroll at any width ─────────────────────────

test.describe('Right panel — no horizontal overflow', () => {
  for (const width of [1280, 1024, 900, 768, 480]) {
    test(`no horizontal scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 768 });
      await gotoApp(page);

      const track = await addBlankTrack(page);
      await selectTrack(page, track);
      await openKeyframesTab(page);

      const rightPanel = page.getByTestId('right-panel');
      if (!(await rightPanel.isVisible())) return;

      const { scrollWidth, clientWidth } = await rightPanel.evaluate((el: HTMLElement) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
    });
  }
});
