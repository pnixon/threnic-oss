/**
 * A rendered export frame that does not require WebCodecs.
 *
 * Browsers without `VideoFrame` (Firefox for Android, older Safari) still
 * render every frame; the pixels simply travel as a plain RGBA array to the
 * real-time recorder instead of into a VideoEncoder.
 */

export interface PixelFrame {
  readonly kind: 'pixels';
  /** Tightly packed RGBA, row 0 at the top. */
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
  /** Presentation time in microseconds. */
  readonly timestamp: number;
  readonly duration: number;
  close(): void;
}

export type ExportFrame = VideoFrame | PixelFrame;

export function isPixelFrame(frame: ExportFrame): frame is PixelFrame {
  return (frame as PixelFrame).kind === 'pixels';
}

/**
 * Wrap tightly packed RGBA pixels as a VideoFrame when the browser has one,
 * otherwise as a PixelFrame. The pixels are copied either way, so the caller
 * may unmap or reuse its buffer straight away.
 */
export function makeExportFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
  timestampMicros: number,
  durationMicros: number,
): ExportFrame {
  const timestamp = Math.round(timestampMicros);
  const duration = Math.round(durationMicros);
  if (typeof VideoFrame !== 'undefined') {
    return new VideoFrame(rgba as BufferSource, {
      format: 'RGBA',
      codedWidth: width,
      codedHeight: height,
      timestamp,
      duration,
    });
  }
  const data = new Uint8ClampedArray(rgba.length);
  data.set(rgba);
  return { kind: 'pixels', data, width, height, timestamp, duration, close() {} };
}
