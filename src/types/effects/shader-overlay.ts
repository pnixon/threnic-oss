/**
 * Shader Overlay Types
 * Defines types for the GPU-rendered WGSL shader preset background overlay.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Cosine palette definition (4 vec3s for the formula a + b*cos(2π(c*t+d))). */
export interface ShaderPalette {
  /** Unique palette identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Base offset */
  a: [number, number, number];
  /** Amplitude */
  b: [number, number, number];
  /** Frequency */
  c: [number, number, number];
  /** Phase */
  d: [number, number, number];
}

// ---------------------------------------------------------------------------
// Preset
// ---------------------------------------------------------------------------

/** A tunable shader parameter exposed to the UI. */
interface ShaderPresetParam {
  /** Unique param identifier */
  id: string;
  /** Display label */
  label: string;
  /** Which uniform slot this maps to ('p0' | 'p1' | 'p2' | 'p3') */
  slot: 'p0' | 'p1' | 'p2' | 'p3';
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Default value */
  default: number;
  /** Step increment */
  step: number;
}

/** A shader preset definition. */
export interface ShaderPreset {
  /** Unique preset identifier */
  id: string;
  /** Human-readable display name */
  label: string;
  /** Description shown in UI */
  description: string;
  /** Default palette id to use */
  palette: string;
  /** Tunable parameters exposed to UI */
  params: ShaderPresetParam[];
  /** WGSL fragment body (inserted between prelude and epilogue) */
  body: string;
}

// ---------------------------------------------------------------------------
// Config (stored in project state / Zustand)
// ---------------------------------------------------------------------------

/** Blend mode for the shader overlay */
export type ShaderBlendMode = 'replace' | 'alpha' | 'additive' | 'screen' | 'multiply';

/** Persisted configuration for the shader overlay. */
export interface ShaderOverlayConfig {
  /** Whether the shader overlay is enabled */
  enabled: boolean;
  /** Active preset id */
  presetId: string;
  /** Active palette id */
  paletteId: string;
  /** Global opacity (0–1) */
  opacity: number;
  /** Blend mode */
  blendMode: ShaderBlendMode;
  /** Audio attack time in seconds (how fast the audio follower rises). Default 0.02 */
  attack: number;
  /** Audio decay time in seconds (how fast the audio follower falls). Default 0.05 */
  decay: number;
  /** Shader-specific parameter 0 */
  p0: number;
  /** Shader-specific parameter 1 */
  p1: number;
  /** Per-parameter audio reactivity configs (widget handles band, sensitivity, curve) */
  arOpacity?: import('./audio-reactive').AudioReactiveConfig;
  arP0?: import('./audio-reactive').AudioReactiveConfig;
  arP1?: import('./audio-reactive').AudioReactiveConfig;
  /** Stage 1 audio router: maps analyzer sources to u_value1()..u_value8() slots. */
  audioRouting?: import('./audio-routing').AudioRoutingTable;
}
