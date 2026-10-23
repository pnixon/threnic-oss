/**
 * Visual Effect Tests — Screenshot + functional verification
 *
 * Each test adds an effect via the UI picker and verifies:
 * 1. The effect instance was added to trackStore.effectsConfig.effectInstances
 * 2. The effect type is correct
 * 3. The effect is enabled (not disabled)
 * 4. Before/after screenshots are captured for visual inspection in the HTML report
 *
 * NOTE: Due to headless Chromium WebGL limitations, pure pixel comparison of the
 * canvas center is unreliable — particles need audio, spatial effects need textured
 * backgrounds, and WebGL readPixels returns zeros. Screenshots are attached as
 * visual evidence for manual review; the assertion verifies store state.
 *
 * Run with: npx playwright test src/test/e2e/effects-visual.spec.ts --reporter=html
 * View report: npx playwright show-report
 */

import { test, expect, type Page } from '@playwright/test';
import {
  gotoApp,
  addBlankTrack,
  selectTrack,
  openEffectsTab,
  addEffect,
  CANVAS_SETTLE,
} from './helpers/app';

type EffectInstanceSummary = { type: string; enabled: boolean };
type StoreWindow = Window & {
  trackStore?: {
    getState(): { effectsConfig: { effectInstances?: EffectInstanceSummary[] } | null };
  };
  keyframeStore?: { getState(): { updateScene(scene: Record<string, unknown>): void } };
};

// ─── Effect type mapping ──────────────────────────────────────────

/** Map from UI label to the effect `type` string used in effectInstances */
const EFFECT_TYPE_MAP: Record<string, string> = {
  Particles: 'particles',
  Oscilloscope: 'visualizer',
  'Chromatic Aberration': 'chromaticAberration',
  'VHS Tracking': 'vhsTracking',
  'Slide (Translate)': 'slide',
  Distortion: 'distortion',
  Zoom: 'zoom',
  Rotate: 'rotate',
};

// ─── Setup ────────────────────────────────────────────────────────

async function setupForEffects(page: Page) {
  await gotoApp(page);

  // Force-dismiss overlays
  await page.evaluate(() => {
    document
      .querySelectorAll('[class*="HelpModal"][class*="overlay"]')
      .forEach((el) => el.remove());
    document.querySelectorAll('[class*="cookie"]').forEach((el) => el.remove());
    document.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      const text = btn.textContent?.toLowerCase() ?? '';
      if (text.includes('close') || text.includes('accept') || text.includes('dismiss'))
        btn.click();
    });
  });
  await page.waitForTimeout(500);

  const track = await addBlankTrack(page);

  await page.evaluate(() => {
    document
      .querySelectorAll('[class*="HelpModal"][class*="overlay"]')
      .forEach((el) => el.remove());
  });
  await page.waitForTimeout(500);

  await selectTrack(page, track);

  await page.waitForFunction(
    () => (window as StoreWindow).trackStore?.getState().effectsConfig !== null,
    {
      timeout: 10_000,
    },
  );

  // Set background color
  await page.evaluate(() => {
    (window as StoreWindow).keyframeStore?.getState().updateScene({ backgroundColor: '#335599' });
  });
  await page.waitForTimeout(CANVAS_SETTLE * 2);

  await openEffectsTab(page);
}

/**
 * Capture a full-page screenshot for visual reference.
 */
async function screenshotFullPage(page: Page): Promise<Buffer> {
  return page.screenshot({ fullPage: false });
}

/**
 * Get the current effect instances from the store.
 */
async function getEffectInstances(page: Page): Promise<Array<{ type: string; enabled: boolean }>> {
  return page.evaluate(() => {
    const ts = (window as StoreWindow).trackStore;
    if (!ts) return [];
    const config = ts.getState().effectsConfig;
    if (!config?.effectInstances) return [];
    return config.effectInstances.map((e) => ({
      type: e.type,
      enabled: e.enabled !== false, // default to true if undefined
    }));
  });
}

// ─── Generic effect test ────────────────────────────────────────

function effectTest(effectLabel: string) {
  const expectedType = EFFECT_TYPE_MAP[effectLabel];
  if (!expectedType) throw new Error(`Unknown effect label: ${effectLabel}`);

  test(`${effectLabel} is added and enabled via UI`, async ({ page }, testInfo) => {
    await setupForEffects(page);
    await page.waitForTimeout(CANVAS_SETTLE);

    // Verify no effects exist yet
    const beforeInstances = await getEffectInstances(page);
    expect(
      beforeInstances.some((e) => e.type === expectedType),
      `Expected no "${expectedType}" effect before adding it`,
    ).toBe(false);

    // Capture before screenshot for visual reference
    const before = await screenshotFullPage(page);
    await testInfo.attach(`${effectLabel} — BEFORE`, {
      body: before,
      contentType: 'image/png',
    });

    // Add effect via UI
    await addEffect(page, effectLabel);

    // Wait for state to propagate
    await page.waitForTimeout(CANVAS_SETTLE * 4);

    // Verify the effect was added to the store
    const afterInstances = await getEffectInstances(page);

    // Capture after screenshot for visual reference
    const after = await screenshotFullPage(page);
    await testInfo.attach(`${effectLabel} — AFTER`, {
      body: after,
      contentType: 'image/png',
    });

    // Assert: effect instance exists with correct type
    const addedEffect = afterInstances.find((e) => e.type === expectedType);
    expect(
      addedEffect,
      `Expected "${effectLabel}" (type: "${expectedType}") to be in effectInstances after adding via UI. ` +
        `Found instances: ${JSON.stringify(afterInstances.map((e) => e.type))}`,
    ).toBeDefined();

    // Assert: effect is enabled
    expect(
      addedEffect!.enabled,
      `Expected "${effectLabel}" to be enabled, but it was disabled`,
    ).toBe(true);

    // Assert: instance count increased
    expect(
      afterInstances.length,
      `Expected more effect instances after adding "${effectLabel}"`,
    ).toBeGreaterThan(beforeInstances.length);
  });
}

// ─── Effects ────────────────────────────────────────────────────────────────────────────────────────────────

// Scene effects
effectTest('Particles');
effectTest('Oscilloscope');

// Post-processing effects
effectTest('Chromatic Aberration');
effectTest('VHS Tracking');
effectTest('Slide (Translate)');
effectTest('Distortion');
effectTest('Zoom');
effectTest('Rotate');
