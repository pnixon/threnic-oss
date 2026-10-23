/**
 * EncoderWorkerBridge
 *
 * Provides the same capture/stop interface as StreamableExportController
 * but delegates encoding and muxing to the encoder Web Worker.
 *
 * This allows the export loop in useExportMode to use either the worker-based
 * or main-thread encoding path with the same API.
 */

const MAX_PENDING_FRAMES = 30;

export class EncoderWorkerBridge {
  private worker: Worker;
  private pendingFrames = 0;
  private workerReady = true;
  private readyResolve: (() => void) | null = null;
  private fps: number;
  frameCounter = 0;
  isRecording = false;

  constructor(worker: Worker) {
    this.worker = worker;
    this.fps = 60;

    this.worker.addEventListener('message', (e: MessageEvent) => {
      const { type, payload } = e.data;

      switch (type) {
        case 'frame-accepted':
          this.pendingFrames = Math.max(0, this.pendingFrames - 1);

          if (payload.ready) {
            this.workerReady = true;
          } else {
            this.workerReady = false;
          }

          if (this.workerReady && this.pendingFrames <= MAX_PENDING_FRAMES) {
            if (this.readyResolve) {
              this.readyResolve();
              this.readyResolve = null;
            }
          }
          break;
        case 'encoder-ready':
          if (payload.ready) {
            this.workerReady = true;
            if (this.pendingFrames <= MAX_PENDING_FRAMES) {
              if (this.readyResolve) {
                this.readyResolve();
                this.readyResolve = null;
              }
            }
          }
          break;
      }
    });
  }

  /**
   * Initialize the encoder worker.
   * Note: writableStream is transferred (moved) to the worker and becomes
   * unusable on the main thread after this call.
   */
  async start(options: {
    width: number;
    height: number;
    fps: number;
    includeAudio: boolean;
    audioSampleRate?: number;
    audioChannels?: number;
    writableStream: WritableStream;
    totalFrames: number;
    videoBitrate?: number;
    /** Preferred video codec. Defaults to 'h264'. */
    codec?: import('@/types/export').CodecKey;
  }): Promise<boolean> {
    this.fps = options.fps;
    this.frameCounter = 0;
    this.pendingFrames = 0;
    this.workerReady = true;

    return new Promise<boolean>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'initialized') {
          this.worker.removeEventListener('message', handler);
          this.isRecording = true;
          resolve(true);
        } else if (e.data.type === 'error') {
          this.worker.removeEventListener('message', handler);
          resolve(false);
        }
      };
      this.worker.addEventListener('message', handler);

      this.worker.postMessage({ type: 'init', payload: options }, [options.writableStream]);
    });
  }

  /**
   * Capture a frame from the canvas. Creates a VideoFrame and transfers it
   * to the worker for encoding. Applies backpressure if the worker is overwhelmed.
   */
  async captureFromCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    if (!this.isRecording) return;

    // Wait for backpressure to clear
    if (!this.workerReady || this.pendingFrames > MAX_PENDING_FRAMES) {
      await this._waitForReady();
    }

    this._sendFrame(canvas);
  }

  captureFromCanvasSync(canvas: HTMLCanvasElement | OffscreenCanvas): boolean {
    if (!this.isRecording) return true;
    if (!this.workerReady || this.pendingFrames > MAX_PENDING_FRAMES) return false;

    this._sendFrame(canvas);
    return true;
  }

  /**
   * Encode a pre-created VideoFrame. Transfers ownership to the worker.
   * The frame will be closed by the worker after encoding.
   */
  async encodeVideoFrame(frame: VideoFrame): Promise<void> {
    if (!this.isRecording) {
      frame.close();
      return;
    }

    if (!this.workerReady || this.pendingFrames > MAX_PENDING_FRAMES) {
      await this._waitForReady();
    }

    // Check again after wait as we might have been cancelled
    if (!this.isRecording) {
      frame.close();
      return;
    }

    this._sendVideoFrame(frame);
  }

  /**
   * Encode a block of audio data. Transfers ownership to the worker.
   */
  async encodeAudio(audioData: AudioData): Promise<void> {
    if (!this.isRecording) {
      audioData.close();
      return;
    }

    if (!this.workerReady || this.pendingFrames > MAX_PENDING_FRAMES) {
      await this._waitForReady();
    }

    // Check again after wait as we might have been cancelled
    if (!this.isRecording) {
      audioData.close();
      return;
    }

    this.worker.postMessage(
      { type: 'encode-audio', payload: { audioData } },
      [audioData], // Transfer the audio data buffer
    );
  }

  /**
   * Synchronous encode attempt for a pre-created VideoFrame.
   * Returns false if backpressured (caller should use async version).
   */
  encodeVideoFrameSync(frame: VideoFrame): boolean {
    if (!this.isRecording) {
      frame.close();
      return true;
    }
    if (!this.workerReady || this.pendingFrames > MAX_PENDING_FRAMES) return false;

    this._sendVideoFrame(frame);
    return true;
  }

  /**
   * Flush encoders, finalize muxer, and wait for completion.
   */
  async stop(isCancel: boolean = false): Promise<void> {
    if (!this.isRecording) return;
    this.isRecording = false;

    // Resolve any pending wait
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
    }

    if (isCancel) {
      this.worker.postMessage({ type: 'cancel' });
      return;
    }

    await new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'completed' || e.data.type === 'error' || e.data.type === 'cancelled') {
          this.worker.removeEventListener('message', handler);
          resolve();
        }
      };
      this.worker.addEventListener('message', handler);
      this.worker.postMessage({ type: 'flush' });
    });
  }

  /**
   * Cancel the current export.
   */
  cancel(): void {
    this.isRecording = false;

    // Unblock the main loop if it's waiting for backpressure
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
    }

    this.worker.postMessage({ type: 'cancel' });
  }

  /**
   * Terminate the worker entirely.
   */
  terminate(): void {
    this.isRecording = false;
    this.worker.terminate();
  }

  // --- Private helpers ---

  private _sendFrame(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    const timestamp = Math.round((this.frameCounter / this.fps) * 1_000_000);
    const duration = Math.round(1_000_000 / this.fps);

    let frame: VideoFrame | null = null;
    try {
      frame = new VideoFrame(canvas, { timestamp, duration });
      this.worker.postMessage(
        { type: 'encode-frame', payload: { frame, frameIndex: this.frameCounter } },
        [frame],
      );
      this.frameCounter++;
      this.pendingFrames++;
    } catch (e) {
      console.error('[EncoderWorkerBridge] Failed to create/send VideoFrame:', e);
      if (frame) frame.close();
    }
  }

  /** Send a pre-created VideoFrame to the worker (transfers ownership). */
  private _sendVideoFrame(frame: VideoFrame): void {
    try {
      this.worker.postMessage(
        { type: 'encode-frame', payload: { frame, frameIndex: this.frameCounter } },
        [frame],
      );
      this.frameCounter++;
      this.pendingFrames++;
    } catch (e) {
      console.error('[EncoderWorkerBridge] Failed to send VideoFrame:', e);
      frame.close();
    }
  }

  private _waitForReady(): Promise<void> {
    if (this.workerReady && this.pendingFrames <= MAX_PENDING_FRAMES) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }
}
