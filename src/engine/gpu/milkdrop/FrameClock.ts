/**
 * FrameClock — the only source of time in the Milkdrop engine.
 *
 * Time is `frame / fps`. Never `performance.now()`, never an accumulated
 * delta. Preview and export run the same clock at the same fps, which is what
 * makes "preview is the export" true rather than approximately true.
 *
 * Because the feedback chain is sequential, a slow preview may not simply skip
 * frames — frame N is only defined in terms of frame N-1. `framesToAdvance()`
 * makes that choice explicit at the call site: either step the chain that many
 * times, or accept that the visuals lag the audio.
 */
export class FrameClock {
  readonly fps: number;
  private _frame: number;

  constructor(fps: number, startFrame = 0) {
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new Error(`[FrameClock] fps must be a positive finite number, got ${fps}`);
    }
    this.fps = fps;
    this._frame = Math.max(0, Math.floor(startFrame));
  }

  /** Current integer frame index. */
  get frame(): number {
    return this._frame;
  }

  /** Current time in seconds — exactly frame / fps. */
  get time(): number {
    return this._frame / this.fps;
  }

  /** Frame duration in seconds — always exactly 1 / fps. */
  get dt(): number {
    return 1 / this.fps;
  }

  /** Step forward one frame and return the new index. */
  advance(): number {
    this._frame += 1;
    return this._frame;
  }

  /**
   * Jump to an absolute frame. With feedback enabled this invalidates the
   * chain — callers must also reset or restore the feedback buffers.
   */
  seek(frame: number): void {
    this._frame = Math.max(0, Math.floor(frame));
  }

  /** Jump to the frame containing `seconds`. */
  seekToTime(seconds: number): void {
    this.seek(FrameClock.frameForTime(seconds, this.fps));
  }

  reset(): void {
    this._frame = 0;
  }

  /**
   * How many frames the chain must be stepped to reach `targetSeconds`.
   *
   * Returns 0 when already at or past the target (preview running ahead of
   * audio), and is clamped to `maxStep` so a stall doesn't turn into a
   * thousand-frame catch-up burst that blocks the GPU.
   */
  framesToAdvance(targetSeconds: number, maxStep = 4): number {
    const target = FrameClock.frameForTime(targetSeconds, this.fps);
    const delta = target - this._frame;
    if (delta <= 0) return 0;
    return Math.min(delta, Math.max(1, Math.floor(maxStep)));
  }

  /** Frame index whose interval contains `seconds`. */
  static frameForTime(seconds: number, fps: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.floor(seconds * fps + 1e-6);
  }

  /** Start time of `frame`. */
  static timeForFrame(frame: number, fps: number): number {
    return frame / fps;
  }
}
