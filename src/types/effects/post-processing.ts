/**
 * Post-Processing Effect Configuration Types
 * Defines visual effects applied after rendering
 */

import type { AudioReactiveConfig } from './audio-reactive';

export interface PostProcessingConfig {
  bloom: {
    enabled: boolean;
    intensity: number;
    threshold: number;
    mode: 'continuous' | 'random';
    randomInterval: {
      enabled: boolean;
      min: number;
      max: number;
    };
    randomDuration?: {
      min: number;
      max: number;
    };
    attack?: number;
    decay?: number;
    audioReactive: {
      intensity: AudioReactiveConfig;
      threshold: AudioReactiveConfig;
    };
  };
  chromaticAberration: {
    enabled: boolean;
    offset: number;
    mode: 'continuous' | 'random';
    randomInterval: {
      enabled: boolean;
      min: number;
      max: number;
    };
    randomDuration?: {
      min: number;
      max: number;
    };
    attack?: number;
    decay?: number;
    audioReactive: AudioReactiveConfig;
  };
  glitch: {
    enabled: boolean;
    strength: number;
    duration?: number;
    mode: 'continuous' | 'random';
    randomInterval: {
      enabled: boolean;
      min: number;
      max: number;
    };
    randomDuration?: {
      min: number;
      max: number;
    };
    attack?: number;
    decay?: number;
    audioReactive: AudioReactiveConfig;
  };
  vhsTracking: {
    enabled: boolean;
    intensity: number;
    trackingSpeed: number;
    distortionAmount: number;
    chromaticSplit: number;
    mode: 'continuous' | 'random';
    randomInterval: {
      enabled: boolean;
      min: number;
      max: number;
    };
    randomDuration?: {
      min: number;
      max: number;
    };
    attack?: number;
    decay?: number;
    audioReactive: {
      intensity: AudioReactiveConfig;
      distortion: AudioReactiveConfig;
      trackingSpeed?: AudioReactiveConfig;
      chromaticSplit?: AudioReactiveConfig;
    };
  };

  slide: {
    enabled: boolean;
    speedX: number;
    speedY: number;
    audioReactive: {
      x: AudioReactiveConfig;
      y: AudioReactiveConfig;
    };
  };
  rotate: {
    enabled: boolean;
    /** Rotation speed in degrees per second */
    speed: number;
    /** Base rotation angle in degrees (-180 to 180) */
    angle: number;
    /** Audio reactivity for the base angle */
    audioReactive: AudioReactiveConfig;
    /** Audio reactivity for the rotation speed */
    speedAudioReactive: AudioReactiveConfig;
  };
  oldFilm: {
    enabled: boolean;
    intensity: number;
    grainAmount: number;
    grainScale?: number;
    scratchAmount: number;
    dirtAmount: number;
    /** Type of grain to use */
    grainType?:
      | 'procedural'
      // Era-Inspired Styles
      | 'gilded_fine'
      | 'foundry_medium'
      | 'elongated_halide'
      | 'majestic_coarse'
      | 'raw_emulsion'
      | 'refined_intensifier'
      // Production Styles
      | 'studio_35mm'
      | 'reporter_16mm'
      | 'amateur_8mm'
      | 'panchromatic_noir'
      | 'tabular_contrast'
      // Exhibition Styles
      | 'dusty_academy'
      | 'theatrical_gate'
      | 'underground_grit';
    /** How often random artifacts appear (0-1) */
    anomalyFrequency?: number;
    /** Bundle of custom grain texture URLs */
    grainBundle?: string[];
    mode: 'continuous' | 'random';
    randomInterval: {
      enabled: boolean;
      min: number;
      max: number;
    };
    randomDuration?: {
      min: number;
      max: number;
    };
    attack?: number;
    decay?: number;
    audioReactive: {
      intensity: AudioReactiveConfig;
      grainScale: AudioReactiveConfig;
      grainAmount?: AudioReactiveConfig;
      scratchAmount?: AudioReactiveConfig;
      dirtAmount?: AudioReactiveConfig;
      anomalyFrequency?: AudioReactiveConfig;
    };
  };
  chainLightning: {
    enabled: boolean;
    /** Lightning bolt color */
    lightningColor: string;
    /** Number of nodes to chain between (3-8) */
    nodeCount: number;
    /** Base width of lightning arcs */
    arcWidth: number;
    /** Glow brightness multiplier */
    glowIntensity: number;
    /** How long each strike lasts (seconds) */
    duration: number;
    /** Minimum time between strikes (seconds) */
    cooldown: number;
    /** Audio level to trigger (0-1, uses high frequency) */
    audioThreshold: number;
    /** Audio reactivity config for intensity modulation */
    audioReactive: {
      /** Legacy / main entry (maps to glow intensity) */
      enabled: boolean;
      band: AudioReactiveConfig['band'];
      intensity: number;
      min: number;
      max: number;
      lowerThreshold?: number;
      upperThreshold?: number;
      boxCenter?: number;
      boxWidth?: number;
      invert?: boolean;
      attack?: number;
      decay?: number;
      /** Per-field */
      arcWidth?: AudioReactiveConfig;
    };
  };
  distortion: {
    enabled: boolean;
    intensity: number;
    distortAmount: number;
    rippleSpeed: number;
    rippleFrequency: number;
    distortionType: 'radial' | 'horizontal' | 'vertical' | 'box';
    color: string;
    opacity: number;
    audioReactive: {
      intensity: AudioReactiveConfig;
      distortAmount: AudioReactiveConfig;
      rippleSpeed: AudioReactiveConfig;
      rippleFrequency: AudioReactiveConfig;
      opacity: AudioReactiveConfig;
    };
  };

  starfield: {
    enabled: boolean;
    /** Number of stars */
    count: number;
    /** Base forward speed */
    speed: number;
    /** Star tint color */
    color: string;
    /** Global brightness multiplier */
    brightness: number;
    /** Star size multiplier */
    sizeMult: number;
    /** @deprecated legacy fields kept for backward compat */
    glow: number;
    length: number;
    width: number;
    opacity: number;
    audioReactive: {
      /** Legacy / main warp entry */
      enabled: boolean;
      band: AudioReactiveConfig['band'];
      intensity: number;
      min: number;
      max: number;
      lowerThreshold?: number;
      upperThreshold?: number;
      boxCenter?: number;
      boxWidth?: number;
      invert?: boolean;
      attack?: number;
      decay?: number;
      /** Per-field */
      count?: AudioReactiveConfig;
      sizeMult?: AudioReactiveConfig;
      brightness?: AudioReactiveConfig;
    };
  };
  zoom: {
    enabled: boolean;
    scale: number;
    centerX: number;
    centerY: number;
    audioReactive: {
      /** Legacy / main zoom scale entry */
      enabled: boolean;
      band: AudioReactiveConfig['band'];
      intensity: number;
      min: number;
      max: number;
      lowerThreshold?: number;
      upperThreshold?: number;
      boxCenter?: number;
      boxWidth?: number;
      invert?: boolean;
      attack?: number;
      decay?: number;
      /** Per-field */
      centerX?: AudioReactiveConfig;
      centerY?: AudioReactiveConfig;
    };
  };
  tiling: {
    enabled: boolean;
    /** Tiling mode: 'both' tiles X+Y, 'horizontal' tiles X only, 'vertical' tiles Y only */
    mode: 'both' | 'horizontal' | 'vertical';
    /** Per-tile UV offset X (-1 to 1) */
    offsetX: number;
    /** Per-tile UV offset Y (-1 to 1) */
    offsetY: number;
    audioReactive?: {
      offsetX?: AudioReactiveConfig;
      offsetY?: AudioReactiveConfig;
    };
  };
  pixelation: {
    enabled: boolean;
    /** Base pixel size (1-100) */
    pixelSize: number;
    /** Pixelation effect mode */
    mode: 'continuous' | 'random-origin' | 'pixel-rain' | 'wave' | 'pulse';
    /** Speed for wave mode (pixels per second) */
    waveSpeed: number;
    /** Direction for wave mode */
    waveDirection: 'horizontal' | 'vertical';
    /** Number of rain spots for pixel-rain mode */
    rainSpotCount: number;
    /** Growth speed for rain spots (seconds to full size) */
    rainGrowthSpeed: number;
    /** How long rain spots last (seconds) */
    rainDuration: number;
    /** Pulse speed for pulse mode */
    pulseSpeed: number;
    /** Pulse origin */
    pulseOrigin: 'center' | 'edges';
    /** Random mode interval */
    randomInterval: {
      enabled: boolean;
      min: number;
      max: number;
    };
    /** Audio reactivity for pixel size */
    audioReactive: AudioReactiveConfig;
    /** Audio reactivity for area of effect (radius/width) */
    audioReactiveArea?: AudioReactiveConfig;
    /** Step size for pixelation (quantizes the pixel size) */
    pixelSizeStep?: number;
  };
  noiseOverlay: {
    enabled: boolean;
    /** Opacity of the noise overlay (0-1) */
    opacity: number;
    /** Size of the noise blocks (1.0 = sharpest) */
    grainSize?: number;
    /** Speed of the horizontal rolling interference bands */
    vSyncSpeed?: number;
    /** Whether to animate the noise with jitter */
    animated: boolean;
    /** Amount of pixel jitter when animated */
    jitterAmount: number;
    /** How often to shuffle the grain pattern (frames) */
    shuffleRate?: number;
    /** Bundle of custom grain texture URLs */
    grainBundle?: string[];
    /** CSS blend mode for compositing */
    blendMode:
      | 'overlay'
      | 'screen'
      | 'multiply'
      | 'soft-light'
      | 'hard-light'
      | 'difference'
      | 'normal';
    audioReactive: {
      opacity: AudioReactiveConfig;
      grainSize: AudioReactiveConfig;
      vSyncSpeed?: AudioReactiveConfig;
    };
  };

  brightness: {
    enabled: boolean;
    brightness: number;
    audioReactive: AudioReactiveConfig;
  };
  contrast: {
    enabled: boolean;
    contrast: number;
    midpoint: number;
    audioReactive: AudioReactiveConfig;
  };
  saturation: {
    enabled: boolean;
    saturation: number;
    weightMode: 'perceptual' | 'uniform';
    clamp: boolean;
    audioReactive: AudioReactiveConfig;
  };
  hueShift: {
    enabled: boolean;
    hue: number;
    audioReactive: AudioReactiveConfig;
  };
  bulbFlicker: {
    enabled: boolean;
    intensity: number;
    audioReactive: AudioReactiveConfig;
  };
  gateJitter: {
    enabled: boolean;
    intensity: number;
    audioReactive: AudioReactiveConfig;
  };
  sepia: {
    enabled: boolean;
    intensity: number;
    audioReactive: AudioReactiveConfig;
  };

  /** LUT Color Grading — pre-baked color profiles */
  lut: {
    enabled: boolean;
    /** The active LUT preset */
    preset:
      | 'none'
      | 'tealOrange'
      | 'noir'
      | 'cineVibrant'
      | 'crushedBlacks'
      | 'coldShadows'
      | 'warmHighlights'
      | 'bleachBypass'
      | 'crossProcess';
    /** Blend intensity (0-1): 0 = original, 1 = full LUT) */
    intensity: number;
    audioReactive: AudioReactiveConfig;
  };

  /** Motion Blur / Echo — frame trailing/ghosting */
  motionBlur: {
    enabled: boolean;
    /** Number of echo/trail frames (1-16) */
    trailCount: number;
    /** Decay factor per frame (0-1, higher = longer trails) */
    decay: number;
    /** Overall intensity (0-1) */
    intensity: number;
    audioReactive: {
      intensity: AudioReactiveConfig;
      decay: AudioReactiveConfig;
    };
  };

  /** Lens Flare — anamorphic streaks and light leaks */
  lensFlare: {
    enabled: boolean;
    /** Flare brightness (0-3) */
    intensity: number;
    /** Luminance threshold to trigger flare (0-1) */
    threshold: number;
    /** Horizontal streak length (0-1) */
    streakLength: number;
    /** Number of ghost reflections (0-8) */
    ghostCount: number;
    /** Spacing between ghosts */
    ghostSpacing: number;
    /** Flare tint color */
    tintColor: string;
    /** Enable anamorphic horizontal streaks */
    anamorphic: boolean;
    audioReactive: {
      intensity: AudioReactiveConfig;
      threshold: AudioReactiveConfig;
    };
  };

  /** Camera Shake — beat-synced shake/zoom pulses */
  cameraShake: {
    enabled: boolean;
    /** Maximum XY displacement (0-0.05) */
    intensity: number;
    /** Shake frequency (Hz, 1-60) */
    frequency: number;
    /** Damping factor (0-1, higher = quicker decay) */
    damping: number;
    /** Include rotation wobble */
    rotational: boolean;
    /** Max rotation angle in degrees */
    maxRotation: number;
    audioReactive: {
      intensity: AudioReactiveConfig;
      frequency: AudioReactiveConfig;
    };
  };

  /** Background/Image Opacity — controls media layer transparency */
  bgOpacity: {
    enabled: boolean;
    /** Opacity from 0.0 (transparent) to 1.0 (opaque) */
    opacity: number;
    audioReactive: AudioReactiveConfig;
  };

  /** Background Blur — applies blur to the background/media layer */
  bgBlur: {
    enabled: boolean;
    /** Blur radius (0 = no blur) */
    amount: number;
    /** Blur algorithm type */
    blurType: 'gaussian' | 'box' | 'motion' | 'radial';
    audioReactive: AudioReactiveConfig;
  };

  /**
   * Secondary Background Image Overlay — composites a second uploaded image on
   * top of the primary background, below the lyrics. Opacity is audio-reactive
   * and the layer can be gated on an audio band threshold; when it turns on it
   * either fades in over `gateAttack` seconds or appears at full opacity.
   */
  bgImageOverlay: {
    enabled: boolean;
    /**
     * IndexedDB asset key for the user-uploaded image (stable across reloads).
     * Undefined ⇒ no image chosen yet (layer renders nothing). NEVER a blob:
     * URL or data URL — those don't survive project reload.
     */
    imageAssetId?: string;
    /** Base opacity 0..1 (multiplied by AR + gate/fade). */
    opacity: number;
    /** How the image fits the frame. */
    fit: 'cover' | 'contain' | 'stretch';
    /** Blend mode for compositing the overlay over the background. */
    blendMode: 'normal' | 'additive' | 'screen' | 'multiply';
    /** Audio-reactive opacity (band → 0..1 multiplier envelope). */
    audioReactive: AudioReactiveConfig;
    /**
     * Optional gate. When present, a rising edge of the chosen band past
     * `threshold` FIRES the layer for `duration` seconds (edge-triggered, like a
     * strike), then it turns off. `cooldown` blocks the NEXT fire until it has
     * elapsed since the last fire (it does NOT keep the layer visible).
     * Undefined (or gate.enabled === false) ⇒ always on.
     */
    gate?: {
      enabled: boolean;
      band: 'bass' | 'mid' | 'treb';
      threshold: number;
      /** Minimum seconds between fires (re-trigger lock, NOT a sustain window). */
      cooldown: number;
      /** How long the layer stays on after a fire, in seconds (down to 0.01). */
      duration: number;
      /** Flash/strobe the opacity while active (a lightning-flash look). */
      flash: boolean;
    };
    /** When gated on: true ⇒ fade in over gateAttack; false ⇒ pop to full. */
    gateFadeIn: boolean;
    /** Fade-in duration in seconds (used only when gateFadeIn). */
    gateAttack: number;
  };
}

/** Effect layer identifiers for ordering */
export type PostProcessingEffectId =
  | 'particles'
  | 'rain'
  | 'bloom'
  | 'chromaticAberration'
  | 'glitch'
  | 'vhsTracking'
  | 'oldFilm'
  | 'bulbFlicker'
  | 'gateJitter'
  | 'sepia'
  | 'chainLightning'
  | 'distortion'
  | 'starfield'
  | 'zoom'
  | 'pixelation'
  | 'noiseOverlay'
  | 'slide'
  | 'rotate'
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'hueShift'
  | 'lut'
  | 'motionBlur'
  | 'lensFlare'
  | 'cameraShake'
  | 'bgOpacity'
  | 'bgBlur'
  | 'visualizer';
