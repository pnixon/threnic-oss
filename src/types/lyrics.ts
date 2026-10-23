/**
 * Lyrics Types - Barrel Export
 *
 * This file maintains backward compatibility by re-exporting all types
 * from the new organized structure under src/types/lyrics/
 *
 * Utility functions have been moved to @/engine/lyrics/converters
 */

export * from './lyrics/index';

// Re-export utility functions for backward compatibility
export {
  lyricLinesToThrenicWords,
  threnicWordsToLyricLines,
  reconcileWordTimings,
} from '@/engine/lyrics/converters';
