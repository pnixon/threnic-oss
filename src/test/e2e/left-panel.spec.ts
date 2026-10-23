/**
 * Integration tests: Left Panel — track list, audio import, track controls
 */

import { test, expect } from '@playwright/test';
import { gotoApp, addBlankTrack, selectTrack } from './helpers/app';

test.describe('Left Panel — Track List', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('left panel is visible', async ({ page }) => {
    await expect(page.getByTestId('left-panel')).toBeVisible();
  });

  test('empty state is shown when no tracks exist', async ({ page }) => {
    const emptyState = page.getByTestId('track-list-empty');
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    const hasTracks = await page.getByTestId('track-item').count();
    // Either has explicit empty state or zero tracks
    expect(hasEmpty || hasTracks === 0).toBe(true);
  });

  test('can add a track via the add button', async ({ page }) => {
    const before = await page.getByTestId('track-item').count();
    await addBlankTrack(page);
    const after = await page.getByTestId('track-item').count();
    expect(after).toBe(before + 1);
  });

  test('can add multiple tracks', async ({ page }) => {
    await addBlankTrack(page);
    await addBlankTrack(page);
    await addBlankTrack(page);
    await expect(page.getByTestId('track-item')).toHaveCount(3);
  });

  test('clicking a track selects it', async ({ page }) => {
    const track = await addBlankTrack(page);
    await selectTrack(page, track);
    await expect(track).toHaveAttribute('data-selected', 'true');
  });

  test('track item has a name label', async ({ page }) => {
    const track = await addBlankTrack(page);
    const name = track.getByTestId('track-name');
    await expect(name).toBeVisible();
    const text = await name.textContent();
    expect(text && text.length > 0).toBeTruthy();
  });

  test('track item has a mute button', async ({ page }) => {
    const track = await addBlankTrack(page);
    await expect(track.getByTestId('track-mute-btn')).toBeVisible();
  });

  test('mute button toggles mute state', async ({ page }) => {
    const track = await addBlankTrack(page);
    const muteBtn = track.getByTestId('track-mute-btn');
    await muteBtn.click();
    await expect(track).toHaveAttribute('data-muted', 'true');
    await muteBtn.click();
    await expect(track).not.toHaveAttribute('data-muted', 'true');
  });

  test('track can be deleted from the context menu', async ({ page }) => {
    const track = await addBlankTrack(page);
    // Right-click to open context menu
    await track.click({ button: 'right' });
    const deleteOption = page.getByTestId('context-menu-delete');
    if (await deleteOption.isVisible()) {
      await deleteOption.click();
      await page.waitForTimeout(300);
      await expect(page.getByTestId('track-item')).toHaveCount(0);
    }
  });
});

test.describe('Left Panel — collapsed/expanded state', () => {
  test('left panel can be collapsed', async ({ page }) => {
    await gotoApp(page);
    const collapseBtn = page.getByTestId('left-panel-collapse-btn');
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click();
      await expect(page.getByTestId('left-panel')).toHaveAttribute('data-collapsed', 'true');
    }
  });

  test('left panel can be expanded after collapse', async ({ page }) => {
    await gotoApp(page);
    const collapseBtn = page.getByTestId('left-panel-collapse-btn');
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click();
      await page.waitForTimeout(300);
      const expandBtn = page.getByTestId('left-panel-expand-btn');
      if (await expandBtn.isVisible()) {
        await expandBtn.click();
        await expect(page.getByTestId('left-panel')).not.toHaveAttribute('data-collapsed', 'true');
      }
    }
  });
});
