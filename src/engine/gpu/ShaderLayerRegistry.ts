/**
 * ShaderLayerRegistry (Stage 2 — Shader layers)
 *
 * Owns one {@link ShaderOverlayPass} + one {@link ShaderSlotDriver} per shaderFx
 * instance id, for BOTH the preview ({@link WebGPURenderer}) and export
 * ({@link OffscreenGPURenderer}) renderers. This is deliberately a single shared
 * module rather than parallel per-renderer state: the duplication between the two
 * renderers was the root cause of the preview/export drift the LLD §7 calls out.
 *
 * Before Stage 2 each renderer held a SINGLE `_shaderOverlayPass` + config +
 * preset + palette, and the app collapsed N enabled shaderFx instances to the
 * first one (GPUCanvas / DecoupledExporter both did `find(...)`). The registry
 * lifts that ceiling: the renderer now composites every enabled shader-mode
 * layer, each at its own stack position, driven by its own config + audio table.
 *
 * Lifecycle contract:
 *   - `sync(id, config)` — idempotent create/reuse; (re)loads the preset when its
 *     id changes, (re)sets palette when it changes, keeps the slot-driver table
 *     in sync. Cheap on an unchanged config.
 *   - `prune(liveIds)` — tears down passes whose instance is no longer live.
 *   - `render(id, ...)` — resolves the audio-router slots and composites that
 *     layer's pass onto the target view. No-op until the pass has a preset.
 *   - `hasRenderable()` — whether any synced layer is ready to draw (used to
 *     decide intermediate-target routing).
 *   - `ensureAllReady()` — awaits every layer's pipeline compile (export).
 *   - `destroy()` — releases every pass.
 */

import { ShaderOverlayPass, type ShaderOverlayConfig } from './ShaderOverlayPass';
import { ShaderSlotDriver } from '../audio/AudioRouter';
import { getPresetById, getPaletteById } from './shaderPresets/index';
import type { ShaderPalette } from '@/types/effects/shader-overlay';
import type { AudioBands } from '../audio/arParam';

/** One shaderFx layer keyed by its effect-instance id. */
export interface ShaderLayerInput {
  id: string;
  config: ShaderOverlayConfig;
}

interface LayerEntry {
  pass: ShaderOverlayPass;
  driver: ShaderSlotDriver;
  config: ShaderOverlayConfig;
  presetId: string | null;
  paletteId: string | null;
}

export class ShaderLayerRegistry {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private entries = new Map<string, LayerEntry>();
  // Export-only: a pre-computed byte-frequency spectrum (0-255/bin) set per
  // frame by the offline exporter (no live AnalyserNode). When present and no
  // analyser is passed to render(), custom-band sources resolve from it.
  private exportSpectrum: Uint8Array | null = null;
  private exportSampleRate = 44100;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  /**
   * Provide a pre-computed byte spectrum for the current export frame. Pass null
   * to clear. Ignored when render() receives a live analyser (preview path).
   */
  setExportSpectrum(byteFreq: Uint8Array | null, sampleRate: number): void {
    this.exportSpectrum = byteFreq;
    if (Number.isFinite(sampleRate) && sampleRate > 0) this.exportSampleRate = sampleRate;
  }

  /**
   * Idempotent create/reuse for one layer. Loads the preset when `presetId`
   * changes, updates palette on change, and keeps the slot-driver table synced.
   * `loadPreset` is async (fire-and-forget); the layer renders nothing until it
   * resolves. Returns the entry so callers can chain if needed.
   */
  sync(id: string, config: ShaderOverlayConfig): void {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        pass: new ShaderOverlayPass(this.device, this.format),
        driver: new ShaderSlotDriver(),
        config,
        presetId: null,
        paletteId: null,
      };
      this.entries.set(id, entry);
    }

    entry.config = config;
    entry.driver.setTable(config.audioRouting ?? null);

    if (config.presetId !== entry.presetId) {
      const preset = getPresetById(config.presetId);
      if (preset) {
        entry.presetId = config.presetId;
        void entry.pass.loadPreset(preset);
      }
    }

    if (entry.paletteId !== config.paletteId) {
      const pal = getPaletteById(config.paletteId);
      if (pal) {
        entry.paletteId = config.paletteId;
        entry.pass.setPalette(pal as ShaderPalette);
      }
    }
  }

  /** Tear down and forget any layer whose id is not in `liveIds`. */
  prune(liveIds: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (!liveIds.has(id)) {
        entry.pass.destroy();
        this.entries.delete(id);
      }
    }
  }

  /** Whether the given layer exists and has a compiled preset ready to draw. */
  isRenderable(id: string): boolean {
    const entry = this.entries.get(id);
    return !!(entry && entry.config.enabled && entry.pass.currentPreset);
  }

  /** Whether ANY synced layer is ready to draw (drives intermediate routing). */
  hasRenderable(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.config.enabled && entry.pass.currentPreset) return true;
    }
    return false;
  }

  /**
   * Resolve one layer's audio-router slots and composite its pass onto `view`.
   * No-op if the layer is absent, disabled, or its preset hasn't compiled yet.
   */
  render(
    id: string,
    view: GPUTextureView,
    encoder: GPUCommandEncoder,
    dt: number,
    bands: AudioBands,
    resolution: [number, number],
    analyser: AnalyserNode | null | undefined,
  ): void {
    const entry = this.entries.get(id);
    if (!entry || !entry.config.enabled || !entry.pass.currentPreset) return;
    // Preview passes a live analyser; export passes null but may have set a
    // per-frame byte spectrum (so custom bands work offline too).
    const slotValues = analyser
      ? entry.driver.update(dt, bands, analyser)
      : entry.driver.updateFromBytes(dt, bands, this.exportSpectrum, this.exportSampleRate);
    entry.pass.render(view, encoder, entry.config, dt, bands, resolution, slotValues);
  }

  /** Await every layer's pipeline compile (export path). Resolves true if all ready. */
  async ensureAllReady(): Promise<boolean> {
    let allReady = true;
    for (const entry of this.entries.values()) {
      if (!entry.config.enabled) continue;
      const preset = getPresetById(entry.config.presetId);
      if (!preset) {
        allReady = false;
        continue;
      }
      const ok = await entry.pass.loadPreset(preset);
      if (!ok) allReady = false;
    }
    return allReady;
  }

  /** Reset every layer's audio driver (on seek). */
  resetDrivers(): void {
    for (const entry of this.entries.values()) entry.driver.reset();
  }

  /** Live layer ids currently held. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Release every pass and clear the registry. */
  destroy(): void {
    for (const entry of this.entries.values()) entry.pass.destroy();
    this.entries.clear();
  }
}
