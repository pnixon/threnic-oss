/**
 * Audio Routing Types (Stage 1 — Audio router)
 *
 * A routing table sits between analyzer sources (shipped bands + user-defined
 * frequency windows + a shared beat detector) and eight shader "value" slots
 * (u_value1()..u_value8() in the WGSL prelude). Each slot runs its own
 * attack/decay envelope through the shipped `createARParam()` machinery, so
 * response shaping is identical to every other audio-reactive control.
 *
 * This module is TYPES ONLY — no engine, no React, no store imports — so it can
 * be consumed by both the preview and export paths.
 */

import type { AudioReactiveConfig } from './audio-reactive';

/** Number of routable slots. Locked at 8 (decision 2). */
export const AUDIO_ROUTING_SLOT_COUNT = 8;

/**
 * A named, per-frame scalar an effect parameter or shader slot can subscribe to.
 *  - The four shipped bands come straight from `AudioBands` (audioStore).
 *  - `beat` is the shared onset envelope (lifted out of ShaderOverlayPass).
 *  - `band:<id>` references a user-defined Hz window in `customBands`.
 */
export type AudioSourceId =
  | 'bass'
  | 'mid'
  | 'high'
  | 'energy' // shipped — audioStore bands
  | 'beat' // shared onset envelope
  | `band:${string}`; // user-defined Hz window, by id

/** A user-defined frequency window integrated over FFT bins. */
export interface CustomBandDef {
  id: string;
  label: string; // "sub", "snare crack", "air"
  loHz: number;
  hiHz: number;
  /** Normalise against the track's offline peak analysis. */
  normalize: boolean;
}

/** One routable slot. `shape` reuses the shipped envelope config verbatim. */
export interface SlotRouting {
  source: AudioSourceId;
  /** curve, thresholds, attack/decay, invert — the shipped envelope config. */
  shape: AudioReactiveConfig;
}

export interface AudioRoutingTable {
  /** index 0..7 -> u_value1()..u_value8(). `null` = constant 0. */
  slots: (SlotRouting | null)[];
  customBands: CustomBandDef[];
}

export const DEFAULT_AUDIO_ROUTING: AudioRoutingTable = {
  slots: [null, null, null, null, null, null, null, null],
  customBands: [],
};

/** Type guard for a `band:<id>` custom-band source. */
function isCustomBandSource(source: AudioSourceId): source is `band:${string}` {
  return source.startsWith('band:');
}

/** Extract the custom-band id from a `band:<id>` source, else null. */
export function customBandId(source: AudioSourceId): string | null {
  return isCustomBandSource(source) ? source.slice('band:'.length) : null;
}
