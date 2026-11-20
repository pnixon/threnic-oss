/**
 * Video export, on every renderer: export the test track with a visualizer
 * and two effects switched on, then check the file is a real video whose
 * frames show the scene (not black, not the wrong way up).
 *
 * The frame checks need ffmpeg/ffprobe; without them only the container is
 * checked.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { applyCase, collectErrors, openEditor } from './stage';

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

interface Hooks {
  createDefaultInstance(type: string): {
    id: string;
    type: string;
    config: Record<string, unknown>;
  };
}

/** One frame of the video as 64×36 RGB, read through ffmpeg. */
function frameAt(file: string, seconds: number): Buffer {
  return execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(seconds),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      'scale=64:36',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1 << 24 },
  );
}

function meanOf(rgb: Buffer, x0: number, y0: number, x1: number, y1: number): number[] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * 64 + x) * 3;
      sum[0] += rgb[i];
      sum[1] += rgb[i + 1];
      sum[2] += rgb[i + 2];
      n++;
    }
  }
  return sum.map((s) => s / n);
}

/** Turn on sepia + pixelation, choose the mode and press Begin Export. */
async function startExportWithEffects(page: Page, quality?: string): Promise<void> {
  // Colour grading and a tint: both change the picture in a way that is easy to
  // verify in the exported frames, and neither depends on audio or time.
  const instances = await page.evaluate(() => {
    const h = (window as unknown as { __threnicTest: Hooks }).__threnicTest;
    const make = (type: string, patch: Record<string, unknown>) => {
      const inst = h.createDefaultInstance(type);
      return { ...inst, config: { ...inst.config, enabled: true, ...patch } };
    };
    return [make('sepia', { intensity: 1 }), make('pixelation', { pixelSize: 12 })];
  });
  await applyCase(page, { instances });
  await page.waitForTimeout(500);

  await page.getByTestId('tab-export').click();
  await expect(page.getByTestId('export-tab-content')).toBeVisible();
  // The mode list sits in a section that may be collapsed, so pick the mode
  // and start the export by clicking the elements directly.
  const click = (label: string) =>
    page.evaluate((text) => {
      const el = [...document.querySelectorAll('button,[role=button],label,span,div')]
        .filter((e) => e.children.length < 3 && e.textContent?.trim() === text)
        .pop() as HTMLElement | undefined;
      el?.click();
      return !!el;
    }, label);
  if (quality) expect(await click(quality), `no "${quality}" option`).toBe(true);
  const started = await page.evaluate(() => {
    const mode = [...document.querySelectorAll('button,[role=button],label,span,div')]
      .filter((e) => e.children.length < 3 && e.textContent?.trim() === 'Export Current Track')
      .pop() as HTMLElement | undefined;
    mode?.click();
    return !!mode;
  });
  expect(started, 'could not find the "Export Current Track" mode').toBe(true);
  await page.waitForTimeout(400);
  const begun = await page.evaluate(() => {
    const begin = [...document.querySelectorAll('button')].find((b) =>
      /^begin export$/i.test(b.textContent?.trim() ?? ''),
    );
    if (!begin || begin.disabled) return false;
    begin.click();
    return true;
  });
  expect(begun, 'the Begin Export button is missing or disabled').toBe(true);
}

/** The frame checks every export must pass: right way up, sepia applied. */
function expectSepiaScene(file: string, seconds: number): void {
  const frame = frameAt(file, seconds);
  expect(frame.length).toBe(64 * 36 * 3);
  // The test background is dark blue at the top left and yellow at the bottom
  // right, with a white disc lower right. Sepia keeps that brightness order,
  // so an upside-down or mirrored export fails here.
  const topLeft = meanOf(frame, 20, 0, 32, 3);
  const bottomRight = meanOf(frame, 54, 14, 64, 22);
  const luma = (c: number[]) => (c[0] + c[1] + c[2]) / 3;
  expect(luma(bottomRight), 'frame is black').toBeGreaterThan(60);
  expect(luma(bottomRight), 'frame is upside down or mirrored').toBeGreaterThan(luma(topLeft) + 25);
  // Sepia: red ≥ green ≥ blue everywhere, unlike the blue/magenta original.
  const mid = meanOf(frame, 0, 0, 64, 36);
  expect(mid[0], 'sepia was not applied to the export').toBeGreaterThan(mid[2] + 10);
}

interface Probe {
  streams: { codec_type: string; width?: number; height?: number; nb_read_packets?: string }[];
  format: { duration?: string };
}

function probeFile(file: string): Probe {
  return JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-count_packets',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,nb_read_packets:format=duration',
      '-of',
      'json',
      file,
    ]).toString(),
  ) as Probe;
}

test('exports a video with effects', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  // Chromium would open the system "Save as" dialog, which a test cannot
  // answer. Without the picker the app saves through a normal download, the
  // same path Firefox always takes.
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const errors = collectErrors(page);
  await openEditor(page, testInfo);

  const encoder = await page.evaluate(async () => {
    if (typeof VideoEncoder === 'undefined') return 'none';
    const h264 = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f',
      width: 1280,
      height: 720,
      bitrate: 5_000_000,
      framerate: 30,
    }).catch(() => ({ supported: false }));
    return h264.supported ? 'h264' : 'no-h264';
  });
  test.skip(encoder === 'none', 'this browser has no WebCodecs video encoder');
  // Playwright's Firefox build ships without an H.264 encoder (release Firefox
  // has one), and the export does not complete on its other codecs. Export in
  // Firefox is therefore checked by hand against release Firefox for now.
  test.skip(encoder === 'no-h264', 'this browser build cannot encode H.264');

  const downloadPromise = page.waitForEvent('download', { timeout: 200_000 });
  await startExportWithEffects(page);
  const download = await downloadPromise;
  const file = testInfo.outputPath('export.mp4');
  await download.saveAs(file);

  expect(fs.statSync(file).size, 'exported file is empty').toBeGreaterThan(20_000);
  const head = fs.readFileSync(file).subarray(0, 64).toString('latin1');
  expect(head, 'exported file is not an MP4').toContain('ftyp');
  expect(errors.take(), 'errors were logged during export').toEqual([]);

  if (!hasFfmpeg) return;
  const probe = probeFile(file);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  expect(video, 'no video stream').toBeTruthy();
  expect(video!.width).toBe(1920);
  expect(video!.height).toBe(1080);
  expect(Number(video!.nb_read_packets), 'too few frames for a 4 second track').toBeGreaterThan(60);
  expect(
    probe.streams.some((s) => s.codec_type === 'audio'),
    'no audio stream',
  ).toBe(true);
  expectSepiaScene(file, 1.6);
});

// Browsers without WebCodecs (Firefox for Android, Safari before 26) record
// the render live instead. Simulate that by removing the APIs before the page
// loads, then check the recording the same way.
test('exports in real time when WebCodecs is missing', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    for (const name of [
      'VideoEncoder',
      'AudioEncoder',
      'VideoDecoder',
      'AudioDecoder',
      'AudioData',
      'EncodedVideoChunk',
      'EncodedAudioChunk',
    ]) {
      delete w[name];
    }
  });
  const errors = collectErrors(page);
  await openEditor(page, testInfo);
  const caps = await page.evaluate(() => ({
    encoder: typeof VideoEncoder,
    recorder: typeof MediaRecorder,
  }));
  expect(caps.encoder, 'the simulated browser still has VideoEncoder').toBe('undefined');
  test.skip(caps.recorder === 'undefined', 'this browser has no MediaRecorder');

  const downloadPromise = page.waitForEvent('download', { timeout: 200_000 });
  await page.getByTestId('tab-export').click();
  await expect(page.getByTestId('export-realtime-notice')).toBeVisible();
  await expect(page.getByTestId('export-unsupported-notice')).toHaveCount(0);
  // 480p: browsers that record live do it in software, and the test machines
  // render in software too, so a small frame keeps the recording at full rate.
  await startExportWithEffects(page, 'Low (480p)');
  const download = await downloadPromise;
  const name = download.suggestedFilename();
  expect(name, 'recording was saved under the wrong extension').toMatch(/\.(webm|mp4)$/);
  const file = testInfo.outputPath(name);
  await download.saveAs(file);

  expect(fs.statSync(file).size, 'recording is empty').toBeGreaterThan(20_000);
  expect(errors.take(), 'errors were logged during the recording').toEqual([]);
  if (!hasFfmpeg) return;

  const probe = probeFile(file);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  expect(video, 'no video stream').toBeTruthy();
  expect(video!.width).toBe(854);
  expect(video!.height).toBe(480);
  expect(
    probe.streams.some((s) => s.codec_type === 'audio'),
    'no audio stream',
  ).toBe(true);
  // The 4 second test track at 30 fps is 120 frames; allow the live encoder to
  // drop some, but not most.
  expect(Number(video!.nb_read_packets), 'the recording lost most of its frames').toBeGreaterThan(
    60,
  );
  const duration = Number(probe.format.duration);
  expect(duration, 'recording has no duration, so editors cannot seek in it').toBeGreaterThan(3);
  expect(duration, 'recording ran far longer than the track').toBeLessThan(8);
  expectSepiaScene(file, 1.6);
});
