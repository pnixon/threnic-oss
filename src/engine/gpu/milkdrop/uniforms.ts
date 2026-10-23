/**
 * Frame uniform block — the contract between the sequential CPU half of the
 * engine and every GPU node.
 *
 * The per-frame equations run once on the CPU and write this block. Warp,
 * shapes, waves, composite, and any custom node (the 3D city layer, lyrics)
 * all read the same buffer. Nothing on the GPU keeps state between frames
 * except the feedback textures themselves.
 *
 * The WGSL struct is generated from the same slot table the packer uses, so
 * the two cannot drift apart.
 */

import type { FrameContext } from './types';

/** One vec4 of the uniform block. */
interface Slot {
  name: string;
  /** Exactly four component names; '_' marks padding. */
  components: [string, string, string, string];
  comment?: string;
}

export const FRAME_SLOTS: readonly Slot[] = [
  { name: 't', components: ['time', 'frame', 'fps', 'seed'] },
  { name: 'aud', components: ['bass', 'mid', 'treb', 'vol'] },
  { name: 'att', components: ['bass_att', 'mid_att', 'treb_att', 'vol_att'] },
  { name: 'bt', components: ['beat', 'beat_counter', 'aspect_x', 'aspect_y'] },
  { name: 'm0', components: ['zoom', 'zoom_exp', 'rot', 'warp'] },
  { name: 'm1', components: ['cx', 'cy', 'dx', 'dy'] },
  { name: 'm2', components: ['sx', 'sy', 'decay', 'warp_speed'] },
  { name: 'c0', components: ['gamma_adj', 'echo_zoom', 'echo_alpha', 'echo_orient'] },
  { name: 'c1', components: ['brighten', 'darken', 'solarize', 'invert'] },
  { name: 's0', components: ['internal_w', 'internal_h', 'output_w', 'output_h'] },
  { name: 'mx', components: ['opacity', 'blend_mode', 'mesh_cols', 'mesh_rows'] },
  { name: 'q0', components: ['q1', 'q2', 'q3', 'q4'] },
  { name: 'q1', components: ['q5', 'q6', 'q7', 'q8'] },
  { name: 'q2', components: ['q9', 'q10', 'q11', 'q12'] },
  { name: 'q3', components: ['q13', 'q14', 'q15', 'q16'] },
  { name: 'q4', components: ['q17', 'q18', 'q19', 'q20'] },
  { name: 'q5', components: ['q21', 'q22', 'q23', 'q24'] },
  { name: 'q6', components: ['q25', 'q26', 'q27', 'q28'] },
  { name: 'q7', components: ['q29', 'q30', 'q31', 'q32'] },
] as const;

/** Number of f32 in the block. */
export const FRAME_UNIFORM_FLOATS = FRAME_SLOTS.length * 4;
/** Byte size of the block — always a multiple of 16. */
export const FRAME_UNIFORM_SIZE = FRAME_UNIFORM_FLOATS * 4;

/** Float index of a named component, e.g. FIELD.zoom. */
export const FIELD: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  FRAME_SLOTS.forEach((slot, s) => {
    slot.components.forEach((c, i) => {
      if (c !== '_') map[c] = s * 4 + i;
    });
  });
  return map;
})();

const XYZW = ['x', 'y', 'z', 'w'] as const;

/**
 * WGSL declaration of the block plus a scalar accessor per field.
 * Nodes call `md_bass()` rather than reaching into the struct, so slot layout
 * stays an implementation detail.
 */
export function frameUniformWGSL(group = 0, binding = 0): string {
  const fields = FRAME_SLOTS.map((s) => `  ${s.name}: vec4f,`).join('\n');
  const accessors = FRAME_SLOTS.flatMap((slot) =>
    slot.components
      .map((c, i) =>
        c === '_' ? null : `fn md_${c}() -> f32 { return md.${slot.name}.${XYZW[i]}; }`,
      )
      .filter((line): line is string => line !== null),
  ).join('\n');

  return `struct MDFrame {\n${fields}\n};\n\n@group(${group}) @binding(${binding}) var<uniform> md: MDFrame;\n\n${accessors}\n`;
}

/**
 * Write a frame context into `dst` (length >= FRAME_UNIFORM_FLOATS).
 * Pure and synchronous — the caller owns the GPU upload.
 */
export function packFrameUniforms(dst: Float32Array, ctx: FrameContext): void {
  if (dst.length < FRAME_UNIFORM_FLOATS) {
    throw new Error(
      `[milkdrop] uniform scratch too small: need ${FRAME_UNIFORM_FLOATS} floats, got ${dst.length}`,
    );
  }
  const { audio: a, motion: m } = ctx;

  const aspect = ctx.internalWidth / Math.max(1, ctx.internalHeight);
  const aspectX = aspect >= 1 ? aspect : 1;
  const aspectY = aspect >= 1 ? 1 : 1 / aspect;

  dst[FIELD.time] = ctx.time;
  dst[FIELD.frame] = ctx.frame;
  dst[FIELD.fps] = ctx.fps;
  dst[FIELD.seed] = ctx.seed;

  dst[FIELD.bass] = a.bass;
  dst[FIELD.mid] = a.mid;
  dst[FIELD.treb] = a.treb;
  dst[FIELD.vol] = a.vol;

  dst[FIELD.bass_att] = a.bassAtt;
  dst[FIELD.mid_att] = a.midAtt;
  dst[FIELD.treb_att] = a.trebAtt;
  dst[FIELD.vol_att] = a.volAtt;

  dst[FIELD.beat] = a.beat;
  dst[FIELD.beat_counter] = a.beatCounter;
  dst[FIELD.aspect_x] = aspectX;
  dst[FIELD.aspect_y] = aspectY;

  dst[FIELD.zoom] = m.zoom;
  dst[FIELD.zoom_exp] = m.zoomExp;
  dst[FIELD.rot] = m.rot;
  dst[FIELD.warp] = m.warp;

  dst[FIELD.cx] = m.cx;
  dst[FIELD.cy] = m.cy;
  dst[FIELD.dx] = m.dx;
  dst[FIELD.dy] = m.dy;

  dst[FIELD.sx] = m.sx;
  dst[FIELD.sy] = m.sy;
  dst[FIELD.decay] = m.decay;
  dst[FIELD.warp_speed] = m.warpAnimSpeed;

  dst[FIELD.gamma_adj] = m.gammaAdj;
  dst[FIELD.echo_zoom] = m.echoZoom;
  dst[FIELD.echo_alpha] = m.echoAlpha;
  dst[FIELD.echo_orient] = m.echoOrient;

  dst[FIELD.brighten] = m.brighten;
  dst[FIELD.darken] = m.darken;
  dst[FIELD.solarize] = m.solarize;
  dst[FIELD.invert] = m.invert;

  dst[FIELD.internal_w] = ctx.internalWidth;
  dst[FIELD.internal_h] = ctx.internalHeight;
  dst[FIELD.output_w] = ctx.outputWidth;
  dst[FIELD.output_h] = ctx.outputHeight;

  dst[FIELD.opacity] = m.opacity;
  dst[FIELD.blend_mode] = m.blendMode;
  dst[FIELD.mesh_cols] = ctx.meshCols;
  dst[FIELD.mesh_rows] = ctx.meshRows;

  const qBase = FIELD.q1;
  for (let i = 0; i < 32; i++) dst[qBase + i] = m.q[i] ?? 0;
}
