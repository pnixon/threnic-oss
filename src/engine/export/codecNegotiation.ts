/**
 * codecNegotiation.ts
 *
 * Pure WebCodecs codec negotiation, extracted from StreamableExportController
 * so its behaviour can be unit-tested without a live WebCodecs runtime (jsdom
 * has no VideoEncoder).
 *
 * ─── WHY THIS EXISTS (do not regress) ──────────────────────────────────────
 * Video export was broken on Firefox with `NotSupportedError: Operation is not
 * supported`. Firefox 130+ fully supports WebCodecs, BUT:
 *
 *   • It has NO hardware H.264 encoder — it encodes H.264 in software
 *     (openh264/ffvpx). Probing with `hardwareAcceleration: 'prefer-hardware'`
 *     only therefore reports every codec unsupported on Firefox.
 *
 *   • `VideoEncoder.isConfigSupported()` can return `supported: true` for a
 *     config that `configure()` then rejects. Trusting isConfigSupported alone
 *     picks a config that dies fatally at configure/encode time.
 *
 * The negotiation below defends BOTH facts:
 *
 *   1. It tries three hardwareAcceleration passes in order —
 *      prefer-hardware → no-preference → prefer-software — so a software-only
 *      encoder (Firefox) is still found after the hardware pass misses.
 *
 *   2. It VALIDATES each candidate by actually constructing an encoder and
 *      calling configure(); a config that passes isConfigSupported but throws
 *      at configure is skipped during negotiation instead of killing the export.
 *
 * If you change this, keep codecNegotiation.test.ts green — those tests encode
 * the Firefox contract.
 */

import { CODEC_PROFILES, type CodecKey } from '@/types/export';

interface NegotiationInput {
  /** Preferred codec family (h264 / hevc / av1). */
  codec: CodecKey;
  width: number;
  height: number;
  /** Requested video bitrate; may be stepped down for very high values. */
  videoBitrate: number;
  fps: number;
}

interface NegotiatedCodec {
  config: VideoEncoderConfig;
  /** mediabunny muxer codec name for the chosen family. */
  muxerCodec: 'avc' | 'hevc' | 'av1';
  /** The bitrate actually accepted (may be lower than requested). */
  bitrate: number;
}

/**
 * Dependencies injected so tests can simulate Chrome (hardware ok), Firefox
 * (software-only + isConfigSupported/configure divergence) and unsupported
 * browsers without a real WebCodecs implementation.
 */
export interface NegotiationDeps {
  isConfigSupported: (
    config: VideoEncoderConfig,
  ) => Promise<{ supported?: boolean; config?: VideoEncoderConfig }>;
  /**
   * Attempt a real configure(). Resolves true when the config configures
   * cleanly, false when it throws (structurally or with NotSupportedError).
   */
  tryConfigure: (config: VideoEncoderConfig) => Promise<boolean>;
}

/** Acceleration passes, most-preferred first. no-preference precedes the
 *  explicit software pass so Firefox (no hardware H.264) is reached. */
export const ACCEL_PASSES: HardwarePreference[] = [
  'prefer-hardware',
  'no-preference',
  'prefer-software',
];

/** Codec probe order: the requested family first, then H.264 as the universal
 *  fallback (H.264 encode exists in every WebCodecs browser). */
export function codecOrderFor(preferred: CodecKey): CodecKey[] {
  const order: CodecKey[] = [preferred];
  if (preferred !== 'h264') order.push('h264');
  return order;
}

/** Bitrate ladder: try the requested bitrate, then progressively lower ceilings
 *  for very high requests some encoders reject. */
export function bitrateLadder(requested: number): number[] {
  const ladder = [requested];
  if (requested > 120_000_000) ladder.push(120_000_000);
  if (requested > 80_000_000) ladder.push(80_000_000);
  if (requested > 50_000_000) ladder.push(50_000_000);
  return ladder;
}

/**
 * Negotiate a usable VideoEncoder config. Returns null when nothing this
 * browser offers both reports supported AND configures cleanly.
 */
export async function negotiateVideoCodec(
  input: NegotiationInput,
  deps: NegotiationDeps,
): Promise<NegotiatedCodec | null> {
  const baseConfig: VideoEncoderConfig = {
    codec: 'avc1.4d0034', // placeholder, overwritten per candidate
    width: input.width,
    height: input.height,
    bitrate: input.videoBitrate,
    framerate: input.fps,
    latencyMode: 'quality',
    hardwareAcceleration: 'prefer-hardware',
  };

  const bitrates = bitrateLadder(input.videoBitrate);

  const validate = async (candidate: VideoEncoderConfig): Promise<boolean> => {
    let support: { supported?: boolean } | undefined;
    try {
      support = await deps.isConfigSupported(candidate);
    } catch {
      return false;
    }
    if (!support?.supported) return false;
    return deps.tryConfigure(candidate);
  };

  for (const codecKey of codecOrderFor(input.codec)) {
    const profile = CODEC_PROFILES[codecKey];
    // Hardware candidates cover high profiles/levels; software fallbacks are the
    // conservative Main-profile strings a software encoder accepts.
    const codecStrings = [...profile.hardwareCandidates, ...profile.softwareFallbacks];

    for (const accel of ACCEL_PASSES) {
      for (const bitrate of bitrates) {
        for (const codecStr of codecStrings) {
          const candidate: VideoEncoderConfig = {
            ...baseConfig,
            codec: codecStr,
            bitrate,
            hardwareAcceleration: accel,
          };
          if (await validate(candidate)) {
            return { config: candidate, muxerCodec: profile.muxerCodec, bitrate };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Real-runtime `tryConfigure` used by StreamableExportController. Spins up a
 * throwaway VideoEncoder, configures it, and reports whether it survived.
 */
export function makeRuntimeTryConfigure(): NegotiationDeps['tryConfigure'] {
  return async (candidate: VideoEncoderConfig): Promise<boolean> => {
    let probe: VideoEncoder | null = null;
    let asyncError = false;
    try {
      probe = new VideoEncoder({ output: () => {}, error: () => (asyncError = true) });
      probe.configure(candidate);
      // configure() throws synchronously for structural errors, but a codec the
      // browser cannot actually run (e.g. Firefox + a rejected config) surfaces
      // asynchronously via the error callback — give it a couple of ticks.
      await Promise.resolve();
      await Promise.resolve();
      return !asyncError && probe.state !== 'closed';
    } catch {
      return false;
    } finally {
      try {
        if (probe && probe.state !== 'closed') probe.close();
      } catch {
        /* noop */
      }
    }
  };
}

// ─── Video DECODER negotiation ─────────────────────────────────────────────
//
// WHY: background-video export decodes source clips through VideoDecoder. A
// clip encoded as H.264 High profile (e.g. `avc1.64001e` = High@L3.0) is
// universally decodable in SOFTWARE, but a machine/browser with no hardware
// High-profile decoder reports it unsupported under a `prefer-hardware`-only
// probe — so VideoFrameExtractor aborted the whole export even though a
// `no-preference`/`prefer-software` decode would have succeeded. Same shape as
// the encoder bug above: probe multiple acceleration modes, take the first the
// browser blesses. (isConfigSupported → configure divergence is not defended
// here because the decode path already degrades to a partial/empty decode via
// the decoder error callback rather than crashing the export.)

interface DecoderNegotiationInput {
  /** Codec string reported by the demuxer, e.g. `avc1.64001e`. */
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** Optional codec-private data (avcC/hvcC) from the demuxer. */
  description?: AllowSharedBufferSource;
}

export interface DecoderNegotiationDeps {
  isConfigSupported: (
    config: VideoDecoderConfig,
  ) => Promise<{ supported?: boolean; config?: VideoDecoderConfig }>;
}

/**
 * Negotiate a usable VideoDecoder config across acceleration modes. Returns the
 * browser-blessed config (which callers pass straight to `decoder.configure`),
 * or null when no acceleration mode supports the codec.
 */
export async function negotiateVideoDecoder(
  input: DecoderNegotiationInput,
  deps: DecoderNegotiationDeps,
): Promise<VideoDecoderConfig | null> {
  const baseConfig: VideoDecoderConfig = {
    codec: input.codec,
    codedWidth: input.codedWidth,
    codedHeight: input.codedHeight,
    ...(input.description ? { description: input.description } : {}),
  };

  for (const accel of ACCEL_PASSES) {
    let support: { supported?: boolean; config?: VideoDecoderConfig } | undefined;
    try {
      support = await deps.isConfigSupported({ ...baseConfig, hardwareAcceleration: accel });
    } catch {
      continue;
    }
    if (support?.supported) {
      return support.config ?? { ...baseConfig, hardwareAcceleration: accel };
    }
  }

  return null;
}

// ─── Audio codec negotiation ───────────────────────────────────────────────
// WHY: Firefox's WebCodecs AudioEncoder cannot ENCODE AAC (mp4a.40.2) — it only
// decodes it — and throws `NotSupportedError` (async, via the error callback)
// when configured for AAC. Chrome/Edge encode AAC fine. mediabunny can mux
// BOTH AAC and Opus into MP4, so we negotiate AAC first (best player
// compatibility) and fall back to Opus, which Firefox encodes.

/** Audio codec candidates, best-compatibility first. `webcodecs` is the
 *  VideoEncoder-style codec string; `muxer` is mediabunny's track codec name. */
interface AudioCandidate {
  webcodecs: string;
  muxer: 'aac' | 'opus';
}

export const AUDIO_CANDIDATES: AudioCandidate[] = [
  { webcodecs: 'mp4a.40.2', muxer: 'aac' }, // AAC-LC — universal MP4 audio
  { webcodecs: 'opus', muxer: 'opus' }, // Opus-in-MP4 — Firefox encode path
];

interface AudioNegotiationInput {
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

export interface NegotiatedAudio {
  config: AudioEncoderConfig;
  muxerCodec: 'aac' | 'opus';
}

export interface AudioNegotiationDeps {
  isConfigSupported: (
    config: AudioEncoderConfig,
  ) => Promise<{ supported?: boolean; config?: AudioEncoderConfig }>;
  tryConfigure: (config: AudioEncoderConfig) => Promise<boolean>;
}

/**
 * Negotiate a usable audio codec. Returns null when NEITHER AAC nor Opus can be
 * encoded — the caller should then export video-only rather than fail.
 */
export async function negotiateAudioCodec(
  input: AudioNegotiationInput,
  deps: AudioNegotiationDeps,
): Promise<NegotiatedAudio | null> {
  for (const candidate of AUDIO_CANDIDATES) {
    const config: AudioEncoderConfig = {
      codec: candidate.webcodecs,
      sampleRate: input.sampleRate,
      numberOfChannels: input.numberOfChannels,
      bitrate: input.bitrate,
    };
    let support: { supported?: boolean } | undefined;
    try {
      support = await deps.isConfigSupported(config);
    } catch {
      continue;
    }
    if (!support?.supported) continue;
    if (await deps.tryConfigure(config)) {
      return { config, muxerCodec: candidate.muxer };
    }
  }
  return null;
}

/** Real-runtime audio tryConfigure — same async-error detection as video. */
export function makeRuntimeAudioTryConfigure(): AudioNegotiationDeps['tryConfigure'] {
  return async (candidate: AudioEncoderConfig): Promise<boolean> => {
    let probe: AudioEncoder | null = null;
    let asyncError = false;
    try {
      probe = new AudioEncoder({ output: () => {}, error: () => (asyncError = true) });
      probe.configure(candidate);
      await Promise.resolve();
      await Promise.resolve();
      return !asyncError && probe.state !== 'closed';
    } catch {
      return false;
    } finally {
      try {
        if (probe && probe.state !== 'closed') probe.close();
      } catch {
        /* noop */
      }
    }
  };
}
