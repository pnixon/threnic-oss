/**
 * Built-in presets — written in the equation language, compiled to IR, then
 * emitted as both JS (per-frame, CPU) and WGSL (per-vertex, GPU).
 *
 * These are original compositions. They are original compositions that
 * exploit this engine's advantages over Milkdrop:
 *
 * - 256×256 warp mesh (vs 48×36), so per-vertex displacements are smooth
 * - Per-vertex equations run on the GPU, so density is free
 * - HDR feedback chain (rgba16float) — no 8-bit banding across decay
 * - Audio-reactive zoom_exp for distance-dependent intensity
 * - 32 q-vars for rich per-frame → per-vertex communication
 * - Deterministic seeded randomness for reproducible frame sequences
 *
 * Design philosophy: each preset has a distinct visual character with audio
 * response that feels physically connected to the music. Bass drives large
 * structural motion (zoom, warp), mid fills the midground (rotation, colour),
 * and treble adds sparkle (high-frequency vertex displacement, echo).
 */

import type { MilkdropPreset } from './MilkdropChain';

// ---------------------------------------------------------------------------
// 1. CLASSIC TUNNEL — the canonical Milkdrop look, refined
// ---------------------------------------------------------------------------

export const VIZ_TUNNEL: MilkdropPreset = {
  id: 'viz-tunnel',
  label: 'Tunnel',
  base: { decay: 0.955, warp: 0.8 },
  meshCols: 128,
  meshRows: 96,
  waves: [{ samples: 128, instances: 2, thickness: 2.0, additive: true }],
  drawShader: `
    let uv = in.uv;
    let p = md_centered(uv);
    let r = length(p);
    let t = md_time();
    let bass = md_bass();

    // Concentric rings radiating from center, spacing modulated by bass
    let ring_freq = 20.0 + bass * 30.0;
    let ring_phase = r * ring_freq - t * 4.0;
    let ring = pow(abs(sin(ring_phase * MD_PI)), 16.0);

    // Radial falloff so edges are dimmer
    let falloff = exp(-r * 2.5);
    let brightness = ring * falloff;

    // Deep blue/cyan palette
    let col = vec3f(
      brightness * 0.15,
      brightness * 0.5 + brightness * brightness * 0.3,
      brightness * 0.9 + brightness * brightness * 0.1
    );

    return md_guard(vec4f(col, 1.0));
  `,
  perFrame: `
    q1 = 2 + bass * 4;
    q2 = beat_counter;

    // Bass drives zoom HARD — you should SEE the tunnel pulse
    zoom = 1.01 + 0.08 * bass + 0.04 * beat;
    rot = 0.015 * sin(time * 0.31) + 0.04 * mid;
    warp = 0.4 + 1.5 * treb;
    warp_speed = 0.6 + 0.8 * vol;
    decay = 0.94 + 0.04 * (1 - bass);
    echo_alpha = 0.08 + 0.20 * beat;
    echo_zoom = 1.03 + 0.04 * bass;
  `,
  perVertex: `
    amp = 0.025 * bass;
    x = x + amp * sin(rad * 14 - time * 2.1);
    y = y + amp * cos(rad * 14 - time * 2.1);
  `,
};

// ---------------------------------------------------------------------------
// 2. BEAT BLOOM — explosive zoom on each beat, trails collapse between
// ---------------------------------------------------------------------------

export const VIZ_BEAT_BLOOM: MilkdropPreset = {
  id: 'viz-beat-bloom',
  label: 'Beat Bloom',
  base: { decay: 0.93, zoomexp: 1.4 },
  meshCols: 128,
  meshRows: 96,
  shapes: [{ sides: 6, instances: 4, filled: true, additive: true }],
  drawShader: `
    let uv = in.uv;
    let p = md_centered(uv);
    let r = length(p);
    let ang = atan2(p.y, p.x);
    let t = md_time();
    let beat = md_beat();
    let num_rays = max(6.0, md_q1() * 4.0);

    // Radial starburst lines
    let ray_pattern = pow(abs(cos(ang * num_rays + t * 0.5)), 8.0);
    let radial_falloff = exp(-r * 3.0) * (1.0 / (r + 0.05));

    // Beats make rays much brighter
    let intensity = ray_pattern * radial_falloff * (0.3 + beat * 2.5);

    // Hot white/yellow with orange trails
    let col = vec3f(
      min(intensity * 1.0, 1.0),
      intensity * 0.85 + intensity * intensity * 0.1,
      intensity * 0.3 * (1.0 - beat * 0.5)
    );

    return md_guard(vec4f(col, 1.0));
  `,
  perFrame: `
    // Pulse accumulates on beat then decays — capped at 1.0
    hit = above(beat, 0.3);
    pulse = min(pulse * 0.82 + hit * 0.5, 1.0);
    q1 = 1 + 3 * pulse;
    q2 = pulse;

    // DRAMATIC zoom on beats: zooms OUT on hit, slowly zooms IN between
    zoom = 0.98 + 0.06 * pulse;
    zoomexp = 1.0 + 1.0 * bass_att;
    rot = 0.06 * pulse * sign(sin(beat_counter * 1.5));
    warp = 0.8 + 2.0 * vol;
    sx = 1 + 0.05 * pulse;
    sy = 1 - 0.04 * pulse;
    decay = 0.90 + 0.06 * (1 - pulse);
  `,
  perVertex: `
    swirl = 0.04 * q2 * (1 - rad);
    x = x + swirl * y;
    y = y - swirl * x;
  `,
};

// ---------------------------------------------------------------------------
// 3. FRACTAL DESCENT — recursive zoom with distance-dependent warping
// ---------------------------------------------------------------------------

const VIZ_FRACTAL_DESCENT: MilkdropPreset = {
  id: 'viz-fractal-descent',
  label: 'Fractal Descent',
  base: { decay: 0.975, zoomexp: 2.0, warp: 1.2 },
  meshCols: 192,
  meshRows: 128,
  drawShader: `
    let uv = in.uv;
    let p = md_centered(uv);
    let t = md_time();

    // Multi-scale checkerboard Moiré interference
    let s1 = 8.0;
    let s2 = 13.0;
    let s3 = 21.0;
    let drift = t * 0.3;

    let c1 = sin((p.x * s1 + drift) * MD_PI) * sin((p.y * s1 - drift * 0.7) * MD_PI);
    let c2 = sin((p.x * s2 - drift * 1.3) * MD_PI) * sin((p.y * s2 + drift * 0.9) * MD_PI);
    let c3 = sin((p.x * s3 + drift * 0.5) * MD_PI) * sin((p.y * s3 - drift * 1.1) * MD_PI);

    // Combine scales with rotation for fractal-like interference
    let rot_x = p.x * cos(t * 0.1) - p.y * sin(t * 0.1);
    let rot_y = p.x * sin(t * 0.1) + p.y * cos(t * 0.1);
    let c4 = sin((rot_x * s2) * MD_PI) * sin((rot_y * s1) * MD_PI);

    let pattern = (c1 * 0.4 + c2 * 0.3 + c3 * 0.2 + c4 * 0.3) * 0.5 + 0.5;
    let brightness = pattern * pattern * 0.6;

    // Purple/magenta/dark palette
    let col = vec3f(
      brightness * 0.7 + brightness * brightness * 0.3,
      brightness * 0.15,
      brightness * 0.9
    );

    return md_guard(vec4f(col, 1.0));
  `,
  perFrame: `
    // Accumulate a slowly drifting centre to give the zoom a sense of
    // travelling through an infinite structure rather than collapsing inward.
    drift_x = drift_x + 0.0003 * sin(time * 0.47);
    drift_y = drift_y + 0.0003 * cos(time * 0.31);
    cx = 0.5 + drift_x + 0.02 * mid_att * sin(time * 0.8);
    cy = 0.5 + drift_y + 0.02 * mid_att * cos(time * 0.6);

    zoom = 1.018 + 0.015 * bass_att;
    zoomexp = 1.8 + 0.5 * treb_att;
    rot = 0.005 * sin(time * 0.23) + 0.008 * mid;
    warp = 1.0 + 0.6 * bass_att;
    warp_speed = 0.5 + 0.3 * vol_att;
    decay = 0.970 + 0.020 * (1 - bass);

    q1 = bass_att;
    q2 = treb_att;
    q3 = mid_att;
    q4 = time;

    echo_alpha = 0.08 + 0.10 * treb_att;
    echo_zoom = 0.96 + 0.02 * sin(time * 0.11);
  `,
  perVertex: `
    // Distance-dependent ripple — high mesh density makes this silky smooth.
    phase = q4 * 1.5 + rad * 20;
    ripple = 0.008 * q1 * sin(phase) * (1 - rad * 0.5);
    x = x + ripple * cos(ang);
    y = y + ripple * sin(ang);
  `,
};

// ---------------------------------------------------------------------------
// 4. SPIRAL GALAXY — logarithmic spiral arms driven by rotation + echo
// ---------------------------------------------------------------------------

const VIZ_SPIRAL_GALAXY: MilkdropPreset = {
  id: 'viz-spiral-galaxy',
  label: 'Spiral Galaxy',
  base: { decay: 0.97, rot: 0.03, warp: 0.4 },
  meshCols: 192,
  meshRows: 128,
  waves: [{ samples: 64, instances: 3, thickness: 1.0, additive: true }],
  drawShader: `
    let uv = in.uv;
    let p = md_centered(uv);
    let r = length(p);
    let ang = atan2(p.y, p.x);
    let t = md_time();

    // Logarithmic spiral: angle offset = k * ln(r)
    let k = 2.5;
    let spiral_phase = ang - k * log(r + 0.001) + t * 0.4;

    // 3 arms with tight concentration
    let arms = 3.0;
    let arm_val = pow(max(cos(spiral_phase * arms), 0.0), 12.0);

    // Radial brightness profile: bright in mid-range, dark at center and edge
    let radial = smoothstep(0.0, 0.15, r) * exp(-r * 3.5);
    var brightness = arm_val * radial;

    // Add subtle core glow
    let core = exp(-r * 20.0) * 0.4;
    brightness = brightness + core;

    // Warm gold/amber palette
    let col = vec3f(
      brightness * 1.0,
      brightness * 0.72 + core * 0.5,
      brightness * 0.2 + core * 0.3
    );

    return md_guard(vec4f(col, 1.0));
  `,
  perFrame: `
    // Slow rotation that reverses direction every 8 beats for interest.
    dir = if(fmod(beat_counter, 16) < 8, 1, 0 - 1);
    rot = 0.025 * dir + 0.015 * mid_att * dir;
    zoom = 1.005 + 0.008 * bass_att;
    decay = 0.982 + 0.012 * (1 - vol);
    warp = 0.3 + 0.4 * treb_att;
    warp_speed = 0.35;

    // Echo creates the trailing arm structure.
    echo_alpha = 0.25 + 0.15 * bass_att;
    echo_zoom = 1.03;
    echo_orient = fmod(floor(beat_counter / 4), 4);

    q1 = dir;
    q2 = bass_att;
    q3 = time;
    q4 = mid_att;
  `,
  perVertex: `
    // Logarithmic spiral displacement — arms emerge from the rotation + this.
    spiral = 0.015 * q2 * sin(ang * 3 + rad * 8 - q3 * q1 * 2);
    x = x + spiral * (1 - rad);
    y = y + spiral * cos(ang * 2 + q3) * (1 - rad);
  `,
};

// ---------------------------------------------------------------------------
// 5. NEON REACTOR — heavy bass-driven warp with stretching pulse
// ---------------------------------------------------------------------------

const VIZ_NEON_REACTOR: MilkdropPreset = {
  id: 'viz-neon-reactor',
  label: 'Neon Reactor',
  base: { decay: 0.935, warp: 2.0, sx: 1.0, sy: 1.0 },
  meshCols: 128,
  meshRows: 96,
  shapes: [
    { sides: 3, instances: 6, filled: true, additive: true },
    { sides: 32, instances: 2, filled: false, additive: true },
  ],
  drawShader: `
    let uv = in.uv;
    let p = md_centered(uv);
    let t = md_time();
    let bass = md_bass();

    // Hexagonal grid via triangular coordinate system
    let scale = 6.0;
    let gx = p.x * scale;
    let gy = p.y * scale;

    // Convert to hex coords
    let hex_x = gx - gy * 0.5773502692;
    let hex_y = gy * 1.1547005384;

    // Nearest hex center
    let hx = floor(hex_x + 0.5);
    let hy = floor(hex_y + 0.5);

    // Distance to nearest hex center (approximate with Euclidean)
    let fx = hex_x - hx;
    let fy = hex_y - hy;
    let d = sqrt(fx * fx + fy * fy);

    // Glowing nodes at intersections
    let node_glow = exp(-d * 8.0);

    // Hex edge lines
    let edge = smoothstep(0.38, 0.42, d) * smoothstep(0.55, 0.48, d);

    // Bass makes nodes pulse bright
    let pulse = node_glow * (0.5 + bass * 2.0);
    var brightness = pulse + edge * 0.3;

    // Seed-based flicker per node
    let seed = md_rand(hx * 73.0 + hy * 137.0 + floor(t * 2.0));
    brightness = brightness * (0.7 + seed * 0.3);

    // Electric green/cyan/white palette
    let col = vec3f(
      brightness * 0.3 + brightness * brightness,
      brightness * 0.95,
      brightness * 0.7 + brightness * brightness * 0.3
    );

    return md_guard(vec4f(col, 1.0));
  `,
  perFrame: `
    // MAXIMUM bass reactivity — this should POUND
    power = min(bass * 2.0 + beat * 3.0, 3.0);

    zoom = 0.98 + 0.08 * power;
    warp = 1.0 + 3.0 * power;
    warp_speed = 0.8 + 1.5 * treb;
    rot = 0.05 * mid * sin(time * 0.7);
    decay = 0.90 + 0.06 * (1 - power * 0.3);

    sx = 1 + 0.08 * power * sin(time * 2.3);
    sy = 1 + 0.08 * power * cos(time * 2.3);
    q1 = power;
    q2 = treb;
    q3 = time;
  `,
  perVertex: `
    push = 0.04 * q1 * rad;
    x = x + push * cos(ang + q3 * 0.5);
    y = y + push * sin(ang + q3 * 0.5);
    shimmer = 0.01 * q2 * sin(ang * 12 + q3 * 4);
    x = x + shimmer * rad * rad;
    y = y + shimmer * rad * rad;
  `,
};

// ---------------------------------------------------------------------------
// 6. ACID RAIN — rapid high-warp + high-decay, treble-driven rotation
// ---------------------------------------------------------------------------

const VIZ_ACID_RAIN: MilkdropPreset = {
  id: 'viz-acid-rain',
  label: 'Acid Rain',
  base: { decay: 0.97, warp: 3.0, warp_speed: 2.0 },
  meshCols: 256,
  meshRows: 192,
  perFrame: `
    zoom = 1.001 + 0.003 * bass_att;
    warp = 2.5 + 2.0 * vol_att;
    warp_speed = 1.5 + 1.0 * treb_att;
    rot = 0.04 * treb_att * sin(time * 1.1) + 0.01 * cos(time * 0.37);
    decay = 0.988 + 0.008 * (1 - bass);

    // Centre slowly orbits for variety.
    cx = 0.5 + 0.05 * sin(time * 0.19);
    cy = 0.5 + 0.05 * cos(time * 0.23);

    // Echo adds depth to the streaking.
    echo_alpha = 0.12;
    echo_zoom = 0.98;

    q1 = vol_att;
    q2 = treb;
    q3 = time;
    q4 = bass_att;
  `,
  perVertex: `
    // Downward streaking effect (different x and y behaviour).
    fall = 0.006 * q4 * (1 + rad);
    x = x + 0.003 * q2 * sin(ang * 7 + q3 * 3);
    y = y + fall + 0.004 * q1 * cos(ang * 5 + q3 * 2);
  `,
};

// ---------------------------------------------------------------------------
// 7. SOLAR FLARE — explosive zoom-out on beats, slow decay between
// ---------------------------------------------------------------------------

const VIZ_SOLAR_FLARE: MilkdropPreset = {
  id: 'viz-solar-flare',
  label: 'Solar Flare',
  base: { decay: 0.97, zoomexp: 1.8 },
  meshCols: 128,
  meshRows: 96,
  perFrame: `
    // Heat accumulates with beats and dissipates slowly.
    heat = heat * 0.92 + beat * 1.5 + bass * 0.2;
    q1 = heat;
    q2 = time;
    q3 = bass_att;

    // Zoom OUT on beats (< 1 = outward), zoom in slowly between.
    zoom = 1.008 - 0.04 * heat;
    zoom = max(zoom, 0.96);
    zoomexp = 1.5 + 0.8 * heat;
    rot = 0.005 + 0.015 * mid_att;
    warp = 0.5 + 1.0 * heat;
    decay = 0.965 + 0.025 * (1 - heat * 0.5);
  `,
  perVertex: `
    // Eruption rays: radial displacement that grows with heat.
    ray = 0.02 * q1 * sin(ang * 6 + q2 * 1.5) * rad;
    x = x + ray * cos(ang);
    y = y + ray * sin(ang);
  `,
};

// ---------------------------------------------------------------------------
// 8. CRYSTAL CAVE — slow, meditative, high-detail warp with inversions
// ---------------------------------------------------------------------------

const VIZ_CRYSTAL_CAVE: MilkdropPreset = {
  id: 'viz-crystal-cave',
  label: 'Crystal Cave',
  base: { decay: 0.975, warp: 1.5, warp_speed: 0.3 },
  meshCols: 256,
  meshRows: 192,
  perFrame: `
    zoom = 1.004 + 0.002 * bass_att;
    warp = 1.2 + 0.5 * mid_att;
    warp_speed = 0.25 + 0.15 * vol_att;
    rot = 0.003 * sin(time * 0.17) + 0.002 * cos(time * 0.41);
    decay = 0.970 + 0.015 * (1 - vol * 0.3);
    cycle = sin(time * 0.09);
    // Slow echo rotation for depth illusion.
    echo_alpha = 0.15 + 0.05 * mid_att;
    echo_zoom = 1.01;
    echo_orient = fmod(floor(time * 0.1), 4);

    q1 = bass_att;
    q2 = time;
    q3 = treb_att;
  `,
  perVertex: `
    // Multi-scale crystalline faceting — high mesh density makes this sharp.
    facet = 0.004 * q1 * sin(ang * 8 + q2 * 0.4) * cos(rad * 12 - q2 * 0.3);
    x = x + facet;
    y = y + facet * cos(ang * 3 + q2 * 0.2);
    // Outer sparkle driven by treble.
    spark = 0.002 * q3 * sin(ang * 20 + q2 * 6) * rad * rad;
    x = x + spark;
  `,
};

// ---------------------------------------------------------------------------
// 9. HEARTBEAT — breathing stretch sync'd to the beat rhythm
// ---------------------------------------------------------------------------

const VIZ_HEARTBEAT: MilkdropPreset = {
  id: 'viz-heartbeat',
  label: 'Heartbeat',
  base: { decay: 0.96, warp: 0.6 },
  meshCols: 128,
  meshRows: 96,
  perFrame: `
    // Simulate a cardiac rhythm: double-pulse on each beat.
    t_since = time - last_beat_time;
    last_beat_time = if(beat > 0.5, time, last_beat_time);
    
    // Double pulse envelope: quick hit at 0, secondary at 0.15s.
    env1 = max(0, 1 - t_since * 8);
    env2 = max(0, 1 - abs(t_since - 0.15) * 10);
    pulse = env1 * 0.7 + env2 * 0.4;
    q1 = pulse;
    q2 = time;

    // Breathing: sx/sy oscillate in antiphase, driven by the pulse.
    sx = 1 + 0.04 * pulse;
    sy = 1 - 0.03 * pulse;
    zoom = 1.005 + 0.01 * pulse;
    rot = 0.005 * mid_att * sin(time * 0.5);
    warp = 0.4 + 0.4 * pulse;
    decay = 0.955 + 0.030 * (1 - pulse);

    echo_alpha = 0.06 + 0.08 * pulse;
    echo_zoom = 1.01;
  `,
  perVertex: `
    // Radial pump: vertices push outward on the heartbeat.
    push = 0.015 * q1 * (1 - rad * 0.5);
    x = x + push * cos(ang);
    y = y + push * sin(ang);
  `,
};

// ---------------------------------------------------------------------------
// 10. WORMHOLE — extreme zoom_exp for tunnel depth, echo for parallax
// ---------------------------------------------------------------------------

const VIZ_WORMHOLE: MilkdropPreset = {
  id: 'viz-wormhole',
  label: 'Wormhole',
  base: { decay: 0.97, zoomexp: 3.5, zoom: 1.02 },
  meshCols: 192,
  meshRows: 128,
  drawShader: `
    let uv = in.uv;
    let p = md_centered(uv);
    let t = md_time();
    let bass = md_bass_att();
    var col = vec3f(0.0);
    // Nested rotating squares shrinking toward center
    for (var i = 0; i < 12; i += 1) {
      let fi = f32(i);
      let scale = 1.0 - fi * 0.075;
      let angle = t * (0.4 + fi * 0.15) + fi * 0.5236;
      let ca = cos(angle);
      let sa = sin(angle);
      let rp = vec2f(p.x * ca - p.y * sa, p.x * sa + p.y * ca) / scale;
      // Diamond/square SDF: max(|x|, |y|)
      let d = max(abs(rp.x), abs(rp.y));
      let size = 0.3 + 0.05 * bass;
      let edge = smoothstep(size + 0.008, size, d) - smoothstep(size - 0.008, size - 0.016, d);
      let bright = edge * (1.0 - fi * 0.06);
      // Electric blue/white gradient per ring
      let blend = fi / 12.0;
      let ringCol = mix(vec3f(0.3, 0.6, 1.0), vec3f(1.0, 1.0, 1.0), blend);
      col += ringCol * bright;
    }
    col *= 1.0 + 0.5 * bass;
    return md_guard(vec4f(col, 1.0));
  `,
  perFrame: `
    // High zoom_exp = massive difference between centre and edge zoom.
    // This creates the infinite-tunnel depth that defines the wormhole.
    zoomexp = 3.0 + 1.5 * bass_att;
    zoom = 1.015 + 0.010 * bass_att;
    rot = 0.02 + 0.015 * mid_att;
    warp = 0.8 + 0.6 * treb_att;
    warp_speed = 0.6 + 0.3 * vol_att;
    decay = 0.968 + 0.020 * (1 - bass * 0.5);

    // Wobbling centre creates the sensation of the tunnel bending.
    cx = 0.5 + 0.03 * sin(time * 0.41) + 0.01 * mid_att * cos(time * 1.3);
    cy = 0.5 + 0.03 * cos(time * 0.37) + 0.01 * mid_att * sin(time * 1.1);

    // Echo parallax: a slightly offset copy at a different zoom.
    echo_alpha = 0.18 + 0.10 * treb_att;
    echo_zoom = 1.05 + 0.03 * bass_att;
    echo_orient = fmod(floor(beat_counter / 8), 4);

    q1 = bass_att;
    q2 = time;
    q3 = treb_att;
    q4 = mid_att;
  `,
  perVertex: `
    // Helical twist: the tunnel wall rotates as a function of depth (rad).
    twist = 0.025 * q4 * (1 - rad);
    x = x + twist * sin(ang * 2 + q2 * 1.5 + rad * 6);
    y = y + twist * cos(ang * 2 + q2 * 1.5 + rad * 6);
    // Inner pinch for wormhole throat effect.
    pinch = 0.01 * q1 * (1 - rad) * (1 - rad);
    x = x - pinch * cos(ang);
    y = y - pinch * sin(ang);
  `,
};

// ===========================================================================
// classic visualizer-INSPIRED PRESETS
//
// Original implementations inspired by the most popular presets from
// classic visualizer (MIT License). These recreate the *visual character* of the
// iconic presets using our clean equation language and modern engine features
// (HDR feedback, 256×256 mesh, GPU per-vertex, audio-reactive zoom_exp).
// No EEL2 code or JSON preset data was copied.
// ===========================================================================

// ---------------------------------------------------------------------------
// 11. COSMIC DUST — inspired by Geiss's particle expansion presets
// Gentle outward drift with fine-grain vertex noise, high decay for trails
// ---------------------------------------------------------------------------

const VIZ_COSMIC_DUST: MilkdropPreset = {
  id: 'viz-cosmic-dust',
  label: 'Cosmic Dust',
  base: { decay: 0.975, zoom: 0.998, warp: 0.3, warp_speed: 0.2 },
  meshCols: 192,
  meshRows: 128,
  drawShader: `
    let uv = in.uv;
    let t = md_time();
    var col = vec3f(0.0);
    // Sparse star-like particles via layered hash
    for (var i = 0; i < 5; i += 1) {
      let fi = f32(i);
      let grid = 30.0 + fi * 12.0;
      let cell = floor(uv * grid);
      let local = fract(uv * grid) - 0.5;
      // Pseudo-random position and brightness per cell
      let h1 = md_rand(cell.x * 127.1 + cell.y * 311.7 + fi * 43.7);
      let h2 = md_rand(cell.y * 269.5 + cell.x * 183.3 + fi * 71.1);
      let h3 = md_rand(cell.x * 419.2 + cell.y * 67.9 + fi * 97.3);
      let offset = vec2f(h1 - 0.5, h2 - 0.5) * 0.7;
      let drift = vec2f(sin(t * 0.1 + h1 * 6.28), cos(t * 0.08 + h2 * 6.28)) * 0.1;
      let dp = local - offset - drift;
      let dist = length(dp);
      // Tiny bright point
      let bright = smoothstep(0.04, 0.0, dist) * step(0.7, h3);
      // Warm white/gold color
      let warmth = mix(vec3f(1.0, 0.95, 0.8), vec3f(1.0, 0.8, 0.4), h1);
      col += warmth * bright * (0.5 + 0.5 * h3);
    }
    let vol = md_vol_att();
    col *= 0.6 + 0.4 * vol;
    return md_guard(vec4f(col, 1.0));
  `,
  perFrame: `
    // Very slow zoom-out (particles drift away from centre)
    zoom = 0.997 - 0.003 * bass_att;
    rot = 0.002 * sin(time * 0.11) + 0.001 * mid_att;
    warp = 0.2 + 0.15 * treb_att;
    warp_speed = 0.15 + 0.1 * vol_att;
    decay = 0.970 + 0.015 * (1 - vol * 0.3);

    // Slow panning for nebula feel
    cx = 0.5 + 0.015 * sin(time * 0.13);
    cy = 0.5 + 0.015 * cos(time * 0.17);

    q1 = bass_att;
    q2 = time;
    q3 = treb;
    q4 = mid_att;

    echo_alpha = 0.04;
    echo_zoom = 1.005;
  `,
  perVertex: `
    // Fine dust displacement — very subtle per-vertex noise
    noise = 0.003 * q3 * sin(ang * 17 + q2 * 2.5 + rad * 30);
    x = x + noise * cos(ang + q2 * 0.3);
    y = y + noise * sin(ang + q2 * 0.3);
    // Bass-driven radial expansion
    expand = 0.004 * q1 * rad;
    x = x + expand * cos(ang);
    y = y + expand * sin(ang);
  `,
};

// ---------------------------------------------------------------------------
// 12. FRACTOPIA — inspired by Rovastar's fractal zoom presets
// Deep recursive zoom with colour inversion cycles and drift
// ---------------------------------------------------------------------------

const VIZ_FRACTOPIA: MilkdropPreset = {
  id: 'viz-fractopia',
  label: 'Fractopia',
  base: { decay: 0.98, zoomexp: 2.2, zoom: 1.015 },
  meshCols: 192,
  meshRows: 128,
  perFrame: `
    // Deep zoom that creates fractal-like self-similarity
    zoom = 1.012 + 0.008 * bass_att;
    zoomexp = 2.0 + 0.8 * mid_att;
    rot = 0.008 * sin(time * 0.29) + 0.005 * treb_att;
    warp = 0.6 + 0.4 * vol_att;
    warp_speed = 0.4;
    decay = 0.978 + 0.015 * (1 - bass * 0.5);

    // Wandering centre creates asymmetric fractal arms
    cx = 0.5 + 0.04 * sin(time * 0.19) + 0.02 * cos(time * 0.53);
    cy = 0.5 + 0.04 * cos(time * 0.23) + 0.02 * sin(time * 0.41);
    cycle = sin(time * 0.07);
    q1 = bass_att;
    q2 = time;
    q3 = treb_att;
    q4 = zoomexp;

    echo_alpha = 0.12 + 0.06 * treb_att;
    echo_zoom = 0.95;
    echo_orient = fmod(floor(time * 0.05), 4);
  `,
  perVertex: `
    // Radial distortion that increases with distance — creates fractal branching
    branch = 0.006 * q1 * sin(ang * 5 + q2 * 0.7) * rad * rad;
    x = x + branch * cos(ang * 2 + q2 * 0.3);
    y = y + branch * sin(ang * 2 + q2 * 0.3);
    // Fine structure at the edges
    fine = 0.003 * q3 * sin(ang * 11 + rad * 20 - q2 * 2) * rad;
    x = x + fine;
    y = y + fine * 0.7;
  `,
};

// ---------------------------------------------------------------------------
// 13. UNIFIED FIELD — inspired by Unchained's high-energy presets
// Aggressive bass warp with unified field-like radial pulsation
// ---------------------------------------------------------------------------

const VIZ_UNIFIED_FIELD: MilkdropPreset = {
  id: 'viz-unified-field',
  label: 'Unified Field',
  base: { decay: 0.955, warp: 2.5, zoom: 1.01 },
  meshCols: 192,
  meshRows: 128,
  perFrame: `
    // High energy: bass drives zoom, treble drives warp speed
    energy = bass_att * 1.2 + beat * 1.5;
    zoom = 1.008 + 0.015 * energy;
    warp = 2.0 + 1.5 * energy;
    warp_speed = 1.0 + 1.0 * treb_att;
    rot = 0.03 * mid_att * sin(time * 0.9);
    decay = 0.950 + 0.035 * (1 - energy * 0.4);
    zoomexp = 1.3 + 0.5 * bass_att;

    // Stretch oscillates for field pulsation
    sx = 1 + 0.03 * sin(time * 1.7) * energy;
    sy = 1 + 0.03 * cos(time * 1.7) * energy;
    q1 = energy;
    q2 = time;
    q3 = treb_att;
    q4 = mid_att;

    echo_alpha = 0.08 + 0.12 * beat;
    echo_zoom = 1.04;
  `,
  perVertex: `
    // Unified field: all vertices push outward with energy
    field = 0.018 * q1 * (0.5 + rad);
    x = x + field * cos(ang + q2 * 0.8);
    y = y + field * sin(ang + q2 * 0.8);
    // Treble creates high-frequency interference pattern
    interference = 0.006 * q3 * sin(ang * 9 + q2 * 5) * sin(rad * 15 - q2 * 3);
    x = x + interference;
    y = y + interference;
  `,
};

// ---------------------------------------------------------------------------
// 14. INFUSED SPIRAL — inspired by flexi's spiral presets
// Deep spiral dominance with echo trail arms
// ---------------------------------------------------------------------------

const VIZ_INFUSED_SPIRAL: MilkdropPreset = {
  id: 'viz-infused-spiral',
  label: 'Infused Spiral',
  base: { decay: 0.97, rot: 0.04, warp: 0.5 },
  meshCols: 192,
  meshRows: 128,
  perFrame: `
    // Dominant rotation — the spiral IS the preset
    rot = 0.035 + 0.020 * mid_att + 0.010 * sin(time * 0.37);
    zoom = 1.006 + 0.004 * bass_att;
    warp = 0.4 + 0.3 * treb_att;
    warp_speed = 0.3 + 0.2 * vol_att;
    decay = 0.968 + 0.015 * (1 - vol * 0.3);
    zoomexp = 1.1 + 0.3 * bass_att;

    // Centre orbits slowly to create asymmetric spirals
    cx = 0.5 + 0.02 * sin(time * 0.21);
    cy = 0.5 + 0.02 * cos(time * 0.19);

    // Heavy echo at different orientations — this creates the spiral arms
    echo_alpha = 0.22 + 0.10 * bass_att;
    echo_zoom = 1.02 + 0.01 * mid_att;
    echo_orient = fmod(floor(beat_counter / 6), 4);

    q1 = bass_att;
    q2 = time;
    q3 = mid_att;
    q4 = rot;
  `,
  perVertex: `
    // Spiral arm reinforcement: angular displacement proportional to radius
    arm = 0.012 * q3 * sin(ang * 2 + rad * 10 - q2 * q4 * 15);
    x = x + arm * (1 - rad * 0.3);
    y = y + arm * cos(ang) * (1 - rad * 0.3);
  `,
};

// ---------------------------------------------------------------------------
// 15. TOKAMAK — inspired by Geiss's plasma ring presets
// Ring-shaped geometry with confined energy that pulses on beats
// ---------------------------------------------------------------------------

const VIZ_TOKAMAK: MilkdropPreset = {
  id: 'viz-tokamak',
  label: 'Tokamak',
  base: { decay: 0.965, warp: 1.0, zoomexp: 1.8 },
  meshCols: 192,
  meshRows: 128,
  shapes: [{ sides: 32, instances: 3, filled: false, additive: true }],
  perFrame: `
    // The tokamak ring: zoom out gently while zoomexp confines energy to a band
    zoom = 0.998 + 0.008 * bass_att;
    zoomexp = 1.6 + 0.8 * mid_att;
    rot = 0.015 + 0.010 * treb_att;
    warp = 0.8 + 0.6 * bass_att;
    warp_speed = 0.7 + 0.4 * treb_att;
    decay = 0.962 + 0.025 * (1 - bass * 0.4);

    // Plasma instability: stretch oscillates to create MHD-like modes
    sx = 1 + 0.02 * sin(time * 2.3) * mid_att;
    sy = 1 + 0.02 * cos(time * 2.3) * mid_att;
    q1 = bass_att;
    q2 = time;
    q3 = treb_att;
    q4 = mid_att;

    echo_alpha = 0.10 + 0.08 * bass_att;
    echo_zoom = 1.01;
  `,
  perVertex: `
    // Ring confinement: push vertices toward a specific radius band
    target_rad = 0.35 + 0.05 * q1;
    toward_ring = (target_rad - rad) * 0.015 * q4;
    x = x + toward_ring * cos(ang);
    y = y + toward_ring * sin(ang);
    // Azimuthal instability (plasma kinks)
    kink = 0.008 * q3 * sin(ang * 6 + q2 * 3) * (1 - abs(rad - target_rad) * 4);
    x = x + kink * sin(ang);
    y = y - kink * cos(ang);
  `,
};

// ---------------------------------------------------------------------------
// 16. CRYSTAL PALACE — inspired by martin's geometric symmetry presets
// High angular symmetry with faceted reflections and slow evolution
// ---------------------------------------------------------------------------

const VIZ_CRYSTAL_PALACE: MilkdropPreset = {
  id: 'viz-crystal-palace',
  label: 'Crystal Palace',
  base: { decay: 0.99, warp: 0.8, warp_speed: 0.25 },
  meshCols: 256,
  meshRows: 192,
  perFrame: `
    zoom = 1.003 + 0.003 * bass_att;
    warp = 0.7 + 0.4 * mid_att;
    warp_speed = 0.2 + 0.1 * vol_att;
    rot = 0.004 * sin(time * 0.13) + 0.003 * cos(time * 0.31);
    decay = 0.989 + 0.008 * (1 - vol * 0.2);
    zoomexp = 1.2 + 0.3 * treb_att;

    // Mirror-like echo for crystal reflections
    echo_alpha = 0.20 + 0.08 * mid_att;
    echo_zoom = 1.00;
    // Rotate echo orientation slowly — creates kaleidoscopic facets
    echo_orient = fmod(floor(time * 0.15), 4);
    q1 = bass_att;
    q2 = time;
    q3 = treb_att;
    q4 = mid_att;
  `,
  perVertex: `
    // Multi-fold angular symmetry — creates crystal facets
    sym = 6;
    fold_ang = fmod(ang * sym / 6.283, 1) * 6.283 / sym;
    facet = 0.005 * q4 * sin(fold_ang * sym + q2 * 0.5) * (1 - rad * 0.3);
    x = x + facet * cos(ang);
    y = y + facet * sin(ang);
    // Treble sparkle on facet edges
    edge = 0.003 * q3 * sin(ang * sym * 2 + q2 * 4) * rad;
    x = x + edge;
  `,
};

// ---------------------------------------------------------------------------
// 17. GRIND — inspired by EoS + Phat's aggressive presets
// Maximum aggression: heavy warp, tight decay, explosive beats
// ---------------------------------------------------------------------------

const VIZ_GRIND: MilkdropPreset = {
  id: 'viz-grind',
  label: 'Grind',
  base: { decay: 0.9, warp: 3.0, zoom: 1.02 },
  meshCols: 128,
  meshRows: 96,
  perFrame: `
    // MAXIMUM AGGRESSION — everything cranked to bass
    slam = min(bass * 3.0 + beat * 4.0, 4.0);

    zoom = 1.02 + 0.10 * slam;
    warp = 2.0 + 4.0 * slam;
    warp_speed = 1.0 + 3.0 * treb;
    rot = 0.08 * mid * sign(sin(time * 1.3));
    decay = 0.85 + 0.08 * (1 - slam * 0.25);
    zoomexp = 1.2 + 1.5 * slam;

    sx = 1 + 0.12 * slam * sin(time * 3.1);
    sy = 1 - 0.10 * slam * sin(time * 3.1);
    q1 = slam;
    q2 = time;
    q3 = treb;
  `,
  perVertex: `
    smash = 0.06 * q1 * sin(ang * 4 + q2 * 4) * rad;
    x = x + smash * cos(ang);
    y = y + smash * sin(ang);
    teeth = 0.02 * q3 * sin(ang * 16 + q2 * 8) * rad * rad;
    x = x + teeth;
    y = y + teeth;
  `,
};

// ---------------------------------------------------------------------------
// 18. SHERWIN MAXAWOW — inspired by Flexi + martin + geiss's layered motion
// Complex multi-layered: slow base rotation, mid-speed warp, fast shimmer
// ---------------------------------------------------------------------------

const VIZ_LAYERED_MOTION: MilkdropPreset = {
  id: 'viz-layered-motion',
  label: 'Layered Motion',
  base: { decay: 0.975, rot: 0.01, warp: 0.8, warp_speed: 0.5 },
  meshCols: 192,
  meshRows: 128,
  shapes: [
    { sides: 5, instances: 3, filled: true, additive: true },
    { sides: 16, instances: 2, filled: false, additive: true },
  ],
  waves: [{ samples: 96, instances: 4, thickness: 1.5, additive: true }],
  perFrame: `
    // Three-speed layering: slow structural, medium warp, fast detail
    // Slow: overall rotation and zoom evolve over 30+ seconds
    rot = 0.012 + 0.008 * sin(time * 0.07) + 0.005 * mid_att;
    zoom = 1.005 + 0.005 * sin(time * 0.11) + 0.003 * bass_att;
    
    // Medium: warp and stretch respond to music at a musical pace
    warp = 0.6 + 0.5 * vol_att + 0.3 * sin(time * 0.37);
    warp_speed = 0.4 + 0.3 * treb_att;
    sx = 1 + 0.015 * sin(time * 0.73) * mid_att;
    sy = 1 + 0.015 * cos(time * 0.73) * mid_att;
    
    // Fast: decay and echo respond beat-by-beat
    decay = 0.972 + 0.018 * (1 - bass * 0.4);
    echo_alpha = 0.12 + 0.10 * beat;
    echo_zoom = 1.015 + 0.01 * sin(time * 0.19);
    echo_orient = fmod(floor(beat_counter / 4), 4);

    // Wandering centre
    cx = 0.5 + 0.03 * sin(time * 0.17) + 0.01 * mid_att * cos(time * 0.9);
    cy = 0.5 + 0.03 * cos(time * 0.13) + 0.01 * mid_att * sin(time * 0.7);
    zoomexp = 1.2 + 0.4 * bass_att;

    q1 = bass_att;
    q2 = time;
    q3 = treb_att;
    q4 = mid_att;
    q5 = vol_att;
  `,
  perVertex: `
    // Multi-scale vertex displacement for the complex layered look
    // Large-scale: gentle radial breathing
    breath = 0.006 * q1 * sin(rad * 6 - q2 * 0.7) * (1 - rad * 0.3);
    x = x + breath * cos(ang);
    y = y + breath * sin(ang);
    // Medium-scale: angular waves
    wave = 0.004 * q4 * sin(ang * 4 + q2 * 1.2) * (1 - rad);
    x = x + wave;
    y = y + wave * 0.7;
    // Fine-scale: treble shimmer
    shimmer = 0.002 * q3 * sin(ang * 13 + q2 * 5 + rad * 18);
    x = x + shimmer * rad;
    y = y + shimmer * rad;
  `,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const VISUALIZER_PRESETS: MilkdropPreset[] = [
  // Original presets
  VIZ_TUNNEL,
  VIZ_BEAT_BLOOM,
  VIZ_FRACTAL_DESCENT,
  VIZ_SPIRAL_GALAXY,
  VIZ_NEON_REACTOR,
  VIZ_ACID_RAIN,
  VIZ_SOLAR_FLARE,
  VIZ_CRYSTAL_CAVE,
  VIZ_HEARTBEAT,
  VIZ_WORMHOLE,
  // Extended presets
  VIZ_COSMIC_DUST,
  VIZ_FRACTOPIA,
  VIZ_UNIFIED_FIELD,
  VIZ_INFUSED_SPIRAL,
  VIZ_TOKAMAK,
  VIZ_CRYSTAL_PALACE,
  VIZ_GRIND,
  VIZ_LAYERED_MOTION,
];
