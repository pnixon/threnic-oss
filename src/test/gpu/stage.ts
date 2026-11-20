/**
 * Driving the editor's stage from a GPU rendering test: open the editor with
 * a track, lyrics and a background, switch effects on through the stores, and
 * capture what the stage shows.
 */
import path from 'node:path';
import fs from 'node:fs';
import { expect, type Page, type TestInfo } from '@playwright/test';

export const FIXTURES = path.join(__dirname, 'fixtures');
export const GOLDEN_DIR = path.join(__dirname, 'goldens', 'stage');
export const UPDATE_GOLDENS = !!process.env.UPDATE_GPU_GOLDENS;

/** Size the stage is reduced to for comparison. */
const CAPTURE_W = 192;
const CAPTURE_H = 108;

/** Playhead position every capture is taken at (inside the second lyric line). */
const CAPTURE_TIME = 1.6;

export type Backend = 'webgpu' | 'webgl2';

export function expectedBackend(testInfo: TestInfo): Backend {
  return (testInfo.project.metadata as { backend: Backend }).backend;
}

/** Console noise that is not a rendering problem. */
const IGNORED_ERRORS = [
  /Content-Security-Policy/i,
  /Content Security Policy/i,
  /favicon/i,
  /Failed to load resource/i,
  /AudioContext/i,
  /ResizeObserver loop/i,
];

/** Collects console errors and page exceptions; `take()` returns and clears them. */
export function collectErrors(page: Page): { take(): string[] } {
  let errors: string[] = [];
  const add = (text: string) => {
    if (!IGNORED_ERRORS.some((re) => re.test(text))) errors.push(text.slice(0, 400));
  };
  page.on('console', (m) => {
    if (m.type() === 'error') add(m.text());
  });
  page.on('pageerror', (e) => add(`pageerror: ${e.message}`));
  return {
    take() {
      const out = errors;
      errors = [];
      return out;
    },
  };
}

/**
 * Open the editor with one track (audio + lyrics + a test-pattern background),
 * paused at a fixed time, and check it is running on the expected renderer.
 */
export async function openEditor(page: Page, testInfo: TestInfo): Promise<void> {
  const meta = testInfo.project.metadata as { backend: Backend; forceCompat?: boolean };
  if (meta.forceCompat) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('threnic_force_compatibility', '1');
      } catch {
        /* storage unavailable */
      }
    });
  }
  await page.goto('/');
  await page.waitForFunction(() => '__threnicTest' in window && 'projectStore' in window);

  const badge = page.getByTestId('render-backend-badge');
  await expect(badge).toHaveAttribute('data-backend', meta.backend, { timeout: 30_000 });

  // First visit opens the help dialog.
  await page.keyboard.press('Escape');

  await page
    .locator('input[type="file"][accept="audio/*"]')
    .first()
    .setInputFiles(path.join(FIXTURES, 'tone.mp3'));
  await expect(page.getByTestId('track-item').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('track-item').first().click();
  await page.keyboard.press('Escape');

  await page.getByTestId('tab-lyrics').click();
  const lrcInput = page.locator('input[type="file"][accept*=".lrc"]');
  await expect(lrcInput.last()).toBeAttached();
  await lrcInput.last().setInputFiles(path.join(FIXTURES, 'tone.lrc'));
  await page.waitForFunction(() => {
    const ps = (
      window as unknown as {
        projectStore: {
          getState(): { selectedTrackId: string; tracks: { id: string; lyricsData?: unknown[] }[] };
        };
      }
    ).projectStore.getState();
    return (ps.tracks.find((t) => t.id === ps.selectedTrackId)?.lyricsData?.length ?? 0) > 0;
  });
  await page.getByTestId('tab-effects').click();

  await page.evaluate(
    async ({ time }) => {
      const w = window as unknown as {
        projectStore: {
          getState(): Record<string, (...a: unknown[]) => unknown> & { selectedTrackId: string };
        };
        timeStore: {
          getState(): {
            setIsPlaying(p: boolean): void;
            setCurrentTime(t: number, seek?: boolean): void;
          };
        };
      };
      const ps = w.projectStore.getState();
      const id = ps.selectedTrackId;

      // An asymmetric, colourful background so every effect has something to act on.
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 640, 360);
      grad.addColorStop(0, '#102a6b');
      grad.addColorStop(0.5, '#b0306a');
      grad.addColorStop(1, '#f0c040');
      g.fillStyle = grad;
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#20e0a0';
      g.fillRect(40, 40, 160, 90);
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(500, 250, 60, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#000000';
      g.lineWidth = 6;
      for (let x = 0; x < 640; x += 80) {
        g.beginPath();
        g.moveTo(x, 300);
        g.lineTo(x + 40, 360);
        g.stroke();
      }
      const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
      ps.updateTrackBackground(id, URL.createObjectURL(blob));

      w.timeStore.getState().setIsPlaying(false);
      w.timeStore.getState().setCurrentTime(time, true);
    },
    { time: CAPTURE_TIME },
  );
  await page.waitForTimeout(1500);
}

export interface StageCase {
  /** Effect instances to enable (empty = none). */
  instances?: unknown[];
  /** Lyric FX instances to enable. */
  lyricFX?: unknown[];
}

/** Replace the selected track's effects (and lyric FX) with exactly these. */
export async function applyCase(page: Page, c: StageCase): Promise<void> {
  await page.evaluate(
    ({ instances, lyricFX, time }) => {
      const w = window as unknown as {
        __gpuTestBase?: { effects: Record<string, unknown>; theme: Record<string, unknown> };
        projectStore: {
          getState(): {
            selectedTrackId: string;
            tracks: {
              id: string;
              effectsConfig: Record<string, unknown>;
              lyricsTheme: Record<string, unknown>;
            }[];
            updateTrackEffects(id: string, c: unknown): void;
            updateTrackProperty(id: string, path: string, v: unknown): void;
          };
        };
        timeStore: {
          getState(): {
            setIsPlaying(p: boolean): void;
            setCurrentTime(t: number, seek?: boolean): void;
          };
        };
      };
      const ps = w.projectStore.getState();
      const id = ps.selectedTrackId;
      const track = ps.tracks.find((t) => t.id === id)!;
      if (!w.__gpuTestBase) {
        w.__gpuTestBase = { effects: track.effectsConfig, theme: track.lyricsTheme };
      }
      const base = w.__gpuTestBase;
      ps.updateTrackEffects(id, { ...base.effects, effectInstances: instances });
      // Large type, so lyric effects cover enough of the stage to compare.
      ps.updateTrackProperty(id, 'lyricsTheme', { ...base.theme, fontSize: 2.2, lyricFX });
      w.timeStore.getState().setIsPlaying(false);
      w.timeStore.getState().setCurrentTime(time, true);
    },
    { instances: c.instances ?? [], lyricFX: c.lyricFX ?? [], time: CAPTURE_TIME },
  );
}

/** Play from the start for `ms`, then pause. */
export async function playFor(page: Page, ms: number): Promise<void> {
  const setPlaying = (playing: boolean) =>
    page.evaluate((playing) => {
      const ts = (
        window as unknown as {
          timeStore: {
            getState(): {
              setIsPlaying(p: boolean): void;
              setCurrentTime(t: number, seek?: boolean): void;
            };
          };
        }
      ).timeStore.getState();
      if (playing) ts.setCurrentTime(0.1, true);
      ts.setIsPlaying(playing);
    }, playing);
  await setPlaying(true);
  await page.waitForTimeout(ms);
  await setPlaying(false);
}

export interface Capture {
  /** PNG data URL of the stage reduced to the capture size. */
  png: string;
  mean: number;
  stddev: number;
  /** Share of pixels that are not near-black. */
  litRatio: number;
}

/**
 * Read the stage canvas, right after the app has drawn a frame (a WebGPU
 * canvas is only readable until the browser presents it).
 */
export async function captureStage(page: Page): Promise<Capture> {
  return page.evaluate(
    ({ W, H }) =>
      new Promise<Capture>((resolve, reject) => {
        requestAnimationFrame(() => {
          try {
            const stage = document.querySelector('[data-testid="center-stage"]') ?? document.body;
            const canvases = [...stage.querySelectorAll('canvas')].filter(
              (c) => c.clientWidth > 0 && c.width > 0,
            );
            if (canvases.length === 0) throw new Error('no stage canvas');
            // The stage is a stack of same-sized canvases (GPU scene, 2D lyric
            // overlay); composite the ones that cover the largest one.
            const area = (c: HTMLCanvasElement) => c.clientWidth * c.clientHeight;
            const biggest = canvases.reduce((a, b) => (area(b) > area(a) ? b : a));
            const layers = canvases.filter((c) => area(c) >= area(biggest) * 0.9);
            const out = document.createElement('canvas');
            out.width = W;
            out.height = H;
            const g = out.getContext('2d', { willReadFrequently: true })!;
            g.fillStyle = '#000';
            g.fillRect(0, 0, W, H);
            g.imageSmoothingQuality = 'high';
            for (const layer of layers) g.drawImage(layer, 0, 0, W, H);
            const px = g.getImageData(0, 0, W, H).data;
            let sum = 0;
            let sumSq = 0;
            let lit = 0;
            const n = px.length / 4;
            for (let i = 0; i < px.length; i += 4) {
              const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
              sum += l;
              sumSq += l * l;
              if (l > 12) lit++;
            }
            const mean = sum / n;
            resolve({
              png: out.toDataURL('image/png'),
              mean,
              stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
              litRatio: lit / n,
            });
          } catch (e) {
            reject(e);
          }
        });
      }),
    { W: CAPTURE_W, H: CAPTURE_H },
  );
}

export interface ImageDiff {
  /** Mean absolute difference per channel, 0–255. */
  mean: number;
  /** Share of pixels where some channel differs by more than 48. */
  bigRatio: number;
}

/** Compare two PNG data URLs of the same size (decoded in the page). */
export async function diffImages(page: Page, a: string, b: string): Promise<ImageDiff> {
  return page.evaluate(
    async ({ a, b }) => {
      const load = async (url: string) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const [pa, pb] = await Promise.all([load(a), load(b)]);
      if (pa.length !== pb.length) return { mean: 255, bigRatio: 1 };
      let sum = 0;
      let big = 0;
      for (let i = 0; i < pa.length; i += 4) {
        let worst = 0;
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(pa[i + k] - pb[i + k]);
          sum += d;
          if (d > worst) worst = d;
        }
        if (worst > 48) big++;
      }
      return { mean: sum / ((pa.length / 4) * 3), bigRatio: big / (pa.length / 4) };
    },
    { a, b },
  );
}

/**
 * Capture once the stage has stopped changing (shaders compiled, assets
 * loaded), or after `timeout` for effects that animate on wall-clock time.
 * `stable` tells the two apart.
 */
export async function captureSettled(
  page: Page,
  timeout = 5000,
): Promise<Capture & { stable: boolean }> {
  const start = Date.now();
  await page.waitForTimeout(350);
  let prev = await captureStage(page);
  let stableRuns = 0;
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(200);
    const next = await captureStage(page);
    const d = await diffImages(page, prev.png, next.png);
    prev = next;
    if (d.mean < 0.6 && d.bigRatio < 0.002) {
      if (++stableRuns >= 2) return { ...prev, stable: true };
    } else {
      stableRuns = 0;
    }
  }
  return { ...prev, stable: false };
}

export function goldenPath(family: string, name: string): string {
  return path.join(GOLDEN_DIR, family, `${name.replace(/[^\w.-]+/g, '_')}.png`);
}

export function writeGolden(file: string, png: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
}

export function readGolden(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}
