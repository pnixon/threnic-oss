/**
 * Export Configuration Types
 * Defines quality tiers, aspect ratios, codecs, frame rates, and export settings
 */

export type QualityKey = 'Ultra' | 'High' | 'Medium' | 'Low';
export type AspectKey = 'Landscape' | 'Portrait' | 'Square';
export type CodecKey = 'h264' | 'hevc' | 'av1';
export type FpsKey = 24 | 30 | 60;
export type BitrateKey = 'Low' | 'Medium' | 'High' | 'Max';

export const BITRATE_TIERS: Record<
  BitrateKey,
  { label: string; description: string; multiplier: number }
> = {
  Low: {
    label: 'Low (Compact)',
    description: 'Best for small file sizes',
    multiplier: 0.07,
  },
  Medium: {
    label: 'Medium (Standard)',
    description: 'Recommended balance of size and quality',
    multiplier: 0.15,
  },
  High: {
    label: 'High (Lossless-ish)',
    description: 'Greatly reduces compression artifacts in fast-motion scenes',
    multiplier: 0.3,
  },
  Max: {
    label: 'Maximum',
    description: 'Production quality, large file size',
    multiplier: 0.5,
  },
};

export const QUALITY_TIERS: Record<QualityKey, { baseHeight: number; label: string }> = {
  Ultra: { baseHeight: 2160, label: 'Ultra (4K)' },
  High: { baseHeight: 1080, label: 'High (1080p)' },
  Medium: { baseHeight: 720, label: 'Medium (720p)' },
  Low: { baseHeight: 480, label: 'Low (480p)' },
};

export const ASPECT_RATIOS: Record<
  AspectKey,
  { ratio: number; label: string; widthMult: number; heightMult: number }
> = {
  Landscape: { ratio: 16 / 9, label: 'Landscape (16:9)', widthMult: 16 / 9, heightMult: 1 },
  Portrait: { ratio: 9 / 16, label: 'Portrait (9:16)', widthMult: 9 / 16, heightMult: 1 },
  Square: { ratio: 1, label: 'Square (1:1)', widthMult: 1, heightMult: 1 },
};

/**
 * Codec profiles — each defines a set of WebCodecs codec strings to probe
 * (ordered from highest quality to most compatible) and the mediabunny muxer codec name.
 */
export const CODEC_PROFILES: Record<
  CodecKey,
  {
    label: string;
    description: string;
    /** Codec name for mediabunny EncodedVideoPacketSource */
    muxerCodec: 'avc' | 'hevc' | 'av1';
    /** WebCodecs codec strings to probe, ordered from best→most-compatible */
    hardwareCandidates: string[];
    /** Software fallback codec strings */
    softwareFallbacks: string[];
  }
> = {
  av1: {
    label: 'AV1 (Highest Quality)',
    description: 'Best compression efficiency, requires newer hardware/modern GPUs',
    muxerCodec: 'av1',
    hardwareCandidates: [
      'av01.0.16M.08', // Main profile, L5.3, 8-bit
      'av01.0.13M.08', // Main profile, L5.0, 8-bit
      'av01.0.12M.08', // Main profile, L4.3, 8-bit
      'av01.0.09M.08', // Main profile, L4.0, 8-bit
      'av01.0.08M.08', // Main profile, L3.3, 8-bit
      'av01.0.04M.08', // Main profile, L3.0, 8-bit
    ],
    softwareFallbacks: ['av01.0.04M.08', 'av01.0.08M.08'],
  },
  hevc: {
    label: 'H.265 (HEVC)',
    description: 'Excellent balance of quality and file size, widely supported',
    muxerCodec: 'hevc',
    hardwareCandidates: [
      'hev1.1.6.L153.B0', // Main profile, L5.1
      'hev1.1.6.L150.B0', // Main profile, L5.0
      'hev1.1.6.L123.B0', // Main profile, L4.1
      'hev1.1.6.L120.B0', // Main profile, L4.0
      'hev1.1.6.L93.B0', // Main profile, L3.1
      'hvc1.1.6.L153.B0', // Alternative tag, L5.1
      'hvc1.1.6.L120.B0', // Alternative tag, L4.0
    ],
    softwareFallbacks: ['hev1.1.6.L120.B0', 'hvc1.1.6.L120.B0'],
  },
  h264: {
    label: 'H.264 (AVC - Universal)',
    description: 'Most compatible/fastest encoding, lowest compression quality',
    muxerCodec: 'avc',
    hardwareCandidates: [
      'avc1.640034', // High profile, L5.2
      'avc1.4d0034', // Main profile, L5.2
      'avc1.640033', // High profile, L5.1
      'avc1.4d0033', // Main profile, L5.1
      'avc1.420034', // Baseline profile, L5.2
      'avc1.420033', // Baseline profile, L5.1
      'avc1.64002a', // High profile, L4.2
      'avc1.4d002a', // Main profile, L4.2
    ],
    softwareFallbacks: ['avc1.4d0034', 'avc1.4d0033'],
  },
};

/**
 * Frame rate options for export
 */
export const FPS_OPTIONS: { value: FpsKey; label: string }[] = [
  { value: 60, label: '60 FPS' },
  { value: 30, label: '30 FPS' },
  { value: 24, label: '24 FPS' },
];

/**
 * Progress data emitted during the export process.
 */
export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  currentTime: number;
  totalDuration: number;
  percentage: number;
  relativeTime: number;
  trackIndex: number;
  trackName?: string;
  framePreview?: string;
  avgFps?: number;
  /** Rolling FPS over the last 5 seconds of wall-clock time */
  recentFps?: number;
  etaSeconds?: number;
  /** Object URL of a periodic snapshot from the offscreen renderer */
  snapshotUrl?: string;
}

export function calcDimensions(
  quality: QualityKey,
  aspect: AspectKey,
): { width: number; height: number } {
  const base = QUALITY_TIERS[quality].baseHeight;

  // All codecs require even dimensions - round to nearest even number
  const toEven = (n: number) => Math.round(n / 2) * 2;

  if (aspect === 'Landscape') {
    return { width: toEven(base * (16 / 9)), height: base };
  }

  if (aspect === 'Portrait') {
    return { width: base, height: toEven(base * (16 / 9)) };
  }

  return { width: base, height: base };
}
