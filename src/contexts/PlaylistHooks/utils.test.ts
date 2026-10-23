import { describe, it, expect } from 'vitest';
import { syncBaseProperty } from './utils';
import type { Track } from '@/contexts/types';

/**
 * Regression: writing the whole `lyricsTheme` object via updateTrackProperty
 * (the Lyric FX panel does this to persist an updated `lyricFX` stack) matched
 * NONE of syncBaseProperty's prefixed branches ('lyrics.', 'fx.', ...), so the
 * write was silently dropped — clicking a lyric effect did nothing.
 */
describe('syncBaseProperty — lyricsTheme whole-object path', () => {
  const makeTrack = (): Track =>
    ({
      id: 't1',
      lyricsTheme: { fontSize: 0.5, lyricFX: [] },
    }) as unknown as Track;

  it('persists a whole lyricsTheme object (with a new lyricFX stack)', () => {
    const track = makeTrack();
    const newTheme = {
      fontSize: 0.5,
      lyricFX: [{ id: 'lyricfx-swell-1', type: 'swell', config: { enabled: true } }],
    };
    syncBaseProperty(track, 'lyricsTheme', newTheme);
    expect(track.lyricsTheme?.lyricFX).toHaveLength(1);
    expect((track.lyricsTheme?.lyricFX as { type: string }[])[0].type).toBe('swell');
  });

  it('still handles the dotted lyrics.<prop> path (animationIn duration)', () => {
    const track = makeTrack();
    syncBaseProperty(track, 'lyrics.animationIn', {
      type: 'fade',
      granularity: 'word',
      duration: 1.5,
    });
    expect(track.lyricsTheme?.animationIn?.duration).toBe(1.5);
  });

  // Regression: a `lyrics.colors.<state>` write updated ONLY the nested
  // `colors` object. The GPU Lyric FX driver reads the FLAT field first
  // (theme.colorPre ?? theme.colors?.pre), so the stale flat value shadowed the
  // picker change and the new colour never rendered (hard white on the WebGPU
  // path). syncBaseProperty must mirror the nested write into the flat field.
  it('mirrors lyrics.colors.<state> into the sibling flat colorPre/Active/Post', () => {
    const track = makeTrack();
    syncBaseProperty(track, 'lyrics.colors.pre', '#4400ff');
    syncBaseProperty(track, 'lyrics.colors.active', '#ff0000');
    syncBaseProperty(track, 'lyrics.colors.post', '#00ff6e');
    const theme = track.lyricsTheme as unknown as {
      colors?: { pre?: string; active?: string; post?: string };
      colorPre?: string;
      colorActive?: string;
      colorPost?: string;
    };
    // nested still written
    expect(theme.colors?.pre).toBe('#4400ff');
    expect(theme.colors?.active).toBe('#ff0000');
    expect(theme.colors?.post).toBe('#00ff6e');
    // AND the flat fields the renderer reads first
    expect(theme.colorPre).toBe('#4400ff');
    expect(theme.colorActive).toBe('#ff0000');
    expect(theme.colorPost).toBe('#00ff6e');
  });
});
