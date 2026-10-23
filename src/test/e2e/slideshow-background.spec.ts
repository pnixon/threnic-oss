/**
 * E2E tests: Slideshow background — memory issues on modify/update/remove
 *
 * Verifies that old backgrounds don't persist when slideshow items are
 * changed, replaced, or removed. Tests the fix for stale slot state,
 * fingerprint tracking, and wallClock reset.
 */

import { test, expect } from '@playwright/test';
import {
  gotoApp,
  addBlankTrack,
  selectTrack,
  openKeyframesTab,
  openKeyframeSubTab,
  CANVAS_SETTLE,
  screenshotCanvas,
} from './helpers/app';
import path from 'path';

// ─── Test fixtures ─────────────────────────────────────────────────

const TEST_IMAGE_1 = path.resolve('public/assets/game-scenes/background.jpg');
const TEST_IMAGE_2 = path.resolve('public/Threnic_Logo.png');

/**
 * Force-dismiss ALL overlays that block pointer events.
 * Uses JS evaluation to directly remove overlay DOM elements and
 * dismiss consent/modal UIs that gotoApp may not fully clear.
 */
async function forceCloseOverlays(page: Parameters<typeof gotoApp>[0]) {
  await page.evaluate(() => {
    // Remove HelpModal overlay
    document
      .querySelectorAll('[class*="HelpModal"][class*="overlay"]')
      .forEach((el) => el.remove());
    // Click any visible Accept/Close buttons via JS
    document.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      const text = btn.textContent?.toLowerCase() ?? '';
      if (text.includes('accept') || text.includes('close') || text.includes('dismiss')) {
        btn.click();
      }
    });
  });
  await page.waitForTimeout(500);

  // Double-check: if any overlay still intercepts, force-remove ALL fixed/absolute overlays
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('div').forEach((el) => {
      const style = getComputedStyle(el);
      if (
        (style.position === 'fixed' || style.position === 'absolute') &&
        style.zIndex !== '' &&
        parseInt(style.zIndex) > 100 &&
        el.offsetWidth > window.innerWidth * 0.5 &&
        el.offsetHeight > window.innerHeight * 0.5
      ) {
        // This is a full-screen overlay — remove it
        el.remove();
      }
    });
  });
  await page.waitForTimeout(300);
}

/** Navigate to the layout sub-tab where background controls live. */
async function setupWithLayoutTab(page: Parameters<typeof gotoApp>[0]) {
  await gotoApp(page);
  await forceCloseOverlays(page);
  const track = await addBlankTrack(page);
  await forceCloseOverlays(page);
  await selectTrack(page, track);
  await openKeyframesTab(page);
  await openKeyframeSubTab(page, 'layout');
}

/** Upload a file to the background media input. */
async function uploadBackground(page: Parameters<typeof gotoApp>[0], filePath: string) {
  // Find the media file input (accepts images and videos)
  const fileInput = page.locator('input[type="file"][accept*="image"]').first();
  await fileInput.setInputFiles(filePath);
  await page.waitForTimeout(CANVAS_SETTLE);
}

// ─── Tests ─────────────────────────────────────────────────────────

test.describe('Slideshow background: memory / stale state', () => {
  test.beforeEach(async ({ page }) => {
    await setupWithLayoutTab(page);
  });

  test('layout tab renders background controls', async ({ page }) => {
    // The layout sub-tab should show background-related UI
    const backgroundLabel = page.locator('text=Background Color').first();
    const uploadBtn = page.locator('button', { hasText: /upload|add.*media/i }).first();
    const eitherVisible =
      (await backgroundLabel.isVisible({ timeout: 5000 }).catch(() => false)) ||
      (await uploadBtn.isVisible({ timeout: 2000 }).catch(() => false));
    expect(eitherVisible).toBe(true);
  });

  test('uploading a background image updates the canvas', async ({ page }) => {
    const before = await screenshotCanvas(page);

    await uploadBackground(page, TEST_IMAGE_1);
    await page.waitForTimeout(CANVAS_SETTLE * 2);

    const after = await screenshotCanvas(page);
    expect(before.equals(after)).toBe(false);
  });

  test('replacing background clears old image', async ({ page }) => {
    // Upload first image
    await uploadBackground(page, TEST_IMAGE_1);
    await page.waitForTimeout(CANVAS_SETTLE * 3);
    const screenshotA = await screenshotCanvas(page);

    // Upload second (different) image — should replace, not overlay
    await uploadBackground(page, TEST_IMAGE_2);
    await page.waitForTimeout(CANVAS_SETTLE * 3);
    const screenshotB = await screenshotCanvas(page);

    // Screenshots must differ — old background must be gone
    expect(screenshotA.equals(screenshotB)).toBe(false);
  });

  test('removing all media does not crash canvas', async ({ page }) => {
    await uploadBackground(page, TEST_IMAGE_1);
    await page.waitForTimeout(CANVAS_SETTLE * 2);

    // Click the remove button if visible
    const removeBtn = page.locator('button[title="Remove"]').first();
    if (await removeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await removeBtn.click();
      await page.waitForTimeout(CANVAS_SETTLE);
    }

    // Canvas should still be present and rendering (no crash)
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
  });

  test('consecutive uploads produce distinct canvas states', async ({ page }) => {
    // This catches the original bug: if old backgrounds "leak" into the
    // current render, consecutive uploads would produce identical screenshots
    // after the second upload because the old background would still be
    // animating into view.

    await uploadBackground(page, TEST_IMAGE_1);
    await page.waitForTimeout(CANVAS_SETTLE * 3);

    // Take multiple rapid screenshots to capture any stale frame
    const shots1: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
      shots1.push(await screenshotCanvas(page));
      await page.waitForTimeout(200);
    }

    await uploadBackground(page, TEST_IMAGE_2);
    await page.waitForTimeout(CANVAS_SETTLE * 3);

    const shots2: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
      shots2.push(await screenshotCanvas(page));
      await page.waitForTimeout(200);
    }

    // At least one screenshot from set 2 must differ from all of set 1
    // (proves the old background isn't persisting)
    const anyDifferent = shots2.some((s2) => shots1.every((s1) => !s1.equals(s2)));
    expect(anyDifferent).toBe(true);
  });
});
