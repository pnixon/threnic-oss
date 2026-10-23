/**
 * Minimal track-title configuration consumed by the renderer.
 *
 * The Threnic app has a larger `TrackTitleConfig` in its effects types; the
 * renderer only reads the fields below, so the package defines its own minimal
 * shape to stay decoupled. The app's type is structurally compatible (it is a
 * superset), so passing the app's config satisfies this interface.
 */
export interface TrackTitleConfig {
  enabled: boolean;
  /** Seconds after track start before the title appears (default 0.5) */
  delay?: number;
  /** Seconds the title stays fully visible (default 3.0) */
  duration?: number;
  /** Horizontal position as percentage 0-100 (default 50) */
  positionX?: number;
  /** Vertical position as percentage 0-100 (default 10) */
  positionY?: number;
  /** Font size in world units (default 0.4) */
  fontSize?: number;
  /** Text color (default #ffffff) */
  color?: string;
}
