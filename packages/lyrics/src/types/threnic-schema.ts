/**
 * Threnic Schema - Unified word-level format for the Sync Engine
 *
 * All ingested formats (LRC, SRT, plain text) are normalized to this structure.
 * Moved verbatim from the Threnic app (src/types/lyrics/threnic-schema.ts).
 */

/**
 * ThrenicWord - A single word with precise timing data.
 * This is the atomic unit of the Threnic lyric system.
 */
export interface ThrenicWord {
  /** Unique identifier (generated via crypto.randomUUID()) */
  id: string;
  /** The word content */
  text: string;
  /** Start time in seconds (e.g. 12.45) */
  startTime: number;
  /** End time in seconds (e.g. 13.10) */
  endTime: number;
  /** True if this word starts a new line (user hit Enter during sync) */
  isLineStart: boolean;
  /** Persistent line identifier — decouples line membership from time order */
  lineId?: string;
  /** @deprecated Use lineId-based grouping. Explicit start time for the line container */
  lineStartX?: number;
  /** @deprecated Use lineId-based grouping. Explicit end time for the line container */
  lineEndX?: number;
  /** True if this word starts a new stanza (follows a gap or double newline) */
  isStanzaStart?: boolean;
  /** Lane assignment for multi-voice/multi-singer support (0-based, stored on line-start words) */
  laneIndex?: number;
}

/**
 * ThrenicTrack - A complete synchronized lyric track
 */
export interface ThrenicTrack {
  meta: {
    /** Schema version for future migrations */
    version: string;
    /** Total track duration in seconds (from audio) */
    duration: number;
    /** Global timing offset in milliseconds */
    offset: number;
  };
  /** Flat array of words for linear scanning */
  lyrics: ThrenicWord[];
}
