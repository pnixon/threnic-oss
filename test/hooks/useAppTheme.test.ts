import { renderHook } from '@testing-library/react';
import { useAppTheme } from '@/hooks/useAppTheme';
import { describe, it, expect, vi } from 'vitest';

// Mock themes and fonts
vi.mock('@/components/lyrics/themes', () => ({
  getTheme: () => ({
    backgroundColor: '#000000',
    colors: { pre: '#666666', active: '#ffffff', post: '#333333' },
  }),
}));

vi.mock('@/constants/fonts', () => ({
  FONTS: [
    { id: 'roboto', name: 'Roboto', defaultWordSpacing: 1.0, charWidthMultiplier: 0.6 },
    { id: 'montserrat', name: 'Montserrat', defaultWordSpacing: 1.2, charWidthMultiplier: 0.7 },
  ],
}));

describe('useAppTheme', () => {
  const defaultProps = {
    selectedFontId: 'roboto',
    fontSize: 0.5,
    lyricColors: { pre: '#666666', active: '#ffffff', post: '#333333' },
    animationType: 'fadeIn',
    animationStagger: 'word',
    fadeInDuration: 1.0,
    fadeOutDuration: 0.5,
    activeScaleEnabled: true,
    glowEnabled: true,
    glowColor: '#ff00ff',
    outlineColor: '#000000',
    wordSpacing: 1.0,
  };

  it('calculates effective theme correctly', () => {
    const { result } = renderHook(() => useAppTheme(defaultProps));

    expect(result.current.effectiveTheme).toBeDefined();
    expect(result.current.effectiveTheme.fontSize).toBe(0.5);
    expect(result.current.effectiveTheme.fontId).toBe('roboto');
    expect(result.current.effectiveTheme.animationIn.type).toBe('fade');
    expect(result.current.effectiveTheme.animationIn.granularity).toBe('word');
  });

  it('updates theme when props change', () => {
    const { result, rerender } = renderHook((props) => useAppTheme(props), {
      initialProps: defaultProps,
    });

    expect(result.current.effectiveTheme.fontSize).toBe(0.5);

    rerender({ ...defaultProps, fontSize: 0.8 });
    expect(result.current.effectiveTheme.fontSize).toBe(0.8);
  });

  it('handles typewriter animation type', () => {
    const { result } = renderHook(() =>
      useAppTheme({
        ...defaultProps,
        animationType: 'typewriter',
      }),
    );

    expect(result.current.effectiveTheme.animationIn.type).toBe('typewriter');
  });

  it('handles letter staggering', () => {
    const { result } = renderHook(() =>
      useAppTheme({
        ...defaultProps,
        animationStagger: 'letter',
      }),
    );

    expect(result.current.effectiveTheme.animationIn.granularity).toBe('char');
  });
});
