'use client';

/**
 * CustomShaderEditor — inspector body for a `customShader` post-processing
 * instance (LLD §5, "transform half"). A dedicated editor (not schema-driven)
 * because the WGSL source is multiline code that needs LIVE compile
 * diagnostics, which the generic field editor can't render.
 *
 * It edits the instance's `CustomShaderConfig`:
 *   - `source`  — the WGSL fragment shader. Must declare
 *       `fn fs_main(input: VertexOutput) -> @location(0) vec4f` and sample the
 *       layer beneath via `inputTexture` / `inputSampler` (bindings 0/1) with
 *       its uniform buffer at binding 2. The RenderGraph prepends the shared
 *       fullscreen vertex shader (providing `VertexOutput`) automatically.
 *   - `params`  — user scalar uniforms, rendered as sliders.
 *
 * Validation runs the SAME ShaderInjector.validate() the render pass uses, so a
 * "compiled" badge here means the pass will compile. The source is persisted to
 * config only when it compiles clean, so a live pass is never fed a broken
 * shader by a mid-edit keystroke. When no GPU device is available (jsdom / a
 * software renderer) validation is skipped and the source is persisted
 * optimistically — the render pass is the ultimate guard.
 *
 * ─── PRESET LICENSING RULE (mandatory) ──────────────────────────────────────
 * This editor makes pasting external WGSL/GLSL (e.g. Shadertoy) trivial. Any
 * preset added to the curated dropdown (`wgslPresets.ts` / `glslPresets.ts`)
 * MUST record its provenance in the preset's own file header:
 *
 *   - the ORIGINAL source (URL or author), and
 *   - its LICENSE (and whether that license permits redistribution here).
 *
 * If a snippet's license is unknown or non-redistributable, DO NOT ship it as a
 * built-in preset — replace it with an original implementation, or leave it as
 * user-pasted content only. Third-party code that ships in the app must also be
 * listed in `LEGAL/THIRD_PARTY_NOTICES.md`. User-pasted source typed into this
 * editor at runtime is the user's own content and is
 * NOT curated or attributed by us.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShaderInjector, type ShaderCompilationMessage } from '@/engine/gpu/ShaderInjector';
import {
  WGSL_PRESETS,
  WGSL_CUSTOM_ID,
  getWgslPreset,
  matchWgslPresetId,
} from '@/engine/gpu/wgslPresets';
import type { CustomShaderConfig, CustomShaderParam } from '@/types/effects/effect-instances';
import { AudioReactiveEditor } from '@/components/effects/shared/AudioReactiveEditor';
import { DEFAULT_AUDIO_REACTIVE } from '@/types/effects';

interface Props {
  config: CustomShaderConfig;
  onChange: (config: CustomShaderConfig) => void;
  /** Owning renderer's GPU device — null on software renderers / SSR. */
  device: GPUDevice | null;
}

interface CompileState {
  ok: boolean;
  /** Diagnostics with line numbers. Empty when clean or not yet checked. */
  messages: ShaderCompilationMessage[];
  /** True until the first validation completes (no badge shown yet). */
  pending: boolean;
}

export function CustomShaderEditor({ config, onChange, device }: Props) {
  const [sourceDraft, setSourceDraft] = useState(config.source);
  const [compile, setCompile] = useState<CompileState>({
    ok: true,
    messages: [],
    pending: true,
  });

  // A single throwaway ShaderInjector reused for validation only (never injects
  // a pass — that's the render manager's job). Built once per device.
  const injectorRef = useRef<ShaderInjector | null>(null);
  useEffect(() => {
    // Validate-only: no render graph needed (see ShaderInjector.graph()).
    injectorRef.current = device ? new ShaderInjector(device, null) : null;
  }, [device]);

  // Keep the draft in sync when the config changes from outside (keyframe nav,
  // undo, a fresh instance).
  useEffect(() => {
    setSourceDraft(config.source);
  }, [config.source]);

  // Debounced validate + persist-on-clean.
  useEffect(() => {
    const handle = setTimeout(() => {
      void (async () => {
        const injector = injectorRef.current;
        if (!injector) {
          // No device — persist optimistically; the render pass validates.
          setCompile({ ok: true, messages: [], pending: false });
          if (sourceDraft !== config.source) onChange({ ...config, source: sourceDraft });
          return;
        }
        const result = await injector.validate(sourceDraft);
        setCompile({
          ok: result.valid,
          messages: [...result.errors, ...result.warnings],
          pending: false,
        });
        if (result.valid && sourceDraft !== config.source) {
          onChange({ ...config, source: sourceDraft });
        }
      })();
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDraft]);

  const setParam = useCallback(
    (name: string, value: number) => {
      const params = config.params.map((p) => (p.name === name ? { ...p, value } : p));
      onChange({ ...config, params });
    },
    [config, onChange],
  );

  /** Patch a single param entry (min/max/audioReactive) by name. */
  const patchParam = useCallback(
    (name: string, patch: Partial<CustomShaderParam>) => {
      const params = config.params.map((p) => (p.name === name ? { ...p, ...patch } : p));
      onChange({ ...config, params });
    },
    [config, onChange],
  );

  /**
   * Apply a curated WGSL preset: replace the source and seed params from the
   * preset's non-builtin ShaderParameter[] (dropping time/resolution/pad slots,
   * which the engine injects automatically), and record the FULL struct field
   * order as `uniformLayout` so the engine packs the uniform buffer at the right
   * offsets. The `custom` sentinel keeps the current source untouched.
   */
  const applyPreset = useCallback(
    (presetId: string) => {
      if (presetId === WGSL_CUSTOM_ID) return; // keep current source
      const preset = getWgslPreset(presetId);
      if (!preset) return;
      const params = preset.parameters
        .filter((p) => !p.builtIn && typeof p.defaultValue === 'number')
        .map((p) => ({
          name: p.name,
          value: p.defaultValue as number,
          min: p.min ?? 0,
          max: p.max ?? 1,
        }));
      const uniformLayout = preset.parameters.map((p) => ({ name: p.name, builtIn: p.builtIn }));
      setSourceDraft(preset.source);
      onChange({ ...config, source: preset.source, params, uniformLayout });
    },
    [config, onChange],
  );

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
          WGSL · fs_main(input) → vec4f
        </span>
        {compile.pending ? (
          <span className="text-[10px] text-[var(--text-muted)]">…</span>
        ) : compile.ok ? (
          <span className="text-[10px]" style={{ color: '#7ee787' }}>
            ✓ compiled
          </span>
        ) : (
          <span className="text-[10px]" style={{ color: '#ff8b8f' }}>
            ✗ error
          </span>
        )}
      </div>

      {/* Preset picker — seed the source + params from a curated WGSL
          transform, or keep the current source ("Custom…"). Reflects which
          preset the current source matches. */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold whitespace-nowrap">
          Preset
        </span>
        <select
          className="flex-1 text-[11px] rounded-md bg-[var(--bg-panel)] border border-[var(--border-subtle)] px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-hover)]"
          value={matchWgslPresetId(config.source)}
          onChange={(e) => applyPreset(e.target.value)}
          aria-label="Custom shader preset"
        >
          {WGSL_PRESETS.map((p) => (
            <option key={p.id} value={p.id} title={p.description}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <textarea
        className="w-full h-64 font-mono text-[11px] leading-snug rounded-md bg-[var(--bg-panel)] border border-[var(--border-subtle)] p-2 text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-hover)]"
        style={compile.ok ? undefined : { borderColor: '#ff8b8f' }}
        spellCheck={false}
        value={sourceDraft}
        onChange={(e) => setSourceDraft(e.target.value)}
        aria-label="Custom shader WGSL source"
      />

      <p className="text-[9px] leading-snug text-[var(--text-muted)]">
        Only paste shader code you have the right to use. Pasted source is your own content and
        remains your responsibility.
      </p>

      {!compile.ok && compile.messages.length > 0 && (
        <div
          className="rounded-md bg-[var(--bg-panel)] border border-[#ff8b8f]/40 p-2 text-[10px] font-mono space-y-1"
          style={{ color: '#ff8b8f' }}
        >
          {compile.messages.map((m, i) => (
            <div key={i}>
              {m.line > 0 ? `L${m.line}: ` : ''}
              {m.message}
            </div>
          ))}
        </div>
      )}

      {config.params.length > 0 && (
        <div className="space-y-2 pt-1">
          <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
            Parameters
          </span>
          {config.params.map((p) => {
            const pMin = p.min ?? 0;
            const pMax = p.max ?? 2;
            const arOn = !!p.audioReactive?.enabled;
            return (
              <div key={p.name} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className="text-[11px] text-[var(--text-muted)] flex-1 truncate"
                    title={p.name}
                  >
                    {p.name}
                  </span>
                  {/* Audio-reactive toggle for this param. When on, the value is
                      driven by the selected band's envelope; the base slider
                      becomes the envelope floor. */}
                  <button
                    type="button"
                    onClick={() =>
                      patchParam(p.name, {
                        audioReactive: arOn
                          ? { ...(p.audioReactive ?? DEFAULT_AUDIO_REACTIVE), enabled: false }
                          : {
                              ...DEFAULT_AUDIO_REACTIVE,
                              ...(p.audioReactive ?? {}),
                              enabled: true,
                              min: pMin,
                              max: pMax,
                            },
                      })
                    }
                    aria-pressed={arOn}
                    title={arOn ? 'Audio-reactive: on' : 'Audio-reactive: off'}
                    className={`text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider transition-colors ${
                      arOn
                        ? 'bg-red-500/20 text-red-300'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    AR
                  </button>
                  <input
                    type="range"
                    min={pMin}
                    max={pMax}
                    step={(pMax - pMin) / 100 || 0.01}
                    value={p.value}
                    disabled={arOn}
                    onChange={(e) => setParam(p.name, Number(e.target.value))}
                    aria-label={`${p.name} value`}
                    className="flex-[2]"
                    style={arOn ? { opacity: 0.4 } : undefined}
                  />
                  <span
                    className="text-[11px] text-[var(--text-primary)]"
                    style={{ minWidth: 32, textAlign: 'right' }}
                  >
                    {p.value.toFixed(2)}
                  </span>
                </div>
                {arOn && (
                  <AudioReactiveEditor
                    label={`${p.name} — audio`}
                    config={p.audioReactive}
                    min={pMin}
                    max={pMax}
                    step={(pMax - pMin) / 100 || 0.01}
                    hideToggle
                    onChange={(ar) => patchParam(p.name, { audioReactive: ar })}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[9px] text-[var(--text-muted)] opacity-70 leading-relaxed">
        Samples the layer beneath via <code>inputTexture</code> / <code>inputSampler</code>.
        Uniforms are packed from Parameters (then a built-in <code>time</code>) into binding 2. Turn
        on <strong>AR</strong> to drive a parameter from an audio band. Source is saved only when it
        compiles cleanly.
      </p>
    </div>
  );
}
