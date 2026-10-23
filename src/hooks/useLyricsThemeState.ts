/**
 * useLyricsThemeState — single source of truth for lyrics theme.
 *
 * Reads the selected track's lyricsTheme directly from projectStore
 * using useSyncExternalStore for guaranteed-consistent reads.
 * Setters write to projectStore imperatively.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { projectStore } from '@/stores/projectStore';
import { DEFAULT_LYRICS_THEME, type LyricTheme } from '@/types/lyrics';
import { FONTS } from '@/constants/fonts';
import { engineToUIAnimationType, engineToUIStagger } from '@/engine/lyrics/animationMap';

interface LyricsThemeState {
  // ── Values ──
  verticalPosition: number;
  horizontalPosition: 'left' | 'center' | 'right';
  wrapWidth: number;
  fontSize: number;
  selectedFontId: string;
  lyricColors: { pre: string; active: string; post: string };
  wordSpacing: number;
  lineSpacing: number;
  glowEnabled: boolean;
  glowColor: string;
  glowIntensity: number;
  outlineColor: string;
  fadeInDuration: number;
  fadeOutDuration: number;
  highlightFadeIn: number;
  highlightFadeOut: number;
  animationType: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
  animationStagger: 'letter' | 'word' | 'line';
  activeScaleEnabled: boolean;
  effectScope: 'word' | 'line' | 'background';

  // ── Setters ──
  setVerticalPosition: (v: number) => void;
  setHorizontalPosition: (v: 'left' | 'center' | 'right') => void;
  setWrapWidth: (v: number) => void;
  setFontSize: (v: number) => void;
  setSelectedFontId: (v: string) => void;
  setLyricColors: (v: { pre: string; active: string; post: string }) => void;
  setWordSpacing: (v: number) => void;
  setLineSpacing: (v: number) => void;
  setGlowEnabled: (v: boolean) => void;
  setGlowColor: (v: string) => void;
  setGlowIntensity: (v: number) => void;
  setOutlineColor: (v: string) => void;
  setFadeInDuration: (v: number) => void;
  setFadeOutDuration: (v: number) => void;
  setHighlightFadeIn: (v: number) => void;
  setHighlightFadeOut: (v: number) => void;
  setAnimationType: (v: string) => void;
  setAnimationStagger: (v: string) => void;
  setActiveScaleEnabled: (v: boolean) => void;
  setEffectScope: (v: string) => void;

  /** Change font and auto-update wordSpacing to the font's default */
  handleFontChange: (fontId: string) => void;
}

// ── Store subscription for useSyncExternalStore ──

const subscribe = projectStore.subscribe;

function getThemeSnapshot(): LyricTheme {
  const state = projectStore.getState();
  const track = state.tracks.find((t) => t.id === state.selectedTrackId);
  return track?.lyricsTheme ?? DEFAULT_LYRICS_THEME;
}

function getTrackIdSnapshot(): string | null {
  return projectStore.getState().selectedTrackId;
}

export function useLyricsThemeState(): LyricsThemeState {
  // useSyncExternalStore guarantees consistent reads and triggers re-render
  // whenever the store changes. No stale closures, no missed updates.
  const theme = useSyncExternalStore(subscribe, getThemeSnapshot, getThemeSnapshot);
  const trackId = useSyncExternalStore(subscribe, getTrackIdSnapshot, getTrackIdSnapshot);

  // Helper: patch field(s) on the current track's lyricsTheme via projectStore
  const patch = useCallback(
    (partial: Partial<LyricTheme>) => {
      const state = projectStore.getState();
      const id = state.selectedTrackId;
      if (!id) return;
      const track = state.tracks.find((t) => t.id === id);
      const current = track?.lyricsTheme ?? DEFAULT_LYRICS_THEME;
      state.updateTrackLyricsTheme(id, { ...current, ...partial });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackId keeps the callback identity changing on track switch
    [trackId],
  );

  // ── Setters ──

  const setVerticalPosition = useCallback((v: number) => patch({ verticalPosition: v }), [patch]);
  const setHorizontalPosition = useCallback(
    (v: 'left' | 'center' | 'right') => patch({ horizontalPosition: v }),
    [patch],
  );
  const setWrapWidth = useCallback((v: number) => patch({ wrapWidth: v }), [patch]);
  const setFontSize = useCallback((v: number) => patch({ fontSize: v }), [patch]);
  const setSelectedFontId = useCallback((v: string) => patch({ fontId: v }), [patch]);
  const setLyricColors = useCallback(
    (v: { pre: string; active: string; post: string }) =>
      patch({ colors: v, colorPre: v.pre, colorActive: v.active, colorPost: v.post }),
    [patch],
  );
  const setWordSpacing = useCallback((v: number) => patch({ wordSpacing: v }), [patch]);
  const setLineSpacing = useCallback((v: number) => patch({ lineSpacing: v }), [patch]);
  const setGlowEnabled = useCallback((v: boolean) => patch({ glowEnabled: v }), [patch]);
  const setGlowColor = useCallback((v: string) => patch({ glowColor: v }), [patch]);
  const setGlowIntensity = useCallback((v: number) => patch({ glowIntensity: v }), [patch]);
  const setOutlineColor = useCallback((v: string) => patch({ outlineColor: v }), [patch]);
  const setFadeInDuration = useCallback(
    (v: number) => {
      const state = projectStore.getState();
      const id = state.selectedTrackId;
      if (!id) return;
      const track = state.tracks.find((t) => t.id === id);
      const current = track?.lyricsTheme ?? DEFAULT_LYRICS_THEME;
      state.updateTrackLyricsTheme(id, {
        ...current,
        animationIn: {
          ...(current.animationIn ?? { type: 'fade', granularity: 'word' }),
          duration: v,
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackId keeps the callback identity changing on track switch
    [trackId],
  );
  const setFadeOutDuration = useCallback(
    (v: number) => {
      const state = projectStore.getState();
      const id = state.selectedTrackId;
      if (!id) return;
      const track = state.tracks.find((t) => t.id === id);
      const current = track?.lyricsTheme ?? DEFAULT_LYRICS_THEME;
      state.updateTrackLyricsTheme(id, {
        ...current,
        animationOut: {
          ...(current.animationOut ?? { type: 'fade', granularity: 'word' }),
          duration: v,
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackId keeps the callback identity changing on track switch
    [trackId],
  );
  const setHighlightFadeIn = useCallback((v: number) => patch({ highlightFadeIn: v }), [patch]);
  const setHighlightFadeOut = useCallback((v: number) => patch({ highlightFadeOut: v }), [patch]);
  const setAnimationType = useCallback(
    (v: string) => {
      const state = projectStore.getState();
      const id = state.selectedTrackId;
      if (!id) return;
      const track = state.tracks.find((t) => t.id === id);
      const current = track?.lyricsTheme ?? DEFAULT_LYRICS_THEME;
      state.updateTrackLyricsTheme(id, {
        ...current,
        animationIn: {
          ...(current.animationIn ?? { type: 'fade', granularity: 'word' }),
          type: v as NonNullable<LyricTheme['animationIn']>['type'],
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackId keeps the callback identity changing on track switch
    [trackId],
  );
  const setAnimationStagger = useCallback(
    (v: string) => {
      const state = projectStore.getState();
      const id = state.selectedTrackId;
      if (!id) return;
      const track = state.tracks.find((t) => t.id === id);
      const current = track?.lyricsTheme ?? DEFAULT_LYRICS_THEME;
      const granularity = v === 'letter' ? 'char' : v === 'line' ? 'line' : 'word';
      state.updateTrackLyricsTheme(id, {
        ...current,
        animationIn: {
          ...(current.animationIn ?? { type: 'fade', granularity: 'word' }),
          granularity,
        },
        animationOut: {
          ...(current.animationOut ?? { type: 'fade', granularity: 'word' }),
          granularity,
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackId keeps the callback identity changing on track switch
    [trackId],
  );
  const setActiveScaleEnabled = useCallback((v: boolean) => patch({ activeScale: v }), [patch]);
  const setEffectScope = useCallback(
    (v: string) => patch({ effect: v as LyricTheme['effect'] }),
    [patch],
  );

  const handleFontChange = useCallback(
    (fontId: string) => {
      const fontDef = FONTS.find((f) => f.id === fontId);
      const updates: Partial<LyricTheme> = { fontId };
      if (fontDef) updates.wordSpacing = fontDef.defaultWordSpacing;
      patch(updates);
    },
    [patch],
  );

  // ── Derived values ──

  const lyricColors = useMemo(
    () => ({
      pre: theme.colorPre ?? theme.colors?.pre ?? '#A9A9A9',
      active: theme.colorActive ?? theme.colors?.active ?? '#FFFFFF',
      post: theme.colorPost ?? theme.colors?.post ?? '#666666',
    }),
    [theme.colorPre, theme.colorActive, theme.colorPost, theme.colors],
  );

  // Map engine animation types → UI types using the canonical converters
  const animationType: LyricsThemeState['animationType'] = engineToUIAnimationType(
    theme.animationIn?.type ?? 'fade',
  );
  const animationStagger: LyricsThemeState['animationStagger'] = engineToUIStagger(
    theme.animationIn?.granularity ?? 'word',
  );

  return {
    verticalPosition: theme.verticalPosition ?? 10,
    horizontalPosition: theme.horizontalPosition ?? 'center',
    wrapWidth: theme.wrapWidth ?? 90,
    fontSize: theme.fontSize ?? 0.5,
    selectedFontId: theme.fontId ?? 'roboto',
    lyricColors,
    wordSpacing: theme.wordSpacing ?? 1.0,
    lineSpacing: theme.lineSpacing ?? 1.35,
    glowEnabled: theme.glowEnabled ?? false,
    glowColor: theme.glowColor ?? '#FFFFFF',
    glowIntensity: theme.glowIntensity ?? 0.3,
    outlineColor: theme.outlineColor ?? '#000000',
    fadeInDuration: theme.animationIn?.duration ?? 1.0,
    fadeOutDuration: theme.animationOut?.duration ?? 1.0,
    highlightFadeIn: theme.highlightFadeIn ?? 1.0,
    highlightFadeOut: theme.highlightFadeOut ?? 1.0,
    animationType,
    animationStagger,
    activeScaleEnabled: theme.activeScale ?? false,
    // effectScope is a UI concept (word/line/background) separate from theme.effect
    // (none/shake/glow etc). Default to 'word' since LyricTheme doesn't carry effectScope.
    effectScope: 'word' as LyricsThemeState['effectScope'],

    setVerticalPosition,
    setHorizontalPosition,
    setWrapWidth,
    setFontSize,
    setSelectedFontId,
    setLyricColors,
    setWordSpacing,
    setLineSpacing,
    setGlowEnabled,
    setGlowColor,
    setGlowIntensity,
    setOutlineColor,
    setFadeInDuration,
    setFadeOutDuration,
    setHighlightFadeIn,
    setHighlightFadeOut,
    setAnimationType,
    setAnimationStagger,
    setActiveScaleEnabled,
    setEffectScope,
    handleFontChange,
  };
}
