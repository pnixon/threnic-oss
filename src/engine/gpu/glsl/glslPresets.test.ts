import { describe, it, expect } from 'vitest';
import { GLSL_PRESETS, GLSL_CUSTOM_ID, matchGlslPresetId } from './glslPresets';

describe('glslPresets — curated GLSL guest library', () => {
  it('lists custom first, then real presets with non-empty audio-reactive bodies', () => {
    expect(GLSL_PRESETS[0].id).toBe(GLSL_CUSTOM_ID);
    const real = GLSL_PRESETS.filter((p) => p.id !== GLSL_CUSTOM_ID);
    expect(real.length).toBeGreaterThan(0);
    for (const p of real) {
      expect(p.source).toContain('mainImage');
      // Each preset samples the audio texture so it reacts out of the box.
      expect(p.source).toContain('iChannel0');
    }
  });

  it('matchGlslPresetId identifies a known source, else custom', () => {
    const preset = GLSL_PRESETS[1];
    expect(matchGlslPresetId(preset.source)).toBe(preset.id);
    expect(matchGlslPresetId('void mainImage(){ /* hand-written */ }')).toBe(GLSL_CUSTOM_ID);
  });

  it('audio-reactive presets declare channelKinds so applying them binds audio', () => {
    // Channels now default to 'none' (unbound → reads 0), so a preset that
    // samples iChannel0 MUST declare channelKinds to opt into audio, or it
    // renders static.
    const pulse = GLSL_PRESETS.find((p) => p.id === 'audio-pulse');
    expect(pulse).toBeDefined();
    expect(pulse!.source).toContain('iChannel0');
    expect(pulse!.channelKinds?.[0]).toBe('audio');
    // The custom sentinel binds nothing.
    const custom = GLSL_PRESETS.find((p) => p.id === GLSL_CUSTOM_ID);
    expect(custom!.channelKinds).toBeUndefined();
  });

  describe('E2E Kitchen Sink preset — full multipass + channel coverage (dev-only)', () => {
    // The E2E preset is gated to NODE_ENV==='development' in glslPresets.ts, so
    // it does NOT appear in GLSL_PRESETS under vitest (NODE_ENV==='test'). Assert
    // both the gating AND the preset contract by importing the dev module directly.
    it('is NOT present in GLSL_PRESETS outside development (prod/test build)', () => {
      // vitest runs with NODE_ENV='test', so the dev preset must be absent.
      expect(GLSL_PRESETS.find((p) => p.id === 'e2e-kitchen-sink')).toBeUndefined();
      expect(process.env.NODE_ENV).not.toBe('development');
    });

    it('exists in the dev module and ships all four buffers a/b/c/d', async () => {
      const { E2E_KITCHEN_SINK: e2e } = await import('./glslPresets.dev');
      expect(e2e).toBeDefined();
      expect(e2e.buffers).toBeDefined();
      for (const bid of ['a', 'b', 'c', 'd'] as const) {
        expect(e2e.buffers![bid]).toBeDefined();
        expect(e2e.buffers![bid]!.source).toContain('mainImage');
        expect(e2e.buffers![bid]!.channelKinds.length).toBe(4);
      }
    });

    it('exercises every GuestChannelKind across the graph', async () => {
      const { E2E_KITCHEN_SINK: e2e } = await import('./glslPresets.dev');
      const allKinds = new Set<string>();
      for (const k of e2e.channelKinds ?? []) allKinds.add(k);
      for (const bid of ['a', 'b', 'c', 'd'] as const) {
        for (const k of e2e.buffers![bid]!.channelKinds) allKinds.add(k);
      }
      for (const kind of ['audio', 'image2d', 'cubemap', 'buffer', 'video']) {
        expect(allKinds.has(kind)).toBe(true);
      }
    });

    it('Buffer A self-references itself for ping-pong feedback', async () => {
      const { E2E_KITCHEN_SINK: e2e } = await import('./glslPresets.dev');
      const a = e2e.buffers!.a!;
      const idx = a.channelKinds.indexOf('buffer');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(a.bufferRefs?.[idx]).toBe('a');
    });

    it('Image pass composites all four buffers a/b/c/d in order', async () => {
      const { E2E_KITCHEN_SINK: e2e } = await import('./glslPresets.dev');
      expect(e2e.channelKinds).toEqual(['buffer', 'buffer', 'buffer', 'buffer']);
      expect(e2e.bufferRefs).toEqual(['a', 'b', 'c', 'd']);
      for (const ch of ['iChannel0', 'iChannel1', 'iChannel2', 'iChannel3']) {
        expect(e2e.source).toContain(ch);
      }
    });

    it('uses routed uValue slots (uValue1 in Buffer C, uValue2 in Image)', async () => {
      const { E2E_KITCHEN_SINK: e2e } = await import('./glslPresets.dev');
      expect(e2e.buffers!.c!.source).toContain('uValue1');
      expect(e2e.source).toContain('uValue2');
    });

    it('Buffer C ships a self-contained embedded cubemap (6 face data URIs)', async () => {
      const { E2E_KITCHEN_SINK: e2e } = await import('./glslPresets.dev');
      const embedded = e2e.buffers!.c!.embeddedCubemap;
      expect(embedded).toBeDefined();
      expect(embedded!.channel).toBe(0);
      expect(embedded!.faces.length).toBe(6);
      for (const face of embedded!.faces) {
        expect(face.startsWith('data:image/png;base64,')).toBe(true);
      }
    });

    it('Buffer B ships a self-contained embedded image (zero-upload)', async () => {
      const { E2E_KITCHEN_SINK: e2e } = await import('./glslPresets.dev');
      const img = e2e.buffers!.b!.embeddedImage;
      expect(img).toBeDefined();
      expect(img!.channel).toBe(0);
      expect(img!.dataUri.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('Buffer D video uses the background source, not an upload', async () => {
      const { E2E_KITCHEN_SINK: e2e } = await import('./glslPresets.dev');
      const d = e2e.buffers!.d!;
      expect(d.channelKinds[0]).toBe('video');
      // No embeddedVideo / upload — the loader treats unset videoSource as
      // 'background', pulling the track's background video.
      expect((d as { videoSources?: unknown }).videoSources).toBeUndefined();
    });
  });

  describe('dev-only edge-case debug presets', () => {
    it('are absent from GLSL_PRESETS outside development', () => {
      const ids = GLSL_PRESETS.map((p) => p.id);
      for (const id of [
        'debug-self-feedback',
        'debug-cubemap-orientation',
        'debug-all-none',
        'debug-uvalue-sweep',
        'debug-buffer-chain',
        'debug-res-intensity',
      ]) {
        expect(ids).not.toContain(id);
      }
    });

    it('the dev module exports six single-concern debug presets', async () => {
      const { DEV_DEBUG_PRESETS } = await import('./glslPresets.dev');
      expect(DEV_DEBUG_PRESETS.length).toBe(6);
      for (const p of DEV_DEBUG_PRESETS) {
        expect(p.source).toContain('mainImage');
        expect(p.label.startsWith('Debug · ')).toBe(true);
        expect(p.channelKinds?.length).toBe(4);
      }
    });

    it('self-feedback debug samples its own buffer (ping-pong)', async () => {
      const { DEV_DEBUG_PRESETS } = await import('./glslPresets.dev');
      const p = DEV_DEBUG_PRESETS.find((x) => x.id === 'debug-self-feedback')!;
      expect(p.buffers!.a!.channelKinds[0]).toBe('buffer');
      expect(p.buffers!.a!.bufferRefs?.[0]).toBe('a'); // self
    });

    it('buffer-chain debug wires a→b→c→d in dependency order', async () => {
      const { DEV_DEBUG_PRESETS } = await import('./glslPresets.dev');
      const p = DEV_DEBUG_PRESETS.find((x) => x.id === 'debug-buffer-chain')!;
      expect(p.buffers!.b!.bufferRefs?.[0]).toBe('a');
      expect(p.buffers!.c!.bufferRefs?.[0]).toBe('b');
      expect(p.buffers!.d!.bufferRefs?.[0]).toBe('c');
      expect(p.bufferRefs?.[0]).toBe('d'); // Image samples D
    });

    it('all-none debug binds zero channels (must render black)', async () => {
      const { DEV_DEBUG_PRESETS } = await import('./glslPresets.dev');
      const p = DEV_DEBUG_PRESETS.find((x) => x.id === 'debug-all-none')!;
      expect(p.channelKinds).toEqual(['none', 'none', 'none', 'none']);
      expect(p.buffers).toBeUndefined();
    });

    it('uvalue-sweep reads all 8 routed slots', async () => {
      const { DEV_DEBUG_PRESETS } = await import('./glslPresets.dev');
      const p = DEV_DEBUG_PRESETS.find((x) => x.id === 'debug-uvalue-sweep')!;
      for (let n = 1; n <= 8; n++) expect(p.source).toContain(`uValue${n}`);
    });

    it('res/intensity probe reads iChannelResolution and iChannelIntensity', async () => {
      const { DEV_DEBUG_PRESETS } = await import('./glslPresets.dev');
      const p = DEV_DEBUG_PRESETS.find((x) => x.id === 'debug-res-intensity')!;
      expect(p.source).toContain('iChannelResolution[0]');
      expect(p.source).toContain('iChannelIntensity[0]');
      expect(p.channelKinds?.[0]).toBe('image2d');
    });

    it('every dev preset documents its EXPECTED result in the source', async () => {
      const dev = await import('./glslPresets.dev');
      const all = [dev.E2E_KITCHEN_SINK, ...dev.DEV_DEBUG_PRESETS];
      for (const p of all) {
        expect(p.source.toUpperCase()).toContain('EXPECTED');
      }
    });

    it('uValue-sweep ships an audioRouting table so its slots resolve non-zero', async () => {
      const { DEV_DEBUG_PRESETS } = await import('./glslPresets.dev');
      const p = DEV_DEBUG_PRESETS.find((x) => x.id === 'debug-uvalue-sweep')!;
      expect(p.audioRouting).toBeDefined();
      expect(p.audioRouting!.slots.length).toBe(8);
      // Every slot is routed (none null) so all 8 bars react.
      for (const slot of p.audioRouting!.slots) {
        expect(slot).not.toBeNull();
        expect(slot!.shape.enabled).toBe(true);
      }
    });

    it('the routing table drives non-zero uValue slots for non-zero bands', async () => {
      const { DEV_DEBUG_PRESETS } = await import('./glslPresets.dev');
      const { ShaderSlotDriver } = await import('@/engine/audio/AudioRouter');
      const p = DEV_DEBUG_PRESETS.find((x) => x.id === 'debug-uvalue-sweep')!;
      const driver = new ShaderSlotDriver();
      driver.setTable(p.audioRouting!);
      const bands = { bass: 0.8, mid: 0.6, high: 0.4, energy: 0.7 };
      // Run several frames so the attack envelope rises off zero.
      let slots = new Float32Array(8);
      for (let i = 0; i < 30; i++) slots = driver.update(0.016, bands, null);
      // Band-routed slots (0-3) must have risen above 0.
      expect(slots[0]).toBeGreaterThan(0); // bass
      expect(slots[1]).toBeGreaterThan(0); // mid
      expect(slots[2]).toBeGreaterThan(0); // high
      expect(slots[3]).toBeGreaterThan(0); // energy
    });
  });
});
