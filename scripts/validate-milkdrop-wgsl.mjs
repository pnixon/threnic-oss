#!/usr/bin/env node
/**
 * Compile and run the Milkdrop chain in a real WebGPU implementation.
 *
 * The engine generates shaders — grid vertex stages, per-vertex equations
 * emitted from the IR — so a preset can break a shader without breaking the
 * type checker, and a uniform-layout change can break a pipeline without
 * breaking either. This script:
 *
 *   1. compiles every node's WGSL module and reports Tint's diagnostics;
 *   2. runs the real MilkdropChain for a few frames and reads the pixels back,
 *      exercising pipelines, bind groups, ping-pong and the uniform block;
 *   3. renders the same frame range twice and compares the output byte for
 *      byte, which is the determinism claim the whole design rests on.
 *
 *   node scripts/validate-milkdrop-wgsl.mjs
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import esbuild from 'esbuild';
import { chromium } from '@playwright/test';

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'md-wgsl-'));
const mdPath = (file) => join(root, 'src/engine/gpu/milkdrop', file).replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// 1. Produce the shader sources in Node (the same code path the graph uses)
// ---------------------------------------------------------------------------

const nodeEntry = join(work, 'node-entry.mjs');
writeFileSync(
  nodeEntry,
  `
import { composeNodeWGSL } from ${JSON.stringify(mdPath('PassGraph.ts'))};
import { buildMilkdropNodes } from ${JSON.stringify(mdPath('MilkdropChain.ts'))};
import { MILKDROP_PRESETS } from ${JSON.stringify(mdPath('presets.ts'))};

export function collect() {
  const out = [];
  for (const preset of [{ id: 'empty' }, ...MILKDROP_PRESETS]) {
    for (const consumeScene of [false, true]) {
      for (const def of buildMilkdropNodes(preset, { consumeScene })) {
        out.push({
          label: preset.id + (consumeScene ? '/scene' : '') + '/' + def.id,
          code: composeNodeWGSL(def),
        });
      }
    }
  }
  return out;
}
`,
);

const nodeBundle = join(work, 'node-bundle.mjs');
await esbuild.build({
  entryPoints: [nodeEntry],
  outfile: nodeBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});

const { collect } = await import(pathToFileURL(nodeBundle).href);
const shaders = collect();
const unique = [...new Map(shaders.map((s) => [s.code, s])).values()];

// ---------------------------------------------------------------------------
// 2. Bundle the chain itself for the browser
// ---------------------------------------------------------------------------

const browserEntry = join(work, 'browser-entry.js');
writeFileSync(
  browserEntry,
  `
import { AudioTable } from ${JSON.stringify(mdPath('AudioTable.ts'))};
import { MilkdropChain } from ${JSON.stringify(mdPath('MilkdropChain.ts'))};
import { MILKDROP_PRESETS } from ${JSON.stringify(mdPath('presets.ts'))};

const WIDTH = 128;
const HEIGHT = 72;
const FORMAT = 'rgba8unorm';

async function renderFrames(device, presetId, frames) {
  const preset = MILKDROP_PRESETS.find((p) => p.id === presetId);
  const target = device.createTexture({
    size: { width: WIDTH, height: HEIGHT },
    format: FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const chain = new MilkdropChain({
    device,
    presentFormat: FORMAT,
    fps: 60,
    internalWidth: 160,
    internalHeight: 90,
  });
  chain.setAudioTable(AudioTable.silent(60, frames + 1));
  chain.loadPreset(preset);

  const view = target.createView();
  for (let f = 0; f < frames; f++) {
    const encoder = device.createCommandEncoder();
    chain.renderFrame(encoder, f, view, WIDTH, HEIGHT);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  }

  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const readback = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow },
    { width: WIDTH, height: HEIGHT },
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(readback.getMappedRange()).slice();
  readback.unmap();
  readback.destroy();
  target.destroy();
  chain.destroy();
  return pixels;
}

window.__milkdropSmoke = async function (presetId, frames) {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(String(e.error.message)));

  const a = await renderFrames(device, presetId, frames);
  const b = await renderFrames(device, presetId, frames);

  let mean = 0;
  let nonZero = 0;
  for (let i = 0; i < a.length; i += 4) {
    const lum = (a[i] + a[i + 1] + a[i + 2]) / 3;
    mean += lum;
    if (lum > 2) nonZero++;
  }
  mean /= a.length / 4;

  let identical = a.length === b.length;
  if (identical) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        identical = false;
        break;
      }
    }
  }

  return { mean, nonZeroRatio: nonZero / (a.length / 4), identical, errors };
};
`,
);

const browserBundle = join(work, 'browser-bundle.js');
await esbuild.build({
  entryPoints: [browserEntry],
  outfile: browserBundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  logLevel: 'silent',
});
const browserCode = readFileSync(browserBundle, 'utf8');

// ---------------------------------------------------------------------------
// 3. Drive a browser
// ---------------------------------------------------------------------------

// WebGPU is exposed only in a secure context, and about:blank is not one, so
// everything runs on a throwaway 127.0.0.1 page.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>milkdrop validation</title>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--enable-unsafe-webgpu',
  '--enable-gpu',
  '--enable-unsafe-swiftshader',
];

async function launchWithWebGPU() {
  for (const channel of ['chrome', 'msedge', 'chromium', undefined]) {
    let browser;
    try {
      browser = await chromium.launch({ channel, args: LAUNCH_ARGS });
    } catch {
      continue;
    }
    const page = await browser.newPage();
    await page.goto(pageUrl);
    const ok = await page.evaluate(async () => {
      if (!navigator.gpu) return false;
      try {
        return !!(await navigator.gpu.requestAdapter());
      } catch {
        return false;
      }
    });
    if (ok) return { browser, page, channel: channel ?? 'bundled chromium' };
    await browser.close();
  }
  return null;
}

const launched = await launchWithWebGPU();
if (!launched) {
  server.close();
  rmSync(work, { recursive: true, force: true });
  console.error('No WebGPU adapter available in any local browser — cannot validate.');
  process.exit(2);
}
const { browser, page, channel } = launched;
console.log(`Using ${channel}`);

let failures = 0;
try {
  console.log(`\nCompiling ${unique.length} unique shader modules (${shaders.length} instances)`);
  const results = await page.evaluate(async (list) => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const out = [];
    for (const { label, code } of list) {
      const module = device.createShaderModule({ label, code });
      const info = await module.getCompilationInfo();
      out.push({
        label,
        messages: info.messages.map((m) => ({
          type: m.type,
          message: m.message,
          lineNum: m.lineNum,
        })),
      });
    }
    return out;
  }, unique);

  for (const result of results) {
    const errors = result.messages.filter((m) => m.type === 'error');
    const warnings = result.messages.filter((m) => m.type === 'warning');
    if (errors.length === 0) {
      console.log(
        `  ok    ${result.label}${warnings.length ? ` (${warnings.length} warning)` : ''}`,
      );
    } else {
      failures++;
      console.error(`  FAIL  ${result.label}`);
      for (const e of errors) console.error(`        line ${e.lineNum}: ${e.message}`);
    }
    for (const w of warnings) console.warn(`        warning line ${w.lineNum}: ${w.message}`);
  }

  await page.addScriptTag({ content: browserCode });
  const presetIds = shaders
    .map((s) => s.label.split('/')[0])
    .filter((id, i, all) => id !== 'empty' && all.indexOf(id) === i);

  console.log('\nRendering each preset for 30 frames, twice');
  for (const id of presetIds) {
    const report = await page.evaluate(
      ([presetId, frames]) => window.__milkdropSmoke(presetId, frames),
      [id, 30],
    );

    const problems = [];
    if (report.errors.length) problems.push(`GPU errors: ${report.errors.join('; ')}`);
    if (!(report.mean > 0.5))
      problems.push(`output is black (mean luma ${report.mean.toFixed(3)})`);
    if (!report.identical) problems.push('two runs of the same frames differ');

    if (problems.length === 0) {
      console.log(
        `  ok    ${id} — mean luma ${report.mean.toFixed(1)}, ` +
          `${(report.nonZeroRatio * 100).toFixed(0)}% lit, bit-identical across runs`,
      );
    } else {
      failures++;
      console.error(`  FAIL  ${id}`);
      for (const p of problems) console.error(`        ${p}`);
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nMilkdrop shader modules compile and the chain renders deterministically.');
