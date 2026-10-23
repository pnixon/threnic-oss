/**
 * The Shoggoth — a churning black protoplasmic mass for a symphonic-metal opera
 * of "At the Mountains of Madness" (MOTIF IV Shoggoth/Slave, MOTIF V "Tekeli-li",
 * "Le Shoggoth / La Fuite", "La Folie de Danforth"). Organic metaball blobs merge
 * and split over a slick iridescent surface with an oily rainbow sheen; eyes and
 * bubbles form and dissolve in viscous, heaving motion. A doom-slow underlying
 * pulse (bass swell) with violent "Tekeli-li" jitter/glitch on treble.
 * Palette: elder-green (defined in index.ts).
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const SHOGGOTH_PRESET: ShaderPreset = {
  id: 'shoggoth',
  label: 'The Shoggoth',
  description:
    'A churning black protoplasmic mass with an oily iridescent sheen — heaving bubbles and eyes that form and dissolve, jittering violently on the Tekeli-li cry',
  palette: 'elder-green',
  params: [
    {
      id: 'churnSpeed',
      label: 'Churn Speed',
      slot: 'p0',
      min: 0.0,
      max: 1.0,
      default: 0.25,
      step: 0.01,
    },
    {
      id: 'blobScale',
      label: 'Blob Scale',
      slot: 'p1',
      min: 1.0,
      max: 8.0,
      default: 3.0,
      step: 0.5,
    },
  ],
  body: /* wgsl */ `
// ─── The Shoggoth — churning protoplasmic metaball mass ─────────────────────

// A single orbiting metaball's field contribution (1 / r^2 falloff).
fn blobField(p: vec2f, centre: vec2f, radius: f32) -> f32 {
  let d = p - centre;
  let r2 = dot(d, d) + 0.0008;
  return (radius * radius) / r2;
}

// Sum of several orbiting metaballs -> a heaving scalar field.
fn metaMass(p: vec2f, t: f32, churn: f32, swell: f32) -> f32 {
  var field = 0.0;

  // Each blob orbits on its own slow ellipse; the whole cluster breathes with
  // the bass swell (radius grows/shrinks). Doom-slow base rate.
  let n = 6;
  for (var i = 0; i < n; i++) {
    let fi = f32(i);
    let seed = fi * 1.618 + 0.37;

    // Orbit phase — slow, per-blob offset so they merge and split organically.
    let ph = t * (0.35 + churn * 1.6) + seed * 6.2831853;
    let ax = 0.55 + 0.25 * sin(seed * 2.1);
    let ay = 0.40 + 0.25 * cos(seed * 1.7);

    let centre = vec2f(
      sin(ph * (0.5 + seed * 0.11)) * ax + cos(ph * 0.31 + seed) * 0.12,
      cos(ph * (0.4 + seed * 0.09)) * ay + sin(ph * 0.27 + seed) * 0.12
    );

    // Radius heaves with the bass swell + a slow per-blob pulse.
    let radius = 0.34 + 0.10 * sin(t * 0.6 + seed * 3.0) + swell * 0.14;
    field += blobField(p, centre, radius);
  }

  return field;
}

fn render(uv: vec2f) -> vec4f {
  let res = u_resolution();
  let aspect = res.x / res.y;

  let t = u_time();
  let churn = u_p0();          // churn speed (0..1)
  let scale = u_p1();          // blob scale / count feel (1..8)

  let bass = u_bass();
  let mid = u_mid();
  let treb = u_treb();
  let beat = u_beat();
  let energy = u_energy();

  // ── Doom-slow heaving swell from bass ──
  let swell = bass * (0.7 + 0.3 * sin(t * 0.35));

  // ── "Tekeli-li" JITTER: treble kicks a violent hashed offset + glitch ──
  // Time-quantized jitter cells give a stuttering, glitchy displacement.
  let jitterTime = floor(t * 30.0);
  let jseed = hash21(uv * 13.0 + vec2f(jitterTime, jitterTime * 1.7));
  let jseed2 = hash21(uv.yx * 17.0 - vec2f(jitterTime * 2.3, jitterTime));
  let jitterAmt = treb * treb * 0.08;
  let jitter = (vec2f(jseed, jseed2) - 0.5) * jitterAmt;

  // Centred, aspect-corrected coordinates, scaled by blob feel + jitter.
  var p = (uv - 0.5) * vec2f(aspect, 1.0) * scale + jitter;

  // ── Protoplasmic churn via fbm domain warp ──
  let warpT = t * (0.15 + churn * 0.6);
  let warp = vec2f(
    fbm(p * 1.3 + vec2f(warpT, -warpT * 0.6), 4),
    fbm(p * 1.3 + vec2f(-warpT * 0.7, warpT), 4)
  );
  let pw = p + (warp - 0.5) * (0.9 + swell * 0.6);

  // ── Metaball field -> heaving mass ──
  let field = metaMass(pw, t, churn, swell);

  // Threshold the field into a slick surface. Higher threshold = tighter blobs.
  let surface = smoothstep(1.4, 2.6, field);

  // Surface gradient (finite differences) -> pseudo-normal for the sheen.
  let e = 0.012;
  let fx = metaMass(pw + vec2f(e, 0.0), t, churn, swell)
         - metaMass(pw - vec2f(e, 0.0), t, churn, swell);
  let fy = metaMass(pw + vec2f(0.0, e), t, churn, swell)
         - metaMass(pw - vec2f(0.0, e), t, churn, swell);
  let grad = vec2f(fx, fy);
  let normal = normalize(vec3f(grad * 0.5, 1.0));

  // ── Iridescent oily sheen: gradient direction + view drives a rainbow t ──
  // The palette hue sweeps with the surface normal; treble glitches the offset.
  let viewDir = normalize(vec3f(0.0, 0.0, 1.0));
  let fresnel = pow(1.0 - clamp(normal.z, 0.0, 1.0), 2.5);
  let sheenT = fract(normal.x * 0.5 + normal.y * 0.35
             + length(grad) * 0.15
             + t * 0.05
             + treb * 0.4 * step(0.5, jseed)); // glitched hue jump on treble

  // Base protoplasm is near-black with a faint elder-green core glow.
  let core = palette(0.15) * 0.10 * surface;
  let sheen = palette(sheenT) * fresnel * (0.6 + mid * 0.8 + energy * 0.4) * surface;

  var col = core + sheen;

  // ── Bubbles: small high-frequency hashed spots that pulse & burst on beat ──
  let bubbleP = pw * 6.0;
  let cell = floor(bubbleP);
  let f = fract(bubbleP);
  let brnd = hash21(cell);
  let present = step(0.86, brnd);
  let bpos = hash22(cell);
  let bd = distance(f, bpos);
  // Each bubble pulses on its own phase; beat triggers a synchronized burst.
  let bphase = hash21(cell + vec2f(5.0, 9.0)) * 6.2831853;
  let bpulse = 0.5 + 0.5 * sin(t * 3.0 + bphase);
  let burst = beat * 0.6;
  let bubbleR = 0.05 + bpulse * 0.05 + burst * 0.04;
  let bubble = smoothstep(bubbleR, 0.0, bd) * present * surface;
  // Bubbles catch a bright iridescent highlight.
  col += palette(fract(sheenT + 0.5)) * bubble * (0.5 + treb * 0.6);

  // ── Eyes: rarer, larger dark voids with a bright rim that form & dissolve ──
  let eyeP = pw * 2.2;
  let ecell = floor(eyeP);
  let ef = fract(eyeP);
  let ernd = hash21(ecell + vec2f(21.0, 3.0));
  let ePresent = step(0.90, ernd);
  // Slow form/dissolve life cycle per eye.
  let elife = 0.5 + 0.5 * sin(t * 0.5 + ernd * 6.2831853);
  let epos = hash22(ecell + vec2f(11.0, 29.0));
  let ed = distance(ef, epos);
  let pupil = smoothstep(0.16, 0.10, ed) * ePresent * elife * surface;
  let iris = smoothstep(0.22, 0.16, ed) * ePresent * elife * surface;
  // Dark pupil punched out, bright elder-green iris rim around it.
  col = mix(col, vec3f(0.0), pupil * 0.9);
  col += palette(0.3) * (iris - pupil) * (0.8 + energy * 0.5);

  // ── Wet vignette / ambient so the mass reads as slick and dark ──
  let vig = 1.0 - smoothstep(0.5, 1.1, length((uv - 0.5) * vec2f(aspect, 1.0)));
  col *= 0.75 + 0.25 * vig;

  // ── Overall doom pulse + Tekeli-li glitch flash ──
  let doom = 0.9 + swell * 0.4 + beat * 0.15;
  let glitchFlash = treb * treb * step(0.7, jseed2) * 0.35;
  col = col * doom + palette(fract(t * 0.1 + 0.6)) * glitchFlash;

  return vec4f(col, 1.0);
}
`,
};
