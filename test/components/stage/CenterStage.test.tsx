import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CenterStage } from '@/components/stage/CenterStage';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';

// Mock specific parts that might be heavy or non-functional in JSDOM
// mocking ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('CenterStage', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <CenterStage isPlaying={false} effectsConfig={DEFAULT_EFFECTS_CONFIG} />,
    );
    expect(container).toBeInTheDocument();
  });
});
