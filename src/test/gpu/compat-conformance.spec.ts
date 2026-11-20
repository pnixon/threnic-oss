/**
 * The WebGL2 compatibility backend must render what WebGPU renders.
 *
 * In Chromium both are available in one page, so each scene is rendered on
 * real WebGPU and on the compatibility backend and the pixels are compared.
 * The WebGPU result is also the golden image that browsers without WebGPU
 * (Firefox) are compared against; refresh the goldens with
 *   UPDATE_GPU_GOLDENS=1 npm run test:gpu -- --project=chrome-webgpu
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { runGpuScenes, SCENE_SIZE, type SceneResult } from './gpuScenes';
import { comparePixels } from './pixels';

const GOLDEN_DIR = path.join(__dirname, 'goldens', 'scenes');
const UPDATE = !!process.env.UPDATE_GPU_GOLDENS;

/** Per-channel tolerance: rounding differs slightly between GPU APIs. */
const TOLERANCE = 3;
/** Share of pixels allowed outside the tolerance (edges of rasterised shapes). */
const MAX_BAD_RATIO = 0.004;

function decode(r: SceneResult): Uint8Array {
  return new Uint8Array(Buffer.from(r.pixels!, 'base64'));
}

function expectSame(name: string, actual: Uint8Array, expected: Uint8Array, what: string) {
  const diff = comparePixels(actual, expected, SCENE_SIZE, SCENE_SIZE, TOLERANCE);
  expect(
    diff.badRatio,
    `${name}: ${what} — ${diff.badPixels} pixels differ (max channel delta ${diff.maxDelta}, first at ${diff.firstBad})`,
  ).toBeLessThanOrEqual(MAX_BAD_RATIO);
}

test('compatibility backend matches WebGPU', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForFunction(() => '__threnicGPU' in window);
  const hasNative = await page.evaluate(() => !!navigator.gpu);

  // WebGPU first: it is the reference the compatibility backend is held to.
  const native = hasNative ? await page.evaluate(runGpuScenes, 'native' as const) : [];
  const compat = await page.evaluate(runGpuScenes, 'compat' as const);
  const failed = compat.filter((r) => r.error);
  expect(failed, `scenes failed on the compatibility backend`).toEqual([]);

  if (hasNative) {
    expect(
      native.filter((r) => r.error),
      'scenes failed on WebGPU',
    ).toEqual([]);
    if (UPDATE && testInfo.project.name === 'chrome-webgpu') {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      for (const r of native) fs.writeFileSync(path.join(GOLDEN_DIR, `${r.name}.rgba`), decode(r));
    }
    for (const r of compat) {
      const ref = native.find((n) => n.name === r.name)!;
      expectSame(r.name, decode(r), decode(ref), 'compat vs WebGPU in this browser');
    }
  }

  for (const r of compat) {
    const file = path.join(GOLDEN_DIR, `${r.name}.rgba`);
    expect(fs.existsSync(file), `missing golden for scene ${r.name}`).toBe(true);
    expectSame(r.name, decode(r), new Uint8Array(fs.readFileSync(file)), 'compat vs WebGPU golden');
  }
});
