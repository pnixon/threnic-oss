/**
 * guestComposite.test.ts — contract for the GLSL guest composite subsystem
 * (Stage 3a, vertical slice).
 *
 * Mock-device tests (WebGPU + WebGL2 can't run in jsdom). They lock in:
 *   GuestCompositor:
 *     - one pipeline per blend mode, cached (re-use does not recreate).
 *     - 'replace' builds a pipeline with no blend state.
 *     - composite() writes the params uniform (opacity, preserveAlpha) and
 *       issues one draw.
 *   GLSLGuestManager:
 *     - sync() is a no-op-safe reconcile when the WebGL2 host can't init
 *       (jsdom): hasGuests() stays false, nothing throws.
 *     - lifecycle guards (renderAndComposite / destroy) are safe with no host.
 *   wrapGuestSource:
 *     - wraps a mainImage body with the full GLSL-guest uniform surface + the
 *       Threnic uValue1..8 slots and an outColor main().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuestCompositor } from './guestComposite';
import { GLSLGuestManager } from './GLSLGuestManager';
import { wrapGuestSource } from './GLSLGuestRenderer';
import type { GuestBlendMode, GuestCompositeParams } from './types';

function installGPUGlobals() {
  (globalThis as Record<string, unknown>).GPUTextureUsage = {
    RENDER_ATTACHMENT: 0x10,
    TEXTURE_BINDING: 0x04,
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    UNIFORM: 0x40,
  };
  (globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  (globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08 };
}

function makeMockDevice() {
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const encoder = { beginRenderPass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
  const createRenderPipeline = vi.fn(
    (d: { fragment: { targets: { blend?: GPUBlendState }[] } }) => ({
      __pipeline: true,
      blend: d.fragment.targets[0].blend,
    }),
  );
  const device = {
    createShaderModule: vi.fn(() => ({ __shader: true })),
    createBindGroupLayout: vi.fn(() => ({ __bgl: true })),
    createPipelineLayout: vi.fn(() => ({ __pl: true })),
    createSampler: vi.fn(() => ({ __sampler: true })),
    createBuffer: vi.fn(() => ({ __buffer: true, destroy: vi.fn() })),
    createRenderPipeline,
    createBindGroup: vi.fn(() => ({ __bg: true })),
    createTexture: vi.fn(() => ({
      __tex: true,
      width: 1920,
      height: 1080,
      createView: vi.fn(() => ({})),
      destroy: vi.fn(),
    })),
    queue: { writeBuffer: vi.fn(), copyExternalImageToTexture: vi.fn() },
  };
  return { device: device as unknown as GPUDevice, encoder, pass, createRenderPipeline };
}

function mockTexture() {
  return { createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture;
}

function params(overrides: Partial<GuestCompositeParams> = {}): GuestCompositeParams {
  return { opacity: 1, blendMode: 'alpha', preserveAlpha: false, ...overrides };
}

describe('GuestCompositor — blend-mode pipeline caching', () => {
  beforeEach(() => installGPUGlobals());

  it('builds one pipeline per blend mode and reuses it', () => {
    const { device, encoder, createRenderPipeline } = makeMockDevice();
    const c = new GuestCompositor(device, 'rgba8unorm');
    const tex = mockTexture();
    const view = {} as GPUTextureView;

    c.composite(tex, view, encoder, params({ blendMode: 'alpha' }));
    c.composite(tex, view, encoder, params({ blendMode: 'alpha' }));
    // Same mode twice → exactly one pipeline built.
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);

    c.composite(tex, view, encoder, params({ blendMode: 'additive' }));
    // New mode → a second pipeline.
    expect(createRenderPipeline).toHaveBeenCalledTimes(2);
  });

  it("'replace' builds a pipeline with no blend state; blended modes set one", () => {
    const { device, encoder, createRenderPipeline } = makeMockDevice();
    const c = new GuestCompositor(device, 'rgba8unorm');
    const tex = mockTexture();
    const view = {} as GPUTextureView;

    c.composite(tex, view, encoder, params({ blendMode: 'replace' }));
    const replaceCall = createRenderPipeline.mock.results[0].value;
    expect(replaceCall.blend).toBeUndefined();

    c.composite(tex, view, encoder, params({ blendMode: 'multiply' }));
    const mulCall = createRenderPipeline.mock.results[1].value;
    expect(mulCall.blend).toBeDefined();
  });

  it('composite writes clamped opacity + preserveAlpha and draws once', () => {
    const { device, encoder, pass } = makeMockDevice();
    const writeBuffer = device.queue.writeBuffer as unknown as ReturnType<typeof vi.fn>;
    const c = new GuestCompositor(device, 'rgba8unorm');
    const tex = mockTexture();
    const view = {} as GPUTextureView;

    c.composite(tex, view, encoder, params({ opacity: 2, preserveAlpha: true }));
    const written = writeBuffer.mock.calls[0][2] as Float32Array;
    expect(written[0]).toBe(1); // opacity clamped to 1
    expect(written[1]).toBe(1); // preserveAlpha → 1
    expect(pass.draw).toHaveBeenCalledWith(3);
    expect(pass.end).toHaveBeenCalledTimes(1);
  });

  it('all five blend modes build a pipeline without throwing', () => {
    const { device, encoder } = makeMockDevice();
    const c = new GuestCompositor(device, 'rgba8unorm');
    const tex = mockTexture();
    const view = {} as GPUTextureView;
    const modes: GuestBlendMode[] = ['alpha', 'additive', 'screen', 'multiply', 'replace'];
    for (const m of modes) {
      expect(() => c.composite(tex, view, encoder, params({ blendMode: m }))).not.toThrow();
    }
  });
});

describe('GLSLGuestManager — lifecycle (no WebGL2 host in jsdom)', () => {
  beforeEach(() => installGPUGlobals());

  it('sync is safe and hasGuests stays false when the host cannot init', () => {
    const { device } = makeMockDevice();
    const m = new GLSLGuestManager(device, 'rgba8unorm', 1920, 1080);
    expect(() =>
      m.sync([
        {
          id: 'a',
          source: 'void mainImage(out vec4 c, in vec2 f){ c = vec4(1.0); }',
          composite: params(),
        },
      ]),
    ).not.toThrow();
    // WebGL2 host cannot init in jsdom → no live guests.
    expect(m.hasGuests()).toBe(false);
  });

  it('renderAndComposite and destroy are safe with no active host', () => {
    const { device, encoder } = makeMockDevice();
    const m = new GLSLGuestManager(device, 'rgba8unorm', 640, 480);
    expect(() =>
      m.renderAndComposite('missing', {} as GPUTextureView, encoder, 0.016, null),
    ).not.toThrow();
    expect(() => m.destroy()).not.toThrow();
  });

  it('sync([]) with no guests is a no-op', () => {
    const { device } = makeMockDevice();
    const m = new GLSLGuestManager(device, 'rgba8unorm', 100, 100);
    expect(() => m.sync([])).not.toThrow();
    expect(m.guestIds()).toEqual([]);
  });

  it('sync with multipass buffers is safe with no host', () => {
    const { device } = makeMockDevice();
    const m = new GLSLGuestManager(device, 'rgba8unorm', 640, 480);
    expect(() =>
      m.sync([
        {
          id: 'g1',
          source:
            'void mainImage(out vec4 c, in vec2 f){ c = texture(iChannel0, f/iResolution.xy); }',
          composite: params(),
          channels: [
            {
              kind: 'buffer',
              bufferId: 'a',
              wrap: 'clamp',
              filter: 'linear',
              vflip: false,
              intensity: 1,
            },
            { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
            { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
            { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
          ],
          buffers: {
            a: {
              source:
                'void mainImage(out vec4 c, in vec2 f){ c = texture(iChannel0, f/iResolution.xy)*0.99; }',
              channels: [
                {
                  kind: 'buffer',
                  bufferId: 'a',
                  wrap: 'clamp',
                  filter: 'linear',
                  vflip: false,
                  intensity: 1,
                },
                { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
                { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
                { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
              ],
            },
          },
        },
      ]),
    ).not.toThrow();
    expect(m.hasGuests()).toBe(false); // no WebGL2 host in jsdom
  });
});

describe('wrapGuestSource', () => {
  it('wraps a mainImage body with the full uniform surface + slots + main()', () => {
    const body = 'void mainImage(out vec4 fragColor, in vec2 fragCoord){ fragColor = vec4(0.5); }';
    const src = wrapGuestSource(body);
    expect(src).toContain('#version 300 es');
    expect(src).toContain('uniform vec3 iResolution');
    expect(src).toContain('uniform float iTime');
    expect(src).toContain('uniform sampler2D iChannel0');
    expect(src).toContain('uniform float uValue1');
    expect(src).toContain('uniform float uValue8');
    expect(src).toContain(body);
    expect(src).toContain('mainImage(c, gl_FragCoord.xy)');
    // The wrapper forces opaque output alpha so a guest's stray alpha < 1 can't
    // attenuate RGB through the non-premultiplied copy.
    expect(src).toContain('outColor = vec4(c.rgb, 1.0)');
  });

  it('defaults all channels to none (sampler2D) with iChannel0..3 present', () => {
    const src = wrapGuestSource('void mainImage(out vec4 c, in vec2 f){ c = vec4(0.0); }');
    // All four channels declared. `none` still emits a sampler2D (placeholder),
    // so the sampler is never dangling — but at bind time it gets a black 1×1
    // texture, NOT the audio texture, so an unbound channel contributes nothing.
    expect(src).toContain('uniform sampler2D iChannel0');
    expect(src).toContain('iChannel1');
    expect(src).toContain('iChannel2');
    expect(src).toContain('iChannel3');
    // New uniform surface for image/cubemap channels.
    expect(src).toContain('uniform vec3 iChannelResolution[4]');
    expect(src).toContain('uniform float iChannelIntensity[4]');
  });

  it('emits samplerCube for a cubemap channel and sampler2D for image/audio', () => {
    const src = wrapGuestSource('void mainImage(out vec4 c, in vec2 f){ c = vec4(0.0); }', [
      'audio',
      'image2d',
      'cubemap',
      'none',
    ]);
    expect(src).toContain('uniform sampler2D iChannel0'); // audio
    expect(src).toContain('uniform sampler2D iChannel1'); // image2d
    expect(src).toContain('uniform samplerCube iChannel2'); // cubemap
    expect(src).toContain('uniform sampler2D iChannel3'); // none → sampler2D placeholder
  });

  it('emits sampler2D for a video channel', () => {
    const src = wrapGuestSource('void mainImage(out vec4 c, in vec2 f){ c = vec4(0.0); }', [
      'video',
      'none',
      'none',
      'none',
    ]);
    expect(src).toContain('uniform sampler2D iChannel0');
  });
});
