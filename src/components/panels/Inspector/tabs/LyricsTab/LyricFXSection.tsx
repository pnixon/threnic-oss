import React, { useCallback, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { CollapsibleSection } from '../../CollapsibleSection';
import {
  LYRIC_FX_LABELS,
  LYRIC_FX_STAGE,
  LYRIC_FX_FIELDS,
  LYRIC_FX_PHASES,
  LYRIC_FX_PHASE_LABELS,
  LYRIC_FX_GRANULARITIES,
  createLyricFXInstance,
  phasesOf,
  type LyricFXType,
  type LyricFXField,
  type LyricFXPhase,
  type LyricFXGranularity,
  type LyricEffectInstance,
} from '@/types/effects/lyric-fx';
import { LYRIC_FX_TRANSFORM_TYPES } from '@/engine/gpu/lyricfx/transform.wgsl';
import { EffectRow } from '../EffectsTab/EffectRow';
import { SliderField } from '@/components/effects/shared/SliderField';
import { ColorField } from '@/components/effects/shared/ColorField';
import styles from '../../Inspector.module.css';

/**
 * LyricFXSection — the dedicated "Lyric FX" inspector panel (Lyric FX Engine,
 * docs/lyric-fx-engine-lld.md).
 *
 * The panel mirrors the main Effects tab: a flat stack of toggleable /
 * expandable effect rows (EffectRow), plus an "Add Effects" discovery group of
 * disabled rows for every available type. Each effect is bound to a lifecycle
 * PHASE — fade-in / fade-out (entry / exit transitions), or active / upcoming /
 * past (the karaoke word states) — chosen inline in the expanded row.
 *
 * The GPU per-glyph renderer is the default whenever WebGPU is active (derived
 * from renderer availability in LyricsCanvas), so there is no per-track renderer
 * toggle. State lives on the LyricTheme: `lyricFX: LyricEffectInstance[]`. This
 * section is a thin editor over that field; the renderer wiring (updateLyricFX)
 * consumes it elsewhere.
 */
/**
 * The curated Lyric FX effects exposed in the panel, each with its intended
 * default phase. Only these render reliably today; the rest of the effect union
 * is hidden (still in the data model, so saved projects keep working). Add a
 * type here once it is verified working.
 *   Vortex   → Fade-in  (spiral the word in)
 *   Card Flip → Active   (flip while the word is held)
 *   Shatter  → Fade-out (fling the word apart as it leaves)
 */
const CURATED_LYRIC_FX: { type: LyricFXType; phase: LyricFXPhase }[] = [
  { type: 'vortex', phase: 'fadeIn' },
  { type: 'cardFlip', phase: 'active' },
  { type: 'shatter', phase: 'fadeOut' },
];

const CURATED_TYPES = CURATED_LYRIC_FX.map((c) => c.type);
const DEFAULT_PHASE_FOR_CURATED = new Map<LyricFXType, LyricFXPhase>(
  CURATED_LYRIC_FX.map((c) => [c.type, c.phase]),
);

interface LyricFXSectionProps {
  /** Current effect stack (all phases, flat). */
  effects: LyricEffectInstance[];
  onEffectsChange: (effects: LyricEffectInstance[]) => void;
  /** Global fade-in / fade-out window durations (seconds). */
  fadeIn?: number;
  fadeOut?: number;
  onFadeChange?: (which: 'fadeIn' | 'fadeOut', seconds: number) => void;
  /** Fade granularity: letter / word / line. */
  fadeGranularity?: LyricFXGranularity;
  onFadeGranularityChange?: (g: LyricFXGranularity) => void;
  /** Single-open accordion controls (optional). */
  open?: boolean;
  onToggle?: () => void;
  forceOpen?: boolean;
}

/** The lifecycle phases an instance is filed under (multi-select, back-compat). */
function phaseListOf(e: LyricEffectInstance): LyricFXPhase[] {
  return phasesOf(e.config, e.type as LyricFXType);
}

/** Short summary of an instance's bound phases for the row title. */
function phaseSummary(e: LyricEffectInstance): string {
  return phaseListOf(e)
    .map((ph) => LYRIC_FX_PHASE_LABELS[ph])
    .join(', ');
}

/** Transform effects (Stage A) — the ones that support reverse-on-fade-out. */
const TRANSFORM_TYPE_SET = new Set<string>(LYRIC_FX_TRANSFORM_TYPES as readonly string[]);

/** [r,g,b(,a)] in 0..1 → '#rrggbb'. */
function rgbToHex(arr: number[]): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(arr[0])}${to(arr[1])}${to(arr[2])}`;
}

/** '#rrggbb' → [r,g,b] in 0..1. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

export function LyricFXSection({
  effects,
  onEffectsChange,
  fadeIn = 1.0,
  fadeOut = 1.0,
  onFadeChange,
  fadeGranularity = 'word',
  onFadeGranularityChange,
  open,
  onToggle,
  forceOpen,
}: LyricFXSectionProps) {
  // Single-open accordion across the effect rows: at most one is expanded.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const removeEffect = useCallback(
    (id: string) => {
      onEffectsChange(effects.filter((e) => e.id !== id));
    },
    [effects, onEffectsChange],
  );

  const setEnabled = useCallback(
    (id: string, enabled: boolean) => {
      onEffectsChange(
        effects.map((e) => (e.id === id ? { ...e, config: { ...e.config, enabled } } : e)),
      );
    },
    [effects, onEffectsChange],
  );

  const setConfigValue = useCallback(
    (id: string, key: string, value: unknown) => {
      onEffectsChange(
        effects.map((e) => (e.id === id ? { ...e, config: { ...e.config, [key]: value } } : e)),
      );
    },
    [effects, onEffectsChange],
  );

  // Toggle a single phase in an effect's multi-select phase list (keeps >= 1).
  const togglePhase = useCallback(
    (id: string, phase: LyricFXPhase) => {
      onEffectsChange(
        effects.map((e) => {
          if (e.id !== id) return e;
          const current = phasesOf(e.config, e.type as LyricFXType);
          const has = current.includes(phase);
          let next = has ? current.filter((p) => p !== phase) : [...current, phase];
          if (next.length === 0) next = [phase]; // never allow an empty phase set
          return {
            ...e,
            config: { ...e.config, lifecyclePhases: next, lifecyclePhase: next[0] },
          };
        }),
      );
    },
    [effects, onEffectsChange],
  );

  // One row per effect TYPE — no separate added/discovery split. A type either
  // has a real instance (editable, enable governs render) or shows a synthetic
  // disabled placeholder that becomes a real instance when toggled on.
  const instanceByType = useMemo(() => {
    const m = new Map<LyricFXType, LyricEffectInstance>();
    for (const e of effects) if (!m.has(e.type as LyricFXType)) m.set(e.type as LyricFXType, e);
    return m;
  }, [effects]);

  const rows = useMemo(
    () => [...CURATED_TYPES].sort((a, b) => LYRIC_FX_LABELS[a].localeCompare(LYRIC_FX_LABELS[b])),
    [],
  );

  // Toggle a TYPE on/off. Enabling a type with no instance materializes one at
  // its curated default phase (and expands it); enabling/disabling an existing
  // instance flips enabled.
  const toggleType = useCallback(
    (type: LyricFXType, enabled: boolean) => {
      const existing = instanceByType.get(type);
      if (existing) {
        setEnabled(existing.id, enabled);
        if (enabled) setExpandedId(existing.id);
        return;
      }
      if (enabled) {
        const phase = DEFAULT_PHASE_FOR_CURATED.get(type);
        const inst = createLyricFXInstance(type, phase);
        onEffectsChange([...effects, inst]);
        setExpandedId(inst.id);
      }
    },
    [instanceByType, effects, onEffectsChange, setEnabled],
  );

  // Per-phase overload: phases carrying >1 ENABLED effect. Stacking multiple
  // effects on one phase composites them into the same target and produces
  // unexpected results (see docs/lyric-fx-engine-lld.md — surface effects can't
  // ping-pong-stack; only one transform folds into the base pass).
  const overloadedPhases = useMemo(() => {
    const counts = new Map<LyricFXPhase, number>();
    for (const e of effects) {
      if (!e.config.enabled) continue;
      for (const ph of phasesOf(e.config, e.type as LyricFXType)) {
        counts.set(ph, (counts.get(ph) ?? 0) + 1);
      }
    }
    return LYRIC_FX_PHASES.filter((ph) => (counts.get(ph) ?? 0) > 1);
  }, [effects]);

  const renderEditor = (e: LyricEffectInstance) => {
    const bound = phaseListOf(e);
    const isTransform = TRANSFORM_TYPE_SET.has(e.type);
    const boundHasFadeOut = bound.includes('fadeOut');
    return (
      <div className={styles.effectParams}>
        {/* Lifecycle phases: multi-select. The effect fires in ANY selected phase. */}
        <div className={styles.paramRow}>
          <label className={styles.paramLabel}>Phases</label>
        </div>
        <div className={styles.chipRow}>
          {LYRIC_FX_PHASES.map((ph) => {
            const active = bound.includes(ph);
            return (
              <button
                key={ph}
                type="button"
                className={styles.addChip}
                aria-pressed={active}
                onClick={() => togglePhase(e.id, ph)}
                style={{
                  border: active
                    ? '1px solid var(--accent-main, #ef4444)'
                    : '1px solid var(--border-subtle)',
                  background: active ? 'var(--accent-muted, rgba(239,68,68,0.15))' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {LYRIC_FX_PHASE_LABELS[ph]}
              </button>
            );
          })}
        </div>

        {/* Reverse-on-fade-out — only meaningful for entry-motion transforms
            that are also bound to the fade-out phase. */}
        {isTransform && (
          <div className={styles.paramRow}>
            <label className={styles.paramLabel} style={{ opacity: boundHasFadeOut ? 1 : 0.5 }}>
              Reverse on fade-out
            </label>
            <input
              type="checkbox"
              checked={!!e.config.reverseOnFadeOut}
              disabled={!boundHasFadeOut}
              onChange={(ev) => setConfigValue(e.id, 'reverseOnFadeOut', ev.target.checked)}
              aria-label="Reverse the entry motion on fade-out"
            />
          </div>
        )}

        {LYRIC_FX_FIELDS[e.type as LyricFXType].map((field) => (
          <FieldEditor
            key={field.key}
            field={field}
            config={e.config}
            onChange={(v) => setConfigValue(e.id, field.key, v)}
          />
        ))}

        <button
          type="button"
          className={`${styles.lineStyleActionBtn} ${styles.lineStyleActionBtnDanger}`}
          style={{ marginTop: 8 }}
          onClick={() => removeEffect(e.id)}
        >
          Remove effect
        </button>
      </div>
    );
  };

  return (
    <CollapsibleSection
      title="Lyric FX"
      icon={<Sparkles size={14} />}
      open={open}
      onToggle={onToggle}
      forceOpen={forceOpen}
    >
      {/* Timing: global fade-in/out window + granularity (letter/word/line). */}
      <div className={styles.subSectionLabel}>Timing</div>
      <SliderField
        label="Fade-in (s)"
        value={fadeIn}
        onChange={(v) => onFadeChange?.('fadeIn', v)}
        min={0}
        max={5}
        step={0.1}
      />
      <SliderField
        label="Fade-out (s)"
        value={fadeOut}
        onChange={(v) => onFadeChange?.('fadeOut', v)}
        min={0}
        max={5}
        step={0.1}
      />
      <div className={styles.paramRow}>
        <label className={styles.paramLabel}>Granularity</label>
        <select
          className={styles.paramSelect}
          value={fadeGranularity}
          onChange={(ev) => onFadeGranularityChange?.(ev.target.value as LyricFXGranularity)}
        >
          {LYRIC_FX_GRANULARITIES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>

      {/* Effects — one row per type; the enable toggle governs what renders. */}
      <div className={styles.subSectionLabel}>Effects</div>
      {overloadedPhases.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
            fontSize: 10,
            lineHeight: 1.4,
            color: 'var(--text-muted)',
            background: 'var(--accent-subtle, rgba(255,180,0,0.08))',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            padding: '6px 8px',
            marginBottom: 8,
          }}
        >
          <span style={{ flexShrink: 0, opacity: 0.8 }}>⚠️</span>
          <span>
            Multiple effects are enabled on the same phase (
            {overloadedPhases.map((ph) => LYRIC_FX_PHASE_LABELS[ph]).join(', ')}). Stacking more
            than one effect on a single phase composites them together and can produce unexpected
            results — keep one effect per phase for predictable output.
          </span>
        </div>
      )}
      <div className="space-y-1.5">
        {rows.map((t) => {
          const inst = instanceByType.get(t);
          const enabled = !!inst?.config.enabled;
          const title = inst
            ? `${LYRIC_FX_LABELS[t]} · ${phaseSummary(inst)}`
            : `${LYRIC_FX_LABELS[t]} · ${LYRIC_FX_STAGE[t]}`;
          return (
            <EffectRow
              key={t}
              name={title}
              isEnabled={enabled}
              selectedChannel="none"
              onToggle={(v) => toggleType(t, v)}
              onSettingsClick={() => (inst ? toggleExpand(inst.id) : toggleType(t, true))}
              expanded={!!inst && expandedId === inst.id}
            >
              {inst && renderEditor(inst)}
            </EffectRow>
          );
        })}
      </div>
    </CollapsibleSection>
  );

  // ─── Per-field editor ─────────────────────────────────────────────

  function FieldEditor({
    field,
    config,
    onChange,
  }: {
    field: LyricFXField;
    config: Record<string, unknown>;
    onChange: (value: unknown) => void;
  }) {
    const raw = config[field.key];

    if (field.kind === 'select') {
      return (
        <div className={styles.paramRow}>
          <label className={styles.paramLabel}>{field.label}</label>
          <select
            className={styles.paramSelect}
            value={typeof raw === 'string' ? raw : (field.options?.[0] ?? '')}
            onChange={(ev) => onChange(ev.target.value)}
          >
            {field.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (field.kind === 'color' || field.kind === 'colorAlpha') {
      const arr = Array.isArray(raw) ? (raw as number[]) : [1, 1, 1, 1];
      return (
        <ColorField
          label={field.label}
          value={rgbToHex(arr)}
          onChange={(hex) => {
            const rgb = hexToRgb(hex);
            onChange(field.kind === 'colorAlpha' ? [...rgb, arr[3] ?? 1] : rgb);
          }}
        />
      );
    }

    // slider (plain number) or param ({ value } object)
    const num =
      field.kind === 'param'
        ? typeof raw === 'object' && raw && 'value' in (raw as Record<string, unknown>)
          ? Number((raw as { value: unknown }).value)
          : 0
        : typeof raw === 'number'
          ? raw
          : 0;
    return (
      <SliderField
        label={field.label}
        value={num}
        onChange={(v) => onChange(field.kind === 'param' ? { value: v } : v)}
        min={field.min ?? 0}
        max={field.max ?? 1}
        step={field.step ?? 0.01}
      />
    );
  }
}
