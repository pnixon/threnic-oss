import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LyricSettingsSection } from '@/components/panels/Inspector/tabs/LyricsTab/LyricSettingsSection';
import React from 'react';

// Mock components
vi.mock('@/components/panels/Inspector/CollapsibleSection', () => ({
  CollapsibleSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="collapsible-section">
      <h3>{title}</h3>
      {children}
    </div>
  ),
  SubCollapsibleSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="sub-collapsible-section">
      <h4>{title}</h4>
      {children}
    </div>
  ),
}));

vi.mock('@/contexts/KeyframeSelectionContext', () => ({
  useKeyframeSelection: () => ({
    selectedKeyframeId: 'default',
    setSelectedKeyframeId: vi.fn(),
    getSelectedKeyframe: vi.fn(),
    setKeyframes: vi.fn(),
    clearSelection: vi.fn(),
    isManualSelection: false,
  }),
}));

vi.mock('@/hooks/useKeyframes', () => ({
  useKeyframes: () => ({
    updateProperty: vi.fn(),
  }),
}));

vi.mock('@/components/effects/shared/SliderField', () => ({
  SliderField: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: number;
    onChange: (val: number) => void;
  }) => {
    const id = label.toLowerCase().replace(/\s+/g, '-');
    return (
      <div data-testid="slider-field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="range"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
      </div>
    );
  },
}));

describe('LyricSettingsSection', () => {
  const defaultProps = {
    selectedFontId: 'skyte',
    onFontChange: vi.fn(),
    fontSize: 0.25,
    onFontSizeChange: vi.fn(),
    wordSpacing: 1.0,
    onWordSpacingChange: vi.fn(),
    verticalPosition: 50,
    onVerticalPositionChange: vi.fn(),
    lyricColors: { pre: '#666666', active: '#d946ef', post: '#444444' },
    onLyricColorsChange: vi.fn(),
    glowEnabled: true,
    glowColor: '#ff00ff',
    onGlowColorChange: vi.fn(),
    outlineColor: '#000000',
    onOutlineColorChange: vi.fn(),
    animationType: 'fadeIn' as const,
    onAnimationTypeChange: vi.fn(),
    animationStagger: 'word' as const,
    onAnimationStaggerChange: vi.fn(),
    fadeInDuration: 1.0,
    onFadeInDurationChange: vi.fn(),
    fadeOutDuration: 0.5,
    onFadeOutDurationChange: vi.fn(),
    lyricsApplied: false,
    onApplyLyricsToAll: vi.fn(),
    continuousZoom: false,
    onContinuousZoomChange: vi.fn(),
    onZoomRangeChange: vi.fn(),
    onGlowEnabledChange: vi.fn(),
    glowIntensity: 1,
    onGlowIntensityChange: vi.fn(),
    laneCount: 1,
    selectedLane: -1,
    laneStyles: {},
    onLaneStyleChange: vi.fn(),
  };

  it('renders appearance controls', () => {
    render(<LyricSettingsSection {...defaultProps} />);

    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByLabelText('Font Family')).toBeInTheDocument();
    expect(screen.getByLabelText('Font Size')).toBeInTheDocument();
  });

  it('renders color controls', () => {
    render(<LyricSettingsSection {...defaultProps} />);

    expect(screen.getByText('Colors')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
  });

  it('renders animation controls', () => {
    render(<LyricSettingsSection {...defaultProps} />);

    expect(screen.getByText('Animation')).toBeInTheDocument();
    expect(screen.getByLabelText('Style')).toBeInTheDocument();
    expect(screen.getByLabelText('Stagger')).toBeInTheDocument();
  });

  it('triggers onFontChange when font selected', () => {
    render(<LyricSettingsSection {...defaultProps} />);

    const select = screen.getByLabelText('Font Family');
    fireEvent.change(select, { target: { value: 'jupiteroid' } });

    expect(defaultProps.onFontChange).toHaveBeenCalledWith('jupiteroid');
  });

  it('calls onApplyLyricsToAll when apply button clicked', () => {
    render(<LyricSettingsSection {...defaultProps} />);

    const applyBtn = screen.getByText('Apply Lyric Settings to All Tracks');
    fireEvent.click(applyBtn);

    expect(defaultProps.onApplyLyricsToAll).toHaveBeenCalled();
  });
});
