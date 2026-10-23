import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Canvas } from '@react-three/fiber';
import { DEFAULT_POST_PROCESSING_CONFIG } from '@/types/effects';

// Mock ResizeObserver for Canvas
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ZoomEffect was refactored from a standalone component into the unified
// useComposerPass pipeline. The original ZoomEffect.tsx no longer exists.
// Instead, zoom is handled as a background-transform effect via useBackgroundTransform.
// These tests verify the zoom config defaults still exist and are well-formed.

describe('Zoom Effect Config', () => {
  it('has valid default zoom config', () => {
    const zoomConfig = DEFAULT_POST_PROCESSING_CONFIG.zoom;
    expect(zoomConfig).toBeDefined();
    expect(typeof zoomConfig.enabled).toBe('boolean');
  });

  it('zoom config has expected default values', () => {
    const zoomConfig = DEFAULT_POST_PROCESSING_CONFIG.zoom;
    expect(zoomConfig.enabled).toBe(false);
  });
});
