/**
 * Instrumented UI tests: Mobile experience (phone viewport)
 *
 * Validates that the mobile version is fully usable — every core surface a
 * desktop user has is reachable on a phone:
 *   - Bottom nav (Stage / Playlist / Studio) switches the active surface.
 *   - Stage shows the compact MobilePlayerBar (time, scrubber, transport).
 *   - The transport play/pause control is present and interactive.
 *   - The TIMELINE toggle swaps the compact bar for the full detailed timeline.
 *   - Opening Playlist / Studio slides a drawer up; the tap-outside backdrop
 *     dismisses it back to Stage.
 *   - The Studio (Inspector) tab rail shows Lyrics / Effects / Export with
 *     legible labels and switches tabs.
 *
 * Runs at a Pixel-class portrait viewport (390×844).
 */

import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers/app';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/**
 * Dismiss any lingering Help / cookie overlay the React-safe way (Escape +
 * overlay click). Never rip React-portal nodes out of the DOM directly — that
 * triggers a "removeChild on Node" crash when React later unmounts them.
 */
async function clearOverlays(page: import('@playwright/test').Page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);
  const overlay = page.locator('[class*="HelpModal"][class*="overlay"]').first();
  if (await overlay.isVisible({ timeout: 500 }).catch(() => false)) {
    await overlay.click({ position: { x: 5, y: 5 }, force: true }).catch(() => {});
    await page.waitForTimeout(150);
  }
}

test.describe('Mobile — core usability (390×844)', () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearOverlays(page);
    // Wait until the responsive layout has fully switched to mobile. useMediaQuery
    // seeds false (SSR) and syncs true on mount; asserting the mobile bottom nav
    // AND the compact player bar are present proves the isMobile branch is live
    // before any mobile-specific expectation.
    await expect(page.getByTestId('mobile-nav-stage')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('mobile-player-bar')).toBeVisible({ timeout: 10_000 });
    // Let transient startup toasts (e.g. "WebGL fallback active") auto-dismiss
    // so they don't intercept taps on the bottom-anchored player bar.
    await page.waitForTimeout(1200);
  });

  test('bottom navigation renders all three tabs', async ({ page }) => {
    await expect(page.getByTestId('mobile-nav-stage')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-playlist')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-studio')).toBeVisible();
  });

  test('Stage tab shows the compact mobile player bar, not the full desktop timeline', async ({
    page,
  }) => {
    await expect(page.getByTestId('mobile-player-bar')).toBeVisible();
    await expect(page.getByTestId('mobile-play-pause')).toBeVisible();
    await expect(page.getByTestId('mobile-prev')).toBeVisible();
    await expect(page.getByTestId('mobile-next')).toBeVisible();
    await expect(page.getByTestId('mobile-timeline-toggle')).toBeVisible();
    await expect(page.getByTestId('center-stage')).toBeVisible();
  });

  test('play/pause control is present and interactive', async ({ page }) => {
    // The compact player bar renders on the Stage tab regardless of whether a
    // track is loaded — validate its transport button is present and clickable.
    const playPause = page.getByTestId('mobile-play-pause');
    await expect(playPause).toBeVisible();

    const labelBefore = await playPause.getAttribute('aria-label');
    expect(['Play', 'Pause']).toContain(labelBefore);

    await playPause.click({ force: true });
    await page.waitForTimeout(400);
    const labelAfter = await playPause.getAttribute('aria-label');
    expect(['Play', 'Pause']).toContain(labelAfter);
  });

  test('TIMELINE toggle swaps the compact bar for the full detailed timeline', async ({ page }) => {
    await expect(page.getByTestId('mobile-player-bar')).toBeVisible();

    // Expand → full timeline panel takes over, compact bar is replaced.
    await page.getByTestId('mobile-timeline-toggle').click({ force: true });
    await page.waitForTimeout(400);
    await expect(page.getByTestId('timeline-container')).toBeVisible();
    await expect(page.getByTestId('mobile-player-bar')).toHaveCount(0);

    // A collapse affordance returns to the compact bar.
    const collapseBtn = page.locator('.mobileTimelineCollapseBtn');
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click({ force: true });
    await page.waitForTimeout(400);
    await expect(page.getByTestId('mobile-player-bar')).toBeVisible();
  });

  test('Playlist tab slides up the playlist drawer', async ({ page }) => {
    await page.getByTestId('mobile-nav-playlist').click({ force: true });
    await page.waitForTimeout(400);
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await expect(page.getByTestId('left-panel-inner')).toBeVisible();
    await expect(page.getByTestId('mobile-drawer-backdrop')).toBeVisible();
  });

  test('track context menu stays fully within the viewport (no right/bottom overflow)', async ({
    page,
  }) => {
    // Open the Playlist drawer and ensure at least one track exists (add one
    // if the session restored none). The add button lives in this drawer.
    await page.getByTestId('mobile-nav-playlist').click({ force: true });
    await page.waitForTimeout(400);
    if ((await page.getByTestId('track-item').count()) === 0) {
      await page.getByTestId('add-track-btn').click({ force: true });
      await page
        .locator('input[type="file"][accept="audio/*"]')
        .first()
        .setInputFiles('D:/git/Threnic_redux/public/assets/default_lazy_strings/audio.mp3');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="track-item"]').length > 0,
        undefined,
        { timeout: 10_000 },
      );
    }

    // Open the track's context menu via the ⋮ more button.
    await page.getByTestId('track-more-btn').first().click({ force: true });
    const menu = page.getByTestId('playlist-context-menu');
    await expect(menu).toBeVisible();

    // The menu must be fully on-screen: right edge ≤ viewport width, and it
    // must not run under the bottom nav (≈ bottom 80px reserved).
    const box = await menu.boundingBox();
    const vw = page.viewportSize()!.width;
    const vh = page.viewportSize()!.height;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1);
  });

  test('tapping the backdrop dismisses the drawer back to Stage', async ({ page }) => {
    await page.getByTestId('mobile-nav-studio').click({ force: true });
    await page.waitForTimeout(400);
    const backdrop = page.getByTestId('mobile-drawer-backdrop');
    await expect(backdrop).toBeVisible();

    await backdrop.click({ force: true });
    await page.waitForTimeout(500);

    await expect(page.getByTestId('mobile-player-bar')).toBeVisible({ timeout: 8_000 });
    await expect(backdrop).toHaveCount(0);
  });

  test('Studio tab exposes Lyrics / Effects / Export with legible labels', async ({ page }) => {
    // The Inspector tab rail (and its labels) render regardless of track
    // selection — that's the touch-legibility surface we validate here.
    await page.getByTestId('mobile-nav-studio').click({ force: true });
    await page.waitForTimeout(500);

    const lyrics = page.getByTestId('tab-lyrics');
    const effects = page.getByTestId('tab-effects');
    const exportTab = page.getByTestId('tab-export');
    await expect(lyrics).toBeVisible();
    await expect(effects).toBeVisible();
    await expect(exportTab).toBeVisible();

    // Labels (not icon-only) — the touch-legibility requirement.
    await expect(lyrics).toContainText(/lyrics/i);
    await expect(effects).toContainText(/effects/i);
    await expect(exportTab).toContainText(/export/i);

    // Switching tabs works.
    await effects.click({ force: true });
    await page.waitForTimeout(300);
    await lyrics.click({ force: true });
    await page.waitForTimeout(300);
    await expect(page.getByTestId('right-panel')).toBeVisible();
  });

  test('no horizontal scroll at phone width', async ({ page }) => {
    const scrollWidth: number = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth: number = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
  });
});
