/**
 * Multi-Export Configuration Types
 * Defines settings for batch and playlist export operations
 */

export interface MultiExportConfig {
  /** Export mode: 'single' = one long video, 'batch' = multiple files, 'selection' = export a portion of current track */
  mode: 'single' | 'batch' | 'selection';

  /** List of track IDs to export */
  tracks: string[];

  /** Transition configuration (for single mode) */
  transition: {
    type: 'crossfade' | 'cut' | 'fade-black';
    duration: number; // Transition overlap/fade duration in seconds
  };

  /** Per-track gap configuration: trackId -> gap duration (seconds) AFTER that track.
   * Allows variable spacing between songs in merged export.
   */
  trackGaps: Record<string, number>;

  /** File naming pattern for batch mode: 'sequential' (01_Title.mp4) or 'track-name' (Title.mp4) */
  outputNaming: 'sequential' | 'track-name';

  /** Selection range for 'selection' mode (seconds) */
  selectionRange?: {
    start: number;
    end: number;
  };
}

export const DEFAULT_MULTI_EXPORT_CONFIG: MultiExportConfig = {
  mode: 'batch',
  tracks: [],
  transition: {
    type: 'fade-black',
    duration: 2.0,
  },
  trackGaps: {},
  outputNaming: 'track-name',
  selectionRange: undefined,
};
