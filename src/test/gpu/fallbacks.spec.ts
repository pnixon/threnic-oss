/**
 * Fallbacks for older GPUs and browsers. Older Macs often cannot render into
 * float textures, so the WebGL2 backend drops to 16-bit or 8-bit targets;
 * those paths must still draw the same picture.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  applyCase,
  captureSettled,
  collectErrors,
  diffImages,
  expectedBackend,
  openEditor,
} from './stage';

interface Hooks {
  createDefaultInstance(type: string): {
    id: string;
    type: string;
    config: Record<string, unknown>;
  };
}

async function renderBloomScene(page: Page, testInfo: Parameters<typeof openEditor>[1]) {
  await openEditor(page, testInfo);
  const instances = await page.evaluate(() => {
    const h = (window as unknown as { __threnicTest: Hooks }).__threnicTest;
    return ['bloom', 'chromaticAberration'].map((type) => {
      const inst = h.createDefaultInstance(type);
      const patch = type === 'bloom' ? { intensity: 1.5, threshold: 0.3 } : { intensity: 0.6 };
      return { ...inst, config: { ...inst.config, enabled: true, ...patch } };
    });
  });
  await applyCase(page, { instances });
  return captureSettled(page);
}

for (const disabled of ['float32', 'float32,float16']) {
  test(`effects match without float render targets (${disabled})`, async ({
    browser,
  }, testInfo) => {
    test.skip(expectedBackend(testInfo) !== 'webgl2', 'only the WebGL2 backend has this fallback');
    test.setTimeout(120_000);
    const meta = testInfo.project.metadata as { forceCompat?: boolean };

    const newPage = async (withDisabled: boolean) => {
      const context = await browser.newContext(testInfo.project.use);
      const page = await context.newPage();
      await page.addInitScript(
        ({ value, force }) => {
          try {
            if (force) localStorage.setItem('threnic_force_compatibility', '1');
            if (value) localStorage.setItem('threnic_gl_disable', value);
          } catch {
            /* storage unavailable */
          }
        },
        { value: withDisabled ? disabled : '', force: !!meta.forceCompat },
      );
      return { context, page };
    };

    const base = await newPage(false);
    const baseline = await renderBloomScene(base.page, testInfo);
    await base.context.close();

    const fb = await newPage(true);
    const errors = collectErrors(fb.page);
    const result = await renderBloomScene(fb.page, testInfo);
    const diff = await diffImages(fb.page, baseline.png, result.png);
    await fb.context.close();

    expect(errors.take(), 'errors with float targets disabled').toEqual([]);
    expect(result.litRatio, 'the scene is black without float targets').toBeGreaterThan(0.05);
    // 8-bit targets band slightly in the glow; the picture must still match.
    expect(diff.mean, 'picture differs without float targets').toBeLessThan(6);
    expect(diff.bigRatio, 'large areas differ without float targets').toBeLessThan(0.03);
  });
}
