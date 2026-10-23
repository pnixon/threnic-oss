/**
 * ButterchurnRenderer sizing + teardown. Butterchurn itself is mocked — we only
 * check what we hand it (pixelRatio pinned to 1, capped size) and that the
 * hidden canvas / WebGL context are released.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createVisualizer = vi.fn();
vi.mock('butterchurn', () => ({ default: { createVisualizer } }));
vi.mock('butterchurn-presets', () => ({ default: { getPresets: () => ({ a: {}, b: {} }) } }));

import { ButterchurnRenderer } from './ButterchurnRenderer';

const loseContext = vi.fn();
function fakeGL(limits = { tex: 16384, rb: 16384 }) {
  return {
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_RENDERBUFFER_SIZE: 0x84e8,
    isContextLost: () => false,
    getParameter: (p: number) => (p === 0x0d33 ? limits.tex : limits.rb),
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
  };
}

const audioContext = {} as AudioContext;
let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createVisualizer.mockReset();
  loseContext.mockReset();
  createVisualizer.mockReturnValue({
    connectAudio: vi.fn(),
    disconnectAudio: vi.fn(),
    setRendererSize: vi.fn(),
    loadPreset: vi.fn(),
    render: vi.fn(),
  });
});

afterEach(() => {
  getContextSpy?.mockRestore();
});

function stubGL(gl: unknown) {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(gl as RenderingContext);
}

describe('ButterchurnRenderer', () => {
  it('passes pixelRatio 1 and a ≤2048 size to butterchurn for a 4K export', async () => {
    stubGL(fakeGL());
    const r = new ButterchurnRenderer({ width: 3840, height: 2160, audioContext });
    expect(await r.init()).toBe(true);
    const opts = createVisualizer.mock.calls[0][2];
    expect(opts).toMatchObject({ width: 2048, height: 1152, pixelRatio: 1, textureRatio: 1 });
    expect(r.getCanvas().width).toBe(2048);
    expect(r.getCanvas().height).toBe(1152);
    r.destroy();
  });

  it('clamps to the context MAX_RENDERBUFFER_SIZE', async () => {
    stubGL(fakeGL({ tex: 4096, rb: 1024 }));
    const r = new ButterchurnRenderer({ width: 1920, height: 1080, audioContext });
    await r.init();
    expect(createVisualizer.mock.calls[0][2]).toMatchObject({ width: 1024, height: 576 });
    r.destroy();
  });

  it('setSize re-caps and forwards pixelRatio 1', async () => {
    stubGL(fakeGL());
    const r = new ButterchurnRenderer({ width: 1280, height: 720, audioContext });
    await r.init();
    const vis = createVisualizer.mock.results[0].value;
    r.setSize(5760, 3240);
    expect(vis.setRendererSize).toHaveBeenCalledWith(2048, 1152, {
      pixelRatio: 1,
      textureRatio: 1,
    });
    expect(r.getCanvas().width).toBe(2048);
    r.destroy();
  });

  it('destroy removes the hidden canvas and force-loses the WebGL context', async () => {
    stubGL(fakeGL());
    const r = new ButterchurnRenderer({ width: 640, height: 360, audioContext });
    await r.init();
    const canvas = r.getCanvas();
    expect(canvas.isConnected).toBe(true);
    r.destroy();
    expect(canvas.isConnected).toBe(false);
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(r.destroyed).toBe(true);
  });

  it('init fails cleanly without WebGL2', async () => {
    stubGL(null);
    const r = new ButterchurnRenderer({ width: 640, height: 360, audioContext });
    expect(await r.init()).toBe(false);
    expect(createVisualizer).not.toHaveBeenCalled();
    r.destroy();
    expect(r.getCanvas().isConnected).toBe(false);
  });

  it('stops rendering on webglcontextlost and rebuilds on restore', async () => {
    stubGL(fakeGL());
    const onContextLost = vi.fn();
    const onContextRestored = vi.fn();
    const r = new ButterchurnRenderer({
      width: 640,
      height: 360,
      audioContext,
      onContextLost,
      onContextRestored,
    });
    await r.init();
    const canvas = r.getCanvas();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(onContextLost).toHaveBeenCalled();
    expect(r.ready).toBe(false);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(onContextRestored).toHaveBeenCalledWith(true);
    expect(r.ready).toBe(true);
    expect(createVisualizer).toHaveBeenCalledTimes(2);
    r.destroy();
  });
});
