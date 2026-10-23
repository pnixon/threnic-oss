/**
 * Glowing Wires — Forward-flying camera through bundled transmitting wires.
 * Pulsing light packets race along cylindrical cables in a tunnel arrangement.
 * p0 = fly speed, p1 = pulse brightness. AR widgets modulate both.
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const GLOWING_WIRES_PRESET: ShaderPreset = {
  id: 'glowingWires',
  label: 'Glowing Wires',
  description: 'Fly through bundled fiber-optic cables transmitting pulses of light',
  palette: 'cyberpunk',
  params: [
    {
      id: 'pulseGlow',
      label: 'Pulse Glow',
      slot: 'p0',
      min: 0.0,
      max: 1.0,
      default: 0.4,
      step: 0.01,
    },
    {
      id: 'pulseSpeed',
      label: 'Pulse Speed',
      slot: 'p1',
      min: 0.0,
      max: 1.0,
      default: 0.3,
      step: 0.01,
    },
    { id: 'hexGlow', label: 'Hex Glow', slot: 'p2', min: 0.0, max: 1.0, default: 0.4, step: 0.01 },
    {
      id: 'flySpeed',
      label: 'Fly Speed',
      slot: 'p3',
      min: 0.0,
      max: 1.0,
      default: 0.2,
      step: 0.01,
    },
  ],
  body: /* wgsl */ `
// ─── Constants ──────────────────────────────────────────────
const PI: f32 = 3.14159265;
const NUM_WIRES: i32 = 12;
const WIRE_RADIUS: f32 = 0.06;
const BUNDLE_RADIUS: f32 = 1.8;
const DOME_LINE_WIDTH: f32 = 0.014; // Hard line thickness
const NUM_SHELLS: i32 = 2;         // Two hex layers

fn rot2(a: f32) -> mat2x2f {
  let c = cos(a); let s = sin(a);
  return mat2x2f(c, s, -s, c);
}

// ─── Hexagonal Background ───────────────────────────────────
// Clean hex grid using 3 line sets at 60° intervals.
// Projected onto sphere via equirectangular.

fn hexEdges(theta: f32, phi: f32, scale: f32) -> f32 {
  // Three parallel line sets at 0°, 60°, 120° = hexagonal edges
  let lineWidth = 0.018;
  let u1 = theta * scale;
  let u2 = (theta * 0.5 + phi * 0.866) * scale;
  let u3 = (theta * 0.5 - phi * 0.866) * scale;

  let d1 = abs(fract(u1) - 0.5);
  let d2 = abs(fract(u2) - 0.5);
  let d3 = abs(fract(u3) - 0.5);

  // Combine: minimum distance to any edge
  let minD = min(d1, min(d2, d3));

  // Hard edge with soft glow
  let edge = smoothstep(lineWidth, lineWidth * 0.3, minD);
  let glow = exp(-minD * minD * 800.0) * 0.4;
  return edge + glow;
}

// Orbiting glowing orb
fn glowingOrb(rd: vec3f, t: f32) -> vec3f {
  let orbSpeed = t * 0.12;
  let orbX = cos(orbSpeed) * 0.6;
  let orbY = sin(orbSpeed * 0.7) * 0.4;
  let orbZ = sin(orbSpeed) * 0.6;
  let orbDir = normalize(vec3f(orbX, orbY, orbZ));

  let angDist = acos(clamp(dot(normalize(rd), orbDir), -1.0, 1.0));

  let core = exp(-angDist * angDist * 800.0);
  let innerGlow = exp(-angDist * angDist * 80.0) * 0.6;
  let outerHalo = exp(-angDist * angDist * 15.0) * 0.2;
  let streak = exp(-abs(rd.y - orbDir.y) * 40.0) * exp(-angDist * 8.0) * 0.3;

  let brightness = core + innerGlow + outerHalo + streak;
  let orbHue = 0.3 + t * 0.01;
  let orbCol = palette(orbHue) * 1.5 + vec3f(0.3, 0.2, 0.1) * core;

  return orbCol * brightness;
}

// Composite: hex containment structure + orb
fn backgroundLayers(rd: vec3f, t: f32, camXY: vec2f, glow: f32) -> vec3f {
  let dir = normalize(rd);
  var col = vec3f(0.0);

  // Dark background base
  col += vec3f(0.01, 0.005, 0.025);

  // Layer 1: Front hex — GREEN, large cells, slow CW rotation
  let theta1 = atan2(dir.x, dir.z) + t * 0.02 + camXY.x * 0.06;
  let phi1 = asin(clamp(dir.y, -1.0, 1.0));
  let hex1 = hexEdges(theta1, phi1, 2.5);
  let green = vec3f(0.0, 0.6, 0.3);
  col += green * hex1 * (0.15 + glow * 0.2);

  // Layer 2: Back hex — PINK, tilted, slow CCW rotation, dimmer
  let tiltedY = dir.y * cos(0.4) - dir.z * sin(0.4);
  let tiltedZ = dir.y * sin(0.4) + dir.z * cos(0.4);
  let tilted = vec3f(dir.x, tiltedY, tiltedZ);
  let theta2 = atan2(tilted.x, tilted.z) - t * 0.015 + camXY.x * 0.03;
  let phi2 = asin(clamp(tilted.y, -1.0, 1.0));
  let hex2 = hexEdges(theta2, phi2, 3.0);
  let pink = vec3f(0.5, 0.05, 0.3);
  col += pink * hex2 * (0.08 + glow * 0.12);

  // Orbiting orb
  col += glowingOrb(dir, t);

  return col;
}

// Wire path — each wire spirals around the bundle axis
fn wireCenter(wireId: i32, z: f32) -> vec2f {
  let angle = f32(wireId) / f32(NUM_WIRES) * PI * 2.0;
  let twist = z * 0.3 + angle;
  let r = BUNDLE_RADIUS * (0.5 + 0.5 * sin(angle * 2.3 + 1.7));
  return vec2f(cos(twist) * r, sin(twist) * r);
}

// Distance to nearest wire (returns distance, wireId as vec2f)
fn mapWires(p: vec3f) -> vec2f {
  var minDist = 999.0;
  var closestId = 0;
  for (var i = 0; i < NUM_WIRES; i++) {
    let center = wireCenter(i, p.z);
    let d = length(p.xy - center) - WIRE_RADIUS;
    if (d < minDist) {
      minDist = d;
      closestId = i;
    }
  }
  return vec2f(minDist, f32(closestId));
}

// Distance field — all wires + outer shell
fn tmap(p: vec3f) -> f32 {
  let wires = mapWires(p);
  let shell = -(length(p.xy) - BUNDLE_RADIUS * 1.6);
  return min(wires.x, shell);
}

// Normal via central differences
fn getNormal(p: vec3f) -> vec3f {
  let e = 0.002;
  return normalize(vec3f(
    tmap(p + vec3f(e, 0.0, 0.0)) - tmap(p - vec3f(e, 0.0, 0.0)),
    tmap(p + vec3f(0.0, e, 0.0)) - tmap(p - vec3f(0.0, e, 0.0)),
    tmap(p + vec3f(0.0, 0.0, e)) - tmap(p - vec3f(0.0, 0.0, e))
  ));
}

// Light pulse traveling along a wire
// Distinct segments (data packets) with smooth soft edges — not point spots, not uniform glow.
fn wirePulse(wireId: i32, z: f32, pulsePhase: f32, speedMult: f32) -> f32 {
  let phase = f32(wireId) * 2.39996 + f32(wireId * wireId) * 0.7;
  let baseSpeed = 3.0 + f32(wireId % 5) * 1.5;

  // Position driven by accumulated phase (monotonic)
  let wavePos = (z * 0.15 - pulsePhase * baseSpeed * 0.1 + phase) * 0.5;
  let pulseZ = fract(wavePos);

  // Smooth segment: flat bright center with soft ramp edges
  // This creates a distinct "packet" shape — bright in middle, fades at ends
  let segmentWidth = 0.15 + speedMult * 0.1; // wider segments at higher speed
  let segCenter = 0.5;
  let distFromCenter = abs(pulseZ - segCenter);
  let segment = smoothstep(segmentWidth + 0.08, segmentWidth - 0.02, distFromCenter);

  // Second smaller segment (trailing packet)
  let pulseZ2 = fract(wavePos + 0.35);
  let dist2 = abs(pulseZ2 - segCenter);
  let segment2 = smoothstep(segmentWidth * 0.6 + 0.06, segmentWidth * 0.6 - 0.02, dist2) * 0.5;

  // Base dim glow (wire is faintly visible even without a packet)
  let baseGlow = 0.05;

  // Brightness scales with speedMult
  let brightness = 0.5 + speedMult * 2.0;

  return (baseGlow + (segment + segment2) * brightness);
}

// Ambient wire glow
fn wireAmbient(wireId: i32) -> f32 {
  return 0.02 + 0.01 * sin(f32(wireId) * 1.7);
}

fn render(uv: vec2f) -> vec4f {
  let res = u_resolution();
  let aspect = res.x / res.y;
  var p = (uv - 0.5) * 2.0;
  p.x *= aspect;
  p.y = -p.y;

  let t = u_time();

  // ─── Audio-Reactive Params (4 slots, each AR-configurable) ─────
  // p0 = Pulse Glow: brightness of the lit pulse segments
  // p1 = Pulse Speed: how fast light packets travel along wires
  // p2 = Hex Glow: brightness of the hexagonal background fields
  // p3 = Fly Speed: camera travel speed through the tunnel
  let pulseGlow = u_p0();
  let pulseSpeed = u_p1();
  let hexGlow = u_p2();
  let camFlySpeed = u_p3();

  let flySpeed = 0.3 + camFlySpeed * 2.0;
  let glowIntensity = 0.2 + pulseGlow * 2.5;
  let pulseSpeedMult = 0.5 + pulseSpeed * 3.5;

  // Camera flies forward along Z
  let camZ = t * flySpeed;

  // Camera orbits outside the wire bundle — no clipping possible
  let orbitAngle = t * 0.15;
  let orbitR = 2.8;
  let camX = cos(orbitAngle) * orbitR;
  let camY = sin(orbitAngle * 0.7) * orbitR;
  let ro = vec3f(camX, camY, camZ);

  // Look toward bundle center + forward
  let lookAhead = 4.0;
  let la = vec3f(camX * 0.3, camY * 0.3, camZ + lookAhead);

  // Camera matrix
  let forward = normalize(la - ro);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let fov = 1.2;
  let rd = normalize(forward * fov + p.x * right + p.y * up);

  // Slight camera roll
  let rollAngle = sin(t * 0.2) * 0.1 + cos(t * 0.13) * 0.07;
  let rdRolled = vec3f(
    (rot2(rollAngle) * rd.xy).x,
    (rot2(rollAngle) * rd.xy).y,
    rd.z
  );
  let rdFinal = normalize(rdRolled);

  // ─── Raymarch wires ─────────────────────────────────────
  var rayDist = 0.0;
  var col = vec3f(0.0);
  var glow = vec3f(0.0);
  var hit = false;

  for (var i = 0; i < 80; i++) {
    let pos = ro + rdFinal * rayDist;
    let wires = mapWires(pos);
    let d = wires.x;
    let wireId = i32(wires.y);

    // Accumulate volumetric glow near wires (wide, soft, ambient)
    if (d < 1.0) {
      let proximity = exp(-d * d * 12.0); // Wide soft falloff (not sharp points)
      let pulse = wirePulse(wireId, pos.z, u_pulsePhase(), pulseSpeedMult);
      let wireColor = palette(f32(wireId) / f32(NUM_WIRES) + t * 0.02);
      glow += wireColor * pulse * glowIntensity * proximity * 0.025;
    }

    if (d < 0.002) {
      hit = true;
      let pos2 = pos;
      let sn = getNormal(pos2);
      let wInfo = mapWires(pos2);
      let hitWireId = i32(wInfo.y);

      let fresnel = pow(1.0 - abs(dot(sn, -rdFinal)), 2.0);
      let wireCol = palette(f32(hitWireId) / f32(NUM_WIRES) + t * 0.02);
      let pulse = wirePulse(hitWireId, pos2.z, u_pulsePhase(), pulseSpeedMult);

      // Smooth ambient surface — like a neon tube, not point lights
      let surface = wireCol * 0.08; // Always-on base color
      let emission = wireCol * pulse * glowIntensity * 0.4 + fresnel * wireCol * 0.3;

      col = surface + emission;
      break;
    }

    rayDist += max(d * 0.7, 0.01);
    if (rayDist > 50.0) { break; }
  }

  // Add volumetric glow
  col += glow;

  // ─── Layered geometric background (visible through wire gaps) ────
  let bgCol = backgroundLayers(rdFinal, t, vec2f(camX, camY), hexGlow);
  if (!hit) {
    col += bgCol;
  } else {
    col += bgCol * 0.05;
  }

  // Subtle depth fog
  let fogFactor = 1.0 - exp(-rayDist * 0.02);
  let fogColor = palette(0.5 + t * 0.01) * 0.01;
  col = mix(col, fogColor, fogFactor * 0.3);

  // Vignette
  let vignette = 1.0 - length(uv - 0.5) * 0.8;
  col *= vignette;

  let final_col = clamp(col, vec3f(0.0), vec3f(2.0));
  // Per-pixel alpha: brighter areas are opaque, dark areas are transparent
  // This lets the track's background image (starfield, etc.) show through gaps
  let pixelAlpha = clamp(length(final_col) * 1.5, 0.0, 1.0);
  return vec4f(final_col, pixelAlpha);
}
`,
};
