import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EffectsSettingsSection } from '@/components/panels/Inspector/tabs/EffectsTab/EffectsSettingsSection';
import React from 'react';

// Mock components
vi.mock('@/components/panels/Inspector/tabs/EffectsTab/DraggableEffectList', () => ({
  DraggableEffectList: ({
    onToggleEffect,
  }: {
    onToggleEffect: (id: string, enabled: boolean) => void;
  }) => (
    <div data-testid="draggable-effect-list">
      <button onClick={() => onToggleEffect('particles', true)}>Toggle Particles</button>
    </div>
  ),
}));

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

import type { EffectsConfig } from '@/types/effects';

describe('EffectsSettingsSection', () => {
  const defaultProps = {
    effectsConfig: {
      effectOrder: ['particles'],
      particles: { enabled: false },
      postProcessing: {},
    } as unknown as EffectsConfig,
    onEffectsConfigChange: vi.fn(),
    effectsApplied: false,
    onApplyEffectsToAll: vi.fn(),
  };

  it('renders effects list', () => {
    render(<EffectsSettingsSection {...defaultProps} />);

    expect(screen.getByTestId('draggable-effect-list')).toBeInTheDocument();
  });

  it('handles effect toggle', () => {
    render(<EffectsSettingsSection {...defaultProps} />);

    const toggleBtn = screen.getByText('Toggle Particles');
    fireEvent.click(toggleBtn);

    expect(defaultProps.onEffectsConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        particles: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it('calls onApplyEffectsToAll when apply button clicked', () => {
    render(<EffectsSettingsSection {...defaultProps} />);

    const applyBtn = screen.getByText('Apply Effects to All Tracks');
    fireEvent.click(applyBtn);

    expect(defaultProps.onApplyEffectsToAll).toHaveBeenCalled();
  });
});
