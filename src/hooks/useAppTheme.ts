import { useMemo } from 'react';
import { getTheme } from '@/components/lyrics/themes';
import { FONTS } from '@/constants/fonts';
import { LyricAnimationType, LyricAnimationConfig } from '@/types/lyrics';

interface UseAppThemeProps {
  selectedFontId: string;
  fontSize: number;
  lyricColors: { pre: string; active: string; post: string };
  verticalPosition: number;
  horizontalPosition: 'left' | 'center' | 'right';
  wrapWidth: number;
  animationType: string;
  animationStagger: string;
  fadeInDuration: number;
  fadeOutDuration: number;
  highlightFadeIn: number;
  highlightFadeOut: number;
  activeScaleEnabled: boolean;
  glowEnabled: boolean;
  glowColor: string;
  outlineColor: string;
  glowIntensity: number;
  wordSpacing: number;
  lineSpacing: number;
}

export function useAppTheme({
  selectedFontId,
  fontSize,
  lyricColors,
  verticalPosition,
  horizontalPosition,
  wrapWidth,
  animationType,
  animationStagger,
  fadeInDuration,
  fadeOutDuration,
  highlightFadeIn,
  highlightFadeOut,
  activeScaleEnabled,
  glowEnabled,
  glowColor,
  outlineColor,
  glowIntensity,
  wordSpacing,
  lineSpacing,
}: UseAppThemeProps) {
  const theme = getTheme('neon');

  function getAnimationType(uiType: string): LyricAnimationType {
    if (uiType === 'typewriter') {
      return 'typewriter';
    }
    return 'fade';
  }

  function getGranularity(stagger: string): 'char' | 'word' | 'line' {
    if (stagger === 'letter') {
      return 'char';
    }
    if (stagger === 'word') {
      return 'word';
    }
    return 'line';
  }

  const effectiveTheme = useMemo(() => {
    const selectedFontDef = FONTS.find((f) => f.id === selectedFontId);

    return {
      ...theme,
      fontSize: fontSize,
      fontId: selectedFontId,
      verticalPosition: verticalPosition,
      horizontalPosition: horizontalPosition,
      wrapWidth: wrapWidth,
      colorPre: lyricColors.pre,
      colorActive: lyricColors.active,
      colorPost: lyricColors.post,
      colors: {
        pre: lyricColors.pre,
        active: lyricColors.active,
        post: lyricColors.post,
      },
      animationIn: {
        type: getAnimationType(animationType),
        granularity: getGranularity(animationStagger),
        duration: fadeInDuration,
        stagger: 0.05,
        distance: 0,
      } as LyricAnimationConfig,
      animationOut: {
        type: 'fade' as const,
        granularity: getGranularity(animationStagger),
        duration: fadeOutDuration,
        stagger: 0.03,
        distance: 0,
      } as LyricAnimationConfig,
      activeScale: activeScaleEnabled,
      glowEnabled: glowEnabled,
      glowColor: glowColor,
      glowIntensity: glowIntensity,
      outlineColor: outlineColor,
      wordSpacing: wordSpacing,
      lineSpacing: lineSpacing,
      charWidth: selectedFontDef?.charWidthMultiplier ?? 0.6,
      highlightFadeIn: highlightFadeIn,
      highlightFadeOut: highlightFadeOut,
    };
  }, [
    theme,
    fontSize,
    verticalPosition,
    horizontalPosition,
    wrapWidth,
    lyricColors.pre,
    lyricColors.active,
    lyricColors.post,
    animationType,
    animationStagger,
    fadeInDuration,
    fadeOutDuration,
    highlightFadeIn,
    highlightFadeOut,
    activeScaleEnabled,
    glowEnabled,
    glowColor,
    outlineColor,
    glowIntensity,
    wordSpacing,
    lineSpacing,
    selectedFontId,
  ]);

  return { effectiveTheme };
}
