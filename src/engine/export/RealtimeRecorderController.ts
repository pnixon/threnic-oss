/**
 * RealtimeRecorderController: the export controller for browsers without
 * WebCodecs. It has the same shape as StreamableExportController as far as
 * DecoupledExporter is concerned, but instead of encoding frames offline it
 * paints each rendered frame onto a canvas and lets MediaRecorder capture that
 * canvas together with the soundtrack, in real time.
 *
 * The soundtrack is played from the already mixed AudioBuffer into a
 * MediaStream destination, started at the same instant as the first frame.
 * Frames are released on the wall clock; if rendering falls behind, the
 * exporter asks `shouldSkip()` and drops frames rather than letting the
 * picture drift away from the sound.
 */

import { isPixelFrame, type ExportFrame } from './exportFrame';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from 'mediabunny';
import { pickRecorderFormat, type RecorderFormat } from './exportEngine';

export interface RecorderControllerOptions {
  width: number;
  height: number;
  fps: number;
  videoBitrate?: number;
  suggestedName?: string;
  /** Mixed soundtrack for the exported range (VirtualAudioBuffer is accepted). */
  audioBuffer?: AudioBuffer | null;
  /** Where in the audio buffer the exported range starts, in seconds. */
  audioStartSec?: number;
  /** Length of the exported range in seconds. */
  durationSec: number;
}

const AUDIO_BITRATE = 192_000;

/**
 * Bitrate for the live encoder. Real-time encoders drop frames when the
 * picture costs more than the budget, so this is deliberately generous:
 * dropped frames look worse than a larger file.
 */
export function recorderBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(24_000_000, Math.max(2_500_000, width * height * fps * 0.3)));
}

export function recordedFileName(suggestedName: string | undefined, ext: string): string {
  const base = (suggestedName ?? 'threnic-export').replace(/\.[A-Za-z0-9]{2,4}$/, '');
  return `${base}.${ext}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * MediaRecorder output has no duration or seek index (WebM) or is fragmented
 * (MP4 from Safari), which makes editors and some players struggle. Copy the
 * packets into a clean container without re-encoding. Returns the original
 * blob if anything about that fails.
 */
export async function finalizeRecording(blob: Blob, extension: 'mp4' | 'webm'): Promise<Blob> {
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const target = new BufferTarget();
    const output = new Output({
      format: extension === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
      target,
    });
    const conversion = await Conversion.init({ input, output });
    // Anything that would need re-encoding is not worth doing here.
    if (!conversion.isValid || conversion.discardedTracks.length > 0) return blob;
    await conversion.execute();
    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) return blob;
    return new Blob([buffer], { type: blob.type });
  } catch (err) {
    console.warn('[Export] Could not tidy the recording; saving it as recorded.', err);
    return blob;
  }
}

/** Copy a (possibly virtual) soundtrack range into a plain AudioBuffer. */
function materializeAudio(
  ctx: AudioContext,
  source: AudioBuffer,
  startSec: number,
  durationSec: number,
): AudioBuffer {
  const rate = source.sampleRate;
  const from = Math.max(0, Math.floor(startSec * rate));
  const to = Math.min(source.length, Math.ceil((startSec + durationSec) * rate));
  const length = Math.max(1, to - from);
  const out = ctx.createBuffer(source.numberOfChannels, length, rate);
  const virtual = source as unknown as {
    getChannelSlice?: (channel: number, start: number, end: number) => Float32Array;
  };
  for (let c = 0; c < source.numberOfChannels; c++) {
    const slice = virtual.getChannelSlice
      ? virtual.getChannelSlice(c, from, to)
      : source.getChannelData(c).subarray(from, to);
    out.copyToChannel(slice as Float32Array<ArrayBuffer>, c, 0);
  }
  return out;
}

export class RealtimeRecorderController {
  /** Present for interface parity; this controller never encodes audio itself. */
  readonly audioEncoder: null = null;
  readonly isRealtime = true;
  /** Frames dropped because rendering fell behind the clock. */
  skippedFrames = 0;
  /** Wall-clock time of the first frame, `performance.now()` based. */
  private t0: number | null = null;

  private readonly o: RecorderControllerOptions;
  private format: RecorderFormat | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  /** Hands the canvas's current content to the recorder, when supported. */
  private requestFrame: (() => void) | null = null;
  private track: (MediaStreamTrack & { requestFrame?: () => void }) | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private audioSource: AudioBufferSourceNode | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private recording = false;
  private recorderError: Error | null = null;
  /** Result of the finished recording (for callers and tests). */
  result: { blob: Blob; fileName: string; mimeType: string } | null = null;

  constructor(options: RecorderControllerOptions) {
    this.o = options;
  }

  static isSupported(): boolean {
    return pickRecorderFormat() !== null;
  }

  async start(includeAudio = false, writableStream?: WritableStream): Promise<boolean> {
    // The recorder produces its own file; a stream acquired for the offline
    // path is not used.
    if (writableStream) {
      try {
        await writableStream.abort();
      } catch {
        /* nothing to release */
      }
    }
    this.format = pickRecorderFormat();
    if (!this.format || typeof document === 'undefined') return false;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = this.o.width;
      canvas.height = this.o.height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return false;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.canvas = canvas;
      this.ctx = ctx;

      // Manual capture: every painted frame is handed to the recorder exactly
      // once. (Sampled capture, captureStream(fps), loses about a third of the
      // frames in Firefox.) Firefox exposes requestFrame() on the stream,
      // Chromium and Safari on the video track.
      const stream = canvas.captureStream(0);
      this.stream = stream;
      this.track = stream.getVideoTracks()[0] as typeof this.track;
      const onStream = (stream as unknown as { requestFrame?: () => void }).requestFrame;
      const onTrack = this.track?.requestFrame;
      if (typeof onStream === 'function') this.requestFrame = () => onStream.call(stream);
      else if (typeof onTrack === 'function') this.requestFrame = () => onTrack.call(this.track);
      else {
        // No manual requests available: fall back to sampled capture.
        stream.getTracks().forEach((t) => t.stop());
        this.stream = canvas.captureStream(this.o.fps);
        this.track = this.stream.getVideoTracks()[0] as typeof this.track;
      }

      if (includeAudio && this.o.audioBuffer) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        const audioCtx = new Ctor({ sampleRate: this.o.audioBuffer.sampleRate });
        this.audioCtx = audioCtx;
        const dest = audioCtx.createMediaStreamDestination();
        this.audioBuffer = materializeAudio(
          audioCtx,
          this.o.audioBuffer,
          this.o.audioStartSec ?? 0,
          this.o.durationSec,
        );
        const src = audioCtx.createBufferSource();
        src.buffer = this.audioBuffer;
        src.connect(dest);
        this.audioSource = src;
        dest.stream.getAudioTracks().forEach((t) => this.stream!.addTrack(t));
        await audioCtx.resume().catch(() => {});
      }

      const recorderOptions: MediaRecorderOptions = {
        mimeType: this.format.mimeType,
        videoBitsPerSecond: recorderBitrate(this.o.width, this.o.height, this.o.fps),
      };
      if (this.audioSource) recorderOptions.audioBitsPerSecond = AUDIO_BITRATE;
      this.recorder = new MediaRecorder(this.stream!, recorderOptions);
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      this.recorder.onerror = (e) => {
        this.recorderError =
          (e as unknown as { error?: Error }).error ?? new Error('Recorder error');
      };

      // Keep a phone's screen on for the length of the recording.
      try {
        const wl = (
          navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<unknown> } }
        ).wakeLock;
        this.wakeLock = ((await wl?.request('screen')) as typeof this.wakeLock) ?? null;
      } catch {
        /* optional */
      }

      this.recording = true;
      return true;
    } catch (err) {
      console.error('[Export] Could not start the real-time recorder:', err);
      await this.teardown();
      return false;
    }
  }

  /** Time since the first frame, in milliseconds. */
  private elapsed(): number {
    return this.t0 === null ? 0 : performance.now() - this.t0;
  }

  /**
   * True when the clock is more than a frame and a half past the moment this
   * frame should appear, so rendering it would only make things worse.
   */
  shouldSkip(frameIndex: number, lastFrameIndex: number): boolean {
    if (this.t0 === null || frameIndex >= lastFrameIndex) return false;
    const late = this.elapsed() - (frameIndex * 1000) / this.o.fps;
    if (late > 1500 / this.o.fps) {
      this.skippedFrames++;
      return true;
    }
    return false;
  }

  async encodeVideoFrame(frame: ExportFrame): Promise<void> {
    try {
      if (!this.recording || !this.ctx || !this.canvas) return;
      if (this.t0 === null) {
        this.paint(frame);
        this.requestFrame?.();
        this.startCapture();
        return;
      }
      const due = (frame.timestamp / 1000) as number;
      const wait = due - this.elapsed();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      this.paint(frame);
      this.requestFrame?.();
    } finally {
      frame.close();
    }
  }

  private paint(frame: ExportFrame): void {
    const ctx = this.ctx!;
    if (isPixelFrame(frame)) {
      ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
    } else {
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
    }
  }

  private startCapture(): void {
    this.t0 = performance.now();
    this.recorder?.start(500);
    if (this.audioSource && this.audioCtx) {
      this.audioSource.start(this.audioCtx.currentTime + 0.02);
    }
  }

  async encodeAudio(): Promise<void> {
    /* the soundtrack is played live; nothing to encode */
  }

  async stop(isCancel = false): Promise<void> {
    if (!this.recording) {
      await this.teardown();
      return;
    }
    this.recording = false;
    const recorder = this.recorder;
    try {
      if (!isCancel && recorder && recorder.state !== 'inactive' && this.t0 !== null) {
        // Let the last frame (and any audio tail) play out before stopping.
        const end = (this.o.durationSec * 1000) / 1 + 150;
        const wait = end - this.elapsed();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      if (recorder && recorder.state !== 'inactive') {
        const stopped = new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
        });
        recorder.stop();
        await stopped;
      }
      if (!isCancel && this.chunks.length > 0 && this.format && !this.recorderError) {
        const mimeType = recorder?.mimeType || this.format.mimeType;
        const ext = mimeType.includes('mp4') ? 'mp4' : this.format.extension;
        const raw = new Blob(this.chunks, { type: mimeType.split(';')[0] });
        const blob = await finalizeRecording(raw, ext);
        const fileName = recordedFileName(this.o.suggestedName, ext);
        this.result = { blob, fileName, mimeType };
        downloadBlob(blob, fileName);
      }
    } finally {
      await this.teardown();
    }
  }

  private async teardown(): Promise<void> {
    this.recording = false;
    try {
      this.audioSource?.stop();
    } catch {
      /* never started */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      await this.audioCtx?.close();
    } catch {
      /* already closed */
    }
    try {
      await this.wakeLock?.release();
    } catch {
      /* already released */
    }
    this.audioSource = null;
    this.audioCtx = null;
    this.audioBuffer = null;
    this.wakeLock = null;
    this.stream = null;
    this.track = null;
    this.requestFrame = null;
    this.recorder = null;
    this.chunks = [];
    this.canvas = null;
    this.ctx = null;
  }
}
