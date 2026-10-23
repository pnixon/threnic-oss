/**
 * GLSL generative presets (Stage 3a companion).
 *
 * A curated dropdown of ready-to-run GLSL-guest `mainImage(...)`
 * bodies for the GLSL guest layer — the same "pick from a list, or write your
 * own" pattern the Butterchurn / Milkdrop pickers use, but for the generative
 * WebGL2 guest engine. A preset that reads audio declares it via `channelKinds`
 * (e.g. iChannel0 = 'audio'); applying the preset binds those channels so the
 * pick reacts immediately. Channels default to 'none' (unbound → reads 0), so a
 * preset that does NOT declare audio is not reactive until the user binds a
 * channel or routes a uValue slot.
 *
 * These are GENERATIVE (they produce colour from scratch), which is the GLSL
 * guest's contract — distinct from the WGSL `customShader` TRANSFORM presets
 * (which sample the layer beneath). The two engines are intentionally separate,
 * so each has its own preset list. The `custom` sentinel keeps whatever the
 * user has authored.
 *
 * ─── LICENSING RULE (mandatory) ─────────────────────────────────────────────
 * The GLSL-guest ABI (iTime/iResolution/iChannel/mainImage) makes pasting
 * external Shadertoy code trivial. Every preset added here MUST document, in a
 * comment directly above its definition, its ORIGINAL source (URL/author) and
 * its LICENSE. Do not ship a preset whose license is unknown or does not permit
 * redistribution — write an original implementation instead. Third-party code
 * that ships must also be listed in LEGAL/THIRD_PARTY_NOTICES.md. The presets
 * below are original to Threnic unless a per-preset comment says otherwise.
 */

import type { GuestBufferId, GuestChannelKind } from './types';

/**
 * A buffer pass a preset ships: its `mainImage` body plus the iChannel0..3
 * KINDS it samples. Only kinds are declared (not full `GuestChannel` objects)
 * because customer assets (image/cubemap/video) are supplied in-app; the editor
 * materializes full channels from these kinds when the preset is applied. A
 * `buffer` kind additionally needs its `bufferId` — declare it in the aligned
 * `bufferRefs` slot (kind==='buffer' with no bufferRef defaults to self).
 */
interface GlslPresetBufferPass {
  /** GLSL ES 3.00 `mainImage(out vec4, in vec2)` body for this buffer pass. */
  source: string;
  /** iChannel0..3 kinds this buffer pass samples (short/missing → 'none'). */
  channelKinds: GuestChannelKind[];
  /**
   * For any channel whose kind is 'buffer', which buffer it samples, aligned to
   * `channelKinds` by index. Undefined/short entries default to this pass's own
   * buffer (self-feedback).
   */
  bufferRefs?: (GuestBufferId | undefined)[];
  /**
   * Optional embedded cubemap (6 face data URIs, GL order +X,-X,+Y,-Y,+Z,-Z)
   * seeded into the given channel's IndexedDB slots when the preset is applied,
   * so a preset can ship a self-contained cubemap with no manual upload. Only
   * carried by the DEV-ONLY preset module (stripped from prod).
   */
  embeddedCubemap?: { channel: number; faces: string[] };
  /**
   * Optional embedded image2d (a single data URI) seeded into the given
   * channel's IndexedDB slot on apply, so a preset can ship a self-contained
   * image with no manual upload. Dev-only (stripped from prod).
   */
  embeddedImage?: { channel: number; dataUri: string };
}

export interface GlslPreset {
  /** Stable id used as the dropdown value. `custom` = keep current source. */
  id: string;
  /** Display name in the dropdown. */
  label: string;
  /** One-line description. */
  description: string;
  /** GLSL-guest GLSL ES 3.00 `mainImage(out vec4, in vec2)` body. */
  source: string;
  /**
   * Optional iChannel0..3 kinds this preset needs. Applying the preset binds
   * exactly these (missing/short entries → 'none'). Omit for a preset that
   * samples no channel. This is how a preset opts INTO audio now that channels
   * default to 'none'.
   */
  channelKinds?: GuestChannelKind[];
  /**
   * For any Image-pass channel whose kind is 'buffer', which buffer it samples,
   * aligned to `channelKinds` by index. Undefined entries → Buffer A.
   */
  bufferRefs?: (GuestBufferId | undefined)[];
  /**
   * Optional multipass buffer passes (Buffer A–D) this preset ships. Applying
   * the preset seeds `config.buffers` with these (only the ids present are
   * enabled). Buffers render a→b→c→d before the Image pass.
   */
  buffers?: Partial<Record<GuestBufferId, GlslPresetBufferPass>>;
  /**
   * Optional embedded cubemap for the IMAGE pass (6 face data URIs), seeded into
   * the given channel's IndexedDB slots on apply. For a preset whose Image pass
   * samples a cubemap directly (no buffer). Buffer-pass cubemaps use the
   * per-pass `embeddedCubemap` on GlslPresetBufferPass instead. Dev-only.
   */
  embeddedCubemap?: { channel: number; faces: string[] };
  /**
   * Optional per-guest audio routing table applied on pick, so a preset that
   * reads uValue1..8 wires the slots to audio sources immediately (otherwise
   * every slot resolves to 0). Same shape as GLSLGuestConfig.audioRouting.
   */
  audioRouting?: import('@/types/effects/audio-routing').AudioRoutingTable;
}

/** Sentinel id for the "write your own" option — never overwrites the source. */
export const GLSL_CUSTOM_ID = 'custom';

const AUDIO_PULSE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  // Low / mid / high energy sampled from the FFT row of iChannel0.
  float bass = texture(iChannel0, vec2(0.03, 0.25)).x;
  float mid  = texture(iChannel0, vec2(0.30, 0.25)).x;
  float high = texture(iChannel0, vec2(0.70, 0.25)).x;
  vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx * 3.0 + vec3(0.0, 2.0, 4.0));
  col *= 0.4 + 1.4 * bass;
  col += 0.3 * high * vec3(0.6, 0.8, 1.0);
  col = mix(col, col.zyx, 0.5 + 0.5 * sin(iTime * 0.3 + mid * 6.0));
  fragColor = vec4(col, 1.0);
}`;

/**
 * The curated preset list. `custom` is first so the dropdown defaults to
 * "Custom" whenever the user's source doesn't match a preset.
 *
 * The E2E "Kitchen Sink" preset is DEV-ONLY: it lives in `glslPresets.dev.ts`
 * and is appended here ONLY when `process.env.NODE_ENV === 'development'`.
 * Next.js inlines that literal at build time, so in a production build the
 * branch is `false`, the `require('./glslPresets.dev')` is dead code, and the
 * bundler drops the dev module entirely — its GLSL source AND its embedded
 * cubemap data URIs never ship to prod. Guarded `require` (not a static
 * `import`) is what makes the elimination possible.
 */
const BASE_PRESETS: GlslPreset[] = [
  {
    id: GLSL_CUSTOM_ID,
    label: 'Custom…',
    description: 'Keep your own hand-written GLSL source.',
    source: '',
  },
  {
    id: 'audio-pulse',
    label: 'Audio Pulse',
    description: 'Cosine-palette field that pulses with bass/mid/high (binds iChannel0 = Audio).',
    source: AUDIO_PULSE,
    channelKinds: ['audio', 'none', 'none', 'none'],
  },
];

function loadDevPresets(): GlslPreset[] {
  if (process.env.NODE_ENV !== 'development') return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dev = require('./glslPresets.dev') as {
      E2E_KITCHEN_SINK: GlslPreset;
      DEV_DEBUG_PRESETS: GlslPreset[];
    };
    return [dev.E2E_KITCHEN_SINK, ...dev.DEV_DEBUG_PRESETS];
  } catch {
    return [];
  }
}

export const GLSL_PRESETS: GlslPreset[] = [...BASE_PRESETS, ...loadDevPresets()];

/** Which preset (if any) a given source string matches, else `custom`. */
export function matchGlslPresetId(source: string): string {
  const hit = GLSL_PRESETS.find((p) => p.id !== GLSL_CUSTOM_ID && p.source === source);
  return hit ? hit.id : GLSL_CUSTOM_ID;
}
