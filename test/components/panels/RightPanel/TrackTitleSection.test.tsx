import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TrackTitleSection } from '@/components/panels/Inspector/tabs/LyricsTab/TrackTitleSection';
import React from 'react';

// Mock components
vi.mock('@/components/panels/Inspector/CollapsibleSection', () => ({
  CollapsibleSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="collapsible-section">
      <h3>{title}</h3>
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

vi.mock('@/components/effects/shared/ColorField', () => ({
  ColorField: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (val: string) => void;
  }) => {
    const id = label.toLowerCase().replace(/\s+/g, '-');
    return (
      <div data-testid="color-field">
        <label htmlFor={id}>{label}</label>
        <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  },
}));

import type { EffectsConfig } from '@/types/effects';
import { Track } from '@/contexts/PlaylistContext';

describe('TrackTitleSection', () => {
  const defaultProps = {
    effectsConfig: {
      trackTitle: {
        enabled: true,
        fontId: 'roboto',
        fontSize: 0.4,
        positionX: 50,
        positionY: 10,
        color: '#d946ef',
        duration: 3.0,
      },
    } as unknown as EffectsConfig,
    onEffectsConfigChange: vi.fn(),
    tracks: [{ id: '1' }, { id: '2' }] as Track[],
    titleApplied: false,
    onApplyTrackTitleToAll: vi.fn(),
  };

  it('renders track title controls when enabled', () => {
    render(<TrackTitleSection {...defaultProps} />);

    expect(screen.getByText('Show Track Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Font Family')).toBeInTheDocument();
    expect(screen.getByLabelText('Title Color')).toBeInTheDocument();
  });

  it('toggles track title enabled state', () => {
    render(<TrackTitleSection {...defaultProps} />);

    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);

    expect(defaultProps.onEffectsConfigChange).toHaveBeenCalled();
  });

  it('triggers onEffectsConfigChange when font changes', () => {
    render(<TrackTitleSection {...defaultProps} />);

    const select = screen.getByLabelText('Font Family');
    fireEvent.change(select, { target: { value: 'space' } });

    expect(defaultProps.onEffectsConfigChange).toHaveBeenCalled();
  });

  it('triggers onEffectsConfigChange when color changes', () => {
    render(<TrackTitleSection {...defaultProps} />);

    const colorInput = screen.getByLabelText('Title Color');
    fireEvent.change(colorInput, { target: { value: '#ffffff' } });

    expect(defaultProps.onEffectsConfigChange).toHaveBeenCalled();
  });

  it('calls onApplyTrackTitleToAll when apply button clicked', () => {
    render(<TrackTitleSection {...defaultProps} />);

    const applyBtn = screen.getByText('Apply to All Tracks');
    fireEvent.click(applyBtn);

    expect(defaultProps.onApplyTrackTitleToAll).toHaveBeenCalled();
  });
});
