/**
 * Cyclopean City — a raymarched non-Euclidean stone megacity of the Elder Things.
 * Immense dark basalt megaliths flank a titanic gateway receding into depth as
 * the camera drifts slowly forward through the portal. Domain-repeated box SDFs
 * form the monolithic corridor; a sickly glow burns deep within the gate.
 * Palette: abyssal (cold, dread-inducing tint).
 *
 * Audio: u_bass() pulses the inner glow, u_beat() a monumental light-flash,
 * u_energy() overall brightness, u_mid() subtle sway.
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const CYCLOPEAN_CITY_PRESET: ShaderPreset = {
  id: 'cyclopeanCity',
  label: 'Cyclopean City',
  description: 'A slow drift through a titanic stone gateway of alien basalt megaliths',
  palette: 'abyssal',
  params: [
    {
      id: 'approachSpeed',
      label: 'Approach Speed',
      slot: 'p0',
      min: 0.0,
      max: 1.0,
      default: 0.12,
      step: 0.01,
    },
    {
      id: 'structureScale',
      label: 'Structure Scale',
      slot: 'p1',
      min: 0.5,
      max: 4.0,
      default: 1.5,
      step: 0.1,
    },
  ],
  body: /* wgsl */ `
fn rot2(a: f32) -> mat2x2f {
  let c = cos(a); let s = sin(a);
  return mat2x2f(c, s, -s, c);
}

// Signed distance to an axis-aligned box centered at origin.
fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// The gate corridor: two colossal walls of stacked, repeated megaliths flanking
// a central open passage, plus a floor and a receding portal frame.
fn cityMap(pIn: vec3f, scl: f32) -> f32 {
  var p = pIn;

  // Corridor half-width (the clear central passage).
  let halfW = 3.0 * scl;

  // --- Floor ---
  let floorDist = p.y + 4.0 * scl;

  // --- Flanking megalith walls ---
  // Mirror across X so we only author the right-hand wall.
  var q = p;
  q.x = abs(q.x) - halfW;

  // Domain repetition along Z (depth) and Y (height) to stack blocks.
  let cellZ = 6.0 * scl;
  let cellY = 5.0 * scl;
  var r = q;
  r.z = r.z - cellZ * floor(r.z / cellZ) - cellZ * 0.5;
  r.y = r.y - cellY * floor((r.y + 4.0 * scl) / cellY) - cellY * 0.5 + 4.0 * scl;

  // Per-cell pseudo-random jitter so the stones read as irregular masonry.
  let cellId = vec2f(floor(p.z / cellZ), floor((p.y + 4.0 * scl) / cellY));
  let jit = hash22(cellId) - 0.5;
  let block = sdBox(
    r - vec3f(jit.x * 0.6 * scl, 0.0, jit.y * 0.8 * scl),
    vec3f(2.2 * scl, cellY * 0.46, cellZ * 0.44)
  );

  // --- Titanic gateway lintel arching over the passage far ahead ---
  // A massive horizontal slab spanning the two walls, high above the floor.
  var g = p;
  g.y = g.y - 5.5 * scl;
  let lintel = sdBox(g, vec3f(halfW + 3.0 * scl, 1.4 * scl, 400.0));

  // Union everything (stone is the max of nothing; take nearest surface).
  var d = min(floorDist, block);
  d = min(d, lintel);
  return d;
}

fn cityNormal(p: vec3f, scl: f32) -> vec3f {
  let e = 0.002;
  return normalize(vec3f(
    cityMap(p + vec3f(e, 0.0, 0.0), scl) - cityMap(p - vec3f(e, 0.0, 0.0), scl),
    cityMap(p + vec3f(0.0, e, 0.0), scl) - cityMap(p - vec3f(0.0, e, 0.0), scl),
    cityMap(p + vec3f(0.0, 0.0, e), scl) - cityMap(p - vec3f(0.0, 0.0, e), scl)
  ));
}

fn render(uv: vec2f) -> vec4f {
  let res = u_resolution();
  let aspect = res.x / res.y;
  var pp = (uv - 0.5) * 2.0;
  pp.x *= aspect;
  pp.y = -pp.y;

  let t = u_time();
  let beat = u_beat();
  let bass = u_bass();
  let mid = u_mid();
  let energy = u_energy();

  let scl = u_p1();

  // Slow forward drift; beat/bass give the faintest surge.
  let spd = u_p0() * 4.0 + beat * 0.4 + bass * 0.2;
  let camZ = t * spd;

  // Mid -> subtle sway of the whole view.
  let swayX = sin(t * 0.4) * mid * 0.3;
  let swayY = cos(t * 0.31) * mid * 0.15;
  let ro = vec3f(swayX, swayY, camZ);

  // Look straight down the corridor into the gate.
  let forward = vec3f(0.0, 0.0, 1.0);
  let right = vec3f(1.0, 0.0, 0.0);
  let up = vec3f(0.0, 1.0, 0.0);
  let fov = 3.14159 / 3.0;
  var rd = normalize(forward + fov * pp.x * right + fov * pp.y * up);

  // A slow roll for unease.
  let roll = sin(t * 0.13) * 0.05 + mid * 0.03;
  let rollXY = rot2(roll) * rd.xy;
  rd = vec3f(rollXY.x, rollXY.y, rd.z);

  // Raymarch with overstepping.
  var dist = 0.0;
  var dt = 0.0;
  var hit = false;
  for (var i = 0; i < 96; i++) {
    let sp = ro + rd * dist;
    dt = cityMap(sp, scl);
    if (dt < 0.01) { hit = true; break; }
    if (dist > 220.0) { break; }
    dist += dt * 0.8;
  }

  // Deep inner glow position: far down the corridor, on the passage axis.
  let glowDepth = camZ + 90.0;
  let glowPos = vec3f(0.0, 0.0, glowDepth);

  var col = vec3f(0.0);

  if (hit) {
    let sp = ro + rd * dist;
    let sn = cityNormal(sp, scl);

    // Key light comes from deep within the gate (the sickly glow).
    let ld = glowPos - sp;
    let ldist = max(length(ld), 0.001);
    let ldn = ld / ldist;
    let diff = max(dot(sn, ldn), 0.0);

    // Stone base tint from palette (abyssal); vary by height + noise.
    let stoneTint = palette(0.15 + sp.y * 0.01 + noise2d(sp.xz * 0.2) * 0.1);
    let stone = mix(vec3f(0.04, 0.05, 0.07), stoneTint * 0.5, 0.6);

    // Ambient + directional; distance attenuation from the far glow.
    let atten = 1.0 / (1.0 + ldist * ldist * 0.0006);
    let ambient = 0.04 + energy * 0.06;
    col = stone * (ambient + diff * 0.9 * atten);

    // Rim light on edges facing the camera for monolithic definition.
    let rim = pow(clamp(1.0 + dot(sn, rd), 0.0, 1.0), 2.0);
    col += palette(0.55) * rim * (0.06 + bass * 0.12);
  } else {
    // Sky / void behind: near-black with a faint cold gradient.
    let voidCol = palette(0.75) * 0.02 * (1.0 - clamp(uv.y, 0.0, 1.0));
    col = voidCol;
  }

  // --- The sickly inner glow, visible down the open passage regardless of hit ---
  // Project the glow as a soft bloom around the corridor vanishing point.
  let glowDir = normalize(glowPos - ro);
  let align = max(dot(rd, glowDir), 0.0);
  let glowFall = pow(align, 40.0);
  let glowPulse = 0.4 + bass * 0.9 + beat * 0.6;
  let glowCol = palette(0.05 + bass * 0.1) * (glowFall * glowPulse);
  col += glowCol;

  // Monumental beat flash washing the stone.
  col += palette(0.5) * beat * 0.15;

  // Distance fog toward the void.
  let fog = 1.0 - exp(-dist * 0.006);
  let fogCol = palette(0.7) * 0.03;
  col = mix(col, fogCol, fog * 0.85);

  // Overall energy brightness.
  col *= 0.8 + energy * 0.5;

  let final_col = clamp(col, vec3f(0.0), vec3f(1.0));
  return vec4f(final_col, 1.0);
}
`,
};
