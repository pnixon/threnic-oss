/**
 * Integration tests: Playback — transport controls, playhead, scrubbing
 */

import { test, expect } from '@playwright/test';
import { gotoApp, addBlankTrack, selectTrack } from './helpers/app';

async function setup(page: Parameters<typeof gotoApp>[0]) {
  await gotoApp(page);
  const track = await addBlankTrack(page);
  await selectTrack(page, track);
}

test.describe('Playback transport', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('play button is visible in the timeline', async ({ page }) => {
    await expect(page.getByTestId('play-btn')).toBeVisible();
  });

  test('stop/pause button is visible', async ({ page }) => {
    await expect(page.getByTestId('stop-btn')).toBeVisible();
  });

  test('time display shows 0:00 at start', async ({ page }) => {
    const display = page.getByTestId('time-display');
    const text = await display.textContent();
    // Accept various 0:00 formats
    expect(text?.replace(/\s/g, '')).toMatch(/^0:00|00:00/);
  });

  test('clicking play changes button state', async ({ page }) => {
    const playBtn = page.getByTestId('play-btn');
    await playBtn.click();
    // After clicking, the aria-label or data attr should indicate playing state
    await expect(playBtn).toHaveAttribute('data-playing', 'true');
    // Stop
    await page.getByTestId('stop-btn').click();
  });

  test('playhead moves during playback', async ({ page }) => {
    const playBtn = page.getByTestId('play-btn');
    const timeDisplay = page.getByTestId('time-display');
    const before = await timeDisplay.textContent();

    await playBtn.click();
    await page.waitForTimeout(1500);
    const after = await timeDisplay.textContent();

    await page.getByTestId('stop-btn').click();
    expect(before).not.toBe(after);
  });

  test('clicking the timeline ruler scrubs the playhead', async ({ page }) => {
    const ruler = page.getByTestId('timeline-ruler');
    const box = await ruler.boundingBox();
    if (!box) return;

    const timeDisplay = page.getByTestId('time-display');
    const before = await timeDisplay.textContent();

    // Click 40% into the ruler
    await page.mouse.click(box.x + box.width * 0.4, box.y + 4);
    await page.waitForTimeout(100);
    const after = await timeDisplay.textContent();

    expect(before).not.toBe(after);
  });

  test('stop button resets playhead to start', async ({ page }) => {
    // Scrub partway into the track
    const ruler = page.getByTestId('timeline-ruler');
    const box = await ruler.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.5, box.y + 4);
    }
    await page.waitForTimeout(100);

    await page.getByTestId('stop-btn').click();
    const timeDisplay = page.getByTestId('time-display');
    const text = await timeDisplay.textContent();
    expect(text?.replace(/\s/g, '')).toMatch(/^0:00|00:00/);
  });
});

test.describe('Playback — speed control', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('speed control is visible on large viewports', async ({ page }) => {
    // The speed controls are hidden below 1024px (per responsive audit fix)
    // This test runs at the default Desktop Chrome 1280×720 viewport
    const speedControls = page.getByTestId('speed-controls');
    await expect(speedControls).toBeVisible();
  });

  test('volume slider is present', async ({ page }) => {
    await expect(page.getByTestId('volume-slider')).toBeVisible();
  });
});
