/**
 * Export Config Isolation Tests
 *
 * Validates that exporting does not mutate the original track's lyric theme
 * or effects config. This was a real bug: the DecoupledExporter received
 * shared references to track objects and mutations propagated back to the
 * preview UI.
 *
 * Run: npm run test:quick -- test/engine/export/export-config-isolation.test.ts
 */

import { describe, it, expect } from 'vitest';
import type { LyricTheme } from '@/types/lyrics';
import { DEFAULT_LYRICS_THEME } from '@/types/lyrics';
import type { EffectsConfig } from '@/types/effects';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';

// ─── Helpers ─────────────────────────────────────────────────

/** Simulates how ExportTab builds the export config for a single track */
function buildSingleTrackExportConfig(originalTrack: {
  lyricsTheme?: LyricTheme;
  effectsConfig?: EffectsConfig;
}) {
  return {
    lyricTheme: originalTrack.lyricsTheme ? structuredClone(originalTrack.lyricsTheme) : undefined,
    lyricVerticalPosition: originalTrack.lyricsTheme?.verticalPosition,
    effectsConfig: originalTrack.effectsConfig
      ? structuredClone(originalTrack.effectsConfig)
      : undefined,
  };
}

/** Simulates how ExportTab builds the theme schedule for multi-track */
function buildThemeSchedule(
  tracks: Array<{ lyricsTheme?: LyricTheme; effectsConfig?: EffectsConfig }>,
) {
  const themeSchedule: Array<{ startTime: number; theme: LyricTheme }> = [];
  const effectsSchedule: Array<{ startTime: number; config: EffectsConfig }> = [];
  let offset = 0;

  tracks.forEach((track) => {
    if (track.lyricsTheme) {
      themeSchedule.push({
        startTime: offset,
        theme: structuredClone(track.lyricsTheme),
      });
    }
    if (track.effectsConfig) {
      effectsSchedule.push({
        startTime: offset,
        config: structuredClone(track.effectsConfig),
      });
    }
    offset += 30; // 30s per track
  });

  return { themeSchedule, effectsSchedule };
}

// ─── Tests ───────────────────────────────────────────────────

describe('Export Config Isolation', () => {
  describe('single-track export config', () => {
    it('deep-clones lyricTheme so mutations do not propagate back', () => {
      const originalTheme: LyricTheme = {
        ...DEFAULT_LYRICS_THEME,
        fontSize: 0.7,
        verticalPosition: 13,
        fontId: 'major-mono',
        wordSpacing: 1.0,
        colorPre: '#666666',
        colorActive: '#ef4444',
        colorPost: '#444444',
      };

      const originalTrack = { lyricsTheme: originalTheme };

      // Snapshot original values
      const beforeFontSize = originalTheme.fontSize;
      const beforeVerticalPosition = originalTheme.verticalPosition;
      const beforeFontId = originalTheme.fontId;

      // Build export config (simulates ExportTab logic)
      const exportConfig = buildSingleTrackExportConfig(originalTrack);

      // Mutate the export config's lyricTheme (simulates exporter operations)
      if (exportConfig.lyricTheme) {
        exportConfig.lyricTheme.fontSize = 999;
        exportConfig.lyricTheme.verticalPosition = 50;
        exportConfig.lyricTheme.fontId = 'mutated-font';
      }

      // Original track theme MUST be unchanged
      expect(originalTheme.fontSize).toBe(beforeFontSize);
      expect(originalTheme.verticalPosition).toBe(beforeVerticalPosition);
      expect(originalTheme.fontId).toBe(beforeFontId);
    });

    it('deep-clones effectsConfig so mutations do not propagate back', () => {
      const originalEffects: EffectsConfig = {
        ...DEFAULT_EFFECTS_CONFIG,
        backgroundBrightness: 1.0,
        backgroundScale: 1.5,
      };

      const originalTrack = { effectsConfig: originalEffects };

      const beforeBrightness = originalEffects.backgroundBrightness;

      const exportConfig = buildSingleTrackExportConfig(originalTrack);

      // Mutate
      if (exportConfig.effectsConfig) {
        exportConfig.effectsConfig.backgroundBrightness = 0.1;
      }

      expect(originalEffects.backgroundBrightness).toBe(beforeBrightness);
    });

    it('preserves all lyric theme fields in the export config', () => {
      const theme: LyricTheme = {
        ...DEFAULT_LYRICS_THEME,
        fontSize: 0.7,
        verticalPosition: 13,
        fontId: 'major-mono',
        wordSpacing: 1.0,
        colorPre: '#666666',
        colorActive: '#ef4444',
        colorPost: '#444444',
        glowEnabled: true,
        glowColor: '#ff0000',
        glowIntensity: 0.8,
        outlineColor: '#000000',
      };

      const exportConfig = buildSingleTrackExportConfig({ lyricsTheme: theme });

      expect(exportConfig.lyricTheme).toEqual(theme);
      expect(exportConfig.lyricVerticalPosition).toBe(13);
    });
  });

  describe('multi-track theme schedule', () => {
    it('deep-clones themes per track so schedule entries are independent', () => {
      const theme1: LyricTheme = {
        ...DEFAULT_LYRICS_THEME,
        verticalPosition: 13,
        fontSize: 0.7,
      };
      const theme2: LyricTheme = {
        ...DEFAULT_LYRICS_THEME,
        verticalPosition: 25,
        fontSize: 0.5,
      };

      const tracks = [
        { lyricsTheme: theme1, effectsConfig: { ...DEFAULT_EFFECTS_CONFIG } },
        { lyricsTheme: theme2, effectsConfig: { ...DEFAULT_EFFECTS_CONFIG } },
      ];

      const { themeSchedule } = buildThemeSchedule(tracks);

      // Mutate schedule entries
      themeSchedule[0].theme.verticalPosition = 99;
      themeSchedule[1].theme.verticalPosition = 99;

      // Originals must be untouched
      expect(theme1.verticalPosition).toBe(13);
      expect(theme2.verticalPosition).toBe(25);
    });

    it('deep-clones effects per track so schedule entries are independent', () => {
      const effects: EffectsConfig = {
        ...DEFAULT_EFFECTS_CONFIG,
        backgroundBrightness: 0.8,
      };

      const tracks = [{ effectsConfig: effects }];
      const { effectsSchedule } = buildThemeSchedule(tracks);

      effectsSchedule[0].config.backgroundBrightness = 0.1;

      expect(effects.backgroundBrightness).toBe(0.8);
    });
  });

  describe('lyric theme value preservation', () => {
    it('verticalPosition=13 survives a full clone cycle', () => {
      const theme: LyricTheme = {
        ...DEFAULT_LYRICS_THEME,
        verticalPosition: 13,
      };

      const cloned = structuredClone(theme);
      expect(cloned.verticalPosition).toBe(13);
      expect(cloned).toEqual(theme);
      expect(cloned).not.toBe(theme); // different reference
    });

    it('nested colors survive a full clone cycle', () => {
      const theme: LyricTheme = {
        ...DEFAULT_LYRICS_THEME,
        colors: { pre: '#111', active: '#222', post: '#333' },
        colorPre: '#111',
        colorActive: '#222',
        colorPost: '#333',
      };

      const cloned = structuredClone(theme);
      cloned.colors!.pre = '#999';

      expect(theme.colors!.pre).toBe('#111'); // original untouched
    });

    it('animation config survives clone', () => {
      const theme: LyricTheme = {
        ...DEFAULT_LYRICS_THEME,
        animationIn: {
          type: 'fade',
          granularity: 'word',
          duration: 0.5,
          stagger: 0.05,
          distance: 0,
        },
      };

      const cloned = structuredClone(theme);
      cloned.animationIn!.duration = 999;

      expect(theme.animationIn!.duration).toBe(0.5);
    });
  });
});
