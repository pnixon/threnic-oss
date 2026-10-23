/**
 * Synthwave Horizon — 80s retrowave cityscape with perspective grid,
 * solid neon-lit buildings, and a scanlined sun.
 * Palette: synthwave (default), also looks great with sunset/miami/outrun/midnight/vapor
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const SYNTHWAVE_PRESET: ShaderPreset = {
  id: 'synthwave',
  label: 'Synthwave Horizon',
  description:
    'Retro 80s grid rushing forward with solid neon buildings and a glowing sun on the horizon',
  palette: 'synthwave',
  params: [
    {
      id: 'driveSpeed',
      label: 'Drive Speed',
      slot: 'p0',
      min: 0.01,
      max: 0.5,
      default: 0.15,
      step: 0.01,
    },
    {
      id: 'buildingDensity',
      label: 'Building Density',
      slot: 'p1',
      min: 2.0,
      max: 12.0,
      default: 6.0,
      step: 1.0,
    },
  ],
  body: /* wgsl */ `
// ─── Synthwave Horizon — Solid 3D city ──────────────────────────────────────

const HORIZON: f32 = 0.45;
const ROAD_HALF: f32 = 0.25;  // half-width of center road in world X

fn gridLine(x: f32, lineWidth: f32) -> f32 {
  let d = abs(fract(x - 0.5) - 0.5);
  return 1.0 - smoothstep(0.0, lineWidth, d);
}

fn gridFloor(uv: vec2f, t: f32, speed: f32) -> vec3f {
  let yBelow = uv.y - HORIZON;
  let belowMask = smoothstep(0.0, 0.005, yBelow);
  let safeY = max(yBelow, 0.001);
  let depth = 0.15 / safeY;
  let worldX = (uv.x - 0.5) * depth * 2.0;
  let worldZ = depth + t * speed;

  let lineWidthX = 0.02 + depth * 0.003;
  let lineWidthZ = 0.02 + depth * 0.003;
  let lineX = gridLine(worldX, lineWidthX);
  let lineZ = gridLine(worldZ, lineWidthZ);
  let grid = max(lineX, lineZ);

  let fade = smoothstep(0.0, 0.05, yBelow) * smoothstep(30.0, 2.0, depth);
  let col = palette(0.7 + grid * 0.2) * grid * fade * belowMask;
  return col * 1.5;
}

fn neonSun(uv: vec2f, beat: f32) -> vec3f {
  let sunCenter = vec2f(0.5, 0.40);
  let sunRadius = 0.16 + beat * 0.02;
  let d = distance(uv, sunCenter);

  let gradT = clamp((uv.y - (sunCenter.y - sunRadius)) / (sunRadius * 2.0), 0.0, 1.0);
  let topCol = vec3f(1.0, 0.9, 0.3);
  let botCol = palette(0.85);
  var sunCol = mix(topCol, botCol, gradT);

  let scan = step(0.5, fract(uv.y * 60.0));
  let scanMask = smoothstep(0.0, 0.5, gradT);
  sunCol = sunCol * (1.0 - scan * scanMask * 0.7);

  let disc = smoothstep(sunRadius, sunRadius - 0.008, d);
  let sun = sunCol * disc;

  let glowDist = max(d - sunRadius, 0.0);
  let glow = exp(-glowDist * 20.0) * 0.4;
  return sun + palette(0.75) * glow;
}

// Project a 3D world point to screen UV
fn project(worldX: f32, worldY: f32, worldZ: f32) -> vec2f {
  let safeZ = max(worldZ, 0.01);
  let screenX = 0.5 + (worldX / safeZ) * 0.5;
  let screenY = HORIZON + (worldY / safeZ) * 0.5;
  return vec2f(screenX, screenY);
}

// Cross product of two 2D vectors (returns scalar z-component)
fn cross2d(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.y - a.y * b.x;
}

// Test if point p is inside the projected quad (a, b, c, d) using winding
fn insideQuad(p: vec2f, a: vec2f, b: vec2f, c: vec2f, d: vec2f) -> bool {
  let c0 = cross2d(b - a, p - a);
  let c1 = cross2d(c - b, p - b);
  let c2 = cross2d(d - c, p - c);
  let c3 = cross2d(a - d, p - d);
  // All same sign = inside (handles both CW and CCW)
  return (c0 >= 0.0 && c1 >= 0.0 && c2 >= 0.0 && c3 >= 0.0) ||
         (c0 <= 0.0 && c1 <= 0.0 && c2 <= 0.0 && c3 <= 0.0);
}

// Render one solid 3D building with face shading + neon edge highlights
fn solidBuilding(uv: vec2f, bx: f32, bz: f32, bw: f32, bd: f32, bh: f32,
                 seed: f32, t: f32, speed: f32) -> vec3f {
  // Z scrolls toward camera continuously
  let scrollZ = t * speed;
  let cellSize = 8.0;
  var z = bz + cellSize - (scrollZ - floor(scrollZ / cellSize) * cellSize);
  z = z - floor(z / cellSize) * cellSize;

  // Scale-in / scale-out animation
  let spawnProgress = 1.0 - (z / cellSize);
  let growFactor = smoothstep(0.0, 0.15, spawnProgress);
  let exitFactor = smoothstep(0.0, 0.08, z);
  let scaleFactor = growFactor * exitFactor;

  let scaledW = bw * scaleFactor;
  let scaledD = bd * scaleFactor;
  let scaledH = bh * scaleFactor;

  let halfW = scaledW * 0.5;
  let halfD = scaledD * 0.5;

  // 8 corners of the box
  let x0 = bx - halfW;
  let x1 = bx + halfW;
  let z0 = z - halfD;  // front face
  let z1 = z + halfD;  // back face
  let y0 = 0.0;        // ground
  let y1 = -scaledH;   // top (negative Y = up)

  let behindMask = smoothstep(-0.5, 0.0, z1);
  if (behindMask < 0.01) { return vec3f(0.0); }

  // Project corners
  let cz0 = max(z0, 0.05);
  let cz1 = max(z1, 0.05);
  let p000 = project(x0, y0, cz0);  // front-bottom-left
  let p100 = project(x1, y0, cz0);  // front-bottom-right
  let p010 = project(x0, y1, cz0);  // front-top-left
  let p110 = project(x1, y1, cz0);  // front-top-right
  let p001 = project(x0, y0, cz1);  // back-bottom-left
  let p101 = project(x1, y0, cz1);  // back-bottom-right
  let p011 = project(x0, y1, cz1);  // back-top-left
  let p111 = project(x1, y1, cz1);  // back-top-right

  // Base color from palette (varies per building)
  let baseCol = palette(seed * 0.4 + 0.1);

  // Audio-reactive brightness
  let audioBoost = 1.0 + u_bass() * 1.2 + u_beat() * 0.8;

  var col = vec3f(0.0);

  // Face shading: front face (brightest), top face (medium), side faces (darkest)
  // Determine which faces are visible based on camera-relative position

  // Front face — always visible (buildings face the camera)
  let frontVisible = z0 > 0.0;
  if (frontVisible && insideQuad(uv, p000, p100, p110, p010)) {
    // Gradient: darker at bottom, lighter at top
    let frontMin = min(p000.y, min(p100.y, min(p010.y, p110.y)));
    let frontMax = max(p000.y, max(p100.y, max(p010.y, p110.y)));
    let frontGrad = 1.0 - smoothstep(frontMin, frontMax, uv.y);
    let shade = 0.3 + frontGrad * 0.5;

    // Window pattern
    let winU = (uv.x - min(p000.x, p010.x)) / max(abs(p100.x - p000.x), 0.001);
    let winV = frontGrad;
    let winX = step(0.5, fract(winU * (3.0 + floor(hash11(seed * 99.0) * 3.0))));
    let winY = step(0.5, fract(winV * (4.0 + floor(hash11(seed * 77.0) * 4.0))));
    let winLit = winX * winY * hash11(seed * 13.0 + floor(winU * 6.0) + floor(winV * 8.0) * 7.0);
    let winGlow = step(0.6, winLit) * 0.4;

    col = baseCol * shade * 0.8 + palette(seed * 0.6 + 0.3) * winGlow;
    col = col * audioBoost * behindMask;
    return col;
  }

  // Top face
  if (insideQuad(uv, p010, p110, p111, p011)) {
    let shade = 0.6;
    col = baseCol * shade * 0.9;
    col = col * audioBoost * behindMask;
    return col;
  }

  // Left side face (visible if building is right of center)
  if (bx > 0.0 && insideQuad(uv, p001, p000, p010, p011)) {
    let shade = 0.15;
    col = baseCol * shade;
    col = col * audioBoost * behindMask;
    return col;
  }

  // Right side face (visible if building is left of center)
  if (bx < 0.0 && insideQuad(uv, p100, p101, p111, p110)) {
    let shade = 0.15;
    col = baseCol * shade;
    col = col * audioBoost * behindMask;
    return col;
  }

  // Neon edge highlights on silhouette edges (thin glow)
  let avgZ = (cz0 + cz1) * 0.5;
  let thick = 0.001 + 0.002 / max(avgZ, 0.5);
  var edgeGlow = 0.0;

  // Front face top edge
  let e0 = p010; let e1 = p110;
  let pa0 = uv - e0; let ba0 = e1 - e0;
  let t0 = clamp(dot(pa0, ba0) / max(dot(ba0, ba0), 0.0001), 0.0, 1.0);
  edgeGlow = max(edgeGlow, smoothstep(thick, thick * 0.2, length(uv - (e0 + ba0 * t0))));

  // Vertical edges
  let e2 = p000; let e3 = p010;
  let pa1 = uv - e2; let ba1 = e3 - e2;
  let t1 = clamp(dot(pa1, ba1) / max(dot(ba1, ba1), 0.0001), 0.0, 1.0);
  edgeGlow = max(edgeGlow, smoothstep(thick, thick * 0.2, length(uv - (e2 + ba1 * t1))));

  let e4 = p100; let e5 = p110;
  let pa2 = uv - e4; let ba2 = e5 - e4;
  let t2 = clamp(dot(pa2, ba2) / max(dot(ba2, ba2), 0.0001), 0.0, 1.0);
  edgeGlow = max(edgeGlow, smoothstep(thick, thick * 0.2, length(uv - (e4 + ba2 * t2))));

  // Top face edges going to back
  let e6 = p010; let e7 = p011;
  let pa3 = uv - e6; let ba3 = e7 - e6;
  let t3 = clamp(dot(pa3, ba3) / max(dot(ba3, ba3), 0.0001), 0.0, 1.0);
  edgeGlow = max(edgeGlow, smoothstep(thick, thick * 0.2, length(uv - (e6 + ba3 * t3))));

  let e8 = p110; let e9 = p111;
  let pa4 = uv - e8; let ba4 = e9 - e8;
  let t4 = clamp(dot(pa4, ba4) / max(dot(ba4, ba4), 0.0001), 0.0, 1.0);
  edgeGlow = max(edgeGlow, smoothstep(thick, thick * 0.2, length(uv - (e8 + ba4 * t4))));

  if (edgeGlow > 0.01) {
    col = palette(seed * 0.3 + 0.5) * edgeGlow * 1.5 * audioBoost * behindMask;
  }

  return col;
}

// Oscilloscope waveforms — audio-reactive traces in the sky
fn oscilloscope(uv: vec2f, t: f32) -> vec3f {
  var total = vec3f(0.0);

  let bass = u_bass();
  let mid = u_mid();
  let treb = u_treb();
  let energy = u_energy();

  let centered = uv - vec2f(0.5, 0.40);

  for (var w = 0; w < 6; w++) {
    let waveSeed = f32(w) * 1.317 + 0.2;

    let angle = (f32(w) / 6.0) * 3.14159 - 0.5;
    let ca = cos(angle);
    let sa = sin(angle);

    let rotP = vec2f(
      centered.x * ca - centered.y * sa,
      centered.x * sa + centered.y * ca
    );

    let traceX = rotP.x;
    let traceY = rotP.y;

    let bandSelect = f32(w % 3);
    var amplitude = 0.0;
    if (bandSelect < 0.5) {
      amplitude = bass * 0.06;
    } else if (bandSelect < 1.5) {
      amplitude = mid * 0.04;
    } else {
      amplitude = treb * 0.03;
    }

    let slowT = t * 0.15;
    let freq = 3.0 + hash11(waveSeed * 7.0) * 5.0;
    let phase = slowT + waveSeed * 6.28;
    let wave = sin(traceX * freq * 6.28 + phase)
             + 0.5 * sin(traceX * freq * 12.56 + phase * 2.1)
             + 0.3 * sin(traceX * freq * 18.84 + phase * 0.7);
    let waveY = wave * amplitude * (1.0 + energy * 2.0);

    let dist = abs(traceY - waveY);

    let lineWidth = 0.003 + energy * 0.004;
    let lineGlow = exp(-dist * dist / (lineWidth * lineWidth)) * 0.6;
    let outerGlow = exp(-dist * 20.0) * 0.15;
    let intensity = lineGlow + outerGlow;

    let traceColor = palette(hash11(waveSeed * 3.3) + energy * 0.2);
    let edgeFade = smoothstep(0.4, 0.15, abs(traceX));

    total += traceColor * intensity * edgeFade;
  }

  let skyMask = smoothstep(HORIZON, HORIZON - 0.2, uv.y);
  return total * skyMask;
}

fn render(uv: vec2f) -> vec4f {
  let t = u_time();
  let speed = u_p0();
  let density = u_p1();
  let beat = u_beat();
  let bass = u_bass();

  // Sky gradient (palette-tinted)
  let skyGrad = smoothstep(0.0, 0.5, uv.y);
  let skyTop = palette(0.0) * 0.08;
  let skyBot = palette(0.15) * 0.15;
  var col = mix(skyTop, skyBot, skyGrad);

  // Oscilloscope traces (behind sun, behind buildings)
  col += oscilloscope(uv, t);

  // Sun (behind buildings)
  col += neonSun(uv, beat);

  // Solid 3D Buildings — grid placement ensures no overlap
  let numBuildings = i32(density);
  let slotDepth = 8.0 / f32(numBuildings);

  // Render back-to-front for correct overlap (far buildings first)
  for (var i = 9; i >= 0; i--) {
    if (i >= numBuildings) { continue; }
    let seed = f32(i) * 1.618 + 0.37;

    let bz = f32(i) * slotDepth;

    let maxW = slotDepth * 0.7;
    let bw = 0.3 + hash11(seed * 17.3) * min(0.4, maxW - 0.3);
    let bd = slotDepth * (0.1 + hash11(seed * 23.7) * 0.15);
    let bh = 0.4 + hash11(seed * 41.1) * 0.9;

    let leftX = -(ROAD_HALF + 0.15 + bw * 0.5);
    let leftResult = solidBuilding(uv, leftX, bz, bw, bd, bh, seed, t, speed);
    // Solid buildings replace (not additive) — use max to layer
    col = select(col, leftResult, leftResult.x + leftResult.y + leftResult.z > 0.01);

    // Right side — offset Z by half a slot for stagger
    let rightSeed = seed + 0.5;
    let rbw = 0.3 + hash11(rightSeed * 17.3) * min(0.4, maxW - 0.3);
    let rbd = slotDepth * (0.1 + hash11(rightSeed * 23.7) * 0.15);
    let rbh = 0.4 + hash11(rightSeed * 41.1) * 0.9;
    let rightX = ROAD_HALF + 0.15 + rbw * 0.5;
    let rightZ = bz + slotDepth * 0.5;
    let rightResult = solidBuilding(uv, rightX, rightZ, rbw, rbd, rbh, rightSeed, t, speed);
    col = select(col, rightResult, rightResult.x + rightResult.y + rightResult.z > 0.01);
  }

  // Perspective grid floor (on top of everything below horizon)
  col += gridFloor(uv, t, speed);

  // Horizon glow line
  let horizonDist = abs(uv.y - HORIZON);
  let horizonGlow = exp(-horizonDist * 80.0) * 0.5;
  col += palette(0.6) * horizonGlow * (1.0 + bass * 0.4);

  // Beat pulse
  col *= 1.0 + beat * 0.15;

  return vec4f(col, 1.0);
}
`,
};
