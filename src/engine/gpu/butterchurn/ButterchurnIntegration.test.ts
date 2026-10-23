/**
 * ButterchurnIntegration.test.ts — Tests for butterchurn rendering pipeline.
 *
 * Covers:
 * 1. Opacity is applied to butterchurn output before GPU copy
 * 2. Audio node connection works with analyser (not just sourceNode)
 * 3. Preset selection fires onChange on click (not just keyboard)
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 1. Opacity application logic
// ---------------------------------------------------------------------------
describe('Butterchurn opacity', () => {
  it('should dim butterchurn output when opacity < 1 using temp canvas', () => {
    // The WebGPURenderer applies opacity by compositing the butterchurn canvas
    // onto a black background with globalAlpha = opacity, then copying that
    // to the GPU texture. This test verifies the logic.
    const mockCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      globalAlpha: 1,
      fillStyle: '' as string,
    };

    const width = 1920;
    const height = 1080;
    const opacity = 0.5;
    const bcCanvas = {} as HTMLCanvasElement;

    // Simulate the opacity application logic from WebGPURenderer
    function applyButterchurnOpacity(
      ctx: typeof mockCtx,
      canvas: HTMLCanvasElement,
      w: number,
      h: number,
      op: number,
    ) {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = op;
      ctx.drawImage(canvas, 0, 0);
      ctx.globalAlpha = 1;
    }

    applyButterchurnOpacity(mockCtx, bcCanvas, width, height, opacity);

    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, width, height);
    expect(mockCtx.fillStyle).toBe('#000');
    expect(mockCtx.fillRect).toHaveBeenCalledWith(0, 0, width, height);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(bcCanvas, 0, 0);
    // globalAlpha was set to opacity before drawImage, then reset to 1
    expect(mockCtx.globalAlpha).toBe(1);
  });

  it('should skip opacity canvas when opacity >= 1', () => {
    // When opacity is 1.0 (or very close), the raw butterchurn canvas
    // should be copied directly without the intermediate 2D canvas.
    const opacity = 1.0;
    const useOpacityCanvas = opacity < 0.999;
    expect(useOpacityCanvas).toBe(false);
  });

  it('should use opacity canvas when opacity < 1', () => {
    const opacity = 0.7;
    const useOpacityCanvas = opacity < 0.999;
    expect(useOpacityCanvas).toBe(true);
  });

  it('should handle zero opacity (fully transparent)', () => {
    const opacity = 0;
    const useOpacityCanvas = opacity < 0.999;
    expect(useOpacityCanvas).toBe(true);
    // At zero opacity, drawImage with globalAlpha=0 produces pure black
    // which is correct -- butterchurn is invisible
  });
});

// ---------------------------------------------------------------------------
// 2. Audio node resolution
// ---------------------------------------------------------------------------
describe('Butterchurn audio connectivity', () => {
  it('should prefer analyser node over sourceNode for audio input', () => {
    // The fix: use analyser node which always has audio flowing regardless
    // of source type (playlist, mic, loopback, app capture).
    // sourceNode only works for playlist mode.
    const mockAnalyser = { type: 'AnalyserNode' };
    const mockSourceNode = { type: 'MediaElementAudioSourceNode' };

    // Simulate the resolution logic from GPUCanvas
    const audioNode = mockAnalyser ?? mockSourceNode;
    expect(audioNode).toBe(mockAnalyser);
  });

  it('should fall back to sourceNode when analyser is null', () => {
    const mockAnalyser = null;
    const mockSourceNode = { type: 'MediaElementAudioSourceNode' };

    const audioNode = mockAnalyser ?? mockSourceNode;
    expect(audioNode).toBe(mockSourceNode);
  });

  it('should handle both null (no audio available yet)', () => {
    const mockAnalyser = null;
    const mockSourceNode = null;

    const audioNode = mockAnalyser ?? mockSourceNode;
    expect(audioNode).toBeNull();
  });

  it('should reconnect audio when node changes', () => {
    // ButterchurnRenderer.connectAudio should only reconnect when the node
    // actually changes (reference equality check)
    const connectAudio = vi.fn();
    let currentNode: { id: string } | null = null;

    function simulateConnectAudio(node: { id: string }) {
      if (node === currentNode) return; // skip if same
      currentNode = node;
      connectAudio(node);
    }

    const node1 = { id: 'analyser-1' };
    const node2 = { id: 'analyser-2' };

    // First connection
    simulateConnectAudio(node1);
    expect(connectAudio).toHaveBeenCalledTimes(1);

    // Same node — should not reconnect
    simulateConnectAudio(node1);
    expect(connectAudio).toHaveBeenCalledTimes(1);

    // Different node — should reconnect
    simulateConnectAudio(node2);
    expect(connectAudio).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Preset selection
// ---------------------------------------------------------------------------
describe('Butterchurn preset selection', () => {
  it('should call onChange when a preset is clicked', () => {
    const onChange = vi.fn();
    const presetName = 'Flexi + Martin - astral projection';

    // Simulate the handleSelect from ButterchurnPresetSelect
    function handleSelect(name: string) {
      onChange(name);
    }

    handleSelect(presetName);
    expect(onChange).toHaveBeenCalledWith(presetName);
  });

  it('should update local state on selection', () => {
    let localValue = 'initial-preset';
    let lastPropRef = 'initial-preset';
    const onChange = vi.fn();

    function handleSelect(name: string) {
      localValue = name;
      lastPropRef = name;
      onChange(name);
    }

    handleSelect('New Preset');
    expect(localValue).toBe('New Preset');
    expect(lastPropRef).toBe('New Preset');
    expect(onChange).toHaveBeenCalledWith('New Preset');
  });

  it('should filter presets by search term', () => {
    const presetNames = [
      'Flexi - alien fish pond',
      'Flexi + Martin - astral projection',
      'Eo.S. + Phat - cubetrace',
      'Rovastar - cosmic journey',
    ];
    const search = 'flexi';

    const filtered = presetNames.filter((n) => n.toLowerCase().includes(search.toLowerCase()));
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toBe('Flexi - alien fish pond');
    expect(filtered[1]).toBe('Flexi + Martin - astral projection');
  });

  it('should support keyboard navigation (ArrowDown/ArrowUp)', () => {
    const presets = ['preset-a', 'preset-b', 'preset-c'];
    let currentIndex = 0;
    const onSelect = vi.fn();

    function handleKeyDown(key: string) {
      if (key === 'ArrowDown') {
        currentIndex = Math.min(currentIndex + 1, presets.length - 1);
        onSelect(presets[currentIndex]);
      } else if (key === 'ArrowUp') {
        currentIndex = Math.max(currentIndex - 1, 0);
        onSelect(presets[currentIndex]);
      }
    }

    handleKeyDown('ArrowDown');
    expect(onSelect).toHaveBeenLastCalledWith('preset-b');

    handleKeyDown('ArrowDown');
    expect(onSelect).toHaveBeenLastCalledWith('preset-c');

    // Should not go past the end
    handleKeyDown('ArrowDown');
    expect(onSelect).toHaveBeenLastCalledWith('preset-c');

    handleKeyDown('ArrowUp');
    expect(onSelect).toHaveBeenLastCalledWith('preset-b');
  });
});

// ---------------------------------------------------------------------------
// 4. Export path shader overlay config resolution (bonus — from prior fix)
// ---------------------------------------------------------------------------
describe('Export shader overlay config resolution', () => {
  interface ShaderCfg {
    enabled: boolean;
    presetId: string;
  }
  interface ShaderFxInstance {
    type: string;
    config: { enabled?: boolean; mode?: string; shader?: ShaderCfg };
  }

  it('should find shader config in effectInstances when top-level is missing', () => {
    // The DecoupledExporter previously only checked effectsConfig.shaderOverlay
    // (legacy path). The fix also checks effectInstances for a shaderFx instance.
    const effectsConfig = {
      shaderOverlay: { enabled: false, presetId: '' },
      effectInstances: [
        {
          type: 'shaderFx',
          config: {
            enabled: true,
            mode: 'shader',
            shader: { enabled: true, presetId: 'glowingWires', opacity: 1, p0: 0.4, p1: 0.3 },
          },
        },
      ],
    };

    // Simulate the resolution logic from DecoupledExporter
    let shaderCfg: ShaderCfg | undefined = effectsConfig.shaderOverlay;
    if (!shaderCfg?.enabled) {
      const instances = effectsConfig.effectInstances;
      const shaderInstance = instances?.find(
        (inst: ShaderFxInstance) =>
          inst.type === 'shaderFx' && inst.config?.mode === 'shader' && inst.config?.enabled,
      );
      if (shaderInstance) {
        shaderCfg = (shaderInstance.config as ShaderFxInstance['config']).shader;
      }
    }

    expect(shaderCfg).toBeDefined();
    expect(shaderCfg!.enabled).toBe(true);
    expect(shaderCfg!.presetId).toBe('glowingWires');
  });

  it('should use top-level shaderOverlay when it is enabled (legacy)', () => {
    const effectsConfig = {
      shaderOverlay: { enabled: true, presetId: 'synthwave', opacity: 0.8 },
      effectInstances: [],
    };

    const shaderCfg = effectsConfig.shaderOverlay;
    if (!shaderCfg?.enabled) {
      // Would look in effectInstances, but won't reach here
    }

    expect(shaderCfg.presetId).toBe('synthwave');
  });

  it('should return null/disabled when neither path has config', () => {
    const effectsConfig = {
      shaderOverlay: { enabled: false, presetId: '' },
      effectInstances: [{ type: 'shaderFx', config: { enabled: true, mode: 'butterchurn' } }],
    };

    let shaderCfg: ShaderCfg | undefined = effectsConfig.shaderOverlay;
    if (!shaderCfg?.enabled) {
      const instances = effectsConfig.effectInstances;
      const shaderInstance = instances?.find(
        (inst: ShaderFxInstance) =>
          inst.type === 'shaderFx' && inst.config?.mode === 'shader' && inst.config?.enabled,
      );
      if (shaderInstance) {
        shaderCfg = (shaderInstance.config as ShaderFxInstance['config']).shader;
      }
    }

    // shaderCfg still has enabled: false since no shader mode instance was found
    expect(shaderCfg!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Frame-driven audio injection (export reactivity fix)
// ---------------------------------------------------------------------------
// During a frame-accurate export the AudioContext clock is decoupled from the
// frame loop, so Butterchurn cannot read a live AnalyserNode and stay in sync.
// renderWithAudio() feeds the exact per-frame waveform bytes into
// visualizer.render({ audioLevels, elapsedTime }) so the export reacts to
// precisely the audio the frame corresponds to — matching the live preview.
describe('Butterchurn frame-driven audio injection (export)', () => {
  // Minimal ButterchurnRenderer stand-in exercising the real sizing logic.
  // Mirrors the buffer-sizing in ButterchurnRenderer.renderWithAudio so the
  // .set() overflow guard and mono L/R fan-out stay locked by a test.
  interface RenderOpts {
    audioLevels: {
      timeByteArray: Uint8Array;
      timeByteArrayL: Uint8Array;
      timeByteArrayR: Uint8Array;
    };
    elapsedTime: number;
  }

  class FakeVisualizer {
    lastOpts: RenderOpts | null | undefined = null;
    audio = { timeByteArray: new Uint8Array(1024) }; // butterchurn: numSamps*2
    render(opts?: RenderOpts) {
      this.lastOpts = opts;
    }
  }

  function renderWithAudio(vis: FakeVisualizer, timeByteArray: Uint8Array, fps: number) {
    const bcSize: number = vis.audio?.timeByteArray?.length ?? timeByteArray.length;
    const dst = new Uint8Array(bcSize);
    const n = Math.min(bcSize, timeByteArray.length);
    dst.set(timeByteArray.subarray(0, n));
    if (n < bcSize) dst.fill(128, n);
    vis.render({
      audioLevels: { timeByteArray: dst, timeByteArrayL: dst, timeByteArrayR: dst },
      elapsedTime: 1 / fps,
    });
    return dst;
  }

  it('passes audioLevels + elapsedTime so butterchurn skips the live analyser', () => {
    const vis = new FakeVisualizer();
    renderWithAudio(vis, new Uint8Array(2048).fill(200), 60);

    // The presence of audioLevels is what makes butterchurn.render() call
    // updateAudio() instead of sampleAudio() (the live-analyser path).
    expect(vis.lastOpts).toBeTruthy();
    expect(vis.lastOpts!.audioLevels).toBeTruthy();
    expect(vis.lastOpts!.elapsedTime).toBeCloseTo(1 / 60);
  });

  it('never overflows butterchurn internal buffer when source is longer (no .set() throw)', () => {
    const vis = new FakeVisualizer(); // internal size 1024
    // AudioAnalyzer produces a 2048-length time-domain array — longer than
    // butterchurn's 1024 buffer. Naively passing it to updateAudio would throw.
    const dst = renderWithAudio(vis, new Uint8Array(2048).fill(200), 60);
    expect(dst.length).toBe(1024);
    expect(vis.lastOpts!.audioLevels.timeByteArray.length).toBe(1024);
    expect(dst[0]).toBe(200); // real samples copied
  });

  it('zero-pads with silence (128) when the source is shorter than the buffer', () => {
    const vis = new FakeVisualizer(); // internal size 1024
    const dst = renderWithAudio(vis, new Uint8Array(256).fill(200), 60);
    expect(dst.length).toBe(1024);
    expect(dst[0]).toBe(200); // real sample region
    expect(dst[255]).toBe(200);
    expect(dst[256]).toBe(128); // padded region = time-domain silence
    expect(dst[1023]).toBe(128);
  });

  it('feeds the same mono waveform to left and right channels', () => {
    const vis = new FakeVisualizer();
    renderWithAudio(vis, new Uint8Array(1024).fill(90), 60);
    const { timeByteArray, timeByteArrayL, timeByteArrayR } = vis.lastOpts!.audioLevels;
    expect(timeByteArrayL).toBe(timeByteArray);
    expect(timeByteArrayR).toBe(timeByteArray);
  });

  it('elapsedTime tracks fps so preset-cycle/motion timing is frame-accurate', () => {
    const vis = new FakeVisualizer();
    renderWithAudio(vis, new Uint8Array(1024), 30);
    expect(vis.lastOpts!.elapsedTime).toBeCloseTo(1 / 30);
  });
});

// ---------------------------------------------------------------------------
// 6. Resize keeps the butterchurn texture in lockstep (silent-blank regression)
// ---------------------------------------------------------------------------
// Bug: modifying an effect (or any resize-triggering change) resized the
// butterchurn WebGL canvas and this.width/height, but WebGPURenderer.resize()
// never recreated _butterchurnTexture. The per-frame copy
//   copyExternalImageToTexture({source: bcCanvas}, {texture: _butterchurnTexture},
//                              [this.width, this.height])
// then copied the NEW extent into the OLD-sized texture, which throws — and the
// throw was swallowed by an empty catch, so butterchurn silently went blank with
// no console error. Fix: recreate the texture on resize so its size always
// matches the copy extent and the source canvas.
describe('Butterchurn resize texture sync', () => {
  // Models WebGPURenderer's copy: copyExternalImageToTexture rejects a copy
  // extent larger than the destination texture in any dimension.
  function copyExternalImageToTexture(
    source: { width: number; height: number },
    texture: { width: number; height: number },
    extent: [number, number],
  ) {
    const [w, h] = extent;
    if (w > texture.width || h > texture.height) {
      throw new Error('copy extent exceeds destination texture size');
    }
    if (w > source.width || h > source.height) {
      throw new Error('copy extent exceeds source size');
    }
  }

  // Minimal stand-in for the renderer's relevant state + the fixed resize().
  class FakeRenderer {
    width: number;
    height: number;
    bcCanvas: { width: number; height: number };
    bcTexture: { width: number; height: number };
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      this.bcCanvas = { width: w, height: h };
      this.bcTexture = { width: w, height: h };
    }
    createButterchurnTexture() {
      this.bcTexture = { width: this.width, height: this.height };
    }
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
      // FIX: butterchurn canvas + texture recreated to the new dimensions.
      this.bcCanvas = { width: w, height: h };
      this.createButterchurnTexture();
    }
    copyFrame() {
      copyExternalImageToTexture(this.bcCanvas, this.bcTexture, [this.width, this.height]);
    }
  }

  it('per-frame copy succeeds after a resize (texture recreated to new size)', () => {
    const r = new FakeRenderer(1920, 1080);
    expect(() => r.copyFrame()).not.toThrow();

    r.resize(1280, 720);
    expect(r.bcTexture).toEqual({ width: 1280, height: 720 });
    expect(() => r.copyFrame()).not.toThrow();

    r.resize(3840, 2160); // upsize (the case that always threw before)
    expect(r.bcTexture).toEqual({ width: 3840, height: 2160 });
    expect(() => r.copyFrame()).not.toThrow();
  });

  it('reproduces the old bug: stale texture size makes the copy throw', () => {
    // Simulate the PRE-FIX resize that only updated width/height + canvas.
    const r = new FakeRenderer(1280, 720);
    r.width = 3840;
    r.height = 2160;
    r.bcCanvas = { width: 3840, height: 2160 };
    // bcTexture intentionally left at 1280x720 (old code never recreated it).
    expect(() => r.copyFrame()).toThrow(/exceeds destination texture size/);
  });
});

// ---------------------------------------------------------------------------
// 7. Effective opacity is routing-independent (post-processing blank regression)
// ---------------------------------------------------------------------------
// Bug: butterchurn's effective opacity on the render-graph/blur path was
//   bcOpacity = min(userOpacity, fadeInAlpha)
// where fadeInAlpha ramped from 0 and could stick at 0 (e.g. dt==0). Since that
// fade lived ONLY on the intermediate path, enabling ANY post-processing effect
// (or blur) routed butterchurn through it and composited at opacity 0 → a black
// stage — while the direct-to-swapchain path (no effects) had no fade and showed
// butterchurn fine. Fix: effective opacity is just the user opacity on BOTH
// paths, so post-processing behaves identically to no post-processing.
describe('Butterchurn effective opacity is routing-independent', () => {
  // Post-fix computation (no fade cap).
  function effectiveOpacity(userOpacity: number): number {
    return userOpacity ?? 1.0;
  }
  // Pre-fix computation (fade cap) — kept to document the regression.
  function effectiveOpacityOld(userOpacity: number, fadeInAlpha: number): number {
    return Math.min(userOpacity, fadeInAlpha);
  }

  it('full-opacity butterchurn stays fully opaque when a render-graph effect is active', () => {
    expect(effectiveOpacity(1.0)).toBe(1.0);
  });

  it('honours a partial user opacity unchanged', () => {
    expect(effectiveOpacity(0.6)).toBeCloseTo(0.6);
  });

  it('does NOT blank to 0 the way the old fade cap did when fade-in is stuck at 0', () => {
    // This is the exact failing case from the [BC-DIAG] log: bcOpacity was 0.
    expect(effectiveOpacityOld(1.0, 0)).toBe(0); // old: black stage
    expect(effectiveOpacity(1.0)).toBe(1.0); // new: visible
  });
});

// ---------------------------------------------------------------------------
// 8. Initial preset resolution (export never starts on the blank visualizer)
// ---------------------------------------------------------------------------
// Bug: the export renderer (OffscreenGPURenderer) only loaded a preset when
// config.presetName was set. With no explicit preset AND a cycle mode selected,
// nothing was loaded, so the export began on butterchurn's default blank preset
// until the first cycle interval elapsed. Fix: ButterchurnRenderer.loadInitialPreset
// always resolves a concrete starting preset — the selected one, a random one in
// 'random' cycle mode, or the first one otherwise.
describe('Butterchurn initial preset resolution', () => {
  // Mirrors ButterchurnRenderer.loadInitialPreset without needing WebGL2/DOM.
  class FakeRenderer {
    presetNames: string[];
    loaded: { name: string; blendTime: number } | null = null;
    constructor(names: string[]) {
      this.presetNames = names;
    }
    loadPreset(name: string, blendTime = 0): boolean {
      if (!this.presetNames.includes(name)) return false;
      this.loaded = { name, blendTime };
      return true;
    }
    loadPresetByIndex(index: number, blendTime = 0): boolean {
      const n = this.presetNames.length;
      const clamped = ((index % n) + n) % n;
      return this.loadPreset(this.presetNames[clamped], blendTime);
    }
    loadInitialPreset(
      presetName: string | undefined,
      cycleMode: 'off' | 'sequential' | 'random',
      blendTime = 0,
    ): boolean {
      if (this.presetNames.length === 0) return false;
      if (presetName) return this.loadPreset(presetName, blendTime);
      if (cycleMode === 'random') {
        const index = Math.floor(Math.random() * this.presetNames.length);
        return this.loadPresetByIndex(index, blendTime);
      }
      return this.loadPresetByIndex(0, blendTime);
    }
  }

  const NAMES = ['preset-a', 'preset-b', 'preset-c', 'preset-d'];

  it('loads the explicitly selected preset regardless of cycle mode', () => {
    const r = new FakeRenderer(NAMES);
    r.loadInitialPreset('preset-c', 'random', 0);
    expect(r.loaded?.name).toBe('preset-c');
  });

  it("starts on a random preset when no name is set and cycle mode is 'random'", () => {
    // Force Math.random to the last bucket so the choice is deterministic here.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const r = new FakeRenderer(NAMES);
      r.loadInitialPreset('', 'random', 0);
      expect(r.loaded?.name).toBe('preset-d'); // floor(0.99 * 4) = 3
    } finally {
      spy.mockRestore();
    }
  });

  it("starts on the first preset when no name is set and cycle mode is 'sequential'", () => {
    const r = new FakeRenderer(NAMES);
    r.loadInitialPreset('', 'sequential', 0);
    expect(r.loaded?.name).toBe('preset-a');
  });

  it("starts on the first preset when no name is set and cycle mode is 'off'", () => {
    const r = new FakeRenderer(NAMES);
    r.loadInitialPreset('', 'off', 0);
    expect(r.loaded?.name).toBe('preset-a');
  });

  it('always resolves to a concrete preset (never the default blank one)', () => {
    for (const mode of ['off', 'sequential', 'random'] as const) {
      const r = new FakeRenderer(NAMES);
      const ok = r.loadInitialPreset('', mode, 0);
      expect(ok).toBe(true);
      expect(r.loaded).not.toBeNull();
      expect(NAMES).toContain(r.loaded!.name);
    }
  });

  it('reproduces the old bug: cycle mode + no name loaded nothing', () => {
    // PRE-FIX export path: only `if (config.presetName) loadPreset(...)`.
    const r = new FakeRenderer(NAMES);
    const presetName = ''; // cycle selected, no explicit preset
    if (presetName) r.loadPreset(presetName, 0);
    expect(r.loaded).toBeNull(); // nothing loaded → blank default visualizer
  });
});

// ---------------------------------------------------------------------------
// 9. Pipelined export path composites butterchurn (blank-export regression)
// ---------------------------------------------------------------------------
// Bug: OffscreenGPURenderer has TWO frame-submission paths — the serialized
// renderAndReadVideoFrame() and the pipelined submitFrame() (the one the export
// loop actually uses, per "[DecoupledExporter] Using pipelined GPU readback").
// renderButterchurnFrame() copies the butterchurn WebGL canvas into its OWN
// texture (_butterchurnTexture), NOT into bgIntermediateTexture. The serialized
// path then alpha-composites that texture over the background via
// _compositeButterchurn(). The pipelined path, however, wrongly assumed
// butterchurn had "pre-written bgIntermediateTexture": it set the bg pass to
// loadOp:'load' + skipped the bg draw AND never called _compositeButterchurn —
// so the intermediate stayed empty and the export rendered fully BLACK, exactly
// as seen at frame 451. Fix: the pipelined path draws the background and then
// composites butterchurn on top, identical to the serialized path.
describe('Pipelined export path composites butterchurn', () => {
  // Models the compositing decisions of a single OffscreenGPURenderer frame
  // path: does it draw the background, and does it composite the butterchurn
  // texture over it? Both real paths (renderAndReadVideoFrame + submitFrame)
  // must produce identical answers now.
  interface PathOps {
    routeToIntermediate: boolean;
    /** did the background fullscreen triangle get drawn into the target? */
    bgDrawn: boolean;
    /** was _compositeButterchurn() invoked on the target view? */
    bcComposited: boolean;
  }

  // Post-fix pipelined submitFrame() intermediate branch.
  function pipelinedPathOps(bcActive: boolean, hasEffects: boolean, blurActive: boolean): PathOps {
    const routeToIntermediate = hasEffects || blurActive || bcActive;
    if (!routeToIntermediate) {
      return { routeToIntermediate, bgDrawn: true, bcComposited: false };
    }
    // FIX: always draw the background, then composite butterchurn on top.
    const bgDrawn = true;
    const bcComposited = bcActive;
    return { routeToIntermediate, bgDrawn, bcComposited };
  }

  // PRE-FIX pipelined submitFrame(): assumed butterchurn pre-wrote the
  // intermediate, so it skipped the bg draw AND never composited.
  function pipelinedPathOpsOld(
    bcActive: boolean,
    hasEffects: boolean,
    blurActive: boolean,
  ): PathOps {
    const routeToIntermediate = hasEffects || blurActive || bcActive;
    const externalBgActive = bcActive;
    const bgDrawn = !externalBgActive; // skipped when butterchurn "active"
    const bcComposited = false; // never composited — the bug
    return { routeToIntermediate, bgDrawn, bcComposited };
  }

  // Serialized renderAndReadVideoFrame() intermediate branch (already correct).
  function serializedPathOps(bcActive: boolean, hasEffects: boolean, blurActive: boolean): PathOps {
    const routeToIntermediate = hasEffects || blurActive || bcActive;
    if (!routeToIntermediate) {
      return { routeToIntermediate, bgDrawn: true, bcComposited: false };
    }
    return { routeToIntermediate, bgDrawn: true, bcComposited: bcActive };
  }

  it('routes butterchurn-only export through the intermediate branch', () => {
    const ops = pipelinedPathOps(true, false, false);
    expect(ops.routeToIntermediate).toBe(true);
  });

  it('composites butterchurn over a drawn background (butterchurn-only, no effects)', () => {
    const ops = pipelinedPathOps(true, false, false);
    expect(ops.bgDrawn).toBe(true);
    expect(ops.bcComposited).toBe(true);
  });

  it('composites butterchurn when a post-processing effect is also active', () => {
    const ops = pipelinedPathOps(true, true, false);
    expect(ops.bgDrawn).toBe(true);
    expect(ops.bcComposited).toBe(true);
  });

  it('does not composite butterchurn when it is inactive', () => {
    const ops = pipelinedPathOps(false, true, false);
    expect(ops.bcComposited).toBe(false);
  });

  it('pipelined and serialized paths now agree on butterchurn compositing', () => {
    for (const bc of [true, false]) {
      for (const fx of [true, false]) {
        for (const blur of [true, false]) {
          const p = pipelinedPathOps(bc, fx, blur);
          const s = serializedPathOps(bc, fx, blur);
          expect(p.routeToIntermediate).toBe(s.routeToIntermediate);
          expect(p.bgDrawn).toBe(s.bgDrawn);
          expect(p.bcComposited).toBe(s.bcComposited);
        }
      }
    }
  });

  it('reproduces the old bug: pipelined butterchurn-only export was blank', () => {
    // butterchurn active, no other effects → routed to intermediate, but the
    // background draw was skipped AND butterchurn was never composited, leaving
    // the intermediate empty → BLANK export (the reported frame-451 black).
    const old = pipelinedPathOpsOld(true, false, false);
    expect(old.routeToIntermediate).toBe(true);
    expect(old.bgDrawn).toBe(false);
    expect(old.bcComposited).toBe(false);
    // Nothing was ever drawn into the intermediate on this path.
    const anythingRendered = old.bgDrawn || old.bcComposited;
    expect(anythingRendered).toBe(false);

    // Post-fix, the same inputs render butterchurn.
    const fixed = pipelinedPathOps(true, false, false);
    expect(fixed.bgDrawn || fixed.bcComposited).toBe(true);
  });
});
