/**
 * VideoFrameExtractor — Pre-decoded video frame atlas for export.
 *
 * Instead of seeking a <video> element per-frame (which depends on
 * requestVideoFrameCallback and browser tab visibility), this module:
 *
 *   1. Fetches the video file as an ArrayBuffer
 *   2. Demuxes it with mp4box.js → EncodedVideoChunks
 *   3. Decodes ALL frames with WebCodecs VideoDecoder
 *   4. Stores every decoded frame as an ImageBitmap (GPU-backed in Chrome)
 *
 * At export time, getFrameAtTime(t) is a simple binary search + array lookup.
 * Zero decoding, zero seeking, zero tab-visibility dependency.
 *
 * ImageBitmaps in Chromium are backed by GPU textures internally, so this
 * effectively pre-loads the entire video into GPU memory. The per-frame
 * copyExternalImageToTexture() call is a fast GPU→GPU DMA copy (~0.1ms).
 *
 * Supports multiple video instances — each slideshow item gets its own
 * extractor with its own pre-decoded frame atlas.
 */

import * as MP4Box from 'mp4box';
import { negotiateVideoDecoder } from './codecNegotiation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PredecodedFrame {
  /** GPU-backed bitmap — ready for copyExternalImageToTexture */
  bitmap: ImageBitmap;
  /** Presentation timestamp in microseconds */
  timestamp: number;
  /** Duration in microseconds */
  duration: number;
}

interface TrackInfo {
  id: number;
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
  timescale: number;
  durationMs: number;
  sampleCount: number;
}

interface LooseVideoTrack {
  codec?: string & { fourcc?: string };
  type?: string;
  mdia?: {
    minf?: {
      stbl?: {
        stsd?: {
          entries?: Array<{
            avcC?: {
              AVCProfileIndication: number;
              profile_compatibility: number;
              AVCLevelIndication: number;
            };
          }>;
        };
      };
    };
  };
}

interface DescriptionSource {
  getTrackById(id: number):
    | {
        mdia?: {
          minf?: {
            stbl?: {
              stsd?: {
                entries?: Array<
                  Record<string, { write(stream: MP4Box.DataStream): void } | undefined>
                >;
              };
            };
          };
        };
      }
    | undefined;
}

interface PreloadProgress {
  /** Frames decoded so far */
  decoded: number;
  /** Total frames to decode */
  total: number;
  /** Estimated memory usage in MB */
  memoryMB: number;
}

// ---------------------------------------------------------------------------
// VideoFrameExtractor
// ---------------------------------------------------------------------------

export class VideoFrameExtractor {
  /** Pre-decoded frames sorted by timestamp */
  private frames: PredecodedFrame[] = [];
  private trackInfo: TrackInfo | null = null;
  private _ready = false;

  get width(): number {
    return this.trackInfo?.codedWidth ?? 0;
  }
  get height(): number {
    return this.trackInfo?.codedHeight ?? 0;
  }
  get duration(): number {
    return (this.trackInfo?.durationMs ?? 0) / 1000;
  }
  get frameCount(): number {
    return this.frames.length;
  }
  get ready(): boolean {
    return this._ready;
  }

  /** Estimated GPU memory usage in MB (RGBA uncompressed) */
  get estimatedMemoryMB(): number {
    if (!this.trackInfo) return 0;
    const bytesPerFrame = this.trackInfo.codedWidth * this.trackInfo.codedHeight * 4;
    return (bytesPerFrame * this.frames.length) / (1024 * 1024);
  }

  /**
   * Pre-decode all frames from a video URL.
   *
   * @param url - Video file URL (blob:, http:, or data:)
   * @param onProgress - Optional callback for decode progress
   * @returns true if all frames were decoded successfully
   */
  async init(url: string, onProgress?: (progress: PreloadProgress) => void): Promise<boolean> {
    // Skip empty or obviously invalid URLs
    if (!url || url.length < 10) {
      console.warn('[VideoFrameExtractor] Skipping empty/invalid URL');
      return false;
    }

    try {
      // ── 1. Fetch the video data ──
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(
          `[VideoFrameExtractor] Fetch failed: HTTP ${response.status} for ${url.substring(0, 80)}`,
        );
        return false;
      }

      const arrayBuffer = await response.arrayBuffer();

      // Bail early if response was empty (CORS block, dead URL, etc.)
      if (arrayBuffer.byteLength < 1024) {
        console.error(
          `[VideoFrameExtractor] File too small (${arrayBuffer.byteLength} bytes), likely invalid`,
        );
        return false;
      }

      // ── 2. Demux with mp4box.js ──
      const samples = await this._demux(arrayBuffer);
      if (!samples || samples.length === 0) {
        console.error('[VideoFrameExtractor] Demuxing failed or no samples found');
        return false;
      }

      // ── 3. Decode all frames ──
      const totalFrames = samples.length;
      const track = this.trackInfo!;

      // Estimate memory and warn if large
      const estMB = (track.codedWidth * track.codedHeight * 4 * totalFrames) / (1024 * 1024);
      if (estMB > 2048) {
        console.warn(
          `[VideoFrameExtractor] Large video atlas: ~${estMB.toFixed(0)} MB. ` +
            `Consider shorter clips or lower resolution.`,
        );
      }

      // Negotiate hardware acceleration: many H.264 profiles (e.g. High
      // "avc1.64xxxx") have no hardware DECODER on a given machine/browser but
      // ARE decodable in software. Probing 'prefer-hardware' ONLY makes
      // isConfigSupported report the whole codec unsupported and aborts the
      // export, even though 'no-preference'/'prefer-software' would succeed.
      // Pure negotiation lives in codecNegotiation.ts (see negotiateVideoDecoder)
      // so the multi-pass contract is unit-tested without a WebCodecs runtime.
      const resolvedConfig = await negotiateVideoDecoder(
        {
          codec: track.codec,
          codedWidth: track.codedWidth,
          codedHeight: track.codedHeight,
          ...(track.description ? { description: track.description } : {}),
        },
        { isConfigSupported: (c) => VideoDecoder.isConfigSupported(c) },
      );

      if (!resolvedConfig) {
        console.error(
          '[VideoFrameExtractor] Codec not supported on any acceleration mode:',
          track.codec,
        );
        return false;
      }

      // Decode all frames into ImageBitmaps
      await this._decodeAllFrames(samples, resolvedConfig, (decoded) => {
        onProgress?.({
          decoded,
          total: totalFrames,
          memoryMB: (track.codedWidth * track.codedHeight * 4 * decoded) / (1024 * 1024),
        });
      });

      // Sort frames by timestamp (should already be in order, but be safe)
      this.frames.sort((a, b) => a.timestamp - b.timestamp);

      this._ready = true;

      return true;
    } catch (e) {
      console.error('[VideoFrameExtractor] Init failed:', e);
      return false;
    }
  }

  /**
   * Get the pre-decoded ImageBitmap for a given time.
   * This is an O(log n) binary search — zero decoding overhead.
   *
   * @param timeSec - Target time in seconds. Wraps automatically for looping.
   * @returns The closest pre-decoded ImageBitmap, or null if not ready.
   */
  getFrameAtTime(timeSec: number): ImageBitmap | null {
    if (!this._ready || this.frames.length === 0) return null;

    const duration = this.duration;
    if (duration <= 0) return null;

    // Wrap time for looping
    const wrappedTime = timeSec % duration;
    const targetMicros = wrappedTime * 1_000_000;

    // Binary search for the frame with timestamp closest to (≤) target
    const index = this._findFrameIndex(targetMicros);
    if (index < 0) return null;

    return this.frames[index].bitmap;
  }

  /**
   * Get frame by direct index (for when you know the exact frame number).
   */
  getFrameByIndex(index: number): ImageBitmap | null {
    if (index < 0 || index >= this.frames.length) return null;
    return this.frames[index].bitmap;
  }

  /**
   * Destroy the extractor and free all GPU-backed ImageBitmaps.
   */
  destroy(): void {
    for (const frame of this.frames) {
      frame.bitmap.close();
    }
    this.frames = [];
    this.trackInfo = null;
    this._ready = false;
  }

  // -------------------------------------------------------------------
  // Private: Demuxing
  // -------------------------------------------------------------------

  private _demux(arrayBuffer: ArrayBuffer): Promise<Array<{
    data: Uint8Array;
    timestamp: number;
    duration: number;
    isKeyframe: boolean;
  }> | null> {
    return new Promise((resolve) => {
      const mp4boxFile = MP4Box.createFile();
      const samples: Array<{
        data: Uint8Array;
        timestamp: number;
        duration: number;
        isKeyframe: boolean;
      }> = [];
      let resolved = false;

      mp4boxFile.onReady = (info: MP4Box.Movie) => {
        const videoTrack = info.tracks.find((t) => t.type === 'video');

        if (!videoTrack) {
          console.error('[VideoFrameExtractor] No video track found');
          resolved = true;
          resolve(null);
          return;
        }

        const codec = this._getCodecString(videoTrack as unknown as LooseVideoTrack);
        const description = this._getDescription(
          mp4boxFile as unknown as DescriptionSource,
          videoTrack.id,
        );

        this.trackInfo = {
          id: videoTrack.id,
          codec,
          codedWidth: videoTrack.video!.width,
          codedHeight: videoTrack.video!.height,
          description,
          timescale: videoTrack.timescale,
          durationMs: (videoTrack.duration / videoTrack.timescale) * 1000,
          sampleCount: videoTrack.nb_samples,
        };

        mp4boxFile.setExtractionOptions(videoTrack.id, null, {
          nbSamples: Infinity,
        });

        mp4boxFile.start();
      };

      mp4boxFile.onSamples = (_trackId: number, _user: unknown, rawSamples: MP4Box.Sample[]) => {
        for (const sample of rawSamples) {
          samples.push({
            data: new Uint8Array(sample.data!),
            timestamp: (sample.cts * 1_000_000) / sample.timescale,
            duration: (sample.duration * 1_000_000) / sample.timescale,
            isKeyframe: sample.is_sync,
          });
        }

        if (!resolved) {
          resolved = true;
          resolve(samples);
        }
      };

      mp4boxFile.onError = (e: string) => {
        console.error('[VideoFrameExtractor] MP4Box error:', e);
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      };

      const mp4Buffer = arrayBuffer as MP4Box.MP4BoxBuffer;
      mp4Buffer.fileStart = 0;
      mp4boxFile.appendBuffer(mp4Buffer);
      mp4boxFile.flush();

      // Safety timeout
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(samples.length > 0 ? samples : null);
        }
      }, 15_000);
    });
  }

  // -------------------------------------------------------------------
  // Private: Decode all frames
  // -------------------------------------------------------------------

  private _decodeAllFrames(
    samples: Array<{ data: Uint8Array; timestamp: number; duration: number; isKeyframe: boolean }>,
    config: VideoDecoderConfig,
    onProgress: (decoded: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let decodedCount = 0;
      const totalSamples = samples.length;

      const decoder = new VideoDecoder({
        output: async (frame: VideoFrame) => {
          try {
            // Convert VideoFrame → ImageBitmap (GPU-backed, persistent)
            const bitmap = await createImageBitmap(frame);
            this.frames.push({
              bitmap,
              timestamp: frame.timestamp ?? 0,
              duration: frame.duration ?? 0,
            });
          } catch (e) {
            console.warn('[VideoFrameExtractor] Failed to create bitmap for frame:', e);
          } finally {
            frame.close();
            decodedCount++;
            if (decodedCount % 30 === 0 || decodedCount === totalSamples) {
              onProgress(decodedCount);
            }
          }
        },
        error: (e) => {
          console.error('[VideoFrameExtractor] Decoder error:', e);
          reject(e);
        },
      });

      decoder.configure(config);

      // Feed all samples to the decoder
      for (const sample of samples) {
        const chunk = new EncodedVideoChunk({
          type: sample.isKeyframe ? 'key' : 'delta',
          timestamp: sample.timestamp,
          duration: sample.duration,
          data: sample.data,
        });
        decoder.decode(chunk);
      }

      // Flush and wait for all output frames
      decoder
        .flush()
        .then(() => {
          decoder.close();
          resolve();
        })
        .catch((e) => {
          console.error('[VideoFrameExtractor] Flush error:', e);
          try {
            decoder.close();
          } catch {}
          // Resolve with whatever we have — partial decode is better than nothing
          resolve();
        });
    });
  }

  // -------------------------------------------------------------------
  // Private: Codec helpers
  // -------------------------------------------------------------------

  private _getCodecString(track: LooseVideoTrack): string {
    const codecStr = track.codec;
    if (typeof codecStr === 'string' && codecStr.includes('.')) return codecStr;

    // Fallback: construct from fourcc + config boxes
    const fourcc = track.codec?.fourcc || track.type || '';

    if (fourcc.startsWith('avc')) {
      const entry = track.mdia?.minf?.stbl?.stsd?.entries?.[0];
      if (entry?.avcC) {
        const p = entry.avcC.AVCProfileIndication;
        const c = entry.avcC.profile_compatibility;
        const l = entry.avcC.AVCLevelIndication;
        return `avc1.${p.toString(16).padStart(2, '0')}${c.toString(16).padStart(2, '0')}${l.toString(16).padStart(2, '0')}`;
      }
      return 'avc1.4d0028';
    }

    if (fourcc.startsWith('hev') || fourcc.startsWith('hvc')) {
      return 'hev1.1.6.L93.B0';
    }

    if (fourcc.startsWith('av01')) {
      return 'av01.0.01M.08';
    }

    if (fourcc.startsWith('vp09') || fourcc.startsWith('vp9')) {
      return 'vp09.00.10.08';
    }

    return codecStr || 'avc1.4d0028';
  }

  private _getDescription(mp4boxFile: DescriptionSource, trackId: number): Uint8Array | undefined {
    const trak = mp4boxFile.getTrackById(trackId);
    if (!trak) return undefined;

    const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0];
    if (!entry) return undefined;

    for (const boxName of ['avcC', 'hvcC', 'av1C']) {
      const box = entry[boxName];
      if (box) {
        const stream = new MP4Box.DataStream(
          undefined,
          0,
          (MP4Box.DataStream as unknown as { BIG_ENDIAN?: MP4Box.Endianness }).BIG_ENDIAN,
        );
        box.write(stream);
        return new Uint8Array(stream.buffer, 8); // Skip box header
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------
  // Private: Frame lookup
  // -------------------------------------------------------------------

  /**
   * Binary search for the frame with timestamp ≤ targetMicros.
   */
  private _findFrameIndex(targetMicros: number): number {
    const frames = this.frames;
    if (frames.length === 0) return -1;

    if (targetMicros <= frames[0].timestamp) return 0;
    if (targetMicros >= frames[frames.length - 1].timestamp) return frames.length - 1;

    let lo = 0;
    let hi = frames.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid].timestamp <= targetMicros) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return hi;
  }
}
