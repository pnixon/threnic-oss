/**
 * GLSLSourceEditor.test.tsx — the editor's non-WebGL behavior (Stage 3a).
 *
 * GLSLGuestRenderer is mocked (no WebGL2 in jsdom), so these lock in the DOM
 * contract: the source textarea, opacity slider, and blend buttons render and
 * call onChange with the right shape; the throwaway renderer is created on mount
 * and destroy()ed on unmount (the context-budget guarantee).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GLSLSourceEditor } from './GLSLSourceEditor';
import type { GLSLGuestConfig } from '@/types/effects/effect-instances';

const destroy = vi.fn();
const setGuest = vi.fn(() => ({ ok: true, log: '' }));
const init = vi.fn(() => true);
const ctor = vi.fn();

vi.mock('@/engine/gpu/glsl/GLSLGuestRenderer', () => ({
  GLSLGuestRenderer: class {
    ready = true;
    constructor(w: number, h: number) {
      ctor(w, h);
    }
    init = init;
    setGuest = setGuest;
    uploadAudio = vi.fn();
    render = vi.fn();
    getCanvas = vi.fn(() => null);
    setChannelParams = vi.fn();
    setChannelImage2D = vi.fn();
    setChannelCubemap = vi.fn();
    setChannelVideo = vi.fn();
    setBackgroundVideo = vi.fn();
    clearChannel = vi.fn();
    destroy = destroy;
  },
}));

vi.mock('@/engine/gpu/glsl/audioTexture', () => ({
  guestAudioFromStore: () => ({ fft: null, wave: null }),
}));

// AudioReactiveEditor is a separate, independently-tested component that pulls in
// the keyframe/effect context tree; stub it so this test isolates the GLSL
// editor's own DOM contract.
vi.mock('@/components/effects/shared/AudioReactiveEditor', () => ({
  AudioReactiveEditor: ({ label }: { label: string }) => <div data-ar-editor={label} />,
}));

// IndexedDB asset helpers are async no-ops in jsdom.
vi.mock('@/engine/gpu/glsl/glslGuestAssets', () => ({
  saveGuestAsset: vi.fn(async () => 'blob:mock'),
  removeGuestAsset: vi.fn(async () => {}),
  loadGuestImage2D: vi.fn(async () => null),
  loadGuestCubemap: vi.fn(async () => [null, null, null, null, null, null]),
  loadGuestAssetUrl: vi.fn(async () => undefined),
  image2dSlot: (i: number) => `ch${i}`,
  cubemapFaceSlot: (i: number, f: number) => `ch${i}.face${f}`,
  videoSlot: (i: number) => `ch${i}.video`,
  CUBEMAP_FACE_LABELS: ['+X', '-X', '+Y', '-Y', '+Z', '-Z'],
  CUBEMAP_FACE_COUNT: 6,
}));

function cfg(overrides: Partial<GLSLGuestConfig> = {}): GLSLGuestConfig {
  return {
    enabled: true,
    source: 'void mainImage(out vec4 c, in vec2 f){ c = vec4(1.0); }',
    opacity: 1,
    blendMode: 'alpha',
    ...overrides,
  };
}

describe('GLSLSourceEditor', () => {
  beforeEach(() => {
    destroy.mockClear();
    setGuest.mockClear();
    init.mockClear();
    ctor.mockClear();
    cleanup();
  });

  it('renders the source textarea, opacity slider, and blend buttons', () => {
    render(<GLSLSourceEditor config={cfg()} onChange={() => {}} guestId="test-guest" />);
    expect(screen.getByLabelText('GLSL fragment source')).toBeTruthy();
    expect(screen.getByLabelText('GLSL guest opacity')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Screen' })).toBeTruthy();
  });

  it('creates the preview renderer on mount and destroys it on unmount', () => {
    const { unmount } = render(
      <GLSLSourceEditor config={cfg()} onChange={() => {}} guestId="test-guest" />,
    );
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('changing opacity calls onChange with a clamped value', () => {
    const onChange = vi.fn();
    render(<GLSLSourceEditor config={cfg()} onChange={onChange} guestId="test-guest" />);
    fireEvent.change(screen.getByLabelText('GLSL guest opacity'), { target: { value: '0.4' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ opacity: 0.4 }));
  });

  it('clicking a blend button calls onChange with that mode', () => {
    const onChange = vi.fn();
    render(<GLSLSourceEditor config={cfg()} onChange={onChange} guestId="test-guest" />);
    fireEvent.click(screen.getByRole('button', { name: 'Multiply' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ blendMode: 'multiply' }));
  });

  it('the active blend button reflects the current mode', () => {
    render(
      <GLSLSourceEditor
        config={cfg({ blendMode: 'screen' })}
        onChange={() => {}}
        guestId="test-guest"
      />,
    );
    expect(screen.getByRole('button', { name: 'Screen' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Alpha' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
