/**
 * GLSLGuestManager — shared owner of the GLSL-guest pipeline for one renderer
 * (Stage 3a, vertical slice).
 *
 * Bundles the three moving parts a renderer needs so each renderer holds ONE
 * field and identical logic (preview + export cannot drift):
 *   - one {@link GLSLGuestRenderer} WebGL2 host (all guests share its context),
 *   - one owned {@link GPUTexture} per guest id (the copyExternalImageToTexture
 *     destination, resized with the renderer),
 *   - one {@link GuestCompositor} (parameterized blend-mode composite pass).
 *
 * Lifecycle per frame, per guest, in layer order:
 *   1. host.render(id, dt, slotValues)   — draw the guest into its WebGL canvas
 *   2. copyExternalImageToTexture(canvas → owned texture)
 *   3. compositor.composite(texture → targetView, params)
 *
 * Export uses {@link GLSLGuestManager.renderAt} for deterministic frame/time.
 */

import { GLSLGuestRenderer } from './GLSLGuestRenderer';
import { GuestCompositor } from './guestComposite';
import type { GLSLGuestSource, GuestBufferId, GuestChannelKind } from './types';
import { GUEST_BUFFER_IDS } from './types';
import { createARParam, type ARParamEnvelope, type AudioBands } from '@/engine/audio/arParam';
import { ShaderSlotDriver } from '@/engine/audio/AudioRouter';

interface GuestEntry {
  source: GLSLGuestSource;
  texture: GPUTexture | null;
}

export class GLSLGuestManager {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private width: number;
  private height: number;
  private host: GLSLGuestRenderer;
  private compositor: GuestCompositor;
  private guests = new Map<string, GuestEntry>();
  private _copyWarned = new Set<string>();
  private _hostInited = false;
  /** Per-guest opacity envelope (attack/decay smoothed AR). */
  private _opacityEnv = new Map<string, ARParamEnvelope>();
  /** Per-guest, per-channel intensity envelopes (key: `${id}:${channel}`). */
  private _channelEnv = new Map<string, ARParamEnvelope>();
  /**
   * Per-guest audio-router slot driver, resolving `audioRouting` → uValue1..8.
   * One per guest so each layer's routing + envelopes are independent.
   */
  private _slotDriver = new Map<string, ShaderSlotDriver>();
  /** Live analyser for slot resolution (null in export; byte spectrum used there). */
  private _analyser: AnalyserNode | null = null;
  /** Export byte spectrum + sample rate for slot resolution (null in live). */
  private _exportSpectrum: Uint8Array | null = null;
  private _exportSampleRate = 48000;

  constructor(device: GPUDevice, format: GPUTextureFormat, width: number, height: number) {
    this.device = device;
    this.format = format;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.host = new GLSLGuestRenderer(this.width, this.height);
    this.compositor = new GuestCompositor(device, format);
  }

  /** Lazily create the WebGL2 host on first real use (deferred so SSR is safe). */
  private ensureHost(): boolean {
    if (this._hostInited) return this.host.ready;
    this._hostInited = true;
    return this.host.init();
  }

  /**
   * Reconcile the set of active GLSL guests to `layers` (ordered). Creates/updates
   * programs, prunes removed ones, and (re)compiles changed sources. Idempotent.
   */
  sync(layers: GLSLGuestSource[]): void {
    if (layers.length === 0 && this.guests.size === 0) return;
    if (!this.ensureHost()) return;

    const live = new Set(layers.map((l) => l.id));
    // Prune removed guests.
    for (const id of [...this.guests.keys()]) {
      if (!live.has(id)) {
        this.host.removeGuest(id);
        const e = this.guests.get(id);
        e?.texture?.destroy();
        this.guests.delete(id);
        this._copyWarned.delete(id);
        this._opacityEnv.delete(id);
        this._channelEnv.delete(id);
        this._slotDriver.delete(id);
      }
    }
    // Create / update.
    for (const layer of layers) {
      const existing = this.guests.get(layer.id);
      const kinds = (layer.channels ?? []).map((c) => c.kind);
      const kindsChanged =
        !existing ||
        (existing.source.channels ?? []).map((c) => c.kind).join(',') !== kinds.join(',');
      // Build the buffer descriptor (source + channel kinds per enabled buffer).
      const bufferSpec: Partial<
        Record<GuestBufferId, { source: string; channelKinds: GuestChannelKind[] }>
      > = {};
      let buffersSig = '';
      for (const bid of GUEST_BUFFER_IDS) {
        const bp = layer.buffers?.[bid];
        if (!bp) continue;
        const bKinds = (bp.channels ?? []).map((c) => c.kind);
        bufferSpec[bid] = { source: bp.source, channelKinds: bKinds };
        buffersSig += `${bid}:${bp.source.length}:${bKinds.join(',')};`;
      }
      const prevBuffersSig = (existing as GuestEntry & { _buffersSig?: string })?._buffersSig ?? '';
      const buffersChanged = buffersSig !== prevBuffersSig;
      if (!existing || existing.source.source !== layer.source || kindsChanged || buffersChanged) {
        // Recompiles when the Image source, any channel KIND, or any buffer
        // source/kind changed (sampler types + pass set are baked into GLSL).
        this.host.setGuest(
          layer.id,
          layer.source,
          kinds.length ? kinds : undefined,
          Object.keys(bufferSpec).length ? bufferSpec : undefined,
        );
      }
      // Push Image-pass per-channel params (wrap/filter/intensity/bufferId).
      (layer.channels ?? []).forEach((c, i) => {
        this.host.setChannelParams(layer.id, i, {
          wrap: c.wrap,
          filter: c.filter,
          intensity: c.intensity,
          bufferId: c.kind === 'buffer' ? (c.bufferId ?? null) : null,
        });
        // Background-video channels bind the shared element here; uploaded-video
        // channels are wired by the caller (GPUCanvas/exporter) via setChannelVideo
        // with the IndexedDB blob URL, since they own the async asset load.
        if (c.kind === 'video' && c.videoSource === 'background') {
          this.host.setChannelVideo(layer.id, i, 'background', null);
        }
      });
      // Push each buffer pass's per-channel params (targets that pass).
      for (const bid of GUEST_BUFFER_IDS) {
        const bp = layer.buffers?.[bid];
        if (!bp) continue;
        (bp.channels ?? []).forEach((c, i) => {
          this.host.setChannelParams(
            layer.id,
            i,
            {
              wrap: c.wrap,
              filter: c.filter,
              intensity: c.intensity,
              bufferId: c.kind === 'buffer' ? (c.bufferId ?? null) : null,
            },
            bid,
          );
        });
      }
      const entry: GuestEntry & { _buffersSig?: string } = {
        source: layer,
        texture: existing?.texture ?? null,
      };
      // Per-guest slot driver: (re)set its routing table so uValue1..8 resolve
      // from this layer's audioRouting each frame. setTable is idempotent on
      // reference, so this is cheap when the table is unchanged.
      let driver = this._slotDriver.get(layer.id);
      if (!driver) {
        driver = new ShaderSlotDriver();
        this._slotDriver.set(layer.id, driver);
      }
      driver.setTable(layer.audioRouting ?? null);
      entry._buffersSig = buffersSig;
      this.guests.set(layer.id, entry);
    }
  }

  /** Expose the host so the caller can upload channel textures from IndexedDB. */
  getHost(): GLSLGuestRenderer {
    return this.host;
  }

  /** Forward the track background video element for videoSource:'background' channels. */
  setBackgroundVideo(video: HTMLVideoElement | null): void {
    this.host.setBackgroundVideo(video);
  }

  /** Whether any guest is registered (cheap gate for the render loop). */
  hasGuests(): boolean {
    return this.guests.size > 0 && this.host.ready;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.host.setSize(this.width, this.height);
    // Owned textures are lazily recreated at the new size on next composite.
  }

  /** Upload the current audio bytes into the host once per frame (before render). */
  uploadAudio(fft: Uint8Array | null, wave: Uint8Array | null): void {
    if (!this.host.ready) return;
    this.host.uploadAudio(fft, wave);
  }

  /**
   * Live path: set the analyser the per-guest slot drivers pull a byte spectrum
   * from for custom-band routing. Pass null in export (use setExportSpectrum).
   */
  setAnalyser(analyser: AnalyserNode | null): void {
    this._analyser = analyser;
  }

  /**
   * Export path: feed the per-frame byte-frequency spectrum + sample rate the
   * slot drivers resolve custom bands from (mirrors the shaderFx export path).
   */
  setExportSpectrum(byteFreq: Uint8Array | null, sampleRate: number): void {
    this._exportSpectrum = byteFreq;
    this._exportSampleRate = sampleRate || this._exportSampleRate;
  }

  /** Reset all guest slot-driver envelopes on seek (mirrors ShaderSlotDriver.reset). */
  resetSlotDrivers(): void {
    for (const d of this._slotDriver.values()) d.reset();
  }

  /** Resolve this guest's uValue1..8 for the frame (live analyser or export bytes). */
  private resolveSlots(id: string, dt: number, bands: AudioBands | null): Float32Array | null {
    const driver = this._slotDriver.get(id);
    if (!driver) return null;
    const b: AudioBands = bands ?? { bass: 0, mid: 0, high: 0, energy: 0 };
    return this._analyser
      ? driver.update(dt, b, this._analyser)
      : driver.updateFromBytes(dt, b, this._exportSpectrum, this._exportSampleRate);
  }

  private ensureTexture(entry: GuestEntry): GPUTexture {
    if (
      entry.texture &&
      entry.texture.width === this.width &&
      entry.texture.height === this.height
    ) {
      return entry.texture;
    }
    entry.texture?.destroy();
    entry.texture = this.device.createTexture({
      label: `glsl-guest-frame:${entry.source.id}`,
      size: [this.width, this.height],
      format: this.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // Initialize the fresh texture to OPAQUE black. A newly created GPUTexture
    // has undefined contents; it is only ever populated by
    // copyExternalImageToTexture in copyToTexture(). On the very first frame
    // (before the host canvas has been copied) or on any frame where the copy
    // is skipped (size desync / thrown copy), the compositor would otherwise
    // read this uninitialized memory and blend GPU garbage over the background —
    // the "swirly artifacts" the guest appears to inject during playback. A
    // one-shot clear pass guarantees the worst case is a black frame, not noise.
    {
      const initEncoder = this.device.createCommandEncoder({
        label: `glsl-guest-init:${entry.source.id}`,
      });
      const pass = initEncoder.beginRenderPass({
        label: `glsl-guest-init-pass:${entry.source.id}`,
        colorAttachments: [
          {
            view: entry.texture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear' as const,
            storeOp: 'store' as const,
          },
        ],
      });
      pass.end();
      this.device.queue.submit([initEncoder.finish()]);
    }
    return entry.texture;
  }

  /** Copy the host canvas into the guest's owned texture, guarding size desync. */
  private copyToTexture(id: string, entry: GuestEntry): boolean {
    const canvas = this.host.getCanvas();
    if (!canvas) return false;
    const tex = this.ensureTexture(entry);
    const copyW = Math.min(this.width, canvas.width, tex.width);
    const copyH = Math.min(this.height, canvas.height, tex.height);
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: canvas as unknown as GPUImageCopyExternalImageSource },
        { texture: tex, origin: [0, 0, 0] },
        [copyW, copyH],
      );
      this._copyWarned.delete(id);
      return true;
    } catch (e) {
      if (!this._copyWarned.has(id)) {
        this._copyWarned.add(id);
        console.warn(
          `[GLSLGuestManager] guest ${id} frame copy failed (canvas ` +
            `${canvas.width}x${canvas.height}, dst ${tex.width}x${tex.height}). Skipping.`,
          e,
        );
      }
      return false;
    }
  }

  /**
   * Apply the audio-reactive envelope for one guest: compute the effective
   * opacity (from `opacityReactive`) and push per-channel effective intensity
   * (from each channel's `intensityReactive`) into the host. Returns the
   * composite params with the reactive opacity folded in. `bands` null / dt<=0
   * (e.g. paused) leaves everything at its base value. Shared by live + export
   * so the two paths use the identical envelope (§7 anti-drift).
   */
  private applyReactive(
    entry: GuestEntry,
    bands: AudioBands | null,
    dt: number,
  ): GLSLGuestSource['composite'] {
    const src = entry.source;
    const composite = { ...src.composite };
    const safeBands: AudioBands = bands ?? { bass: 0, mid: 0, high: 0, energy: 0 };
    // Opacity envelope.
    if (src.opacityReactive?.enabled) {
      let env = this._opacityEnv.get(src.id);
      if (!env) {
        env = createARParam();
        this._opacityEnv.set(src.id, env);
      }
      composite.opacity = env.compute(src.composite.opacity, src.opacityReactive, dt, safeBands);
    }
    // Per-channel intensity envelopes.
    (src.channels ?? []).forEach((c, i) => {
      if (!c.intensityReactive?.enabled) return;
      const key = `${src.id}:${i}`;
      let env = this._channelEnv.get(key);
      if (!env) {
        env = createARParam();
        this._channelEnv.set(key, env);
      }
      const v = env.compute(c.intensity, c.intensityReactive, dt, safeBands);
      this.host.setChannelParams(src.id, i, { intensity: v });
    });
    return composite;
  }

  /**
   * Live path: render one guest with wall-clock time, copy, and composite over
   * the target view. `slotValues` are the Stage-1 uValue1..8. `bands` drives the
   * audio-reactive opacity + channel-intensity envelopes.
   */
  renderAndComposite(
    id: string,
    targetView: GPUTextureView,
    encoder: GPUCommandEncoder,
    dt: number,
    slotValues: Float32Array | null,
    bands: AudioBands | null = null,
  ): void {
    const entry = this.guests.get(id);
    if (!entry || !this.host.ready) return;
    const composite = this.applyReactive(entry, bands, dt);
    // Resolve uValue1..8 from this guest's routing table (falls back to the
    // explicitly-passed slotValues, then null → zeros).
    const slots = this.resolveSlots(id, dt, bands) ?? slotValues;
    this.host.render(id, dt, slots);
    if (!this.copyToTexture(id, entry)) return;
    this.compositor.composite(entry.texture!, targetView, encoder, composite);
  }

  /**
   * Export path: render one guest at an explicit frame/time (deterministic),
   * copy, and composite. Audio must have been uploaded via uploadAudio first.
   */
  renderAtAndComposite(
    id: string,
    frame: number,
    timeSec: number,
    dt: number,
    slotValues: Float32Array | null,
    targetView: GPUTextureView,
    encoder: GPUCommandEncoder,
    bands: AudioBands | null = null,
  ): void {
    const entry = this.guests.get(id);
    if (!entry || !this.host.ready) return;
    const composite = this.applyReactive(entry, bands, dt);
    const slots = this.resolveSlots(id, dt, bands) ?? slotValues;
    this.host.renderAt(id, frame, timeSec, dt, slots);
    if (!this.copyToTexture(id, entry)) return;
    this.compositor.composite(entry.texture!, targetView, encoder, composite);
  }

  /** Ordered guest ids as last synced. */
  guestIds(): string[] {
    return [...this.guests.keys()];
  }

  destroy(): void {
    for (const e of this.guests.values()) e.texture?.destroy();
    this.guests.clear();
    this._copyWarned.clear();
    this._opacityEnv.clear();
    this._channelEnv.clear();
    this.host.destroy();
    this.compositor.destroy();
  }
}
