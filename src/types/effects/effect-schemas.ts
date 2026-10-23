/**
 * Effect Schemas Registry
 *
 * Every effect's editor UI is described here declaratively.
 * The GenericEffectEditor reads these schemas to render controls.
 *
 * Convention:
 *  - Each field with an `audioReactive` binding will get an
 *    AudioReactiveEditor paired with it automatically.
 *  - When `audioReactive.hideBaseWhenActive` is true (the default),
 *    the base slider is hidden while AR is enabled and an info box is shown.
 */

import type { EffectSchema } from './effect-schema';

// ───────────────────────────────────────────────────────────────
// Simple single-slider effects
// ───────────────────────────────────────────────────────────────

const brightness: EffectSchema = {
  type: 'brightness',
  label: 'Brightness',
  fields: [
    {
      type: 'slider',
      property: 'brightness',
      label: 'Brightness',
      min: 0,
      max: 2,
      step: 0.05,
      default: 1.0,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactivity (Brightness Boost)',
        min: 0,
        max: 2,
      },
    },
  ],
};

const contrast: EffectSchema = {
  type: 'contrast',
  label: 'Contrast',
  fields: [
    {
      type: 'slider',
      property: 'contrast',
      label: 'Contrast',
      min: 0,
      max: 3,
      step: 0.05,
      default: 1.0,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactivity (Contrast Boost)',
        min: 0,
        max: 3,
      },
    },
    {
      type: 'slider',
      property: 'midpoint',
      label: 'Midpoint',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      hint: 'Center point of contrast. Lower this if the screen is too dark.',
    },
  ],
};

const saturation: EffectSchema = {
  type: 'saturation',
  label: 'Saturation',
  fields: [
    {
      type: 'slider',
      property: 'saturation',
      label: 'Saturation',
      min: 0,
      max: 3,
      step: 0.05,
      default: 1.0,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactivity (Saturation Boost)',
        min: 0,
        max: 3,
      },
    },
    {
      type: 'select',
      property: 'weightMode',
      label: 'Mode',
      default: 'perceptual',
      options: [
        { value: 'perceptual', label: 'Perceptual (Natural)' },
        { value: 'uniform', label: 'Uniform (Impact All Equally)' },
      ],
    },
    {
      type: 'checkbox',
      property: 'clamp',
      label: 'Safety Clamp',
      checkboxLabel: 'Prevent Color Artifacts',
      default: true,
    },
  ],
};

const hueShift: EffectSchema = {
  type: 'hueShift',
  label: 'Hue Shift',
  fields: [
    {
      type: 'slider',
      property: 'hue',
      label: 'Hue Shift',
      min: -3.1,
      max: 3.1,
      step: 0.1,
      default: 0,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactivity (Hue Rotation)',
        min: -3.1,
        max: 3.1,
      },
    },
  ],
};

const sepia: EffectSchema = {
  type: 'sepia',
  label: 'Sepia',
  fields: [
    {
      type: 'slider',
      property: 'intensity',
      label: 'Base Intensity',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      audioReactive: { path: 'audioReactive', label: 'Audio Intensity', min: 0, max: 1 },
    },
  ],
};

const bulbFlicker: EffectSchema = {
  type: 'bulbFlicker',
  label: 'Bulb Flicker',
  fields: [
    {
      type: 'slider',
      property: 'intensity',
      label: 'Base Intensity',
      min: 0,
      max: 0.5,
      step: 0.01,
      default: 0,
      audioReactive: { path: 'audioReactive', label: 'Audio Intensity', min: 0, max: 0.5 },
    },
  ],
};

const gateJitter: EffectSchema = {
  type: 'gateJitter',
  label: 'Gate Jitter',
  fields: [
    {
      type: 'slider',
      property: 'intensity',
      label: 'Base Intensity',
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
      audioReactive: { path: 'audioReactive', label: 'Audio Intensity', min: 0, max: 1 },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Mode + slider effects (with randomInterval pattern)
// ───────────────────────────────────────────────────────────────

const bloom: EffectSchema = {
  type: 'bloom',
  label: 'Bloom',
  fields: [
    {
      type: 'buttonGroup',
      property: 'mode',
      label: 'Mode',
      default: 'continuous',
      options: [
        { value: 'continuous', label: 'Continuous' },
        { value: 'random', label: 'Random' },
      ],
    },
    {
      type: 'range',
      propertyLow: 'randomInterval.min',
      propertyHigh: 'randomInterval.max',
      label: 'Interval',
      min: 0.1,
      max: 20,
      step: 0.1,
      defaultLow: 1,
      defaultHigh: 5,
      showWhen: { field: 'mode', value: 'random' },
    },
    {
      type: 'range',
      propertyLow: 'randomDuration.min',
      propertyHigh: 'randomDuration.max',
      label: 'Duration',
      min: 0.01,
      max: 5,
      step: 0.01,
      defaultLow: 0.1,
      defaultHigh: 0.8,
      showWhen: { field: 'mode', value: 'random' },
    },
    {
      type: 'slider',
      property: 'attack',
      label: 'Attack (Fade In)',
      min: 0,
      max: 1.0,
      step: 0.01,
      default: 0.05,
      showWhen: { field: 'mode', value: 'random' },
    },
    {
      type: 'slider',
      property: 'decay',
      label: 'Decay (Fade Out)',
      min: 0,
      max: 1.0,
      step: 0.01,
      default: 0.1,
      showWhen: { field: 'mode', value: 'random' },
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'intensity',
      label: 'Base Intensity',
      min: 0,
      max: 2,
      step: 0.1,
      default: 0,
      audioReactive: { path: 'audioReactive.intensity', label: 'Intensity', min: 0, max: 2 },
    },
    {
      type: 'slider',
      property: 'threshold',
      label: 'Luminance Threshold',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.5,
      audioReactive: { path: 'audioReactive.threshold', label: 'Threshold', min: 0, max: 1 },
    },
  ],
};

const chromaticAberration: EffectSchema = {
  type: 'chromaticAberration',
  label: 'Chromatic Aberration',
  fields: [
    {
      type: 'buttonGroup',
      property: 'mode',
      label: 'Mode',
      default: 'continuous',
      options: [
        { value: 'continuous', label: 'Continuous' },
        { value: 'random', label: 'Random' },
      ],
    },
    {
      type: 'range',
      propertyLow: 'randomInterval.min',
      propertyHigh: 'randomInterval.max',
      label: 'Interval',
      min: 0.01,
      max: 20,
      step: 0.01,
      defaultLow: 1,
      defaultHigh: 5,
      showWhen: { field: 'mode', value: 'random' },
      dividerAfter: true,
    },
    {
      type: 'range',
      propertyLow: 'randomDuration.min',
      propertyHigh: 'randomDuration.max',
      label: 'Duration',
      min: 0.01,
      max: 5,
      step: 0.01,
      defaultLow: 0.1,
      defaultHigh: 0.8,
      showWhen: { field: 'mode', value: 'random' },
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'attack',
      label: 'Attack (Fade In)',
      min: 0,
      max: 1.0,
      step: 0.01,
      default: 0.05,
      showWhen: { field: 'mode', value: 'random' },
    },
    {
      type: 'slider',
      property: 'decay',
      label: 'Decay (Fade Out)',
      min: 0,
      max: 1.0,
      step: 0.01,
      default: 0.1,
      showWhen: { field: 'mode', value: 'random' },
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'offset',
      label: 'Base Offset',
      min: -0.1,
      max: 0.1,
      step: 0.001,
      default: 0.005,
      audioReactive: {
        path: 'audioReactive',
        label: 'Offset',
        min: -0.1,
        max: 0.1,
        step: 0.001,
      },
    },
  ],
};

const glitch: EffectSchema = {
  type: 'glitch',
  label: 'Glitch',
  fields: [
    {
      type: 'buttonGroup',
      property: 'mode',
      label: 'Mode',
      default: 'continuous',
      options: [
        { value: 'continuous', label: 'Const' },
        { value: 'random', label: 'Rnd' },
      ],
    },
    {
      type: 'slider',
      property: 'duration',
      label: 'Duration',
      min: 0.05,
      max: 2,
      step: 0.05,
      default: 0.2,
      showWhen: { field: 'mode', value: 'random' },
      dividerAfter: true,
    },
    {
      type: 'range',
      propertyLow: 'randomInterval.min',
      propertyHigh: 'randomInterval.max',
      label: 'Interval',
      min: 0.1,
      max: 20,
      step: 0.1,
      defaultLow: 1,
      defaultHigh: 5,
      showWhen: { field: 'mode', value: 'random' },
    },
    {
      type: 'range',
      propertyLow: 'randomDuration.min',
      propertyHigh: 'randomDuration.max',
      label: 'Duration',
      min: 0.01,
      max: 5,
      step: 0.01,
      defaultLow: 0.1,
      defaultHigh: 0.8,
      showWhen: { field: 'mode', value: 'random' },
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'strength',
      label: 'Base Strength',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0,
      audioReactive: { path: 'audioReactive', label: 'Strength', min: 0, max: 1 },
    },
  ],
};

const vhsTracking: EffectSchema = {
  type: 'vhsTracking',
  label: 'VHS Tracking',
  fields: [
    {
      type: 'buttonGroup',
      property: 'mode',
      label: 'Mode',
      default: 'continuous',
      options: [
        { value: 'continuous', label: 'Continuous' },
        { value: 'random', label: 'Random' },
      ],
    },
    {
      type: 'range',
      propertyLow: 'randomInterval.min',
      propertyHigh: 'randomInterval.max',
      label: 'Interval',
      min: 0.1,
      max: 20,
      step: 0.1,
      defaultLow: 1,
      defaultHigh: 5,
      showWhen: { field: 'mode', value: 'random' },
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'intensity',
      label: 'Base Intensity',
      min: 0,
      max: 2,
      step: 0.1,
      default: 0.6,
      audioReactive: { path: 'audioReactive.intensity', label: 'Intensity', min: 0, max: 2 },
    },
    {
      type: 'slider',
      property: 'distortionAmount',
      label: 'Distortion Amount',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.5,
      audioReactive: { path: 'audioReactive.distortion', label: 'Distortion', min: 0, max: 1 },
    },
    {
      type: 'slider',
      property: 'trackingSpeed',
      label: 'Tracking Speed',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.2,
      audioReactive: {
        path: 'audioReactive.trackingSpeed',
        label: 'Tracking Speed',
        min: 0,
        max: 1,
      },
    },
    {
      type: 'slider',
      property: 'chromaticSplit',
      label: 'Chromatic Split',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.3,
      audioReactive: {
        path: 'audioReactive.chromaticSplit',
        label: 'Chromatic Split',
        min: 0,
        max: 1,
      },
    },
  ],
};

const oldFilm: EffectSchema = {
  type: 'oldFilm',
  label: 'Old Film',
  fields: [
    {
      type: 'buttonGroup',
      property: 'mode',
      label: 'Mode',
      default: 'continuous',
      options: [
        { value: 'continuous', label: 'Continuous' },
        { value: 'random', label: 'Random' },
      ],
    },
    {
      type: 'range',
      propertyLow: 'randomInterval.min',
      propertyHigh: 'randomInterval.max',
      label: 'Interval',
      min: 0.5,
      max: 20,
      step: 0.5,
      defaultLow: 2,
      defaultHigh: 8,
      showWhen: { field: 'mode', value: 'random' },
    },
    {
      type: 'range',
      propertyLow: 'randomDuration.min',
      propertyHigh: 'randomDuration.max',
      label: 'Duration',
      min: 0.01,
      max: 5,
      step: 0.01,
      defaultLow: 0.1,
      defaultHigh: 0.8,
      showWhen: { field: 'mode', value: 'random' },
    },
    {
      type: 'slider',
      property: 'attack',
      label: 'Attack (Fade In)',
      min: 0,
      max: 1.0,
      step: 0.01,
      default: 0.05,
      showWhen: { field: 'mode', value: 'random' },
    },
    {
      type: 'slider',
      property: 'decay',
      label: 'Decay (Fade Out)',
      min: 0,
      max: 1.0,
      step: 0.01,
      default: 0.1,
      showWhen: { field: 'mode', value: 'random' },
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'intensity',
      label: 'Base Intensity',
      min: 0,
      max: 2,
      step: 0.1,
      default: 0,
      audioReactive: { path: 'audioReactive.intensity', label: 'Intensity', min: 0, max: 2 },
    },
    {
      type: 'slider',
      property: 'grainScale',
      label: 'Grain Scale',
      min: 1,
      max: 250,
      step: 0.5,
      default: 4,
      audioReactive: {
        path: 'audioReactive.grainScale',
        label: 'Grain Scale',
        min: 1,
        max: 250,
        step: 0.5,
      },
    },
    {
      type: 'slider',
      property: 'grainAmount',
      label: 'Grain Amount',
      min: 0,
      max: 0.2,
      step: 0.01,
      default: 0.05,
      audioReactive: { path: 'audioReactive.grainAmount', label: 'Grain Amount', min: 0, max: 0.2 },
    },
    {
      type: 'slider',
      property: 'scratchAmount',
      label: 'Scratches',
      min: 0,
      max: 2,
      step: 0.1,
      default: 1,
      audioReactive: { path: 'audioReactive.scratchAmount', label: 'Scratches', min: 0, max: 2 },
    },
    {
      type: 'slider',
      property: 'dirtAmount',
      label: 'Dirt',
      min: 0,
      max: 2,
      step: 0.1,
      default: 1,
      audioReactive: { path: 'audioReactive.dirtAmount', label: 'Dirt', min: 0, max: 2 },
    },
    {
      type: 'slider',
      property: 'anomalyFrequency',
      label: 'Anomaly Freq',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      audioReactive: {
        path: 'audioReactive.anomalyFrequency',
        label: 'Anomaly Frequency',
        min: 0,
        max: 1,
      },
    },
    {
      type: 'select',
      property: 'grainType',
      label: 'Grain Type',
      default: 'procedural',
      options: [
        { value: 'procedural', label: 'Procedural (Classic)' },
        { value: 'studio_35mm', label: 'Studio 35mm (Clean)' },
        { value: 'reporter_16mm', label: 'Reporter 16mm (News)' },
        { value: 'amateur_8mm', label: 'Amateur 8mm (Home)' },
        { value: 'panchromatic_noir', label: 'Panchromatic Noir' },
        { value: 'tabular_contrast', label: 'Tabular Cluster' },
        { value: 'gilded_fine', label: 'Gilded Fine' },
        { value: 'foundry_medium', label: 'Foundry Medium' },
        { value: 'elongated_halide', label: 'Elongated Halide' },
        { value: 'majestic_coarse', label: 'Majestic Coarse' },
        { value: 'raw_emulsion', label: 'Raw Emulsion' },
        { value: 'refined_intensifier', label: 'Refined Intensifier' },
        { value: 'dusty_academy', label: 'Dusty Academy' },
        { value: 'theatrical_gate', label: 'Theatrical Gate' },
        { value: 'underground_grit', label: 'Underground Grit' },
      ],
      dividerAfter: true,
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Distortion
// ───────────────────────────────────────────────────────────────

const distortion: EffectSchema = {
  type: 'distortion',
  label: 'Distortion',
  fields: [
    {
      type: 'slider',
      property: 'intensity',
      label: 'Intensity',
      min: 0,
      max: 2,
      step: 0.01,
      default: 0.5,
      audioReactive: { path: 'audioReactive.intensity', label: 'Intensity', min: 0, max: 2 },
    },
    {
      type: 'slider',
      property: 'distortAmount',
      label: 'Dist Amount',
      min: 0,
      max: 5,
      step: 0.1,
      default: 1,
      audioReactive: { path: 'audioReactive.distortAmount', label: 'Dist Amount', min: 0, max: 5 },
    },
    {
      type: 'slider',
      property: 'rippleSpeed',
      label: 'Ripple Speed',
      min: 0,
      max: 10,
      step: 0.1,
      default: 2,
      audioReactive: { path: 'audioReactive.rippleSpeed', label: 'Ripple Speed', min: 0, max: 10 },
    },
    {
      type: 'slider',
      property: 'rippleFrequency',
      label: 'Ripple Freq',
      min: 1,
      max: 50,
      step: 1,
      default: 15,
      transform: 'round',
      audioReactive: {
        path: 'audioReactive.rippleFrequency',
        label: 'Ripple Freq',
        min: 1,
        max: 50,
      },
      dividerAfter: true,
    },
    {
      type: 'select',
      property: 'distortionType',
      label: 'Shape',
      default: 'radial',
      options: [
        { value: 'radial', label: 'Radial' },
        { value: 'horizontal', label: 'Horizontal' },
        { value: 'vertical', label: 'Vertical' },
        { value: 'box', label: 'Box' },
      ],
    },
    {
      type: 'color',
      property: 'color',
      label: 'Color',
      default: '#ffffff',
    },
    {
      type: 'slider',
      property: 'opacity',
      label: 'Tint Opacity',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0,
      audioReactive: { path: 'audioReactive.opacity', label: 'Tint Opacity', min: 0, max: 1 },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Zoom
// ───────────────────────────────────────────────────────────────

const zoom: EffectSchema = {
  type: 'zoom',
  label: 'Zoom',
  note: {
    text: 'Zoom only affects static image and video backgrounds — it has no effect on Shader FX backgrounds (fragment shader, game scene, or Butterchurn).',
    onlyWhenShaderFxEnabled: true,
  },
  fields: [
    {
      type: 'slider',
      property: 'scale',
      label: 'Max Zoom Scale',
      min: 0.1,
      max: 3,
      step: 0.1,
      default: 1,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactive (Zoom Scale)',
        min: 0.1,
        max: 3,
      },
    },
    {
      type: 'slider',
      property: 'centerX',
      label: 'Horizontal (X)',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      sectionHeader: 'Focal Point',
      audioReactive: { path: 'audioReactive.centerX', label: 'Center X', min: 0, max: 1 },
    },
    {
      type: 'slider',
      property: 'centerY',
      label: 'Vertical (Y)',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      audioReactive: { path: 'audioReactive.centerY', label: 'Center Y', min: 0, max: 1 },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Rotate
// ───────────────────────────────────────────────────────────────

const rotate: EffectSchema = {
  type: 'rotate',
  label: 'Rotate',
  note: {
    text: 'Rotate only affects static image and video backgrounds — it has no effect on Shader FX backgrounds (fragment shader, game scene, or Butterchurn).',
    onlyWhenShaderFxEnabled: true,
  },
  fields: [
    {
      type: 'slider',
      property: 'angle',
      label: 'Base Angle (°)',
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactive (Base Angle)',
        min: -180,
        max: 180,
      },
    },
    {
      type: 'slider',
      property: 'speed',
      label: 'Rotation Speed (°/s)',
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      audioReactive: {
        path: 'speedAudioReactive',
        label: 'Audio Reactive (Rotation Speed)',
        min: -180,
        max: 180,
      },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Slide
// ───────────────────────────────────────────────────────────────

const slide: EffectSchema = {
  type: 'slide',
  label: 'Slide',
  note: {
    text: 'Slide / translate only affects static image and video backgrounds — it has no effect on Shader FX backgrounds (fragment shader, game scene, or Butterchurn).',
    onlyWhenShaderFxEnabled: true,
  },
  groups: [
    { id: 'horizontal', label: 'Horizontal (X)', defaultOpen: true },
    { id: 'vertical', label: 'Vertical (Y)', defaultOpen: true },
  ],
  fields: [
    {
      type: 'slider',
      property: 'speedX',
      label: 'Speed X',
      min: -2,
      max: 2,
      step: 0.05,
      default: 0,
      group: 'horizontal',
      audioReactive: { path: 'audioReactive.x', label: 'Audio Push X', min: -2, max: 2 },
    },
    {
      type: 'slider',
      property: 'speedY',
      label: 'Speed Y',
      min: -2,
      max: 2,
      step: 0.05,
      default: 0,
      group: 'vertical',
      audioReactive: { path: 'audioReactive.y', label: 'Audio Push Y', min: -2, max: 2 },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Chain Lightning
// ───────────────────────────────────────────────────────────────

const chainLightning: EffectSchema = {
  type: 'chainLightning',
  label: 'Chain Lightning',
  fields: [
    {
      type: 'color',
      property: 'lightningColor',
      label: 'Color',
      default: '#00AAFF',
      sectionHeader: 'APPEARANCE',
    },
    {
      type: 'slider',
      property: 'nodeCount',
      label: 'Node Count',
      min: 3,
      max: 8,
      step: 1,
      default: 4,
      transform: 'round',
    },
    {
      type: 'slider',
      property: 'arcWidth',
      label: 'Arc Width',
      min: 1,
      max: 12,
      step: 0.5,
      default: 4,
      audioReactive: { path: 'audioReactive.arcWidth', label: 'Arc Width', min: 1, max: 12 },
    },
    {
      type: 'slider',
      property: 'glowIntensity',
      label: 'Glow Intensity',
      min: 0.1,
      max: 2,
      step: 0.1,
      default: 1,
      audioReactive: {
        path: 'audioReactive',
        label: 'Trigger & Glow',
        min: 0.1,
        max: 2,
      },
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'duration',
      label: 'Duration',
      min: 0.1,
      max: 2,
      step: 0.05,
      default: 0.5,
      sectionHeader: 'TIMING',
    },
    {
      type: 'slider',
      property: 'cooldown',
      label: 'Cooldown',
      min: 0.1,
      max: 2,
      step: 0.05,
      default: 0.3,
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Noise Overlay
// ───────────────────────────────────────────────────────────────

const noiseOverlay: EffectSchema = {
  type: 'noiseOverlay',
  label: 'Noise Overlay',
  fields: [
    {
      type: 'slider',
      property: 'opacity',
      label: 'Base Opacity',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.15,
      audioReactive: { path: 'audioReactive.opacity', label: 'Opacity Pulse', min: 0, max: 1 },
    },
    {
      type: 'slider',
      property: 'grainSize',
      label: 'Grain Size',
      min: 1,
      max: 32,
      step: 0.5,
      default: 1.5,
      audioReactive: { path: 'audioReactive.grainSize', label: 'Scale Jitter', min: 1, max: 32 },
    },
    {
      type: 'slider',
      property: 'vSyncSpeed',
      label: 'Horizontal Roll',
      min: 0,
      max: 10,
      step: 0.1,
      default: 1,
      audioReactive: { path: 'audioReactive.vSyncSpeed', label: 'Roll Speed', min: 0, max: 10 },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Starfield
// ───────────────────────────────────────────────────────────────

const starfield: EffectSchema = {
  type: 'starfield',
  label: 'Starfield',
  fields: [
    {
      type: 'slider',
      property: 'count',
      label: 'Star Count',
      min: 50,
      max: 2000,
      step: 50,
      default: 500,
      transform: 'round',
      audioReactive: { path: 'audioReactive.count', label: 'Star Count', min: 50, max: 2000 },
    },
    {
      type: 'slider',
      property: 'speed',
      label: 'Base Speed',
      min: -10,
      max: 10,
      step: 0.5,
      default: 4.5,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactivity',
        min: 0,
        max: 5,
      },
    },
    {
      type: 'slider',
      property: 'sizeMult',
      label: 'Star Size',
      min: 0.3,
      max: 3,
      step: 0.1,
      default: 1,
      audioReactive: { path: 'audioReactive.sizeMult', label: 'Star Size', min: 0.3, max: 3 },
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'brightness',
      label: 'Brightness',
      min: 0.1,
      max: 3,
      step: 0.1,
      default: 1,
      audioReactive: { path: 'audioReactive.brightness', label: 'Brightness', min: 0.1, max: 3 },
    },
    { type: 'color', property: 'color', label: 'Star Color', default: '#d1ffff' },
  ],
};

// ───────────────────────────────────────────────────────────────
// Pixelation
// ───────────────────────────────────────────────────────────────

const pixelation: EffectSchema = {
  type: 'pixelation',
  label: 'Pixelation',
  fields: [
    {
      type: 'select',
      property: 'mode',
      label: 'Mode',
      default: 'continuous',
      options: [
        { value: 'continuous', label: 'Continuous' },
        { value: 'random-origin', label: 'Random Origin' },
        { value: 'pixel-rain', label: 'Pixel Rain' },
        { value: 'wave', label: 'Wave' },
        { value: 'pulse', label: 'Pulse' },
      ],
    },
    {
      type: 'slider',
      property: 'pixelSize',
      label: 'Pixel Size',
      min: 1,
      max: 50,
      step: 1,
      default: 1,
      audioReactive: { path: 'audioReactive', label: 'Pixel Size', min: 1, max: 50, step: 1 },
    },
    {
      type: 'slider',
      property: 'pixelSizeStep',
      label: 'Size Step',
      min: 1,
      max: 10,
      step: 1,
      default: 1,
      dividerAfter: true,
    },
    // Random-origin interval
    {
      type: 'range',
      propertyLow: 'randomInterval.min',
      propertyHigh: 'randomInterval.max',
      label: 'Interval (s)',
      min: 0.1,
      max: 20,
      step: 0.1,
      defaultLow: 1,
      defaultHigh: 5,
      showWhen: { field: 'mode', value: 'random-origin' },
      dividerAfter: true,
    },
    // Pixel-rain
    {
      type: 'slider',
      property: 'rainSpotCount',
      label: 'Spot Count',
      min: 1,
      max: 10,
      step: 1,
      default: 10,
      showWhen: { field: 'mode', value: 'pixel-rain' },
    },
    {
      type: 'slider',
      property: 'rainGrowthSpeed',
      label: 'Growth Speed (s)',
      min: 0.1,
      max: 2,
      step: 0.1,
      default: 0.3,
      showWhen: { field: 'mode', value: 'pixel-rain' },
    },
    {
      type: 'slider',
      property: 'rainDuration',
      label: 'Duration (s)',
      min: 0.5,
      max: 5,
      step: 0.1,
      default: 1.5,
      showWhen: { field: 'mode', value: 'pixel-rain' },
      dividerAfter: true,
    },
    // Wave
    {
      type: 'slider',
      property: 'waveSpeed',
      label: 'Wave Speed',
      min: 10,
      max: 500,
      step: 10,
      default: 200,
      showWhen: { field: 'mode', value: 'wave' },
    },
    {
      type: 'buttonGroup',
      property: 'waveDirection',
      label: 'Direction',
      options: [
        { value: 'horizontal', label: 'Horizontal' },
        { value: 'vertical', label: 'Vertical' },
      ],
      showWhen: { field: 'mode', value: 'wave' },
      dividerAfter: true,
    },
    // Pulse
    {
      type: 'slider',
      property: 'pulseSpeed',
      label: 'Pulse Speed',
      min: 0.5,
      max: 5,
      step: 0.1,
      default: 2,
      showWhen: { field: 'mode', value: 'pulse' },
    },
    {
      type: 'select',
      property: 'pulseOrigin',
      label: 'Origin',
      options: [
        { value: 'center', label: 'Center' },
        { value: 'edges', label: 'Edges' },
      ],
      showWhen: { field: 'mode', value: 'pulse' },
      dividerAfter: true,
    },
    // Area AR for non-continuous modes
    {
      type: 'slider',
      property: '_audioReactiveArea',
      label: 'Area Size Reactivity',
      min: 0,
      max: 1,
      step: 0.01,
      showWhen: { field: 'mode', value: 'continuous', negate: true },
      audioReactive: {
        path: 'audioReactiveArea',
        label: 'Area Size Reactivity',
        hideBaseWhenActive: false,
      },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Particles
// ───────────────────────────────────────────────────────────────

const particles: EffectSchema = {
  type: 'particles',
  label: 'Particles',
  groups: [
    { id: 'physics', label: 'Physics & Motion', icon: 'Wind', defaultOpen: true },
    { id: 'visuals', label: 'Visual Style', icon: 'Flame', defaultOpen: true },
    { id: 'audio', label: 'Audio Reactivity', icon: 'Music', defaultOpen: false },
  ],
  fields: [
    {
      type: 'select',
      property: 'style',
      label: 'Particles Type',
      default: 'dust',
      options: [{ value: 'dust', label: 'Dust (Floating)' }],
    },
    {
      type: 'logSlider',
      property: 'count',
      label: 'Density (Count)',
      min: 10,
      max: 30000,
      default: 15000,
      transform: 'round',
    },
    // Physics
    {
      type: 'slider',
      property: 'gravity',
      label: 'Fall Speed (Gravity)',
      min: -2,
      max: 2,
      step: 0.01,
      default: 0.2,
      group: 'physics',
      audioReactive: { path: 'audioReactive.gravity', label: 'Gravity', min: -2, max: 2 },
    },
    {
      type: 'slider',
      property: 'windX',
      label: 'Drift (Wind X)',
      min: -2,
      max: 2,
      step: 0.1,
      default: 0.1,
      group: 'physics',
      audioReactive: { path: 'audioReactive.windX', label: 'Wind X', min: -2, max: 2 },
    },
    {
      type: 'slider',
      property: 'turbulence',
      label: 'Turbulence',
      min: 0,
      max: 5,
      step: 0.1,
      default: 1.8,
      group: 'physics',
      audioReactive: {
        path: 'audioReactive.turbulence',
        label: 'Turbulence Reactivity',
        min: 0.5,
        max: 4,
      },
    },
    // Visuals
    {
      type: 'slider',
      property: 'size',
      label: 'Particle Size',
      min: 0.5,
      max: 10,
      step: 0.1,
      default: 1.5,
      group: 'visuals',
      audioReactive: { path: 'audioReactive.size', label: 'Size', min: 0.5, max: 10 },
    },
    {
      type: 'slider',
      property: 'opacity',
      label: 'Opacity',
      min: 0.1,
      max: 1,
      step: 0.01,
      default: 0.4,
      group: 'visuals',
      audioReactive: { path: 'audioReactive.opacity', label: 'Opacity', min: 0.1, max: 1 },
    },
    { type: 'color', property: 'color', label: 'Color', default: '#ffffff', group: 'visuals' },
    {
      type: 'select',
      property: 'blending',
      label: 'Blending Mode',
      default: 'additive',
      group: 'visuals',
      options: [
        { value: 'additive', label: 'Additive (Glow/Light)' },
        { value: 'normal', label: 'Normal (Solid/Dark)' },
      ],
      hint: "Use 'Normal' for dark particles to block the background.",
    },
    // Audio group
    {
      type: 'slider',
      property: '_audioSpeedDummy',
      label: '',
      group: 'audio',
      audioReactive: {
        path: 'audioReactive.speed',
        label: 'Pulse on Bass',
        min: 0.05,
        max: 1,
        hideBaseWhenActive: false,
      },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Rain (3D)
// ───────────────────────────────────────────────────────────────

const rain: EffectSchema = {
  type: 'rain',
  label: 'Rain',
  groups: [{ id: 'audio', label: 'Audio Reactivity', icon: 'Music', defaultOpen: true }],
  fields: [
    {
      type: 'slider',
      property: 'count',
      label: 'Count',
      min: 1000,
      max: 25000,
      step: 1000,
      default: 10000,
      transform: 'round',
      audioReactive: { path: 'audioReactive.count', label: 'Count', min: 1000, max: 25000 },
    },
    {
      type: 'slider',
      property: 'speed',
      label: 'Speed',
      min: 0.5,
      max: 50,
      step: 0.1,
      default: 2,
      audioReactive: { path: 'audioReactive.speed', label: 'Speed', min: 0.5, max: 50 },
    },
    {
      type: 'slider',
      property: 'size',
      label: 'Rain Drop Size',
      min: 0.1,
      max: 5,
      step: 0.1,
      default: 1.0,
      audioReactive: { path: 'audioReactive.size', label: 'Size', min: 1.0, max: 3.0 },
    },
    {
      type: 'slider',
      property: 'windX',
      label: 'Wind X',
      min: -1,
      max: 1,
      step: 0.05,
      default: 0.2,
      audioReactive: { path: 'audioReactive.windX', label: 'Wind X', min: -1, max: 1 },
    },
    {
      type: 'slider',
      property: 'windZ',
      label: 'Wind Z',
      min: -1,
      max: 1,
      step: 0.05,
      default: 0.1,
      audioReactive: { path: 'audioReactive.windZ', label: 'Wind Z', min: -1, max: 1 },
    },
    {
      type: 'slider',
      property: 'opacity',
      label: 'Opacity',
      min: 0.1,
      max: 1,
      step: 0.05,
      default: 0.4,
      audioReactive: { path: 'audioReactive.opacity', label: 'Opacity', min: 0.1, max: 1 },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Visualizer (no audio reactive - the effect IS audio reactive by nature)
// ───────────────────────────────────────────────────────────────

const visualizer: EffectSchema = {
  type: 'visualizer',
  label: 'Oscilloscope',
  fields: [
    {
      type: 'buttonGroup',
      property: 'type',
      label: 'Mode',
      default: 'linear',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'circle', label: 'Circle' },
        { value: 'bars', label: 'Bars' },
        { value: 'tunnel', label: 'Tunnel (3D)' },
      ],
    },
    {
      type: 'buttonGroup',
      property: 'style',
      label: 'Style',
      default: 'modern',
      options: [
        { value: 'modern', label: 'Modern' },
        { value: 'retro', label: 'Retro' },
        { value: 'lasers', label: 'Lasers' },
        { value: 'blocky', label: 'Blocky' },
        { value: 'classic', label: 'Classic' },
      ],
      showWhen: { field: 'type', value: 'bars' },
    },
    { type: 'color', property: 'minColor', label: 'Min Color', default: '#00ffff' },
    { type: 'color', property: 'maxColor', label: 'Max Color', default: '#ff00ff' },
    {
      type: 'slider',
      property: 'glowIntensity',
      label: 'Glow',
      min: 0,
      max: 5,
      step: 0.1,
      default: 1.5,
    },
    {
      type: 'slider',
      property: 'lineWidth',
      label: 'Width',
      min: 0.5,
      max: 10,
      step: 0.5,
      default: 1.5,
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'sensitivity',
      label: 'Sensitivity',
      min: 0.1,
      max: 5,
      step: 0.1,
      default: 1,
    },
    {
      type: 'slider',
      property: 'attack',
      label: 'Attack (Rise)',
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.02,
    },
    {
      type: 'slider',
      property: 'decay',
      label: 'Decay (Fall)',
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.05,
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'scale',
      label: 'Scale',
      min: 0.1,
      max: 5,
      step: 0.1,
      default: 1,
    },
    {
      type: 'slider',
      property: 'positionX',
      label: 'Pos X %',
      min: 0,
      max: 100,
      step: 1,
      default: 50,
    },
    {
      type: 'slider',
      property: 'positionY',
      label: 'Pos Y %',
      min: 0,
      max: 100,
      step: 1,
      default: 50,
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// LUT Color Grading
// ───────────────────────────────────────────────────────────────

const lut: EffectSchema = {
  type: 'lut',
  label: 'LUT Color Grading',
  fields: [
    {
      type: 'select',
      property: 'preset',
      label: 'Preset',
      default: 'tealOrange',
      options: [
        { value: 'none', label: '— None —' },
        { value: 'tealOrange', label: 'Teal & Orange' },
        { value: 'noir', label: 'Noir' },
        { value: 'cineVibrant', label: 'Cine-Vibrant' },
        { value: 'crushedBlacks', label: 'Crushed Blacks' },
        { value: 'coldShadows', label: 'Cold Shadows' },
        { value: 'warmHighlights', label: 'Warm Highlights' },
        { value: 'bleachBypass', label: 'Bleach Bypass' },
        { value: 'crossProcess', label: 'Cross Process' },
      ],
    },
    {
      type: 'slider',
      property: 'intensity',
      label: 'Intensity',
      min: 0,
      max: 1,
      step: 0.01,
      default: 1.0,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactivity (Intensity)',
        min: 0,
        max: 1,
      },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Motion Blur / Echo
// ───────────────────────────────────────────────────────────────

const motionBlur: EffectSchema = {
  type: 'motionBlur',
  label: 'Motion Blur / Echo',
  fields: [
    {
      type: 'slider',
      property: 'intensity',
      label: 'Intensity',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      audioReactive: {
        path: 'audioReactive.intensity',
        label: 'Intensity',
        min: 0,
        max: 1,
      },
    },
    {
      type: 'slider',
      property: 'decay',
      label: 'Trail Decay',
      min: 0,
      max: 0.99,
      step: 0.01,
      default: 0.7,
      hint: 'Higher = longer ghosting trails',
      audioReactive: {
        path: 'audioReactive.decay',
        label: 'Decay',
        min: 0,
        max: 0.99,
      },
    },
    {
      type: 'slider',
      property: 'trailCount',
      label: 'Trail Count',
      min: 1,
      max: 16,
      step: 1,
      default: 4,
      transform: 'round',
      hint: 'Number of echo frames (visual only)',
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Lens Flare
// ───────────────────────────────────────────────────────────────

const lensFlare: EffectSchema = {
  type: 'lensFlare',
  label: 'Lens Flare',
  groups: [{ id: 'ghosts', label: 'Ghost Reflections', defaultOpen: false }],
  fields: [
    {
      type: 'slider',
      property: 'intensity',
      label: 'Brightness',
      min: 0,
      max: 3,
      step: 0.05,
      default: 1.0,
      audioReactive: {
        path: 'audioReactive.intensity',
        label: 'Brightness',
        min: 0,
        max: 3,
      },
    },
    {
      type: 'slider',
      property: 'threshold',
      label: 'Threshold',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
      hint: 'Luminance level required to trigger flare',
      audioReactive: {
        path: 'audioReactive.threshold',
        label: 'Threshold',
        min: 0,
        max: 1,
      },
    },
    {
      type: 'slider',
      property: 'streakLength',
      label: 'Streak Length',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      type: 'color',
      property: 'tintColor',
      label: 'Flare Tint',
      default: '#ffaa44',
    },
    {
      type: 'checkbox',
      property: 'anamorphic',
      label: 'Anamorphic',
      checkboxLabel: 'Enable horizontal anamorphic streaks',
      default: true,
      dividerAfter: true,
    },
    {
      type: 'slider',
      property: 'ghostCount',
      label: 'Ghost Count',
      min: 0,
      max: 8,
      step: 1,
      default: 4,
      transform: 'round',
      group: 'ghosts',
    },
    {
      type: 'slider',
      property: 'ghostSpacing',
      label: 'Ghost Spacing',
      min: 0.1,
      max: 1,
      step: 0.05,
      default: 0.3,
      group: 'ghosts',
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Camera Shake
// ───────────────────────────────────────────────────────────────

const cameraShake: EffectSchema = {
  type: 'cameraShake',
  label: 'Camera Shake',
  fields: [
    {
      type: 'slider',
      property: 'intensity',
      label: 'Intensity',
      min: 0,
      max: 0.05,
      step: 0.001,
      default: 0.01,
      audioReactive: {
        path: 'audioReactive.intensity',
        label: 'Intensity',
        min: 0,
        max: 0.05,
      },
    },
    {
      type: 'slider',
      property: 'frequency',
      label: 'Frequency (Hz)',
      min: 1,
      max: 60,
      step: 1,
      default: 15,
      transform: 'round',
      audioReactive: {
        path: 'audioReactive.frequency',
        label: 'Frequency',
        min: 1,
        max: 60,
      },
    },
    {
      type: 'slider',
      property: 'damping',
      label: 'Damping',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      hint: 'Higher = quicker decay after beats',
    },
    {
      type: 'checkbox',
      property: 'rotational',
      label: 'Rotation',
      checkboxLabel: 'Enable rotational wobble',
      default: false,
    },
    {
      type: 'slider',
      property: 'maxRotation',
      label: 'Max Rotation (°)',
      min: 0,
      max: 15,
      step: 0.5,
      default: 2,
      showWhen: { field: 'rotational', value: 'true' },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Background Image Overlay
// ───────────────────────────────────────────────────────────────

const bgImageOverlay: EffectSchema = {
  type: 'bgImageOverlay',
  label: 'Secondary Image',
  fields: [
    {
      type: 'imageUpload',
      property: 'imageAssetId',
      label: 'Image',
    },
    {
      type: 'buttonGroup',
      property: 'fit',
      label: 'Fit',
      default: 'cover',
      options: [
        { value: 'cover', label: 'Cover' },
        { value: 'contain', label: 'Contain' },
        { value: 'stretch', label: 'Stretch' },
      ],
    },
    {
      type: 'buttonGroup',
      property: 'blendMode',
      label: 'Blend',
      default: 'normal',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'additive', label: 'Additive' },
        { value: 'screen', label: 'Screen' },
        { value: 'multiply', label: 'Multiply' },
      ],
    },
    {
      type: 'slider',
      property: 'opacity',
      label: 'Opacity',
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
      audioReactive: {
        path: 'audioReactive',
        label: 'Audio Reactivity (Opacity)',
        min: 0,
        max: 1,
      },
      dividerAfter: true,
    },
    {
      type: 'checkbox',
      property: 'gate.enabled',
      label: 'Gate',
      checkboxLabel: 'Only show when audio exceeds a threshold',
      default: false,
    },
    {
      type: 'triggerLevel',
      property: 'gate',
      label: 'Gate Trigger',
      default: { band: 'bass', threshold: 0.7, cooldown: 0.5, duration: 0.5, flash: false },
      showWhen: { field: 'gate.enabled', value: true },
    },
    {
      type: 'slider',
      property: 'gate.duration',
      label: 'Duration (s)',
      min: 0.01,
      max: 5,
      step: 0.01,
      default: 0.5,
      hint: 'How long the image stays on after a trigger. Cooldown blocks re-triggering, it does not extend this.',
      showWhen: { field: 'gate.enabled', value: true },
    },
    {
      type: 'checkbox',
      property: 'gate.flash',
      label: 'Flash',
      checkboxLabel: 'Lightning flash (strobe on trigger)',
      default: false,
      showWhen: { field: 'gate.enabled', value: true },
    },
    {
      type: 'checkbox',
      property: 'gateFadeIn',
      label: 'On Gate',
      checkboxLabel: 'Fade in (ignored when Flash is on)',
      default: true,
      showWhen: { field: 'gate.enabled', value: true },
    },
    {
      type: 'slider',
      property: 'gateAttack',
      label: 'Fade In (s)',
      min: 0,
      max: 2,
      step: 0.05,
      default: 0.3,
      showWhen: { field: 'gate.enabled', value: true },
    },
  ],
};

// ───────────────────────────────────────────────────────────────
// Registry
// ───────────────────────────────────────────────────────────────

const EFFECT_SCHEMAS: Record<string, EffectSchema> = {
  brightness,
  contrast,
  saturation,
  hueShift,
  sepia,
  bulbFlicker,
  gateJitter,
  bloom,
  chromaticAberration,
  glitch,
  vhsTracking,
  oldFilm,
  distortion,
  zoom,
  rotate,
  slide,
  chainLightning,
  noiseOverlay,
  starfield,
  pixelation,
  particles,
  rain,
  visualizer,
  bgImageOverlay,
  butterchurn: {
    type: 'butterchurn',
    label: 'Butterchurn',
    fields: [
      {
        type: 'butterchurnPresetPicker',
        property: 'presetName',
        label: 'Preset',
        default: '',
      },
      {
        type: 'buttonGroup',
        property: 'blendMode',
        label: 'Blend',
        options: [
          { value: 'replace', label: 'Replace' },
          { value: 'composite', label: 'Composite' },
        ],
        default: 'replace',
      },
      {
        type: 'buttonGroup',
        property: 'cycleMode',
        label: 'Cycle',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'sequential', label: 'Sequential' },
          { value: 'random', label: 'Random' },
        ],
        default: 'off',
      },
      {
        type: 'slider',
        property: 'cycleInterval',
        label: 'Cycle Interval (s)',
        min: 3,
        max: 60,
        step: 1,
        default: 15,
      },
      {
        type: 'slider',
        property: 'blendTime',
        label: 'Blend Time (s)',
        min: 0,
        max: 10,
        step: 0.5,
        default: 2.0,
      },
      {
        type: 'slider',
        property: 'opacity',
        label: 'Opacity',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1.0,
      },
    ],
  },
  shaderFx: {
    type: 'shaderFx',
    label: 'Shader FX',
    fields: [
      {
        type: 'buttonGroup',
        property: 'mode',
        label: 'Mode',
        options: [
          { value: 'shader', label: 'Fragment Shader' },
          { value: 'littlejs', label: 'Game Scene' },
          { value: 'glsl', label: 'GLSL Guest' },
          // 'feedback' (Feedback Chain) and 'butterchurn' modes are hidden from the
          // UI but remain fully supported in the render pipeline / saved projects.
        ],
        default: 'shader',
      },
      // ── Shader mode preset picker ──
      {
        type: 'select',
        property: 'shader.presetId',
        label: 'Preset',
        default: 'glowingWires',
        options: [
          { value: 'glowingWires', label: 'Glowing Wires' },
          // Other shader presets remain in the code (SHADER_PRESETS registry) but
          // are hidden from the UI. Existing projects using them still render.
        ],
        showWhen: { field: 'mode', value: 'shader' },
      },
      {
        type: 'slider',
        property: 'shader.opacity',
        label: 'Opacity',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1.0,
        showWhen: { field: 'mode', value: 'shader' },
        audioReactive: { path: 'shader.arOpacity', label: 'Opacity AR', min: 0, max: 1 },
      },
      // ── Feedback mode preset picker ──
      {
        type: 'select',
        property: 'feedback.presetId',
        label: 'Preset',
        default: 'viz-tunnel',
        options: [
          { value: 'viz-tunnel', label: 'Tunnel' },
          { value: 'viz-beat-bloom', label: 'Beat Bloom' },
          { value: 'viz-fractal-descent', label: 'Fractal Descent' },
          { value: 'viz-spiral-galaxy', label: 'Spiral Galaxy' },
          { value: 'viz-neon-reactor', label: 'Neon Reactor' },
          { value: 'viz-acid-rain', label: 'Acid Rain' },
          { value: 'viz-solar-flare', label: 'Solar Flare' },
          { value: 'viz-crystal-cave', label: 'Crystal Cave' },
          { value: 'viz-heartbeat', label: 'Heartbeat' },
          { value: 'viz-wormhole', label: 'Wormhole' },
          { value: 'viz-cosmic-dust', label: 'Cosmic Dust' },
          { value: 'viz-fractopia', label: 'Fractopia' },
          { value: 'viz-unified-field', label: 'Unified Field' },
          { value: 'viz-infused-spiral', label: 'Infused Spiral' },
          { value: 'viz-tokamak', label: 'Tokamak' },
          { value: 'viz-crystal-palace', label: 'Crystal Palace' },
          { value: 'viz-grind', label: 'Grind' },
          { value: 'viz-layered-motion', label: 'Layered Motion' },
        ],
        showWhen: { field: 'mode', value: 'feedback' },
      },
      {
        type: 'slider',
        property: 'feedback.opacity',
        label: 'Opacity',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1.0,
        showWhen: { field: 'mode', value: 'feedback' },
      },
      {
        type: 'slider',
        property: 'feedback.zoom',
        label: 'Zoom',
        min: 0.9,
        max: 1.2,
        step: 0.005,
        default: 1.02,
        showWhen: { field: 'mode', value: 'feedback' },
        audioReactive: { path: 'feedback.arZoom', label: 'Zoom AR', min: 0.9, max: 1.3 },
      },
      {
        type: 'slider',
        property: 'feedback.warp',
        label: 'Warp',
        min: 0,
        max: 5,
        step: 0.1,
        default: 1.0,
        showWhen: { field: 'mode', value: 'feedback' },
        audioReactive: { path: 'feedback.arWarp', label: 'Warp AR', min: 0, max: 8 },
      },
      {
        type: 'slider',
        property: 'feedback.rotation',
        label: 'Rotation',
        min: -0.1,
        max: 0.1,
        step: 0.005,
        default: 0.02,
        showWhen: { field: 'mode', value: 'feedback' },
        audioReactive: { path: 'feedback.arRotation', label: 'Rotation AR', min: -0.15, max: 0.15 },
      },
      {
        type: 'slider',
        property: 'feedback.decay',
        label: 'Trail Length',
        min: 0.8,
        max: 0.99,
        step: 0.005,
        default: 0.95,
        showWhen: { field: 'mode', value: 'feedback' },
        audioReactive: { path: 'feedback.arDecay', label: 'Decay AR', min: 0.8, max: 0.99 },
      },
      // ── Butterchurn mode fields ──
      {
        type: 'butterchurnPresetPicker',
        property: 'butterchurn.presetName',
        label: 'Preset',
        default: '',
        showWhen: { field: 'mode', value: 'butterchurn' },
      },
      {
        type: 'buttonGroup',
        property: 'butterchurn.cycleMode',
        label: 'Cycle',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'sequential', label: 'Sequential' },
          { value: 'random', label: 'Random' },
        ],
        default: 'off',
        showWhen: { field: 'mode', value: 'butterchurn' },
      },
      {
        type: 'slider',
        property: 'butterchurn.cycleInterval',
        label: 'Cycle Interval (s)',
        min: 3,
        max: 60,
        step: 1,
        default: 15,
        showWhen: { field: 'mode', value: 'butterchurn' },
      },
      {
        type: 'slider',
        property: 'butterchurn.blendTime',
        label: 'Blend Time (s)',
        min: 0,
        max: 10,
        step: 0.5,
        default: 2.0,
        showWhen: { field: 'mode', value: 'butterchurn' },
      },
      {
        type: 'slider',
        property: 'butterchurn.opacity',
        label: 'Opacity',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1.0,
        showWhen: { field: 'mode', value: 'butterchurn' },
      },
      // ── LittleJS Game Scene mode fields ──
      {
        type: 'select',
        property: 'littlejs.sceneId',
        label: 'Scene',
        default: 'rpgCombat',
        options: [
          { value: 'rpgCombat', label: 'RPG Combat' },
          // Boy & Dog Fetch + Car Racing are built and tested but hidden from
          // the picker for now (WIP) — re-add these options to expose them:
          // { value: 'fetch', label: 'Boy & Dog Fetch' },
          // { value: 'carRacing', label: 'Car Racing' },
        ],
        showWhen: { field: 'mode', value: 'littlejs' },
      },
      {
        type: 'slider',
        property: 'littlejs.opacity',
        label: 'Scene Opacity',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1.0,
        hint: 'Blends the whole game scene over the background (1 = fully opaque, 0 = fully transparent). Remove the scene Background asset to overlay the fighters on your own background.',
        showWhen: { field: 'mode', value: 'littlejs' },
      },
      {
        type: 'checkbox',
        property: 'littlejs.params.leftHover',
        label: 'Left',
        checkboxLabel: 'Idle hover animation',
        default: false,
        showWhen: { field: 'mode', value: 'littlejs' },
      },
      {
        type: 'checkbox',
        property: 'littlejs.params.rightHover',
        label: 'Right',
        checkboxLabel: 'Idle hover animation',
        default: false,
        showWhen: { field: 'mode', value: 'littlejs' },
      },
      {
        type: 'slider',
        property: 'littlejs.params.hpFloor',
        label: 'End HP',
        min: 0,
        max: 0.5,
        step: 0.01,
        default: 0.05,
        showWhen: { field: 'mode', value: 'littlejs' },
      },
      // ── Left Fighter Attack Config ──
      {
        type: 'triggerLevel',
        property: 'littlejs.params.leftAttack',
        label: 'Left Attack Trigger',
        default: { band: 'bass', threshold: 0.7, cooldown: 1.5 },
        showWhen: { field: 'mode', value: 'littlejs' },
      },
      // ── Right Fighter Attack Config ──
      {
        type: 'triggerLevel',
        property: 'littlejs.params.rightAttack',
        label: 'Right Attack Trigger',
        default: { band: 'treb', threshold: 0.7, cooldown: 1.5 },
        showWhen: { field: 'mode', value: 'littlejs' },
      },
    ],
  },
  lut,
  motionBlur,
  lensFlare,
  cameraShake,
  bgOpacity: {
    type: 'bgOpacity',
    label: 'Image Opacity',
    note: {
      text: 'Opacity only affects static image and video backgrounds — it has no effect on Shader FX backgrounds (fragment shader, game scene, or Butterchurn).',
      onlyWhenShaderFxEnabled: true,
    },
    fields: [
      {
        type: 'slider',
        property: 'opacity',
        label: 'Opacity',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1.0,
        hint: 'Controls media layer transparency (0 = fully transparent, 1 = fully opaque).',
        audioReactive: {
          path: 'audioReactive',
          label: 'Audio Reactivity (Opacity)',
          min: 0,
          max: 1,
        },
      },
    ],
  },
  bgBlur: {
    type: 'bgBlur',
    label: 'Background Blur',
    fields: [
      {
        type: 'select',
        property: 'blurType',
        label: 'Blur Type',
        default: 'gaussian',
        options: [
          { value: 'gaussian', label: 'Gaussian (Soft, Natural)' },
          { value: 'box', label: 'Box (Fast, Pixelated)' },
          { value: 'directional', label: 'Directional (Horizontal Smear)' },
          { value: 'radial', label: 'Radial (Zoom Blur)' },
        ],
      },
      {
        type: 'slider',
        property: 'amount',
        label: 'Amount',
        min: 0,
        max: 20,
        step: 0.5,
        default: 0,
        audioReactive: {
          path: 'audioReactive',
          label: 'Audio Reactivity (Blur)',
          min: 0,
          max: 20,
        },
      },
    ],
  },
};

export function getEffectSchema(type: string): EffectSchema | undefined {
  return EFFECT_SCHEMAS[type];
}
