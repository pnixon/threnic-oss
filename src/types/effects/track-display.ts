/**
 * Track Display Configuration Types
 * Defines track title display settings
 */

export interface TrackTitleConfig {
  /** Whether track title display is enabled */
  enabled: boolean;
  /** Font ID to use for the track title */
  fontId: string;
  /** Font size scaling factor */
  fontSize: number;
  /** Horizontal position (0-100, 0=left, 50=center, 100=right) */
  positionX: number;
  /** Vertical position (0-100, 0=top, 100=bottom) */
  positionY: number;
  /** Text color */
  color: string;
  /** How long the title displays in seconds */
  duration: number;
  /** Delay after song starts before showing title in seconds */
  delay: number;
}
