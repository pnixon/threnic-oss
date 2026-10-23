/**
 * Custom Waves node — audio waveform line-strips drawn into the feedback buffer.
 *
 * Milkdrop's custom waves sample the audio waveform or spectrum and draw
 * it as a colored line-strip. Each point's position is determined by
 * per-point equations. In our engine, the vertex stage generates positions
 * from a procedural waveform (sine-shaped, audio-modulated) since we don't
 * have access to raw time-domain samples in the shader. The visual effect
 * is equivalent: an oscillating line whose shape responds to audio bands.
 *
 * Topology: line-strip. Each wave is one continuous line with `samples`
 * vertices. Multiple wave instances provide layered visual complexity.
 */

export interface WaveConfig {
  /** Number of vertices (sample points) per wave. Default 128. */
  samples: number;
  /** Number of wave instances drawn per frame. Default 3. */
  instances: number;
  /** Line thickness in pixels (via vertex displacement). */
  thickness: number;
  /** Whether to use additive blending. */
  additive: boolean;
}

export const DEFAULT_WAVE_CONFIG: WaveConfig = {
  samples: 128,
  instances: 3,
  thickness: 2.0,
  additive: true,
};

/**
 * Generate WGSL for a custom wave node.
 *
 * The wave draws as a line-strip. Each vertex position is computed from
 * the vertex index (normalized 0-1 along the wave) plus audio-reactive
 * displacement. Different instances have different phase/color/position.
 */
export function waveNodeWGSL(config: WaveConfig = DEFAULT_WAVE_CONFIG): string {
  const { samples, instances } = config;

  return /* wgsl */ `
const WAVE_SAMPLES: u32 = ${samples}u;
const WAVE_INSTANCES: u32 = ${instances}u;

fn md_hsv_w(h: f32, s: f32, v: f32) -> vec3f {
  let c = v * s;
  let x = c * (1.0 - abs(((h * 6.0) % 2.0) - 1.0));
  let m = v - c;
  var rgb: vec3f;
  let hi = u32(h * 6.0) % 6u;
  switch (hi) {
    case 0u: { rgb = vec3f(c, x, 0.0); }
    case 1u: { rgb = vec3f(x, c, 0.0); }
    case 2u: { rgb = vec3f(0.0, c, x); }
    case 3u: { rgb = vec3f(0.0, x, c); }
    case 4u: { rgb = vec3f(x, 0.0, c); }
    default: { rgb = vec3f(c, 0.0, x); }
  }
  return rgb + vec3f(m);
}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> MDVertexOut {
  let t = md_time();
  let inst_f = f32(ii);
  let sample_f = f32(vi) / f32(WAVE_SAMPLES - 1u);

  // Base position: horizontal spread across the screen
  let wave_offset = (inst_f - f32(WAVE_INSTANCES - 1u) * 0.5) * 0.15;
  let base_x = sample_f;
  let base_y = 0.5 + wave_offset;

  // Audio-reactive waveform displacement
  // Each instance uses a different audio band mix for its shape
  let band_mix = fract(inst_f * 0.333);
  let bass_weight = max(0.0, 1.0 - band_mix * 3.0);
  let mid_weight = max(0.0, 1.0 - abs(band_mix - 0.333) * 3.0);
  let treb_weight = max(0.0, (band_mix - 0.667) * 3.0);

  let audio_drive = md_bass() * bass_weight + md_mid() * mid_weight + md_treb() * treb_weight;

  // Waveform shape: multi-frequency sine modulated by audio
  let freq1 = 3.0 + inst_f * 2.0;
  let freq2 = 7.0 + inst_f * 3.0;
  let phase = t * (0.5 + inst_f * 0.3);
  let wave1 = sin(sample_f * MD_TAU * freq1 + phase) * 0.08 * (0.3 + audio_drive * 0.7);
  let wave2 = sin(sample_f * MD_TAU * freq2 + phase * 1.7) * 0.04 * md_treb();
  let beat_kick = md_beat() * 0.06 * sin(sample_f * MD_PI);

  let y_displacement = wave1 + wave2 + beat_kick;

  // Final position
  let pos_x = base_x;
  let pos_y = base_y + y_displacement;

  // Convert to clip space
  let clip_x = pos_x * 2.0 - 1.0;
  let clip_y = 1.0 - pos_y * 2.0;

  var out: MDVertexOut;
  out.position = vec4f(clip_x, clip_y, 0.0, 1.0);
  out.uv = vec2f(pos_x, pos_y);
  out.src = vec2f(pos_x, pos_y);
  return out;
}

@fragment
fn fs_main(in: MDVertexOut) -> @location(0) vec4f {
  // Color per instance based on time + position
  let hue = fract(md_time() * 0.03 + in.uv.x * 0.3 + in.uv.y * 0.5);
  let brightness = 0.5 + 0.5 * md_vol();
  let rgb = md_hsv_w(hue, 0.9, brightness);
  return md_guard(vec4f(rgb, 0.9));
}
`;
}
