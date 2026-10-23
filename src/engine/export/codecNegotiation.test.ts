/**
 * codecNegotiation.test.ts
 *
 * ─── WHAT THESE TESTS PROTECT ──────────────────────────────────────────────
 * Video export once threw `NotSupportedError: Operation is not supported` on
 * Firefox, and separately reported every codec unsupported. Both were caused by
 * a codec negotiation that assumed hardware H.264 and trusted
 * isConfigSupported() without confirming configure(). This suite pins the fixed
 * behaviour so that regression cannot return unnoticed.
 *
 * Each test documents the real-world browser fact it defends. If one of these
 * fails after a refactor, do NOT relax the test — the negotiation has lost a
 * property that a shipping browser depends on. The negotiation is dependency-
 * injected (isConfigSupported / tryConfigure) precisely so these facts can be
 * simulated without a real WebCodecs runtime (jsdom has none).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  negotiateVideoCodec,
  codecOrderFor,
  bitrateLadder,
  ACCEL_PASSES,
  negotiateAudioCodec,
  AUDIO_CANDIDATES,
  negotiateVideoDecoder,
  type NegotiationDeps,
  type AudioNegotiationDeps,
  type DecoderNegotiationDeps,
} from './codecNegotiation';
import { CODEC_PROFILES } from '@/types/export';

const H264_STRINGS = new Set([
  ...CODEC_PROFILES.h264.hardwareCandidates,
  ...CODEC_PROFILES.h264.softwareFallbacks,
]);

const baseInput = {
  codec: 'h264' as const,
  width: 1920,
  height: 1080,
  videoBitrate: 8_000_000,
  fps: 30,
};

/** A deps double that accepts a config only when the predicate says so, and
 *  records every candidate offered to each stage so tests can assert order. */
function makeDeps(opts: {
  isSupported: (c: VideoEncoderConfig) => boolean;
  configures?: (c: VideoEncoderConfig) => boolean;
}): NegotiationDeps & {
  supportedCalls: VideoEncoderConfig[];
  configureCalls: VideoEncoderConfig[];
} {
  const supportedCalls: VideoEncoderConfig[] = [];
  const configureCalls: VideoEncoderConfig[] = [];
  return {
    supportedCalls,
    configureCalls,
    isConfigSupported: vi.fn(async (c: VideoEncoderConfig) => {
      supportedCalls.push(c);
      return { supported: opts.isSupported(c), config: c };
    }),
    tryConfigure: vi.fn(async (c: VideoEncoderConfig) => {
      configureCalls.push(c);
      return opts.configures ? opts.configures(c) : true;
    }),
  };
}

describe('negotiateVideoCodec — Firefox software-encoder contract', () => {
  it('FINDS a codec when the browser only encodes in software (Firefox has no hardware H.264)', async () => {
    // Firefox reports prefer-hardware UNsupported for H.264 but accepts it under
    // no-preference (software openh264/ffvpx). If negotiation only ever probed
    // prefer-hardware, Firefox would get zero codecs and export would be dead.
    const deps = makeDeps({
      isSupported: (c) => c.hardwareAcceleration !== 'prefer-hardware' && H264_STRINGS.has(c.codec),
    });

    const result = await negotiateVideoCodec(baseInput, deps);

    expect(result).not.toBeNull();
    expect(result!.muxerCodec).toBe('avc');
    // The accepted config must NOT be a prefer-hardware one.
    expect(result!.config.hardwareAcceleration).not.toBe('prefer-hardware');
    // It must have actually tried a prefer-hardware pass first (and been rejected)
    // before reaching the software-capable pass — proving the pass order holds.
    expect(deps.supportedCalls.some((c) => c.hardwareAcceleration === 'prefer-hardware')).toBe(
      true,
    );
  });

  it('SKIPS a config that isConfigSupported approves but configure() rejects', async () => {
    // The core NotSupportedError bug: isConfigSupported returned true for a
    // config that configure() then threw on. Negotiation MUST confirm with a
    // real configure() and move on, not commit to the first "supported" config.
    let firstApprovedCodec: string | null = null;
    const deps = makeDeps({
      // Everything H.264 claims supported…
      isSupported: (c) => H264_STRINGS.has(c.codec),
      // …but the very first candidate offered to configure() throws; the rest work.
      configures: (c) => {
        if (firstApprovedCodec === null) {
          firstApprovedCodec = c.codec;
          return false; // simulate NotSupportedError at configure()
        }
        return true;
      },
    });

    const result = await negotiateVideoCodec(baseInput, deps);

    expect(result).not.toBeNull();
    // Negotiation must have kept going past the configure() failure.
    expect(deps.configureCalls.length).toBeGreaterThan(1);
    // And the returned config is one that actually configured cleanly.
    expect(result!.config.codec).not.toBe(firstApprovedCodec);
  });

  it('NEVER returns a config that failed configure(), even if isConfigSupported said yes', async () => {
    // Belt-and-braces on the property above: if configure() rejects EVERYTHING,
    // the result is null — a fatal mid-export throw must not be possible from a
    // config this function returned.
    const deps = makeDeps({
      isSupported: () => true, // browser lies: says everything is supported
      configures: () => false, // but nothing actually configures
    });

    const result = await negotiateVideoCodec(baseInput, deps);
    expect(result).toBeNull();
  });

  it('returns null (no fatal throw) when the browser supports nothing', async () => {
    // Old Safari / no-WebCodecs path. A null result lets the caller surface a
    // clean "unsupported browser" message instead of crashing the export.
    const deps = makeDeps({ isSupported: () => false });
    const result = await negotiateVideoCodec(baseInput, deps);
    expect(result).toBeNull();
  });

  it('treats an isConfigSupported that THROWS as unsupported, not fatal', async () => {
    // Some browsers throw from isConfigSupported for exotic strings. Negotiation
    // must swallow that per-candidate and keep probing, never propagate it.
    const deps: NegotiationDeps = {
      isConfigSupported: vi.fn(async (c: VideoEncoderConfig) => {
        if (c.codec.startsWith('hev1') || c.codec.startsWith('av01')) throw new Error('bad codec');
        return { supported: H264_STRINGS.has(c.codec), config: c };
      }),
      tryConfigure: vi.fn(async () => true),
    };
    // Request HEVC so the throwing family is probed first, then falls back to H264.
    const result = await negotiateVideoCodec({ ...baseInput, codec: 'hevc' }, deps);
    expect(result).not.toBeNull();
    expect(result!.muxerCodec).toBe('avc'); // fell back to H.264
  });
});

describe('negotiateVideoCodec — Chrome hardware path is unregressed', () => {
  it('prefers a hardware config when the browser offers one', async () => {
    // Chrome must keep taking the hardware encoder (the fast path) — the Firefox
    // fix must not accidentally down-rank Chrome to software.
    const deps = makeDeps({
      isSupported: (c) => H264_STRINGS.has(c.codec), // hardware works
    });
    const result = await negotiateVideoCodec(baseInput, deps);
    expect(result).not.toBeNull();
    expect(result!.config.hardwareAcceleration).toBe('prefer-hardware');
  });
});

describe('negotiateVideoCodec — requested-family and bitrate behaviour', () => {
  it('honours the requested codec family before falling back to H.264', async () => {
    const deps = makeDeps({ isSupported: (c) => c.codec.startsWith('av01') });
    const result = await negotiateVideoCodec({ ...baseInput, codec: 'av1' }, deps);
    expect(result).not.toBeNull();
    expect(result!.muxerCodec).toBe('av1');
  });

  it('steps the bitrate down when a very high request is rejected', async () => {
    // Requests above ~120 Mbps are rejected by some encoders; negotiation must
    // retry at the lower ceilings rather than fail outright.
    const deps = makeDeps({
      isSupported: (c) => H264_STRINGS.has(c.codec) && (c.bitrate ?? 0) <= 120_000_000,
    });
    const result = await negotiateVideoCodec({ ...baseInput, videoBitrate: 200_000_000 }, deps);
    expect(result).not.toBeNull();
    expect(result!.bitrate).toBe(120_000_000);
  });
});

describe('negotiation ordering primitives', () => {
  it('ACCEL_PASSES reaches software AFTER hardware but does include no-preference', () => {
    // The ORDER is the contract: hardware first (Chrome fast path), then
    // no-preference (Firefox software H.264), then explicit software.
    expect(ACCEL_PASSES[0]).toBe('prefer-hardware');
    expect(ACCEL_PASSES).toContain('no-preference');
    expect(ACCEL_PASSES.indexOf('no-preference')).toBeGreaterThan(
      ACCEL_PASSES.indexOf('prefer-hardware'),
    );
  });

  it('codecOrderFor always appends H.264 as the universal fallback', () => {
    expect(codecOrderFor('av1')).toEqual(['av1', 'h264']);
    expect(codecOrderFor('hevc')).toEqual(['hevc', 'h264']);
    // h264 requested → no duplicate.
    expect(codecOrderFor('h264')).toEqual(['h264']);
  });

  it('bitrateLadder descends only for high requests', () => {
    expect(bitrateLadder(8_000_000)).toEqual([8_000_000]);
    expect(bitrateLadder(200_000_000)).toEqual([200_000_000, 120_000_000, 80_000_000, 50_000_000]);
  });
});

describe('negotiateAudioCodec — Firefox AAC-encode gap', () => {
  const audioInput = { sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 };

  function makeAudioDeps(opts: {
    isSupported: (c: AudioEncoderConfig) => boolean;
    configures?: (c: AudioEncoderConfig) => boolean;
  }): AudioNegotiationDeps {
    return {
      isConfigSupported: vi.fn(async (c: AudioEncoderConfig) => ({
        supported: opts.isSupported(c),
        config: c,
      })),
      tryConfigure: vi.fn(async (c: AudioEncoderConfig) =>
        opts.configures ? opts.configures(c) : true,
      ),
    };
  }

  it('prefers AAC when the browser can encode it (Chrome/Edge)', async () => {
    // AAC-in-MP4 is the universal-compatibility default; a browser that encodes
    // it must keep getting it.
    const deps = makeAudioDeps({ isSupported: (c) => c.codec === 'mp4a.40.2' });
    const result = await negotiateAudioCodec(audioInput, deps);
    expect(result).not.toBeNull();
    expect(result!.muxerCodec).toBe('aac');
    expect(result!.config.codec).toBe('mp4a.40.2');
  });

  it('falls back to Opus when AAC cannot be ENCODED (the Firefox failure mode)', async () => {
    // Firefox's WebCodecs AudioEncoder decodes AAC but cannot encode it — it
    // reports mp4a.40.2 unsupported (or fails configure) and encodes Opus. The
    // export must switch to Opus-in-MP4 rather than throw NotSupportedError.
    const deps = makeAudioDeps({ isSupported: (c) => c.codec === 'opus' });
    const result = await negotiateAudioCodec(audioInput, deps);
    expect(result).not.toBeNull();
    expect(result!.muxerCodec).toBe('opus');
    expect(result!.config.codec).toBe('opus');
  });

  it('falls back to Opus when AAC is reported supported but configure() rejects it', async () => {
    // The exact bug the console showed: isConfigSupported can lie / configure()
    // throws async. A config that does not actually configure must be skipped.
    const deps = makeAudioDeps({
      isSupported: () => true, // both claim supported
      configures: (c) => c.codec === 'opus', // but only Opus really configures
    });
    const result = await negotiateAudioCodec(audioInput, deps);
    expect(result).not.toBeNull();
    expect(result!.muxerCodec).toBe('opus');
  });

  it('returns null (→ caller exports video-only) when NEITHER audio codec encodes', async () => {
    // No fatal throw: a browser with no usable audio encoder must still export
    // video, silently dropping audio with a warning — never abort the export.
    const deps = makeAudioDeps({ isSupported: () => false });
    const result = await negotiateAudioCodec(audioInput, deps);
    expect(result).toBeNull();
  });

  it('AUDIO_CANDIDATES lists AAC before Opus (compatibility order is the contract)', () => {
    expect(AUDIO_CANDIDATES[0].muxer).toBe('aac');
    expect(AUDIO_CANDIDATES.map((c) => c.muxer)).toContain('opus');
    expect(AUDIO_CANDIDATES.findIndex((c) => c.muxer === 'aac')).toBeLessThan(
      AUDIO_CANDIDATES.findIndex((c) => c.muxer === 'opus'),
    );
  });
});

// ─── Video DECODER negotiation ─────────────────────────────────────────────
//
// WHAT THESE PROTECT: background-video export once aborted with
// `[VideoFrameExtractor] Codec not supported: "avc1.64001e"` because the
// decoder config was probed with hardwareAcceleration:'prefer-hardware' ONLY.
// H.264 High profile has no hardware decoder on many machines but decodes in
// software, so the hardware-only probe reported the codec unsupported and
// killed the export. negotiateVideoDecoder must try every acceleration mode.

/** Decoder deps double: accept a config only when the predicate says so, and
 *  record every candidate offered so tests can assert probe order. */
function makeDecoderDeps(
  isSupported: (c: VideoDecoderConfig) => boolean,
): DecoderNegotiationDeps & {
  supportedCalls: VideoDecoderConfig[];
} {
  const supportedCalls: VideoDecoderConfig[] = [];
  return {
    supportedCalls,
    isConfigSupported: vi.fn(async (c: VideoDecoderConfig) => {
      supportedCalls.push(c);
      return { supported: isSupported(c), config: c };
    }),
  };
}

const decoderInput = {
  codec: 'avc1.64001e', // H.264 High@L3.0 — the exact codec from the console error
  codedWidth: 1280,
  codedHeight: 720,
};

describe('negotiateVideoDecoder', () => {
  it('accepts the hardware pass when hardware decode IS available (Chrome fast path)', async () => {
    const deps = makeDecoderDeps(() => true);
    const config = await negotiateVideoDecoder(decoderInput, deps);
    expect(config).not.toBeNull();
    expect(config!.codec).toBe('avc1.64001e');
    // First probe wins, no need to walk further passes.
    expect(deps.supportedCalls).toHaveLength(1);
    expect(deps.supportedCalls[0].hardwareAcceleration).toBe('prefer-hardware');
  });

  it('falls through to a software pass when the codec has NO hardware decoder', async () => {
    // The bug: prefer-hardware reports unsupported for High profile. The
    // negotiation must keep going and succeed on a later pass.
    const deps = makeDecoderDeps((c) => c.hardwareAcceleration !== 'prefer-hardware');
    const config = await negotiateVideoDecoder(decoderInput, deps);
    expect(config).not.toBeNull();
    expect(config!.hardwareAcceleration).toBe('no-preference');
    // Proves it did not stop at the hardware pass.
    expect(deps.supportedCalls[0].hardwareAcceleration).toBe('prefer-hardware');
    expect(deps.supportedCalls[1].hardwareAcceleration).toBe('no-preference');
  });

  it('reaches prefer-software when only software decode works', async () => {
    const deps = makeDecoderDeps((c) => c.hardwareAcceleration === 'prefer-software');
    const config = await negotiateVideoDecoder(decoderInput, deps);
    expect(config).not.toBeNull();
    expect(config!.hardwareAcceleration).toBe('prefer-software');
    expect(deps.supportedCalls.map((c) => c.hardwareAcceleration)).toEqual(ACCEL_PASSES);
  });

  it('probes acceleration modes in the SAME order as the encoder (ACCEL_PASSES)', async () => {
    const deps = makeDecoderDeps(() => false); // force all passes to run
    await negotiateVideoDecoder(decoderInput, deps);
    expect(deps.supportedCalls.map((c) => c.hardwareAcceleration)).toEqual(ACCEL_PASSES);
  });

  it('returns null (→ caller falls back to image texture) when no mode supports the codec', async () => {
    // A genuinely undecodable codec must return null so DecoupledExporter can
    // degrade to a still image rather than crash the export.
    const deps = makeDecoderDeps(() => false);
    const config = await negotiateVideoDecoder(decoderInput, deps);
    expect(config).toBeNull();
  });

  it('skips a pass whose isConfigSupported THROWS instead of returning false', async () => {
    // Some browsers throw from isConfigSupported rather than returning
    // {supported:false}; a thrown pass must not abort negotiation.
    const deps: DecoderNegotiationDeps & { supportedCalls: VideoDecoderConfig[] } = {
      supportedCalls: [],
      isConfigSupported: vi.fn(async (c: VideoDecoderConfig) => {
        deps.supportedCalls.push(c);
        if (c.hardwareAcceleration === 'prefer-hardware') throw new Error('probe blew up');
        return { supported: c.hardwareAcceleration === 'no-preference', config: c };
      }),
    };
    const config = await negotiateVideoDecoder(decoderInput, deps);
    expect(config).not.toBeNull();
    expect(config!.hardwareAcceleration).toBe('no-preference');
  });

  it('threads the demuxer codec-private description through to the resolved config', async () => {
    // avcC/hvcC private data must survive negotiation or decode fails.
    const description = new Uint8Array([1, 100, 0, 30]);
    const deps = makeDecoderDeps(() => true);
    const config = await negotiateVideoDecoder({ ...decoderInput, description }, deps);
    expect(config).not.toBeNull();
    expect(config!.description).toBe(description);
  });
});
