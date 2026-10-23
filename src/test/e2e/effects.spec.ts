/**
 * Integration tests: Effect system — add, configure, toggle, remove
 *
 * Tests the effect panel UI for every registered effect type.
 * Each effect has its own describe block.
 */

import { test, expect } from '@playwright/test';
import {
  gotoApp,
  addBlankTrack,
  selectTrack,
  openKeyframesTab,
  addEffect,
  toggleEffect,
  removeEffect,
  setSliderValue,
  EFFECT_SETTLE,
} from './helpers/app';

// ─── Test fixture: boot app and select a track once per describe block ────────

async function setupWithTrack(page: Parameters<typeof gotoApp>[0]) {
  await gotoApp(page);
  const track = await addBlankTrack(page);
  await selectTrack(page, track);
  await openKeyframesTab(page);
}

// ─── Generic effect lifecycle (add → toggle → remove) ─────────────────────────

function effectLifecycleTests(
  effectLabel: string,
  /** Additional effect-specific checks to run against the card */
  extraChecks?: (
    card: ReturnType<typeof addEffect> extends Promise<infer T> ? T : never,
  ) => void | Promise<void>,
) {
  test.describe(`Effect: ${effectLabel}`, () => {
    test.beforeEach(async ({ page }) => {
      await setupWithTrack(page);
    });

    test('can be added from the effects picker', async ({ page }) => {
      const card = await addEffect(page, effectLabel);
      await expect(card).toBeVisible();
    });

    test('shows an enable/disable toggle', async ({ page }) => {
      const card = await addEffect(page, effectLabel);
      await expect(card.getByTestId('effect-enable-toggle')).toBeVisible();
    });

    test('can be toggled off and on', async ({ page }) => {
      const card = await addEffect(page, effectLabel);
      // Initially enabled
      await expect(card.getByTestId('effect-enable-toggle')).toBeChecked();

      // Disable
      await toggleEffect(card);
      await expect(card.getByTestId('effect-enable-toggle')).not.toBeChecked();

      // Re-enable
      await toggleEffect(card);
      await expect(card.getByTestId('effect-enable-toggle')).toBeChecked();
    });

    test('can be removed', async ({ page }) => {
      const card = await addEffect(page, effectLabel);
      await removeEffect(card);
      await page.waitForTimeout(EFFECT_SETTLE);
      // Card should be gone from DOM
      await expect(page.getByTestId('effect-card').filter({ hasText: effectLabel })).toHaveCount(0);
    });

    test('multiple instances can be added independently', async ({ page }) => {
      await addEffect(page, effectLabel);
      await addEffect(page, effectLabel);
      const cards = page.getByTestId('effect-card').filter({ hasText: effectLabel });
      await expect(cards).toHaveCount(2);
    });

    if (extraChecks) {
      test('effect-specific controls are visible and interactive', async ({ page }) => {
        const card = await addEffect(page, effectLabel);
        await extraChecks(card);
      });
    }
  });
}

// ─── Scene (3-D) effects ──────────────────────────────────────────────────────

effectLifecycleTests('Particles', async (card) => {
  // Particles must expose count and speed sliders
  await expect(card.getByTestId('slider-count')).toBeVisible();
  await expect(card.getByTestId('slider-speed')).toBeVisible();
});

effectLifecycleTests('Rain (3D)', async (card) => {
  await expect(card.getByTestId('slider-count')).toBeVisible();
  await expect(card.getByTestId('slider-speed')).toBeVisible();
  await expect(card.getByTestId('slider-opacity')).toBeVisible();
});

effectLifecycleTests('Water (3D)', async (card) => {
  await expect(card.getByTestId('slider-rippleStrength')).toBeVisible();
});

effectLifecycleTests('Oscilloscope', async (card) => {
  await expect(card.getByTestId('slider-lineWidth')).toBeVisible();
});

effectLifecycleTests('Starfield', async (card) => {
  await expect(card.getByTestId('slider-count')).toBeVisible();
  await expect(card.getByTestId('slider-speed')).toBeVisible();
});

// ─── Post-processing effects ──────────────────────────────────────────────────

effectLifecycleTests('Bloom', async (card) => {
  await expect(card.getByTestId('slider-intensity')).toBeVisible();
  await expect(card.getByTestId('slider-threshold')).toBeVisible();
  await expect(card.getByRole('combobox', { name: /mode/i })).toBeVisible();
});

effectLifecycleTests('Chromatic Aberration', async (card) => {
  await expect(card.getByTestId('slider-offset')).toBeVisible();
});

effectLifecycleTests('Glitch', async (card) => {
  await expect(card.getByTestId('slider-strength')).toBeVisible();
  const modeSelect = card.getByRole('combobox', { name: /mode/i });
  await expect(modeSelect).toBeVisible();
  // Verify mode options
  const options = await modeSelect.locator('option').allTextContents();
  expect(options).toContain('bass-triggered');
  expect(options).toContain('continuous');
  expect(options).toContain('random');
});

effectLifecycleTests('VHS Tracking', async (card) => {
  await expect(card.getByTestId('slider-intensity')).toBeVisible();
  await expect(card.getByTestId('slider-trackingSpeed')).toBeVisible();
  await expect(card.getByTestId('slider-distortionAmount')).toBeVisible();
  await expect(card.getByTestId('slider-chromaticSplit')).toBeVisible();
});

effectLifecycleTests('Old Film', async (card) => {
  await expect(card.getByTestId('slider-intensity')).toBeVisible();
  await expect(card.getByTestId('slider-grainAmount')).toBeVisible();
  await expect(card.getByTestId('slider-scratchAmount')).toBeVisible();
  await expect(card.getByTestId('slider-dirtAmount')).toBeVisible();
  // Grain type selector
  await expect(card.getByRole('combobox', { name: /grain type/i })).toBeVisible();
});

effectLifecycleTests('Bulb Flicker', async (card) => {
  await expect(card.getByTestId('slider-intensity')).toBeVisible();
});

effectLifecycleTests('Gate Jitter', async (card) => {
  await expect(card.getByTestId('slider-intensity')).toBeVisible();
});

effectLifecycleTests('Sepia', async (card) => {
  await expect(card.getByTestId('slider-intensity')).toBeVisible();
});

effectLifecycleTests('Distortion', async (card) => {
  await expect(card.getByTestId('slider-intensity')).toBeVisible();
  await expect(card.getByTestId('slider-distortAmount')).toBeVisible();
  await expect(card.getByTestId('slider-rippleSpeed')).toBeVisible();
  await expect(card.getByTestId('slider-rippleFrequency')).toBeVisible();
  // Type selector
  const typeSelect = card.getByRole('combobox', { name: /distortion type/i });
  await expect(typeSelect).toBeVisible();
  const options = await typeSelect.locator('option').allTextContents();
  expect(options).toContain('radial');
  expect(options).toContain('horizontal');
  expect(options).toContain('vertical');
  expect(options).toContain('box');
});

effectLifecycleTests('Zoom', async (card) => {
  await expect(card.getByTestId('slider-scale')).toBeVisible();
  await expect(card.getByTestId('slider-centerX')).toBeVisible();
  await expect(card.getByTestId('slider-centerY')).toBeVisible();
});

effectLifecycleTests('Pixelation', async (card) => {
  await expect(card.getByTestId('slider-pixelSize')).toBeVisible();
  await expect(card.getByRole('combobox', { name: /mode/i })).toBeVisible();
});

effectLifecycleTests('Noise Overlay', async (card) => {
  await expect(card.getByTestId('slider-opacity')).toBeVisible();
  await expect(card.getByRole('combobox', { name: /blend mode/i })).toBeVisible();
});

effectLifecycleTests('Slide (Translate)', async (card) => {
  await expect(card.getByTestId('slider-speedX')).toBeVisible();
  await expect(card.getByTestId('slider-speedY')).toBeVisible();
});

effectLifecycleTests('Brightness', async (card) => {
  await expect(card.getByTestId('slider-brightness')).toBeVisible();
});

effectLifecycleTests('Contrast', async (card) => {
  await expect(card.getByTestId('slider-contrast')).toBeVisible();
  await expect(card.getByTestId('slider-midpoint')).toBeVisible();
});

effectLifecycleTests('Saturation', async (card) => {
  await expect(card.getByTestId('slider-saturation')).toBeVisible();
});

effectLifecycleTests('Hue Shift', async (card) => {
  await expect(card.getByTestId('slider-hue')).toBeVisible();
});

effectLifecycleTests('Chain Lightning', async (card) => {
  await expect(card.getByTestId('slider-nodeCount')).toBeVisible();
  await expect(card.getByTestId('slider-arcWidth')).toBeVisible();
  await expect(card.getByTestId('slider-glowIntensity')).toBeVisible();
  await expect(card.getByTestId('slider-duration')).toBeVisible();
  await expect(card.getByTestId('slider-cooldown')).toBeVisible();
  await expect(card.getByTestId('slider-audioThreshold')).toBeVisible();
});

effectLifecycleTests('Rain on Glass', async (card) => {
  await expect(card.getByTestId('slider-intensity')).toBeVisible();
});

// ─── Slider value persistence tests ──────────────────────────────────────────

test.describe('Effect slider value persistence', () => {
  test.beforeEach(async ({ page }) => {
    await setupWithTrack(page);
  });

  test('Bloom intensity is retained when scrolling away and back', async ({ page }) => {
    const card = await addEffect(page, 'Bloom');
    await setSliderValue(card, 'slider-intensity', 0.9);

    // Scroll down and back
    await page.mouse.wheel(0, 500);
    await page.mouse.wheel(0, -500);

    const val = await card.getByTestId('slider-intensity').inputValue();
    expect(parseFloat(val)).toBeCloseTo(0.9, 1);
  });

  test('Glitch strength is retained when switching sub-tabs', async ({ page }) => {
    const card = await addEffect(page, 'Glitch');
    await setSliderValue(card, 'slider-strength', 0.7);

    // Switch to layout sub-tab and back
    await page.getByTestId('subtab-layout').click();
    await page.getByTestId('subtab-effects').click();

    const restoredCard = page.getByTestId('effect-card').filter({ hasText: 'Glitch' }).first();
    const val = await restoredCard.getByTestId('slider-strength').inputValue();
    expect(parseFloat(val)).toBeCloseTo(0.7, 1);
  });
});
