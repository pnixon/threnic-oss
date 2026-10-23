import type { LyricAnimationType, LyricAnimationGranularity } from '../types/core';

export type UILyricAnimationType = 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
export type UILyricAnimationStagger = 'letter' | 'word' | 'line';

export function uiToEngineAnimationType(uiType: UILyricAnimationType | string): LyricAnimationType {
  switch (uiType) {
    case 'none':
      return 'fade';
    case 'fadeIn':
      return 'fade';
    case 'popIn':
      return 'pop';
    case 'slideUp':
      return 'slide';
    case 'flyIn':
      return 'fly';
    case 'typewriter':
      return 'typewriter';
    default:
      return 'fade';
  }
}

export function engineToUIAnimationType(
  engineType: LyricAnimationType | string,
): UILyricAnimationType {
  switch (engineType) {
    case 'fade':
      return 'fadeIn';
    case 'pop':
      return 'popIn';
    case 'fly':
      return 'flyIn';
    case 'slide':
      return 'slideUp';
    case 'typewriter':
      return 'typewriter';
    case 'zoom':
      return 'popIn'; // Fallback
    case 'none':
      return 'none';
    default:
      return 'fadeIn';
  }
}

export function uiToEngineStagger(
  uiStagger: UILyricAnimationStagger | string,
): LyricAnimationGranularity {
  switch (uiStagger) {
    case 'letter':
      return 'char';
    case 'word':
      return 'word';
    case 'line':
      return 'line';
    default:
      return 'word';
  }
}

export function engineToUIStagger(
  engineStagger: LyricAnimationGranularity | string,
): UILyricAnimationStagger {
  switch (engineStagger) {
    case 'char':
      return 'letter';
    case 'word':
      return 'word';
    case 'line':
      return 'line';
    default:
      return 'word';
  }
}
