/**
 * Per-frame audio metrics passed to the renderer and to lyric styles.
 * Extracted to its own module so both CanvasLyricRenderer and the style seam
 * can import it without a cycle.
 */
export interface FrameAudioMetrics {
  bass: number;
  mid: number;
  high: number;
  energy: number;
}
