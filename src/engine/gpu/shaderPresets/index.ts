/**
 * Shader Presets Registry
 * Exports palettes, presets, and default config for the shader overlay system.
 */

import type { ShaderPalette, ShaderPreset } from '@/types/effects/shader-overlay';
import { STAR_WARP_PRESET } from './starWarp';
import { CLOUD_FLIGHT_PRESET } from './cloudFlight';
import { VOLUMETRIC_CLOUDS_PRESET } from './volumetricClouds';
import { STORM_CLOUDS_PRESET } from './stormClouds';
import { SYNTHWAVE_PRESET } from './synthwave';
import { GLOWING_WIRES_PRESET } from './glowingWires';
import { ALIEN_TEXT_PRESET } from './alienText';
import { ANTARCTIC_VOID_PRESET } from './antarcticVoid';
import { ICE_CORE_DRILL_PRESET } from './iceCoreDrill';
import { BLIZZARD_PRESET } from './blizzard';
import { CYCLOPEAN_CITY_PRESET } from './cyclopeanCity';
import { SHOGGOTH_PRESET } from './shoggoth';

// ─── Palettes ───────────────────────────────────────────────

const SHADER_PALETTES: ShaderPalette[] = [
  {
    id: 'ember',
    label: 'Ember',
    a: [0.5, 0.2, 0.1],
    b: [0.5, 0.3, 0.2],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.15, 0.2],
  },
  {
    id: 'ice',
    label: 'Ice',
    a: [0.3, 0.5, 0.7],
    b: [0.2, 0.3, 0.3],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.1, 0.2],
  },
  {
    id: 'toxic',
    label: 'Toxic',
    a: [0.1, 0.4, 0.1],
    b: [0.3, 0.5, 0.2],
    c: [1.0, 1.0, 0.5],
    d: [0.0, 0.25, 0.5],
  },
  {
    id: 'vaporwave',
    label: 'Vaporwave',
    a: [0.5, 0.3, 0.6],
    b: [0.5, 0.3, 0.4],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.33, 0.67],
  },
  {
    id: 'mono',
    label: 'Bone',
    a: [0.6, 0.55, 0.5],
    b: [0.2, 0.2, 0.2],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.0, 0.0],
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    a: [0.5, 0.2, 0.5],
    b: [0.5, 0.3, 0.5],
    c: [1.0, 1.0, 0.5],
    d: [0.8, 0.5, 0.75],
  },
  {
    id: 'stone',
    label: 'Stone',
    a: [0.4, 0.35, 0.3],
    b: [0.2, 0.15, 0.1],
    c: [1.0, 1.0, 0.8],
    d: [0.0, 0.05, 0.1],
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    a: [0.2, 0.5, 0.7],
    b: [0.4, 0.3, 0.4],
    c: [1.0, 0.8, 1.0],
    d: [0.0, 0.4, 0.7],
  },
  {
    id: 'sunset',
    label: 'Sunset',
    a: [0.6, 0.3, 0.2],
    b: [0.4, 0.3, 0.3],
    c: [1.0, 0.7, 0.4],
    d: [0.0, 0.15, 0.6],
  },
  {
    id: 'miami',
    label: 'Miami',
    a: [0.5, 0.4, 0.6],
    b: [0.5, 0.4, 0.3],
    c: [0.8, 1.0, 1.0],
    d: [0.55, 0.8, 0.9],
  },
  {
    id: 'outrun',
    label: 'Outrun',
    a: [0.4, 0.1, 0.4],
    b: [0.6, 0.2, 0.5],
    c: [1.0, 1.0, 0.5],
    d: [0.9, 0.6, 0.8],
  },
  {
    id: 'midnight',
    label: 'Midnight',
    a: [0.1, 0.15, 0.35],
    b: [0.3, 0.2, 0.4],
    c: [1.0, 1.0, 1.0],
    d: [0.6, 0.7, 0.8],
  },
  {
    id: 'vapor',
    label: 'Vapor',
    a: [0.6, 0.5, 0.7],
    b: [0.3, 0.3, 0.3],
    c: [0.8, 0.8, 1.0],
    d: [0.1, 0.4, 0.6],
  },
  // ─── Cold pack: Lovecraftian Antarctic horror (At the Mountains of Madness) ───
  {
    // Glacial cyan → white → pale blue. Aurora, ice, snowfields.
    id: 'antarctic-ice',
    label: 'Antarctic Ice',
    a: [0.55, 0.7, 0.85],
    b: [0.3, 0.3, 0.35],
    c: [1.0, 1.0, 1.0],
    d: [0.55, 0.6, 0.7],
  },
  {
    // Near-black violet abyss with cold indigo highlights. Depths, tombs, void.
    id: 'abyssal',
    label: 'Abyssal',
    a: [0.1, 0.08, 0.18],
    b: [0.2, 0.15, 0.35],
    c: [1.0, 1.0, 1.0],
    d: [0.7, 0.55, 0.85],
  },
  {
    // Crimson bleeding into cold white snow. The massacre / storm.
    id: 'blood-snow',
    label: 'Blood Snow',
    a: [0.6, 0.45, 0.5],
    b: [0.45, 0.15, 0.2],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.35, 0.55],
  },
  {
    // Sickly phosphor green / bioluminescent alien glyphs. The Elder Things.
    id: 'elder-green',
    label: 'Elder Green',
    a: [0.25, 0.45, 0.35],
    b: [0.25, 0.4, 0.25],
    c: [1.0, 1.0, 1.0],
    d: [0.4, 0.15, 0.5],
  },
  {
    // Dead cold greys with a faint amber ember. Radio silence, ash, dread.
    id: 'radio-dead',
    label: 'Radio Dead',
    a: [0.35, 0.35, 0.38],
    b: [0.2, 0.2, 0.22],
    c: [1.0, 1.0, 1.0],
    d: [0.1, 0.15, 0.25],
  },
];

// ─── Presets ────────────────────────────────────────────────

const SHADER_PRESETS: ShaderPreset[] = [
  STAR_WARP_PRESET,
  CLOUD_FLIGHT_PRESET,
  VOLUMETRIC_CLOUDS_PRESET,
  STORM_CLOUDS_PRESET,
  SYNTHWAVE_PRESET,
  GLOWING_WIRES_PRESET,
  ALIEN_TEXT_PRESET,
  // ─── Lovecraftian Antarctic horror set ───
  ANTARCTIC_VOID_PRESET,
  ICE_CORE_DRILL_PRESET,
  BLIZZARD_PRESET,
  CYCLOPEAN_CITY_PRESET,
  SHOGGOTH_PRESET,
];

// ─── Helpers ────────────────────────────────────────────────

export function getPresetById(id: string): ShaderPreset | undefined {
  return SHADER_PRESETS.find((p) => p.id === id);
}

export function getPaletteById(id: string): ShaderPalette | undefined {
  return SHADER_PALETTES.find((p) => p.id === id);
}
