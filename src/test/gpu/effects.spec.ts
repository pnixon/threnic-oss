/**
 * Every effect, visualizer preset and lyric effect, on every renderer.
 *
 * Each case switches one thing on, lets the stage settle and captures it.
 * Three things are checked:
 *   - nothing logged an error (shader translation, pipeline creation, …);
 *   - the stage is not blank;
 *   - on the WebGL2 backend the picture matches the one real WebGPU produced
 *     for the same case (the golden images under goldens/stage).
 *
 * Cases that animate on wall-clock time or audio never settle, so they cannot
 * be compared pixel for pixel; for those the first two checks apply and the
 * picture must still be clearly "something" rather than black.
 *
 * Refresh the goldens from real WebGPU with
 *   UPDATE_GPU_GOLDENS=1 npm run test:gpu -- --project=chrome-webgpu
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  applyCase,
  captureSettled,
  captureStage,
  collectErrors,
  diffImages,
  expectedBackend,
  GOLDEN_DIR,
  goldenPath,
  openEditor,
  playFor,
  readGolden,
  UPDATE_GOLDENS,
  writeGolden,
  type StageCase,
} from './stage';

interface Hooks {
  createDefaultInstance(type: string): {
    id: string;
    type: string;
    config: Record<string, unknown>;
  };
  createLyricFXInstance(type: string): {
    id: string;
    type: string;
    config: Record<string, unknown>;
  };
  effectTypes: string[];
  lyricFXTypes: string[];
  shaderPresetIds: string[];
  milkdropPresetIds: string[];
  wgslPresets: { id: string; source: string; params: unknown[]; uniformLayout: unknown[] }[];
  glslPresets: { id: string; source: string }[];
}

/** Effect types covered by their own, preset-by-preset tests below. */
const OWN_FAMILY = new Set(['shaderFx', 'butterchurn', 'visualizer', 'customShader']);

/**
 * Most effects default to "off until the music drives them" (intensity 0 with
 * audio reactivity), which shows nothing on a paused stage. These settings
 * make each one plainly visible instead.
 */
const VISIBLE_SETTINGS: Record<string, Record<string, unknown>> = {
  bgBlur: { amount: 10 },
  bgOpacity: { opacity: 0.5 },
  bloom: { intensity: 1.5, threshold: 0.3 },
  brightness: { brightness: 1.6 },
  bulbFlicker: { intensity: 0.8 },
  cameraShake: { intensity: 0.05 },
  contrast: { contrast: 1.8 },
  distortion: { opacity: 0.6 },
  gateJitter: { intensity: 0.8 },
  glitch: { strength: 0.8, mode: 'continuous' },
  hueShift: { hue: 120 },
  noiseOverlay: { opacity: 0.5 },
  oldFilm: { intensity: 0.9 },
  pixelation: { pixelSize: 12 },
  saturation: { saturation: 0.2 },
  sepia: { intensity: 1 },
  slide: { speedX: 0.2 },
  rotate: { angle: 20 },
  tiling: { offsetX: 0.25 },
};

/** Mean per-channel difference allowed between WebGL2 and the WebGPU golden. */
const MAX_MEAN_DIFF = 9;
/**
 * Per-pixel patterns (grain, scanlines) depend on the exact canvas size, which
 * differs by a few pixels between browsers, so their average differs more
 * even though the picture is the same. These get a wider average allowance;
 * the share of clearly different pixels still has to stay small.
 */
const FINE_PATTERN_CASES = new Set(['effects/noiseOverlay', 'custom-shader/scanlines']);
const MAX_MEAN_DIFF_FINE_PATTERN = 20;
/** Share of clearly different pixels allowed (text edges differ by browser). */
const MAX_BIG_RATIO = 0.06;

interface NamedCase extends StageCase {
  name: string;
  /** The effect draws nothing visible by default; skip the "not blank" check. */
  mayBeBlank?: boolean;
  /**
   * Play for this long before capturing: audio-driven visualizers draw nothing
   * until they have been fed some audio. Such a capture is never pixel-compared.
   */
  playMs?: number;
}

async function runFamily(
  page: Page,
  family: string,
  backend: 'webgpu' | 'webgl2',
  errors: { take(): string[] },
  cases: NamedCase[],
): Promise<void> {
  expect(cases.length, `${family}: no cases found`).toBeGreaterThan(0);
  // Start from a clean stage so a case never inherits the previous one's state.
  await applyCase(page, {});
  const base = await captureSettled(page, 3000);
  errors.take();

  // Which cases visibly change the stage, as recorded from real WebGPU. A case
  // that changes the picture there must change it on every renderer — this is
  // what catches an effect that silently draws nothing.
  const changesFile = path.join(GOLDEN_DIR, family, '_changes.json');
  const recordedChanges: Record<string, boolean> = fs.existsSync(changesFile)
    ? JSON.parse(fs.readFileSync(changesFile, 'utf8'))
    : {};
  const observedChanges: Record<string, boolean> = {};

  for (const c of cases) {
    await test.step(`${family} / ${c.name}`, async () => {
      await applyCase(page, c);
      let shot: Awaited<ReturnType<typeof captureSettled>>;
      if (c.playMs) {
        await playFor(page, c.playMs);
        shot = { ...(await captureStage(page)), stable: false };
      } else {
        shot = await captureSettled(page);
      }
      const errs = errors.take();
      expect.soft(errs, `${family}/${c.name}: errors were logged`).toEqual([]);
      if (!c.mayBeBlank) {
        expect
          .soft(shot.litRatio, `${family}/${c.name}: stage is blank (mean ${shot.mean.toFixed(1)})`)
          .toBeGreaterThan(0.02);
      }

      const change = await diffImages(page, shot.png, base.png);
      const changed = change.bigRatio > (family === 'lyric-fx' ? 0.004 : 0.02);
      observedChanges[c.name] = changed;
      if (recordedChanges[c.name] && !(backend === 'webgpu' && UPDATE_GOLDENS)) {
        expect
          .soft(
            changed,
            `${family}/${c.name}: no visible effect on the stage (it has one on WebGPU)`,
          )
          .toBe(true);
      }

      const file = goldenPath(family, c.name);
      if (backend === 'webgpu') {
        if (UPDATE_GOLDENS && shot.stable) writeGolden(file, shot.png);
        return;
      }
      const golden = readGolden(file);
      // No golden means WebGPU itself never settled on this case: nothing to compare.
      if (!golden || !shot.stable) return;
      const d = await diffImages(page, shot.png, golden);
      expect
        .soft(
          d.mean,
          `${family}/${c.name}: differs from WebGPU (mean ${d.mean.toFixed(1)}, ${(d.bigRatio * 100).toFixed(1)}% of pixels)`,
        )
        .toBeLessThanOrEqual(
          FINE_PATTERN_CASES.has(`${family}/${c.name}`)
            ? MAX_MEAN_DIFF_FINE_PATTERN
            : MAX_MEAN_DIFF,
        );
      expect
        .soft(
          d.bigRatio,
          `${family}/${c.name}: differs from WebGPU in ${(d.bigRatio * 100).toFixed(1)}% of pixels`,
        )
        .toBeLessThanOrEqual(MAX_BIG_RATIO);
    });
  }
  if (backend === 'webgpu' && UPDATE_GOLDENS) {
    fs.mkdirSync(path.dirname(changesFile), { recursive: true });
    fs.writeFileSync(changesFile, `${JSON.stringify(observedChanges, null, 2)}\n`);
  }
  // Leave nothing running for the next family.
  await applyCase(page, {});
}

test.describe('stage rendering', () => {
  let page: Page;
  let errors: { take(): string[] };
  let backend: 'webgpu' | 'webgl2';
  let hooks: Hooks;

  test.beforeAll(async ({ browser }, testInfo) => {
    page = await browser.newPage();
    errors = collectErrors(page);
    backend = expectedBackend(testInfo);
    await openEditor(page, testInfo);
    hooks = await page.evaluate(() => {
      const h = (window as unknown as { __threnicTest: Hooks }).__threnicTest;
      return {
        effectTypes: h.effectTypes,
        lyricFXTypes: h.lyricFXTypes,
        shaderPresetIds: h.shaderPresetIds,
        milkdropPresetIds: h.milkdropPresetIds,
        wgslPresets: h.wgslPresets,
        glslPresets: h.glslPresets,
      } as Hooks;
    });
  });

  test.afterAll(async () => {
    await page?.close();
  });

  /** Default instance of an effect type, with config overrides. */
  const instance = (
    type: string,
    patch: Record<string, unknown> = {},
  ): Promise<{ id: string; type: string; config: Record<string, unknown> }> =>
    page.evaluate(
      ({ type, patch }) => {
        const h = (window as unknown as { __threnicTest: Hooks }).__threnicTest;
        const inst = h.createDefaultInstance(type);
        return { ...inst, config: { ...inst.config, enabled: true, ...patch } };
      },
      { type, patch },
    );

  test('base stage: background and lyrics', async () => {
    await runFamily(page, 'base', backend, errors, [{ name: 'background-and-lyrics' }]);
  });

  test('lyrics are drawn on the stage', async () => {
    // Two moments with different lines on screen must look different; with no
    // lyrics drawn (or drawn off-canvas) the paused stage would be identical.
    const seek = (t: number) =>
      page.evaluate((t) => {
        (
          window as unknown as {
            timeStore: { getState(): { setCurrentTime(t: number, seek?: boolean): void } };
          }
        ).timeStore
          .getState()
          .setCurrentTime(t, true);
      }, t);
    await applyCase(page, {});
    const second = await captureSettled(page);
    await seek(3.4);
    const third = await captureSettled(page);
    await applyCase(page, {});
    const d = await diffImages(page, second.png, third.png);
    expect(
      d.bigRatio,
      'the stage looks the same while different lyric lines are due: lyrics are not being drawn',
    ).toBeGreaterThan(0.001);
    expect(errors.take()).toEqual([]);
  });

  test('effects', async () => {
    const cases: NamedCase[] = [];
    for (const type of hooks.effectTypes.filter((t) => !OWN_FAMILY.has(t))) {
      cases.push({ name: type, instances: [await instance(type, VISIBLE_SETTINGS[type])] });
    }
    await runFamily(page, 'effects', backend, errors, cases);
  });

  test('effects combined in one chain', async () => {
    const chain = [
      'bloom',
      'chromaticAberration',
      'glitch',
      'vhsTracking',
      'noiseOverlay',
      'sepia',
    ];
    const instances = [];
    for (const t of chain.filter((t) => hooks.effectTypes.includes(t)))
      instances.push(await instance(t));
    await runFamily(page, 'chain', backend, errors, [{ name: 'six-effects', instances }]);
  });

  test('oscilloscope types and styles', async () => {
    const cases: NamedCase[] = [];
    for (const type of ['linear', 'circle', 'bars', 'tunnel']) {
      cases.push({
        name: `type-${type}`,
        instances: [await instance('visualizer', { type })],
        playMs: 1500,
      });
    }
    for (const style of ['retro', 'modern', 'lasers', 'blocky']) {
      cases.push({
        name: `style-${style}`,
        instances: [await instance('visualizer', { style })],
        playMs: 1500,
      });
    }
    await runFamily(page, 'oscilloscope', backend, errors, cases);
  });

  test('Butterchurn (MilkDrop) presets', async () => {
    const names = await page.evaluate(() =>
      (
        window as unknown as { __threnicTest: { getButterchurnPresetNames(): Promise<string[]> } }
      ).__threnicTest.getButterchurnPresetNames(),
    );
    // The default preset, then a spread across the bundled set.
    const picks = [0, 0.2, 0.4, 0.6, 0.8, 0.99].map((f) => names[Math.floor(f * names.length)]);
    const cases: NamedCase[] = [
      { name: 'default', instances: [await instance('butterchurn')], playMs: 1800 },
    ];
    for (const presetName of [...new Set(picks)]) {
      cases.push({
        name: presetName,
        instances: [await instance('butterchurn', { presetName })],
        playMs: 1800,
      });
    }
    await runFamily(page, 'butterchurn', backend, errors, cases);
  });

  test('native MilkDrop presets', async () => {
    const cases: NamedCase[] = [];
    for (const presetId of hooks.milkdropPresetIds) {
      const inst = await instance('shaderFx');
      const feedback = { ...(inst.config.feedback as object), enabled: true, presetId };
      cases.push({
        name: presetId,
        instances: [{ ...inst, config: { ...inst.config, mode: 'feedback', feedback } }],
        playMs: 1500,
      });
    }
    await runFamily(page, 'milkdrop', backend, errors, cases);
  });

  test('shader overlay presets', async () => {
    const cases: NamedCase[] = [];
    for (const presetId of hooks.shaderPresetIds) {
      const inst = await instance('shaderFx');
      const shader = { ...(inst.config.shader as object), enabled: true, presetId };
      cases.push({
        name: presetId,
        instances: [{ ...inst, config: { ...inst.config, mode: 'shader', shader } }],
      });
    }
    await runFamily(page, 'shader-overlay', backend, errors, cases);
  });

  test('custom WGSL shader presets', async () => {
    const cases: NamedCase[] = [
      { name: 'starter-tint', instances: [await instance('customShader')] },
    ];
    for (const p of hooks.wgslPresets) {
      cases.push({
        name: p.id,
        instances: [
          await instance('customShader', {
            source: p.source,
            params: p.params,
            uniformLayout: p.uniformLayout,
          }),
        ],
      });
    }
    await runFamily(page, 'custom-shader', backend, errors, cases);
  });

  test('GLSL guest shaders and game scenes', async () => {
    const cases: NamedCase[] = [];
    for (const p of hooks.glslPresets) {
      const inst = await instance('shaderFx');
      const glsl = { ...(inst.config.glsl as object), source: p.source };
      cases.push({
        name: `glsl-${p.id}`,
        instances: [{ ...inst, config: { ...inst.config, mode: 'glsl', glsl } }],
      });
    }
    for (const sceneId of ['rpgCombat', 'fetch', 'carRacing']) {
      const inst = await instance('shaderFx');
      cases.push({
        name: `littlejs-${sceneId}`,
        instances: [
          {
            ...inst,
            config: { ...inst.config, mode: 'littlejs', littlejs: { enabled: true, sceneId } },
          },
        ],
      });
    }
    await runFamily(page, 'guests', backend, errors, cases);
  });

  test('lyric effects', async () => {
    const cases: NamedCase[] = [];
    for (const type of hooks.lyricFXTypes) {
      const fx = await page.evaluate((type) => {
        const h = (window as unknown as { __threnicTest: Hooks }).__threnicTest;
        const inst = h.createLyricFXInstance(type);
        return { ...inst, config: { ...inst.config, enabled: true } };
      }, type);
      cases.push({ name: type, lyricFX: [fx] });
    }
    await runFamily(page, 'lyric-fx', backend, errors, cases);
  });
});
