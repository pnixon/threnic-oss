/**
 * Shared Playwright helpers for the Threnic integration test suite.
 *
 * Provides page-object-style utilities for the most common UI interactions —
 * loading a track, navigating the right panel, adding effects, etc.
 */

import path from 'node:path';
import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Must match the baseURL in playwright.config.ts */
const BASE_URL = 'http://localhost:3000';

/** Approximate time (ms) to wait for WebGL/Three.js canvas to settle */
export const CANVAS_SETTLE = 800;

/** Time (ms) to wait after adding an effect for the panel to update */
export const EFFECT_SETTLE = 400;

// ─── Navigation helpers ───────────────────────────────────────────────────────

/**
 * Navigate to the app and wait until the main UI is interactive.
 *
 * Isolation strategy:
 *  1. Navigate to the editor (served at `/`).
 *  2. Delete ThrenicDB before React's project-restore effect runs.
 *  3. Reload — React starts clean with no saved project.
 *  4. Dismiss the first-visit Help modal (opens because help_seen was also deleted).
 *  5. Seed help_seen to prevent the modal re-opening mid-test.
 */
export async function gotoApp(page: Page) {
  // Phase 1: load the app. It may briefly restore stale IDB data here — that's fine.
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });

  // Phase 2: now that we're on the correct origin, delete ThrenicDB synchronously
  // using an awaited evaluate. The delete request will block any pending opens,
  // and since React hasn't fully initialised yet (domcontentloaded is before React
  // effects), we beat the project-restore useEffect.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      try {
        const del = indexedDB.deleteDatabase('ThrenicDB');
        del.onsuccess = () => resolve();
        del.onerror = () => resolve();
        del.onblocked = () => {
          // Database is blocked (open connection); force close by trying again after tick
          setTimeout(resolve, 50);
        };
      } catch {
        resolve();
      }
    });
  });

  // Phase 3: reload so React mounts with a totally empty ThrenicDB
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Wait for the app shell
  await page.waitForSelector('[data-testid="left-panel"]', { timeout: 20_000 });

  // Dismiss the first-visit Help & Guide modal the React-safe way.
  // NOTE: Do NOT rip the modal node out of the DOM with el.remove() — it is a
  // React-managed portal, and removing it directly makes React throw
  // "Failed to execute 'removeChild' on 'Node'" when it later unmounts the
  // modal, crashing the app (surfaces intermittently, e.g. at phone widths).
  // The HelpModal closes on Escape and on overlay click (both wired to onClose).
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const overlay = page.locator('[class*="HelpModal"][class*="overlay"]').first();
    if (await overlay.isVisible({ timeout: 800 }).catch(() => false)) {
      await overlay.click({ position: { x: 5, y: 5 }, force: true });
      await page.waitForTimeout(200);
    }
  } catch {
    /* no modal — continue */
  }

  // Seed help_seen so the modal doesn't re-open mid-test
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        try {
          const req = indexedDB.open('ThrenicDB', 2);
          req.onsuccess = () => {
            const db = req.result;
            try {
              const tx = db.transaction('settings', 'readwrite');
              tx.objectStore('settings').put(true, 'help_seen');
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => {
                db.close();
                resolve();
              };
            } catch {
              db.close();
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    })
    .catch(() => {
      /* ignore */
    });
}

// ─── Track helpers ────────────────────────────────────────────────────────────

/** Path to a small audio file that can be used as a test fixture */
const TEST_AUDIO_PATH = path.join(process.cwd(), 'src/test/e2e/fixtures/tone.mp3');

/**
 * Add a track by injecting a test audio file into the hidden file input.
 * Returns the new track item locator.
 */
export async function addBlankTrack(page: Page): Promise<Locator> {
  const countBefore = await page.getByTestId('track-item').count();

  // Click the add-track button (it triggers a hidden file input)
  const addBtn = page.getByTestId('add-track-btn');
  await addBtn.click();

  // Find the hidden audio file input and inject the fixture file
  const fileInput = page.locator('input[type="file"][accept="audio/*"]').first();
  await fileInput.setInputFiles(TEST_AUDIO_PATH);

  // Wait for the new track item to appear
  await page.waitForFunction(
    (prevCount) => document.querySelectorAll('[data-testid="track-item"]').length > prevCount,
    countBefore,
    { timeout: 10_000 },
  );

  const tracks = page.getByTestId('track-item');
  return tracks.last();
}

/**
 * Click a track item to select it, making the right panel active.
 */
export async function selectTrack(page: Page, trackLocator: Locator) {
  await trackLocator.click();
  // Right panel content becomes enabled when a track is selected
  await expect(page.getByTestId('right-panel-content')).not.toHaveAttribute(
    'data-disabled',
    'true',
  );
}

// ─── Right panel tab navigation ───────────────────────────────────────────────

/**
 * Switch the right panel to the Effects top-level tab.
 * (Replaces the old openKeyframesTab — the tab structure was refactored.)
 */
export async function openEffectsTab(page: Page) {
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="tab-effects"]') as HTMLButtonElement;
    if (button) button.click();
  });
  await page.waitForTimeout(500);
}

/**
 * @deprecated Use openEffectsTab instead. Kept for backwards compatibility.
 */
export async function openKeyframesTab(page: Page) {
  await openEffectsTab(page);
}

/**
 * Switch the right panel to the Export top-level tab.
 */
export async function openExportTab(page: Page) {
  await page.getByTestId('tab-export').click();
  await page.waitForSelector('[data-testid="export-tab-content"]', { timeout: 5_000 });
}

/**
 * Switch to a top-level Inspector tab by name.
 * (Previously used subtab- prefix, now uses tab- prefix after refactor.)
 */
export async function openKeyframeSubTab(
  page: Page,
  tab: 'layout' | 'lyrics' | 'transitions' | 'effects' | 'timeline' | 'templates',
) {
  // Map old sub-tab names to new top-level tab names
  const tabMap: Record<string, string> = {
    layout: 'templates',
    effects: 'effects',
    lyrics: 'lyrics',
    transitions: 'templates',
    timeline: 'templates',
    templates: 'templates',
  };
  const mappedTab = tabMap[tab] ?? tab;

  await page.evaluate((tabName) => {
    // Try new tab- prefix first, then fall back to subtab- for compatibility
    const button =
      (document.querySelector(`[data-testid="tab-${tabName}"]`) as HTMLButtonElement) ??
      (document.querySelector(`[data-testid="subtab-${tabName}"]`) as HTMLButtonElement);
    if (button) button.click();
  }, mappedTab);

  await page.waitForTimeout(500);
}

// ─── Effect helpers ───────────────────────────────────────────────────────────

/**
 * Navigate to the Effects sub-tab and add an effect by its type label.
 *
 * @param effectLabel - The human-readable label shown in the "Add Effect" picker
 *                      (e.g. "Bloom", "Glitch", "Rain (3D)")
 * @returns Locator for the new effect card
 */
export async function addEffect(page: Page, effectLabel: string): Promise<Locator> {
  await openKeyframeSubTab(page, 'effects');

  // Map effect labels to determine their section (scene vs postProcessing)
  const sceneEffects = ['Particles', 'Rain (3D)', 'Water (3D)', 'Oscilloscope', 'Starfield'];
  const section = sceneEffects.includes(effectLabel) ? 'scene' : 'postProcessing';

  // Wait for the add button to be visible, then click it via JavaScript
  const addBtn = page.getByTestId(`add-effect-btn-${section}`);
  await addBtn.waitFor({ state: 'visible', timeout: 10000 });

  // Use JavaScript click to bypass pointer interception
  await page.evaluate((sectionName) => {
    const button = document.querySelector(
      `[data-testid="add-effect-btn-${sectionName}"]`,
    ) as HTMLButtonElement;
    if (button) {
      button.click();
    }
  }, section);

  // Wait a bit for the picker to render and calculate position
  await page.waitForTimeout(500);

  // Try to find the picker by data-testid first, fall back to finding by content
  const picker = page.getByTestId('effect-picker');
  const pickerAttached = await picker.isVisible({ timeout: 2000 }).catch(() => false);

  if (pickerAttached) {
    // Picker found by testid — click the matching effect option
    const option = picker.getByText(effectLabel, { exact: true });
    await option.click({ force: true });
  } else {
    // Fallback: find the effect button directly in the page (portaled to body)
    const option = page.getByRole('button', { name: effectLabel, exact: true }).last();
    await option.click({ force: true });
  }

  await page.waitForTimeout(EFFECT_SETTLE);

  // Find the new effect row by its name text.
  // EffectRow renders the name inside the row container — find the row that contains
  // both the effect name and a toggle switch (role="switch").
  const card = page
    .locator('div')
    .filter({ hasText: effectLabel })
    .filter({ has: page.locator('button[role="switch"]') })
    .last();

  // Wait for the row to be visible (with a generous timeout for first load)
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  return card;
}

/**
 * Toggle the enable/disable switch on an effect card.
 */
export async function toggleEffect(effectCard: Locator) {
  await effectCard.getByTestId('effect-enable-toggle').click();
}

/**
 * Remove an effect by clicking its delete button.
 */
export async function removeEffect(effectCard: Locator) {
  await effectCard.getByTestId('effect-delete-btn').click();
}

/**
 * Set a slider to a specific value using keyboard input.
 */
export async function setSliderValue(effectCard: Locator, sliderTestId: string, value: number) {
  const slider = effectCard.getByTestId(sliderTestId);
  await slider.fill(String(value));
  await slider.dispatchEvent('input');
  await slider.dispatchEvent('change');
}

// ─── Canvas / rendering helpers ───────────────────────────────────────────────

/**
 * Capture a screenshot of the canvas element only (for visual diff assertions).
 */
export async function screenshotCanvas(page: Page): Promise<Buffer> {
  const canvas = page.locator('canvas').first();
  return canvas.screenshot();
}

// ─── Keyframe helpers ─────────────────────────────────────────────────────────

/**
 * Click "Add Keyframe" in the keyframe controller at the current playhead time.
 * Returns the newly created keyframe's ID from the timeline.
 */
export async function addKeyframeAtCurrentTime(page: Page): Promise<string> {
  const btn = page.getByTestId('add-keyframe-btn');
  await btn.click();
  await page.waitForTimeout(200);
  // Re-read the timeline to find the latest keyframe id
  const items = page.getByTestId('keyframe-timeline-item');
  const last = items.last();
  return (await last.getAttribute('data-keyframe-id')) ?? '';
}
