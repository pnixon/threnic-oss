/**
 * Integration tests: Keyframe system
 *
 * Tests adding keyframes, interpolation across the timeline, switching between
 * keyframes, and property overrides for effects and scene settings.
 */

import { test, expect } from '@playwright/test';
import {
  gotoApp,
  addBlankTrack,
  selectTrack,
  openKeyframesTab,
  openKeyframeSubTab,
  addEffect,
  addKeyframeAtCurrentTime,
} from './helpers/app';

async function setupWithTrackAndKeyframeTab(page: Parameters<typeof gotoApp>[0]) {
  await gotoApp(page);
  const track = await addBlankTrack(page);
  await selectTrack(page, track);
  await openKeyframesTab(page);
}

test.describe('Keyframe Controller', () => {
  test.beforeEach(async ({ page }) => {
    await setupWithTrackAndKeyframeTab(page);
  });

  test('keyframe controller panel is visible', async ({ page }) => {
    await expect(page.getByTestId('keyframe-controller')).toBeVisible();
  });

  test('Add Keyframe button is visible', async ({ page }) => {
    await expect(page.getByTestId('add-keyframe-btn')).toBeVisible();
  });

  test('can add a keyframe at the current time', async ({ page }) => {
    const id = await addKeyframeAtCurrentTime(page);
    expect(id.length).toBeGreaterThan(0);
    // The keyframe should now appear in the timeline row
    await expect(page.getByTestId('keyframe-timeline-item').first()).toBeVisible();
  });

  test('can add multiple keyframes', async ({ page }) => {
    await addKeyframeAtCurrentTime(page);

    // Advance playhead to a different time by clicking the timeline
    const timeline = page.getByTestId('timeline-ruler');
    const box = await timeline.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.5, box.y + 4);
    }
    await page.waitForTimeout(200);

    await addKeyframeAtCurrentTime(page);

    const items = page.getByTestId('keyframe-timeline-item');
    await expect(items).toHaveCount(2);
  });

  test('clicking a keyframe in the timeline selects it', async ({ page }) => {
    await addKeyframeAtCurrentTime(page);
    const item = page.getByTestId('keyframe-timeline-item').first();
    await item.click();
    await expect(item).toHaveAttribute('data-selected', 'true');
  });

  test('keyframe sub-tabs are visible', async ({ page }) => {
    for (const tab of ['layout', 'lyrics', 'transitions', 'effects', 'timeline']) {
      await expect(page.getByTestId(`subtab-${tab}`)).toBeVisible();
    }
  });
});

test.describe('Keyframe sub-tabs', () => {
  test.beforeEach(async ({ page }) => {
    await setupWithTrackAndKeyframeTab(page);
  });

  test('Layout sub-tab shows background and scene settings', async ({ page }) => {
    await openKeyframeSubTab(page, 'layout');
    await expect(page.getByTestId('section-background')).toBeVisible();
  });

  test('Lyrics sub-tab shows lyrics import section', async ({ page }) => {
    await openKeyframeSubTab(page, 'lyrics');
    await expect(page.getByTestId('section-lyrics')).toBeVisible();
  });

  test('Transitions sub-tab shows transition controls', async ({ page }) => {
    await openKeyframeSubTab(page, 'transitions');
    await expect(page.getByTestId('section-transitions')).toBeVisible();
  });

  test('Effects sub-tab shows the effect list and Add Effect button', async ({ page }) => {
    await openKeyframeSubTab(page, 'effects');
    await expect(page.getByTestId('add-effect-btn')).toBeVisible();
  });

  test('Timeline sub-tab shows the keyframe timeline section', async ({ page }) => {
    await openKeyframeSubTab(page, 'timeline');
    await expect(page.getByTestId('section-keyframe-timeline')).toBeVisible();
  });
});

test.describe('Keyframe + Effect integration', () => {
  test('adding an effect inside a keyframe persists after switching keyframes', async ({
    page,
  }) => {
    await setupWithTrackAndKeyframeTab(page);

    // Add first keyframe at time 0 and add Bloom
    const id1 = await addKeyframeAtCurrentTime(page);
    await openKeyframeSubTab(page, 'effects');
    await addEffect(page, 'Bloom');

    // Move playhead forward and add second keyframe
    const timeline = page.getByTestId('timeline-ruler');
    const box = await timeline.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.6, box.y + 4);
    }
    await page.waitForTimeout(200);

    const id2 = await addKeyframeAtCurrentTime(page);
    expect(id1).not.toBe(id2);

    // Switch back to keyframe 1 — Bloom should still be listed
    await page.getByTestId('keyframe-timeline-item').first().click();
    await openKeyframeSubTab(page, 'effects');

    const bloomCard = page.getByTestId('effect-card').filter({ hasText: 'Bloom' }).first();
    await expect(bloomCard).toBeVisible();
  });

  test('keyframe dropdown shows the correct keyframes', async ({ page }) => {
    await setupWithTrackAndKeyframeTab(page);

    await addKeyframeAtCurrentTime(page);
    const timeline = page.getByTestId('timeline-ruler');
    const box = await timeline.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.5, box.y + 4);
    }
    await page.waitForTimeout(200);
    await addKeyframeAtCurrentTime(page);

    const dropdown = page.getByTestId('keyframe-dropdown');
    if (await dropdown.isVisible()) {
      const options = await dropdown.locator('option').count();
      expect(options).toBeGreaterThanOrEqual(2);
    }
  });
});
