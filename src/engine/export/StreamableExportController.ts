import { type CodecKey } from '@/types/export';
import {
  negotiateVideoCodec,
  makeRuntimeTryConfigure,
  negotiateAudioCodec,
  makeRuntimeAudioTryConfigure,
  type NegotiatedAudio,
} from './codecNegotiation';

interface WriteQueueItem {
  type: 'video' | 'audio';
  chunk: EncodedVideoChunk | EncodedAudioChunk;
  meta?: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata;
}

import {
  Output,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  StreamTarget,
  Mp4OutputFormat,
  EncodedPacket,
} from 'mediabunny';

type MuxerType = Output;

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>;
};

interface ExportControllerOptions {
  width: number;
  height: number;
  fps?: number;
  videoBitrate?: number;
  audioSampleRate?: number;
  audioChannels?: number;
  audioBitrate?: number;
  suggestedName?: string;
  /** Preferred video codec. Defaults to 'h264'. Falls back if unsupported. */
  codec?: CodecKey;
}

/**
 * StreamableExportController - High-performance video/audio export with backpressure
 */
export class StreamableExportController {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioSampleRate: number;
  audioChannels: number;
  audioBitrate: number;
  suggestedName?: string;
  /** Selected codec preference */
  codec: CodecKey;
  /** The actual codec string that was negotiated with the encoder */
  resolvedCodecString: string | null = null;

  private muxer: MuxerType | null = null;
  private videoSource: EncodedVideoPacketSource | null = null;
  private audioSource: EncodedAudioPacketSource | null = null;
  videoEncoder: VideoEncoder | null = null;
  audioEncoder: AudioEncoder | null = null;
  fileHandle: FileSystemFileHandle | null = null;
  writableStream: WritableStream | null = null;
  streamTarget: StreamTarget | null = null;
  isRecording = false;
  frameCounter = 0;
  hasAudio = false;

  writeQueue: WriteQueueItem[] = [];
  isProcessingQueue = false;
  MAX_QUEUE_SIZE = 500;
  private encoderError = false;
  private isFinalized = false;
  private intentionallyStopped = false;

  /**
   * Ultra-low-latency yield using a cached MessageChannel (~0.1ms).
   */
  private static _yieldChannel: MessageChannel | null = null;
  private static _yieldResolve: (() => void) | null = null;
  private static yieldMicrotask(): Promise<void> {
    return new Promise((resolve) => {
      if (!StreamableExportController._yieldChannel) {
        StreamableExportController._yieldChannel = new MessageChannel();
        StreamableExportController._yieldChannel.port1.onmessage = () => {
          StreamableExportController._yieldResolve?.();
        };
      }
      StreamableExportController._yieldResolve = resolve;
      StreamableExportController._yieldChannel.port2.postMessage(null);
    });
  }

  private static yieldForEncoder(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 2));
  }

  constructor(options: ExportControllerOptions) {
    const toEven = (n: number) => Math.round(n / 2) * 2;
    this.width = toEven(options.width);
    this.height = toEven(options.height);
    this.fps = options.fps ?? 60;

    let visuallyLosslessBitrate = Math.floor(this.width * this.height * this.fps * 0.15);

    if (visuallyLosslessBitrate > 200_000_000) {
      visuallyLosslessBitrate = 200_000_000;
    }

    this.videoBitrate = options.videoBitrate ?? visuallyLosslessBitrate;
    this.audioSampleRate = options.audioSampleRate ?? 48000;
    this.audioChannels = options.audioChannels ?? 2;
    this.audioBitrate = options.audioBitrate ?? 128_000;
    this.suggestedName = options.suggestedName;
    this.codec = options.codec ?? 'h264';
  }

  static isSupported(): boolean {
    return typeof VideoEncoder !== 'undefined';
  }

  /**
   * Start recording
   * @param includeAudio - Whether to include audio track
   * @param writableStream - Optional pre-acquired writable stream (required for workers)
   */
  async start(includeAudio = false, writableStream?: WritableStream): Promise<boolean> {
    if (!StreamableExportController.isSupported()) {
      console.error('WebCodecs not supported');
      return false;
    }

    try {
      if (writableStream) {
        this.writableStream = writableStream;
      } else if (typeof window !== 'undefined' && (window as SavePickerWindow).showSaveFilePicker) {
        this.fileHandle = await (window as SavePickerWindow).showSaveFilePicker!({
          suggestedName: this.suggestedName || 'visualization.mp4',
          types: [
            {
              description: 'MP4 Video',
              accept: { 'video/mp4': ['.mp4'] },
            },
          ],
        });
        if (!this.fileHandle) throw new Error('No file handle acquired');
        this.writableStream = await this.fileHandle.createWritable();
      } else {
        throw new Error('No writable stream provided and showSaveFilePicker not available');
      }

      if (!this.writableStream) throw new Error('Failed to acquire writable stream');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Failed to initialize export stream:', err);
      }
      return false;
    }

    this.streamTarget = new StreamTarget(this.writableStream);
    this.muxer = new Output({
      format: new Mp4OutputFormat(),
      target: this.streamTarget,
    });

    let resolvedMuxerCodec: 'avc' | 'hevc' | 'av1' = 'avc';

    // Codec negotiation is extracted to codecNegotiation.ts (pure + unit-tested)
    // because it encodes the Firefox contract: software-only H.264 requires a
    // no-preference/software acceleration pass, and isConfigSupported must be
    // confirmed with a real configure(). See codecNegotiation.test.ts.
    const negotiated = await negotiateVideoCodec(
      {
        codec: this.codec,
        width: this.width,
        height: this.height,
        videoBitrate: this.videoBitrate,
        fps: this.fps,
      },
      {
        isConfigSupported: (c) => VideoEncoder.isConfigSupported(c),
        tryConfigure: makeRuntimeTryConfigure(),
      },
    );

    if (!negotiated) {
      await this.cleanup();
      return false;
    }

    const selectedConfig = negotiated.config;
    this.videoBitrate = negotiated.bitrate;
    resolvedMuxerCodec = negotiated.muxerCodec;

    this.resolvedCodecString = selectedConfig.codec;

    this.videoSource = new EncodedVideoPacketSource(resolvedMuxerCodec);
    this.muxer.addVideoTrack(this.videoSource);

    // Negotiate the audio codec BEFORE adding the muxer track: Firefox cannot
    // encode AAC via WebCodecs, so we fall back to Opus-in-MP4, and to
    // video-only if neither encodes. The muxer track codec must match whatever
    // the encoder will actually produce.
    let negotiatedAudio: NegotiatedAudio | null = null;
    if (includeAudio && typeof AudioEncoder !== 'undefined') {
      negotiatedAudio = await negotiateAudioCodec(
        {
          sampleRate: this.audioSampleRate,
          numberOfChannels: this.audioChannels,
          bitrate: this.audioBitrate,
        },
        {
          isConfigSupported: (c) => AudioEncoder.isConfigSupported(c),
          tryConfigure: makeRuntimeAudioTryConfigure(),
        },
      );
      if (!negotiatedAudio) {
        // No encodable audio codec in this browser — export video-only rather
        // than aborting the whole export.
        console.warn(
          '[Export] No WebCodecs audio encoder available (browser cannot encode ' +
            'AAC or Opus). Exporting video-only.',
        );
      }
    }
    const willIncludeAudio = includeAudio && negotiatedAudio !== null;

    if (willIncludeAudio) {
      this.audioSource = new EncodedAudioPacketSource(negotiatedAudio!.muxerCodec);
      this.muxer.addAudioTrack(this.audioSource);
    }

    await this.muxer.start();

    this.isRecording = true;
    this.frameCounter = 0;
    this.writeQueue = [];
    this.hasAudio = willIncludeAudio;

    this.encoderError = false;
    this.intentionallyStopped = false;
    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => this.handleVideoChunk(chunk, meta),
      error: (e) => {
        if (e.name === 'QuotaExceededError' && (this.intentionallyStopped || !this.isRecording))
          return;
        console.error('Video encoding error:', e);
        this.encoderError = true;
      },
    });

    try {
      await this.videoEncoder.configure(selectedConfig);
    } catch {
      await this.cleanup();
      return false;
    }

    if (willIncludeAudio) {
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => this.handleAudioChunk(chunk, meta),
        error: (e) => {
          if (e.name === 'QuotaExceededError' && (this.intentionallyStopped || !this.isRecording))
            return;
          console.error('Audio encoding error:', e);
          this.encoderError = true;
        },
      });

      try {
        await this.audioEncoder.configure(negotiatedAudio!.config);
      } catch {
        await this.cleanup();
        return false;
      }
    }

    return true;
  }

  private async cleanup(): Promise<void> {
    this.isRecording = false;
    if (this.videoEncoder?.state !== 'closed') this.videoEncoder?.close();
    if (this.audioEncoder?.state !== 'closed') this.audioEncoder?.close();
    if (this.writableStream) {
      try {
        await this.writableStream.abort();
      } catch {}
    }
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.writableStream = null;
    this.fileHandle = null;
    this.muxer = null;
  }

  private handleVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    this.writeQueue.push({ type: 'video', chunk, meta });
    this.processQueue();
  }

  private handleAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
    this.writeQueue.push({ type: 'audio', chunk, meta });
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.writeQueue.length > 0) {
      const item = this.writeQueue.shift();
      if (!item || !this.muxer) continue;

      if (this.isFinalized) {
        const closable = item.chunk as unknown as { close?: () => void };
        if (closable.close) closable.close();
        continue;
      }

      try {
        if (item.type === 'video' && this.videoSource) {
          const packet = EncodedPacket.fromEncodedChunk(item.chunk as EncodedVideoChunk);
          await this.videoSource.add(packet, item.meta as EncodedVideoChunkMetadata);
        } else if (item.type === 'audio' && this.audioSource) {
          const packet = EncodedPacket.fromEncodedChunk(item.chunk as EncodedAudioChunk);
          await this.audioSource.add(packet, item.meta as EncodedAudioChunkMetadata);
        }
      } catch (err) {
        console.error('Error writing chunk:', err);
      }
    }

    this.isProcessingQueue = false;
  }

  async encodeAudio(audioData: AudioData): Promise<void> {
    if (!this.audioEncoder || !this.hasAudio || this.encoderError) return;
    while (this.writeQueue.length >= this.MAX_QUEUE_SIZE || this.audioEncoder.encodeQueueSize > 8) {
      if (this.audioEncoder.encodeQueueSize > 8) {
        await StreamableExportController.yieldForEncoder();
      } else {
        await StreamableExportController.yieldMicrotask();
      }
      if (this.encoderError || this.audioEncoder.state !== 'configured' || !this.isRecording)
        return;
    }
    this.audioEncoder.encode(audioData);
  }

  encodeAudioSync(audioData: AudioData): boolean {
    if (!this.audioEncoder || !this.hasAudio || this.encoderError || !this.isRecording) return true;
    if (this.writeQueue.length >= this.MAX_QUEUE_SIZE || this.audioEncoder.encodeQueueSize > 8)
      return false;
    this.audioEncoder.encode(audioData);
    return true;
  }

  async captureFromCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    const encoder = this.videoEncoder;
    if (!this.isRecording || !encoder || this.encoderError || encoder.state !== 'configured')
      return;

    while (this.writeQueue.length >= this.MAX_QUEUE_SIZE || encoder.encodeQueueSize > 8) {
      if (encoder.encodeQueueSize > 8) {
        await StreamableExportController.yieldForEncoder();
      } else {
        await StreamableExportController.yieldMicrotask();
      }
      if (this.encoderError || !this.isRecording) return;
    }

    this._encodeCanvas(canvas, encoder);
  }

  captureFromCanvasSync(canvas: HTMLCanvasElement | OffscreenCanvas): boolean {
    const encoder = this.videoEncoder;
    if (!this.isRecording || !encoder || this.encoderError || encoder.state !== 'configured')
      return true;
    if (this.writeQueue.length >= this.MAX_QUEUE_SIZE || encoder.encodeQueueSize > 8) return false;
    this._encodeCanvas(canvas, encoder);
    return true;
  }

  /**
   * Encode a pre-created VideoFrame directly.
   * Applies backpressure if the encoder queue is full.
   */
  async encodeVideoFrame(frame: VideoFrame): Promise<void> {
    const encoder = this.videoEncoder;
    if (!this.isRecording || !encoder || this.encoderError || encoder.state !== 'configured') {
      frame.close();
      return;
    }

    while (this.writeQueue.length >= this.MAX_QUEUE_SIZE || encoder.encodeQueueSize > 8) {
      if (encoder.encodeQueueSize > 8) {
        await StreamableExportController.yieldForEncoder();
      } else {
        await StreamableExportController.yieldMicrotask();
      }
      if (this.encoderError || !this.isRecording) {
        frame.close();
        return;
      }
    }

    this._encodeVideoFrame(frame, encoder);
  }

  /**
   * Synchronous encode attempt for a pre-created VideoFrame.
   * Returns false if backpressured (caller should use async version).
   */
  encodeVideoFrameSync(frame: VideoFrame): boolean {
    const encoder = this.videoEncoder;
    if (!this.isRecording || !encoder || this.encoderError || encoder.state !== 'configured') {
      frame.close();
      return true;
    }
    if (this.writeQueue.length >= this.MAX_QUEUE_SIZE || encoder.encodeQueueSize > 8) return false;
    this._encodeVideoFrame(frame, encoder);
    return true;
  }

  private _encodeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, encoder: VideoEncoder): void {
    const timestampMicros = (this.frameCounter / this.fps) * 1_000_000;
    let frame: VideoFrame | null = null;
    try {
      if (!this.isRecording) return;
      frame = new VideoFrame(canvas, {
        timestamp: Math.round(timestampMicros),
        duration: Math.round(1_000_000 / this.fps),
      });
      const needsKeyFrame = this.frameCounter % (this.fps * 2) === 0;
      encoder.encode(frame, { keyFrame: needsKeyFrame });
      this.frameCounter++;
    } catch (e) {
      console.error('[Export] VideoEncoder capture/encode error:', e);
      this.encoderError = true;
    } finally {
      if (frame) frame.close();
    }
  }

  /** Encode a pre-created VideoFrame. Closes the frame after encoding. */
  private _encodeVideoFrame(frame: VideoFrame, encoder: VideoEncoder): void {
    try {
      if (!this.isRecording) return;
      const needsKeyFrame = this.frameCounter % (this.fps * 2) === 0;
      encoder.encode(frame, { keyFrame: needsKeyFrame });
      this.frameCounter++;
    } catch (e) {
      console.error('[Export] VideoEncoder encode error:', e);
      this.encoderError = true;
    } finally {
      frame.close();
    }
  }

  async stop(isCancel: boolean = false): Promise<void> {
    if (!this.isRecording && !this.intentionallyStopped) return;
    this.isRecording = false;
    this.intentionallyStopped = true;

    if (this.encoderError || isCancel) {
      await this.cleanup();
      return;
    }

    try {
      if (this.videoEncoder?.state === 'configured') await this.videoEncoder.flush();
      if (this.audioEncoder?.state === 'configured') await this.audioEncoder.flush();

      const drainTimeout = (typeof Date !== 'undefined' ? Date.now() : 0) + 30000;
      while (
        (this.writeQueue.length > 0 || this.isProcessingQueue) &&
        (typeof Date !== 'undefined' ? Date.now() < drainTimeout : true)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      this.isFinalized = true;
      if (this.muxer) await this.muxer.finalize();

      if (this.writableStream) {
        try {
          if (!this.writableStream.locked) {
            await this.writableStream.close();
          }
        } catch {}
      }

      if (this.videoEncoder?.state !== 'closed') this.videoEncoder?.close();
      if (this.audioEncoder?.state !== 'closed') this.audioEncoder?.close();

      this.videoEncoder = null;
      this.audioEncoder = null;
      this.writableStream = null;
      this.muxer = null;
    } catch (e) {
      console.error('Error during export finalization:', e);
      await this.cleanup();
    }
  }
}
