/**
 * OscilloscopePass — Pure WGSL oscilloscope visualizer.
 *
 * Draws audio waveform data directly in the WebGPU shader pipeline,
 * supporting linear, circular, bar, and 3D tunnel modes.
 *
 * Unlike the legacy R3F WaveformVisualizer, this runs natively in the
 * RenderGraph and works identically in both preview and export.
 *
 * Waveform data (128 samples) is packed as array<vec4f> in the uniform
 * buffer. The 3D tunnel mode additionally keeps a rolling HISTORY of the
 * last RING_COUNT waveform rings so it can extrude the trace into depth.
 *
 * Architecture:
 *   audioStore.getState().timeDomainData (Uint8Array[2048])
 *      ↓  downsample to 128 f32 [-1, 1]
 *   updater() → Float32Array → GPU uniform buffer
 *      ↓
 *   WGSL shader → SDF line rendering with glow
 *
 * 3D Tunnel look:
 *   Each captured frame becomes one ring of RING_SAMPLES points wrapped
 *   into a circle. Rings recede down +Z; the camera flies through at a
 *   CONSTANT rate (Z-velocity is NOT audio-tied — tying fly speed to audio
 *   makes the whole tunnel appear to spin). Audio drives radius pulse and
 *   brightness only. Newest ring is near/bright; older rings shrink and fog
 *   into the distance.
 */

import type { EffectPassConfig, EffectPassParams } from './RenderGraph';
import { audioStore } from '@/engine/stores/audioStore';

// ─── Tunnel constants (shared JS ↔ WGSL) ────────────────────────────────────
const RING_COUNT = 48; // number of history rings drawn into depth
const RING_SAMPLES = 32; // points per ring
const TUNNEL_SEGMENTS = RING_COUNT * RING_SAMPLES; // instances used by tunnel mode
const HISTORY_FLOATS = RING_COUNT * RING_SAMPLES; // 1536 floats of ring history

// Max instances any mode needs. Linear/circle use ≤128, bars ≤64, tunnel 1536.
const MAX_INSTANCES = TUNNEL_SEGMENTS;

// ─── WGSL Shader ───────────────────────────────────────────────────────────

const OSCILLOSCOPE_WGSL = /* wgsl */ `
const RING_COUNT: i32 = ${RING_COUNT};
const RING_SAMPLES: i32 = ${RING_SAMPLES};

struct Config {
  // vec4 0: time, lineWidth, sensitivity, smoothness
  // vec4 1: posX, posY, scaleX, scaleY
  // vec4 2: minR, minG, minB, maxR
  // vec4 3: maxG, maxB, glowIntensity, opacity
  // vec4 4: resX, resY, type, energy
  // vec4 5: bass, mid, high, sampleCount
  // vec4 6: ringCount, ringSamples, headOffset, scroll
  config: array<vec4f, 7>,
  // Waveform / ring-history data. For linear/circle/bars the first 128 floats
  // (32 vec4) hold the current waveform. For the tunnel, this region holds
  // RING_COUNT × RING_SAMPLES history samples packed 4 per vec4.
  data: array<vec4f, ${Math.ceil(HISTORY_FLOATS / 4)}>,
}

@group(0) @binding(2) var<uniform> u: Config;

// Read a raw sample from the packed data region by flat float index.
fn readData(idx: i32) -> f32 {
  let clamped = clamp(idx, 0, ${HISTORY_FLOATS - 1});
  let vecIdx = clamped / 4;
  let component = clamped % 4;
  let v = u.data[vecIdx];
  switch component {
    case 0: { return v.x; }
    case 1: { return v.y; }
    case 2: { return v.z; }
    default: { return v.w; }
  }
}

// Legacy 128-sample accessor for linear/circle/bars.
fn readSample(idx: i32) -> f32 {
  return readData(clamp(idx, 0, 127));
}

// Ring history accessor: ring 0 = newest. Wraps via headOffset scroll.
fn readRing(ring: i32, sample: i32) -> f32 {
  let head = i32(u.config[6].z);
  let slot = ((head - ring) % RING_COUNT + RING_COUNT) % RING_COUNT;
  return readData(slot * RING_SAMPLES + (sample % RING_SAMPLES));
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) localP: vec2f,
  @location(2) a: vec2f,
  @location(3) b: vec2f,
  @location(4) amplitude: f32,
  @location(5) barWidth: f32,
  @location(6) depthFade: f32,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vIdx: u32,
  @builtin(instance_index) iIdx: u32
) -> VertexOutput {
  var out: VertexOutput;
  out.depthFade = 1.0;
  let sampleCount = i32(u.config[5].w);
  let vizType = u.config[4].z;

  let lineWidth = u.config[0].y;
  let glowIntensity = u.config[3].z;
  let resX = u.config[4].x;
  let resY = u.config[4].y;
  let aspect = resX / max(resY, 1.0);

  let pixelSize = 1.0 / resY;
  let coreWidth = lineWidth * pixelSize;
  // Glow slider is 0.0–0.2 (max glow greatly reduced). Remap ×5 for spread so the
  // usable range is preserved, then keep the padding modest.
  let glowSpread = glowIntensity * 5.0;
  let glowWidth = max(coreWidth * (2.0 + glowSpread * 4.0), 0.05); // Min glow padding
  let padding = glowWidth * 2.5;

  var a = vec2f(0.0);
  var b = vec2f(0.0);
  var s0 = 0.0;
  var s1 = 0.0;
  var activeInstance = true;
  var actualBarWidth = 0.0;

  let scaleX = u.config[1].z;
  let scaleY = u.config[1].w;
  let sensitivity = u.config[0].z;

  if (vizType < 0.5) { // Linear
    let count = min(sampleCount, 128);
    if (i32(iIdx) >= count - 1) { activeInstance = false; }
    let t0 = f32(iIdx) / f32(count - 1);
    let t1 = f32(iIdx + 1) / f32(count - 1);
    a = vec2f(t0 - 0.5, readSample(i32(iIdx)) * sensitivity * 0.25);
    b = vec2f(t1 - 0.5, readSample(i32(iIdx) + 1) * sensitivity * 0.25);
    s0 = readSample(i32(iIdx)); s1 = readSample(i32(iIdx) + 1);
  } else if (vizType < 1.5) { // Circle
    let count = min(sampleCount, 128);
    if (i32(iIdx) >= count) { activeInstance = false; }
    let nextI = (i32(iIdx) + 1) % count;
    let angle0 = f32(iIdx) / f32(count) * 6.283185;
    let angle1 = f32(nextI) / f32(count) * 6.283185;
    let r0 = 0.15 * scaleX + readSample(i32(iIdx)) * sensitivity * 0.08;
    let r1 = 0.15 * scaleX + readSample(nextI) * sensitivity * 0.08;
    a = vec2f(cos(angle0) * r0, sin(angle0) * r0);
    b = vec2f(cos(angle1) * r1, sin(angle1) * r1);
    s0 = readSample(i32(iIdx)); s1 = readSample(nextI);
  } else if (vizType < 2.5) { // Bars
    let barCount = min(sampleCount / 2, 64);
    if (i32(iIdx) >= barCount) { activeInstance = false; }
    let totalWidth = scaleX * 0.8;
    let barWidth = totalWidth / f32(barCount);
    actualBarWidth = barWidth - (barWidth * 0.2);
    let startX = -totalWidth * 0.5;
    let barX = startX + f32(iIdx) * barWidth + actualBarWidth * 0.5;
    let sample = abs(readSample(i32(iIdx) * 2)) * sensitivity * scaleY * 0.3;
    a = vec2f(barX, 0.0);
    b = vec2f(barX, sample);
    s0 = sample; s1 = sample;
  } else { // Tunnel (3D)
    // Each instance is one segment: (ring, sample) → (ring, sample+1) around the ring.
    let ring = i32(iIdx) / RING_SAMPLES;
    let seg = i32(iIdx) % RING_SAMPLES;
    if (ring >= RING_COUNT) { activeInstance = false; }

    let bass = u.config[5].x;
    let energy = u.config[4].w;

    // Fractional scroll makes rings glide toward the camera smoothly between
    // capture ticks (scroll ∈ [0,1)). Depth = ring index minus scroll offset.
    let scroll = u.config[6].w;
    let depthIdx = f32(ring) - scroll;

    // Ring radius: base + audio pulse. Bass swells the whole ring; the trace
    // sample perturbs the radius per point. NOTE: fly speed / depth spacing is
    // constant (set on the CPU); audio must NOT drive Z or the tunnel spins.
    let baseR = 0.18 * scaleX;
    let pulse = 1.0 + bass * 0.35;
    let s_a = readRing(ring, seg);
    let s_b = readRing(ring, seg + 1);
    let ampScale = sensitivity * 0.10 * scaleX;

    let ang0 = f32(seg) / f32(RING_SAMPLES) * 6.283185;
    let ang1 = f32(seg + 1) / f32(RING_SAMPLES) * 6.283185;
    let r0 = baseR * pulse + s_a * ampScale;
    let r1 = baseR * pulse + s_b * ampScale;

    // 3D ring points, then perspective projection into 2D screen space.
    // z grows with depth; perspective divide shrinks distant rings.
    let ringSpacing = 0.55;
    let z = depthIdx * ringSpacing + 0.65; // keep newest ring in front of camera
    let persp = 1.0 / z; // pinhole projection

    let p0 = vec2f(cos(ang0) * r0, sin(ang0) * r0) * persp;
    let p1 = vec2f(cos(ang1) * r1, sin(ang1) * r1) * persp;
    a = p0;
    b = p1;
    s0 = s_a; s1 = s_b;

    // Depth fade: near = 1, far → 0. Also brighten the newest few rings.
    let fogFar = f32(RING_COUNT) * ringSpacing + 0.65;
    out.depthFade = clamp(1.0 - (z - 0.65) / fogFar, 0.0, 1.0);
    out.depthFade = out.depthFade * out.depthFade; // stronger falloff
  }

  // Calculate bounding quad
  let dir = b - a;
  let len = length(dir);
  var ndir = vec2f(1.0, 0.0);
  if (len > 0.0001) { ndir = dir / len; }
  let pd = vec2f(-ndir.y, ndir.x); // Normal

  // Basic [0..1] x [-1..1] quad mapping
  var quadMappings = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0)
  );
  let q = quadMappings[vIdx];

  var activePadding = padding;
  if (vizType >= 1.5 && vizType < 2.5) { // Bars
     activePadding = max(padding, actualBarWidth * 0.5 + padding);
  }
  if (vizType >= 2.5) { // Tunnel: thin, depth-scaled line width
     activePadding = max(coreWidth * (1.5 + glowSpread * 2.0) * out.depthFade, 0.004);
  }

  let localX = mix(-activePadding, len + activePadding, q.x);
  let localY = mix(-activePadding, activePadding, (q.y + 1.0) * 0.5);
  let centerSpacePos = a + ndir * localX + pd * localY;

  out.localP = centerSpacePos;
  out.a = a;
  out.b = b;
  out.barWidth = actualBarWidth;

  let posX = u.config[1].x / 100.0;
  let posY = u.config[1].y / 100.0;

  // Scale
  var p = centerSpacePos;
  if (vizType < 0.5 || (vizType >= 1.5 && vizType < 2.5)) {
     p.x *= scaleX;
     p.y *= scaleY;
  }

  // Aspect
  p.x /= aspect;

  let uv = p + vec2f(posX, posY);
  out.uv = uv;
  out.position = vec4f(uv.x * 2.0 - 1.0, -(uv.y * 2.0 - 1.0), 0.0, 1.0);

  if (!activeInstance) {
    out.position = vec4f(2.0, 2.0, 2.0, 0.0); // Discard
  }

  if (vizType < 0.5) {
     out.amplitude = abs(s0 + s1) * 0.5 / (sensitivity * 0.25 + 0.001);
  } else if (vizType < 1.5) {
     out.amplitude = abs(s0 + s1) * 0.5 / (sensitivity * 0.08 + 0.001);
  } else if (vizType < 2.5) {
     out.amplitude = s0 / (sensitivity * scaleY * 0.3 + 0.001);
  } else {
     out.amplitude = clamp(abs(s0 + s1) * 0.5 * 1.5, 0.0, 1.0);
  }

  return out;
}

fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let vizType = u.config[4].z;
  let amplitude = clamp(input.amplitude, 0.0, 1.0);

  var dist = 0.0;
  var colorMask = 0.0;

  if (vizType < 1.5 || vizType >= 2.5) {
    // Linear, Circle, Tunnel: SDF line
    dist = sdSegment(input.localP, input.a, input.b);
  } else {
    let barX = input.a.x;
    let sampleVal = input.b.y;
    let dx = abs(input.localP.x - barX) - input.barWidth * 0.5;
    let dy = abs(input.localP.y) - sampleVal * 0.5;
    dist = length(max(vec2f(dx, dy), vec2f(0.0))) + min(max(dx, dy), 0.0);
    if (dist < 0.0) {
       colorMask = 1.0;
    } else {
       colorMask = max(0.0, exp(-dist * 200.0));
    }
    dist = max(0.0, 1.0 - colorMask) * 0.01;
  }

  let lineWidth = u.config[0].y;
  let glowIntensity = u.config[3].z;
  let opacity = u.config[3].w;
  let resY = u.config[4].y;
  let energy = u.config[4].w;

  let minColor = vec3f(u.config[2].x, u.config[2].y, u.config[2].z);
  let maxColor = vec3f(u.config[2].w, u.config[3].x, u.config[3].y);

  let pixelSize = 1.0 / resY;
  let coreWidth = lineWidth * pixelSize;
  // Glow slider is 0.0–0.2. Remap ×5 for spread (preserves usable width range) but
  // keep the emitted glow brightness an order of magnitude below the old scale.
  let glowSpread = glowIntensity * 5.0;
  var glowWidth = max(coreWidth * (2.0 + glowSpread * 4.0), 0.05);

  var totalIntensity = 0.0;
  if (vizType < 1.5) {
    let coreIntensity = smoothstep(coreWidth, coreWidth * 0.3, dist);
    let glowFalloff = exp(-dist / max(glowWidth, 0.001)) * glowSpread * 0.05;
    totalIntensity = coreIntensity + glowFalloff;
  } else if (vizType < 2.5) {
    totalIntensity = colorMask;
  } else {
    // Tunnel: depth-scaled core + glow, faded by distance.
    let df = input.depthFade;
    let tCore = max(coreWidth * (0.6 + df), 0.0015);
    let tGlow = max(glowWidth * (0.4 + df * 0.8), 0.002);
    let coreIntensity = smoothstep(tCore, tCore * 0.3, dist);
    let glowFalloff = exp(-dist / tGlow) * (0.25 + glowSpread * 0.06);
    totalIntensity = (coreIntensity + glowFalloff) * df;
  }

  var waveColor = mix(minColor, maxColor, amplitude);
  let pulse = 1.0 + energy * 0.15;
  let finalWave = waveColor * totalIntensity * pulse * opacity;

  return vec4f(finalWave, totalIntensity);
}
`;

// ─── Pass Configuration ────────────────────────────────────────────────────

// Uniform layout:
//   7 config vec4s   = 7 × 16 = 112 bytes = 28 floats
//   HISTORY_FLOATS (1536) packed 4/vec4 = 384 vec4 = 6144 bytes = 1536 floats
//   Total = 6256 bytes = 1564 floats → round up to 16-byte multiple: 6272 bytes
export const OSCILLOSCOPE_PASS_ID = 'gpu-oscilloscope';

const UNIFORM_BUFFER_SIZE = Math.ceil((28 + HISTORY_FLOATS) / 4) * 16;

export const oscilloscopePassConfig: EffectPassConfig = {
  id: OSCILLOSCOPE_PASS_ID,
  label: 'Oscilloscope',
  customVertexShader: ' ', // Use empty string to signal it's handled manually in shaderSource
  shaderSource: OSCILLOSCOPE_WGSL,
  uniformBufferSize: UNIFORM_BUFFER_SIZE,
  priority: 250, // Render late in the pipeline (e.g., after starfield)
  topology: 'triangle-list',
  vertexCount: 6,
  instanceCount: MAX_INSTANCES,
  copyBeforePass: true,
  noStandardBindings: true,
  blend: {
    color: {
      srcFactor: 'one',
      dstFactor: 'one',
      operation: 'add',
    },
    alpha: {
      srcFactor: 'zero',
      dstFactor: 'one',
      operation: 'add',
    },
  },
};

// ─── State Interface ───────────────────────────────────────────────────────

export interface OscilloscopePassState {
  type: number; // 0=linear, 1=circle, 2=bars, 3=tunnel
  lineWidth: number;
  sensitivity: number;
  smoothness: number;
  positionX: number;
  positionY: number;
  scale: number;
  minColorR: number;
  minColorG: number;
  minColorB: number;
  maxColorR: number;
  maxColorG: number;
  maxColorB: number;
  glowIntensity: number;
  opacity: number;
}

// ─── Updater Factory ───────────────────────────────────────────────────────

/**
 * Creates a uniform updater that reads live waveform data from audioStore.getState().
 * The updater downsamples the 2048-sample timeDomainData to 128 samples
 * and packs them as vec4s in the uniform buffer.
 *
 * For the tunnel mode it additionally maintains a rolling ring-history buffer:
 * every TUNNEL_CAPTURE_INTERVAL seconds of media time it captures the current
 * downsampled ring into the next history slot. Capture cadence is time-based
 * (not per-frame) so the fly-through speed is identical in preview and export
 * regardless of frame rate — and constant, never audio-driven.
 */
export function createOscilloscopeUpdater(getState: () => OscilloscopePassState) {
  // Smoothed waveform buffer (persists across frames for temporal smoothing)
  const smoothedWaveform = new Float32Array(128);
  // Tracks whether the smoothing buffer has been seeded with real data. Until it
  // has, the EMA is bypassed and the raw waveform is written directly — otherwise
  // the buffer converges from all-zeros when playback starts, which reads as the
  // visualizer "sliding in" from a flat/collapsed shape into its configured place.
  let primed = false;
  // Idle-fade multiplier [0,1]: fades the oscilloscope out to invisible while the
  // audio is silent/paused (a dead flat line looks unprofessional) and fades it
  // back in when real signal arrives — so nothing "snaps" into place on play.
  let idleFade = 0;

  // ── Tunnel ring history ────────────────────────────────────────────────
  // Flat [RING_COUNT * RING_SAMPLES] buffer, ring = slot index. `head` is the
  // slot most-recently written (newest ring). A fractional scroll accumulator
  // drives smooth glide between captures.
  const ringHistory = new Float32Array(RING_COUNT * RING_SAMPLES);
  let head = 0;
  let scrollAccum = 0; // fractional ring progress toward the next capture [0,1)
  let lastTime = -1; // media time of the previous tick (to derive dt from the clock)
  // Rings advance one slot per this many seconds of media time. Lower = faster
  // fly-through. Constant on purpose.
  const CAPTURE_INTERVAL = 1 / 24;

  return (uniforms: Float32Array, params: EffectPassParams): void => {
    const s = getState();

    // ── Config vec4[0]: time, lineWidth, sensitivity, smoothness
    uniforms[0] = params.time;
    uniforms[1] = s.lineWidth ?? 1.5;
    uniforms[2] = s.sensitivity ?? 1.0;
    uniforms[3] = s.smoothness ?? 0.5;

    // ── Config vec4[1]: posX, posY, scaleX, scaleY
    uniforms[4] = s.positionX ?? 50;
    uniforms[5] = s.positionY ?? 50;
    uniforms[6] = s.scale ?? 1.0;
    uniforms[7] = s.scale ?? 1.0;

    // ── Config vec4[2]: minR, minG, minB, maxR
    uniforms[8] = s.minColorR ?? 0.16;
    uniforms[9] = s.minColorG ?? 0.16;
    uniforms[10] = s.minColorB ?? 0.18;
    uniforms[11] = s.maxColorR ?? 0.94;

    // ── Config vec4[3]: maxG, maxB, glowIntensity, opacity
    uniforms[12] = s.maxColorG ?? 0.27;
    uniforms[13] = s.maxColorB ?? 0.27;
    uniforms[14] = s.glowIntensity ?? 1.5;
    uniforms[15] = s.opacity ?? 1.0;

    // ── Config vec4[4]: resX, resY, type, energy
    uniforms[16] = params.resolution[0];
    uniforms[17] = params.resolution[1];
    uniforms[18] = s.type ?? 0;
    uniforms[19] = params.audioEnergy;

    // ── Config vec4[5]: bass, mid, high, sampleCount
    uniforms[20] = params.audioBass;
    uniforms[21] = params.audioMid;
    uniforms[22] = params.audioHigh;
    uniforms[23] = 128; // sample count

    // ── Waveform data ─────────────────────────────────────────────────────
    const timeDomain = audioStore.getState().timeDomainData;
    const step = timeDomain.length / 128;

    // Smoothness is expressed as the EMA coefficient at 60fps.
    // Scale to actual dt so the perceived smoothness is the same at any frame rate.
    // Higher value = more smoothing (slower response). Default 0.85 ≈ 100ms lag at 60fps.
    const baseSmoothness = s.smoothness ?? 0.85;
    const dtFrames = Math.max(params.dt * 60, 0.1); // normalised frame count this tick
    const frameSmoothing = Math.pow(baseSmoothness, dtFrames); // dt-corrected coefficient

    // Detect whether the incoming waveform actually carries signal. A silent OR
    // paused analyser returns a *flat* buffer — every sample is (near) equal,
    // whether that's the 128 silence baseline (→ ~0) or a frozen DC value. The
    // previous check ("any sample magnitude > 0") wrongly treated a flat non-zero
    // idle buffer as signal and primed on it, so playback then snapped the shape
    // in from that dead frame. Real audio VARIES across samples, so we detect the
    // sample-to-sample range instead of raw magnitude.
    let rawMin = Infinity;
    let rawMax = -Infinity;

    for (let i = 0; i < 128; i++) {
      // Downsample: average samples in this bin from the 2048-sample buffer
      const srcIdx = Math.floor(i * step);
      const endIdx = Math.min(Math.floor((i + 1) * step), timeDomain.length);

      let sum = 0;
      let count = 0;
      for (let j = srcIdx; j < endIdx; j++) {
        sum += (timeDomain[j] - 128) / 128;
        count++;
      }
      const raw = count > 0 ? sum / count : 0;
      if (raw < rawMin) rawMin = raw;
      if (raw > rawMax) rawMax = raw;

      // On the first frame that carries real signal, seed the buffer directly so
      // the shape appears immediately in its configured position. Afterwards use
      // the dt-corrected EMA so FPS doesn't change the feel.
      if (!primed) {
        smoothedWaveform[i] = raw;
      } else {
        smoothedWaveform[i] = smoothedWaveform[i] * frameSmoothing + raw * (1 - frameSmoothing);
      }

      // Pack into uniform buffer starting at offset 28 (after 7 config vec4s)
      uniforms[28 + i] = smoothedWaveform[i];
    }

    // A waveform is "live" when its peak-to-peak range clears a small floor. This
    // is true only for real audio — a flat idle/paused buffer has ~0 range.
    const hasSignal = rawMax - rawMin > 0.01;

    // Idle-fade: instead of hard-cutting a dead flat line before playback, control
    // the whole oscilloscope's opacity with signal presence.
    //  • First frame that carries signal (same instant `primed` seeds the shape):
    //    SNAP fully in — the waveform must appear in place, never fade/slide in
    //    (this also keeps frame 0 of an export at full opacity).
    //  • When signal stops (pause/silence): fade OUT smoothly over ~0.5s so it
    //    doesn't leave a dead flat line, and doesn't hard-blink off.
    // Applied as a multiplier on the opacity uniform below.
    if (hasSignal) {
      idleFade = 1;
    } else {
      const fadeRate = 1 - Math.pow(0.001, params.dt); // ~fully out over ~0.5s
      idleFade += (0 - idleFade) * fadeRate;
      if (idleFade < 0.001) idleFade = 0;
    }
    // Fold the fade into the opacity uniform (vec4[3].w) written above.
    uniforms[15] = (s.opacity ?? 1.0) * idleFade;

    // Only mark primed once we've actually written real signal, so a paused/silent
    // start doesn't consume the seed frame and leave the ramp for real playback.
    if (hasSignal) primed = true;

    // ── Tunnel ring history (only maintained/emitted for tunnel mode) ──────
    if ((s.type ?? 0) >= 3) {
      // A seek/rewind invalidates the flight history — clear it so pre-seek rings
      // don't keep flying past for the next couple of seconds.
      if (params.didReset) {
        ringHistory.fill(0);
        head = 0;
        scrollAccum = 0;
        lastTime = -1;
      }

      // Derive dt from the media clock so capture cadence is FPS-independent and
      // identical in export. Guard against seeks/rewinds (negative or huge jumps).
      const t = params.time;
      let dt = lastTime < 0 ? params.dt : t - lastTime;
      if (dt < 0 || dt > 0.5) dt = params.dt; // seek/rewind → fall back to frame dt
      lastTime = t;

      scrollAccum += dt / CAPTURE_INTERVAL;
      // Advance one (or more) ring slots when enough time has elapsed.
      let guard = 0;
      while (scrollAccum >= 1 && guard < RING_COUNT) {
        scrollAccum -= 1;
        head = (head + 1) % RING_COUNT;
        // Capture the current smoothed waveform (downsampled to RING_SAMPLES)
        // into the new head slot.
        const base = head * RING_SAMPLES;
        const bin = 128 / RING_SAMPLES;
        for (let k = 0; k < RING_SAMPLES; k++) {
          const src = Math.floor(k * bin);
          ringHistory[base + k] = smoothedWaveform[src];
        }
        guard++;
      }

      // ── Config vec4[6]: ringCount, ringSamples, headOffset (as newest slot), scroll
      uniforms[24] = RING_COUNT;
      uniforms[25] = RING_SAMPLES;
      uniforms[26] = head;
      uniforms[27] = Math.min(Math.max(scrollAccum, 0), 0.9999);

      // Overwrite the data region with the full ring history.
      uniforms.set(ringHistory, 28);
    } else {
      // Non-tunnel modes leave config vec4[6] zeroed (unused by their branches).
      uniforms[24] = 0;
      uniforms[25] = 0;
      uniforms[26] = 0;
      uniforms[27] = 0;
      // Reset tunnel accumulators so switching back to tunnel starts clean.
      lastTime = -1;
      scrollAccum = 0;
    }
  };
}
