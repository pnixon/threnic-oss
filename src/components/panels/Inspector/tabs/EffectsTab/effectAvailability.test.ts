import { describe, it, expect } from 'vitest';
import { effectUnavailableReason } from './effectAvailability';

describe('effectUnavailableReason', () => {
  it('everything is available on the WebGPU stage and while detecting', () => {
    for (const type of ['bloom', 'butterchurn', 'particles', 'zoom']) {
      expect(effectUnavailableReason(type, 'webgpu')).toBeNull();
      expect(effectUnavailableReason(type, 'pending')).toBeNull();
    }
  });

  it('GPU-only effects are unavailable on the fallback stage', () => {
    for (const type of ['bloom', 'butterchurn', 'particles', 'shaderFx', 'customShader']) {
      expect(effectUnavailableReason(type, 'fallback')).toMatch(/WebGPU/);
    }
  });

  it('background transforms / opacity still work on the fallback stage', () => {
    for (const type of ['zoom', 'slide', 'rotate', 'bgOpacity']) {
      expect(effectUnavailableReason(type, 'fallback')).toBeNull();
    }
  });
});
