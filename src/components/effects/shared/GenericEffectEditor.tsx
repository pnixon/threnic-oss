'use client';

/**
 * GenericEffectEditor
 *
 * A single component that replaces all 25+ individual effect editors.
 * It reads an EffectSchema and dynamically renders the correct controls
 * (sliders, color pickers, selects, button groups, audio reactive editors)
 * with consistent layout and behavior.
 *
 * Layout per field row (3 columns):
 *   [🔊 AR toggle] [Label — slider/control — ] [numeric value]
 *
 * When the AR toggle is active, the AudioReactiveEditor settings expand
 * below the field row.
 */

import React, { useMemo, useCallback, useState, useEffect } from 'react';
import styles from '../../modals/EffectsModal.module.css';
import { SliderField } from './SliderField';
import { LogSliderField } from './LogSliderField';
import { ColorField } from './ColorField';
import { RangeSliderField } from './RangeSliderField';
import { AudioReactiveEditor } from './AudioReactiveEditor';
import { ButterchurnPresetSelect } from './ButterchurnPresetSelect';
import { TriggerLevelWidget } from './TriggerLevelWidget';
import { ImageUploadField } from './ImageUploadField';
import { useKeyframes } from '@/hooks/useKeyframes';
import { useEffectEditor } from './EffectEditorContext';
import type { EffectSchema, FieldDef, GroupDef } from '@/types/effects/effect-schema';
import type { AudioReactiveConfig } from '@/types/effects/audio-reactive';

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

/** Get a value from a nested object by dot-notation path */
function getNestedValue(obj: Record<string, unknown>, path?: string): unknown {
  if (!path) return undefined;
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | null | undefined)?.[k], obj);
}

/** Set a value on a nested object by dot-notation path (returns new shallow-cloned object) */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const keys = path.split('.');
  if (keys.length === 1) {
    return { ...obj, [keys[0]]: value };
  }
  const [head, ...rest] = keys;
  return {
    ...obj,
    [head]: setNestedValue((obj[head] as Record<string, unknown>) ?? {}, rest.join('.'), value),
  };
}

// ───────────────────────────────────────────────────────────────
// Props
// ───────────────────────────────────────────────────────────────

interface GenericEffectEditorProps {
  schema: EffectSchema;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  /**
   * Whether a Shader FX instance is currently enabled on this track. Used to
   * conditionally show schema notes flagged `onlyWhenShaderFxEnabled` (e.g. the
   * background-transform effects that don't affect shader-driven backgrounds).
   */
  shaderFxEnabled?: boolean;
}

// ───────────────────────────────────────────────────────────────
// AudioReactive Toggle Icon (inline SVG)
// ───────────────────────────────────────────────────────────────

// Injected once: keyframes for the AR toggle's equalizer-bar pulse. Uses a
// styleId guard so mounting many rows doesn't duplicate the <style> tag.
const AR_EQ_STYLE_ID = 'ar-eq-bar-pulse-keyframes';
const AR_EQ_KEYFRAMES = `
@keyframes arEqWave1 { 0%,100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
@keyframes arEqWave2 { 0%,100% { transform: scaleY(0.85); } 50% { transform: scaleY(0.3); } }
@keyframes arEqWave3 { 0%,100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }
`;

function useArEqKeyframes() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(AR_EQ_STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = AR_EQ_STYLE_ID;
    el.textContent = AR_EQ_KEYFRAMES;
    document.head.appendChild(el);
    // Intentionally not removed on unmount: shared across all AR rows.
  }, []);
}

function ArToggleIcon({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  useArEqKeyframes();

  // Three equalizer bars. When AR is on they pulse (each on its own animation
  // + phase); when off they sit flat and muted. Color follows the theme accent.
  const bars = [
    { rest: 0.4, anim: 'arEqWave1', dur: '0.7s', delay: '0s' },
    { rest: 0.85, anim: 'arEqWave2', dur: '0.5s', delay: '0.1s' },
    { rest: 0.55, anim: 'arEqWave3', dur: '0.85s', delay: '0.05s' },
  ];

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={enabled ? 'Disable audio reactivity' : 'Enable audio reactivity'}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 2,
        width: 18,
        height: 18,
        padding: '0 3px 4px',
        background: enabled ? 'var(--accent-muted)' : 'transparent',
        border: `1px solid ${enabled ? 'var(--accent-main)' : 'var(--border-subtle)'}`,
        borderRadius: 3,
        cursor: 'pointer',
        transition: 'background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease',
        flexShrink: 0,
        opacity: enabled ? 1 : 0.7,
        overflow: 'hidden',
      }}
    >
      {bars.map((bar, i) => (
        <span
          key={i}
          style={{
            display: 'block',
            width: 2,
            height: 10,
            borderRadius: 1,
            transformOrigin: 'bottom center',
            background: enabled ? 'var(--accent-main)' : 'var(--text-muted)',
            transform: enabled ? undefined : `scaleY(${bar.rest})`,
            animation: enabled
              ? `${bar.anim} ${bar.dur} ${bar.delay} infinite ease-in-out`
              : 'none',
          }}
        />
      ))}
      {/* Disabled state: red diagonal strike-through for a clear "off" affordance */}
      {!enabled && (
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          <line
            x1="3"
            y1="15"
            x2="15"
            y2="3"
            stroke="#ff2d46"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}

// ───────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────

/** A single field renderer with inline AR toggle */
function SchemaField({
  field,
  config,
  onChange,
  editorCtx,
  updateProperty,
  selectedKeyframeId,
}: {
  field: FieldDef;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  editorCtx: ReturnType<typeof useEffectEditor>;
  updateProperty: (property: string, value: unknown, keyframeId?: string) => void;
  selectedKeyframeId: string | undefined;
}) {
  // ── Track expanded state for AR panel ──
  const [arExpanded, setArExpanded] = useState(false);

  // ── Resolve the current value from config ──
  const rawValue = getNestedValue(config, field.property as string);
  const value = rawValue ?? field.default;

  // ── Resolve the current low/high values from config for range fields ──
  const rawValueLow = field.propertyLow ? getNestedValue(config, field.propertyLow) : undefined;
  const valueLow = rawValueLow ?? field.defaultLow ?? field.min ?? 0;

  const rawValueHigh = field.propertyHigh ? getNestedValue(config, field.propertyHigh) : undefined;
  const valueHigh = rawValueHigh ?? field.defaultHigh ?? field.max ?? 1;

  const displayValueLow = useMemo(() => {
    const v = typeof valueLow === 'number' ? valueLow : 0;
    return field.displayScale ? v * field.displayScale.scale : v;
  }, [valueLow, field.displayScale]);

  const displayValueHigh = useMemo(() => {
    const v = typeof valueHigh === 'number' ? valueHigh : 0;
    return field.displayScale ? v * field.displayScale.scale : v;
  }, [valueHigh, field.displayScale]);

  // ── Audio reactive check: is AR enabled for this field? ──
  const hasAr = !!field.audioReactive;
  const arConfig = hasAr
    ? (getNestedValue(config, field.audioReactive!.path) as AudioReactiveConfig | undefined)
    : undefined;
  const arEnabled = !!arConfig?.enabled;

  // ── Whether to hide the base control when AR is active ──
  const hideBase = arEnabled && (field.audioReactive?.hideBaseWhenActive ?? true);

  // ── Generic updater that merges + writes keyframe ──
  const handleChange = useCallback(
    (newValue: number) => {
      let storeValue = newValue;
      if (field.transform === 'round') storeValue = Math.round(newValue);
      if (field.displayScale) storeValue = newValue / field.displayScale.scale;

      const nextConfig = setNestedValue(config, field.property as string, storeValue);
      onChange(nextConfig);

      if (editorCtx?.propertyPrefix) {
        updateProperty(
          `${editorCtx.propertyPrefix}.${field.property as string}`,
          storeValue,
          selectedKeyframeId,
        );
      }
    },
    [config, field, onChange, editorCtx, updateProperty, selectedKeyframeId],
  );

  // ── Compute display value (applying displayScale) ──
  const displayValue = useMemo(() => {
    const v = typeof value === 'number' ? value : 0;
    return field.displayScale ? v * field.displayScale.scale : v;
  }, [value, field.displayScale]);

  // ── Handle AR toggle click — toggles enabled + auto expand/collapse ──
  const handleArToggle = useCallback(() => {
    if (!field.audioReactive) return;

    if (arEnabled) {
      // Disable AR and collapse
      const currentAr =
        (getNestedValue(config, field.audioReactive.path) as Record<string, unknown>) ?? {};
      const nextConfig = setNestedValue(config, field.audioReactive.path, {
        ...currentAr,
        enabled: false,
      });
      onChange(nextConfig);
      setArExpanded(false);
    } else {
      // Enable AR and expand
      const currentAr =
        (getNestedValue(config, field.audioReactive.path) as Record<string, unknown>) ?? {};
      const nextConfig = setNestedValue(config, field.audioReactive.path, {
        ...currentAr,
        enabled: true,
      });
      onChange(nextConfig);
      setArExpanded(true);
    }
  }, [field.audioReactive, arEnabled, config, onChange]);

  // ── Check showWhen condition (AFTER all hooks to avoid ordering violation) ──
  if (field.showWhen) {
    const conditionValue = getNestedValue(config, field.showWhen.field);
    const matchValues = Array.isArray(field.showWhen.value)
      ? field.showWhen.value
      : [field.showWhen.value];

    const matches = matchValues.some((v) => {
      if (typeof v === 'string' && typeof conditionValue === 'boolean') {
        return conditionValue === (v === 'true');
      }
      return conditionValue === v;
    });

    const shouldShow = field.showWhen.negate ? !matches : matches;
    if (!shouldShow) return null;
  }

  // ── Render the control ──
  const renderControl = () => {
    // If base is hidden by AR, show info text instead
    if (hideBase && field.type !== 'buttonGroup' && field.type !== 'select') {
      if (field.audioReactive?.infoText) {
        return (
          <div className={styles.infoBox} style={{ flex: 1 }}>
            {field.audioReactive.infoText}
          </div>
        );
      }
      // Still show the label when hidden
      return (
        <div className={styles.field} style={{ flex: 1 }}>
          <label className={styles.fieldLabel} style={{ opacity: 0.5 }}>
            {field.label}
          </label>
          <span
            style={{
              flex: 1,
              fontSize: 9,
              color: 'var(--accent-main)',
              fontStyle: 'italic',
            }}
          >
            audio driven
          </span>
        </div>
      );
    }

    switch (field.type) {
      case 'range':
        return (
          <RangeSliderField
            label={field.label}
            valueLow={displayValueLow}
            valueHigh={displayValueHigh}
            min={field.min ?? 0}
            max={field.max ?? 1}
            step={field.step ?? 0.01}
            propertyLow={field.propertyLow}
            propertyHigh={field.propertyHigh}
            onChange={(low, high) => {
              let storeLow = low;
              let storeHigh = high;
              if (field.transform === 'round') {
                storeLow = Math.round(low);
                storeHigh = Math.round(high);
              }
              if (field.displayScale) {
                storeLow = low / field.displayScale.scale;
                storeHigh = high / field.displayScale.scale;
              }

              let nextConfig = config;
              if (field.propertyLow) {
                nextConfig = setNestedValue(nextConfig, field.propertyLow, storeLow);
              }
              if (field.propertyHigh) {
                nextConfig = setNestedValue(nextConfig, field.propertyHigh, storeHigh);
              }
              onChange(nextConfig);
            }}
          />
        );

      case 'slider':
        return (
          <SliderField
            label={field.label}
            value={displayValue}
            onChange={handleChange}
            min={field.min ?? 0}
            max={field.max ?? 1}
            step={field.step ?? 0.01}
            property={field.property as string}
          />
        );

      case 'logSlider':
        return (
          <LogSliderField
            label={field.label}
            value={typeof value === 'number' ? value : 0}
            onChange={(v) => {
              const storeValue = field.transform === 'round' ? Math.round(v) : v;
              const nextConfig = setNestedValue(config, field.property as string, storeValue);
              onChange(nextConfig);
              if (editorCtx?.propertyPrefix) {
                updateProperty(
                  `${editorCtx.propertyPrefix}.${field.property as string}`,
                  storeValue,
                  selectedKeyframeId,
                );
              }
            }}
            min={field.min ?? 1}
            max={field.max ?? 100}
            property={field.property as string}
          />
        );

      case 'color':
        return (
          <ColorField
            label={field.label}
            value={typeof value === 'string' ? value : ((field.default as string) ?? '#ffffff')}
            onChange={(color) => {
              const nextConfig = setNestedValue(config, field.property as string, color);
              onChange(nextConfig);
            }}
            property={field.property as string}
          />
        );

      case 'select':
        return (
          <div className={styles.field} style={{ flex: 1 }}>
            <label className={styles.fieldLabel}>{field.label}</label>
            <select
              className={styles.select}
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => {
                const nextConfig = setNestedValue(config, field.property as string, e.target.value);
                onChange(nextConfig);
                if (editorCtx?.propertyPrefix) {
                  updateProperty(
                    `${editorCtx.propertyPrefix}.${field.property as string}`,
                    e.target.value,
                    selectedKeyframeId,
                  );
                }
              }}
            >
              {(field.dynamicOptionsKey ? [] : field.options)?.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        );

      case 'checkbox':
        return (
          <div className={styles.field} style={{ flex: 1 }}>
            <label className={styles.fieldLabel}>{field.label}</label>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={!!value}
                onChange={(e) => {
                  const nextConfig = setNestedValue(
                    config,
                    field.property as string,
                    e.target.checked,
                  );
                  onChange(nextConfig);
                  if (editorCtx?.propertyPrefix) {
                    updateProperty(
                      `${editorCtx.propertyPrefix}.${field.property as string}`,
                      e.target.checked,
                      selectedKeyframeId,
                    );
                  }
                }}
              />
              {field.checkboxLabel}
            </label>
          </div>
        );

      case 'buttonGroup': {
        const cols = (field.options?.length ?? 2) <= 3 ? field.options!.length : 2;
        return (
          <div className={styles.field} style={{ flex: 1 }}>
            <label className={styles.fieldLabel}>{field.label}</label>
            <div
              className={styles.buttonGroup}
              style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 4 }}
            >
              {field.options?.map((opt) => {
                const isActive =
                  typeof value === 'boolean'
                    ? String(value) === opt.value
                    : String(value) === opt.value;
                return (
                  <button
                    key={opt.value}
                    className={`${styles.bandButton} ${isActive ? styles.active : ''}`}
                    onClick={() => {
                      let parsedValue: string | boolean = opt.value;
                      if (opt.value === 'true') parsedValue = true;
                      else if (opt.value === 'false') parsedValue = false;

                      const nextConfig = setNestedValue(
                        config,
                        field.property as string,
                        parsedValue,
                      );
                      onChange(nextConfig);
                      if (editorCtx?.propertyPrefix) {
                        updateProperty(
                          `${editorCtx.propertyPrefix}.${field.property as string}`,
                          parsedValue,
                          selectedKeyframeId,
                        );
                      }
                    }}
                    type="button"
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      }

      case 'butterchurnPresetPicker':
        return (
          <ButterchurnPresetSelect
            value={typeof value === 'string' ? value : ''}
            onChange={(name) => {
              const nextConfig = setNestedValue(config, field.property as string, name);
              onChange(nextConfig);
              if (editorCtx?.propertyPrefix) {
                updateProperty(
                  `${editorCtx.propertyPrefix}.${field.property as string}`,
                  name,
                  selectedKeyframeId,
                );
              }
            }}
          />
        );

      case 'triggerLevel': {
        // TriggerLevel widget: reads a compound value { band, threshold, cooldown }
        type TriggerValue = { band: 'bass' | 'mid' | 'treb'; threshold: number; cooldown: number };
        const triggerDefault = field.default as Partial<TriggerValue> | undefined;
        const triggerConfig =
          typeof value === 'object' && value !== null
            ? (value as TriggerValue)
            : {
                band: triggerDefault?.band ?? 'bass',
                threshold: triggerDefault?.threshold ?? 0.7,
                cooldown: triggerDefault?.cooldown ?? 1.5,
              };
        return (
          <TriggerLevelWidget
            label={field.label}
            config={triggerConfig}
            triggerId={
              // Derive triggerId from property: 'littlejs.params.leftAttack' → 'left'
              (field.property as string)?.includes('leftAttack')
                ? 'left'
                : (field.property as string)?.includes('rightAttack')
                  ? 'right'
                  : undefined
            }
            onChange={(newTrigger) => {
              const nextConfig = setNestedValue(config, field.property as string, newTrigger);
              onChange(nextConfig);

              // Persist numeric sub-values as individual dot-path keyframes so
              // threshold and cooldown INTERPOLATE between keyframes (band is
              // categorical — write it as a held value, not interpolated).
              if (editorCtx?.propertyPrefix) {
                const base = `${editorCtx.propertyPrefix}.${field.property as string}`;
                updateProperty(`${base}.threshold`, newTrigger.threshold, selectedKeyframeId);
                updateProperty(`${base}.cooldown`, newTrigger.cooldown, selectedKeyframeId);
                updateProperty(`${base}.band`, newTrigger.band, selectedKeyframeId);
              }
            }}
          />
        );
      }

      case 'imageUpload':
        return (
          <ImageUploadField
            label={field.label}
            value={typeof value === 'string' ? value : undefined}
            onChange={(assetId) => {
              const nextConfig = setNestedValue(config, field.property as string, assetId);
              onChange(nextConfig);
              if (editorCtx?.propertyPrefix) {
                updateProperty(
                  `${editorCtx.propertyPrefix}.${field.property as string}`,
                  assetId,
                  selectedKeyframeId,
                );
              }
            }}
          />
        );

      default:
        return null;
    }
  };

  // ── Render AR expanded panel ──
  const renderArPanel = () => {
    if (!field.audioReactive || !arEnabled || !arExpanded) return null;

    // For display-scaled fields, scale the AR config min/max for display
    const displayArConfig =
      arConfig && field.displayScale
        ? {
            ...arConfig,
            min: arConfig.min * field.displayScale.scale,
            max: arConfig.max * field.displayScale.scale,
          }
        : arConfig;

    return (
      <div
        style={{
          marginLeft: 24, // indent past the AR toggle column
          marginTop: 2,
          marginBottom: 4,
          borderLeft: '2px solid var(--accent-main)',
          paddingLeft: 8,
        }}
      >
        {/* Collapse chevron */}
        <button
          type="button"
          onClick={() => setArExpanded(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            width: '100%',
            background: 'none',
            border: 'none',
            color: 'var(--accent-main)',
            fontSize: 9,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            cursor: 'pointer',
            padding: '2px 0',
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 7 }}>▼</span>
          {field.audioReactive.label ?? field.label} — Audio Reactive
        </button>

        <AudioReactiveEditor
          label={field.audioReactive.label ?? field.label}
          config={displayArConfig}
          hideToggle
          onChange={(scaledAr: AudioReactiveConfig) => {
            const storeAr = field.displayScale
              ? {
                  ...scaledAr,
                  min: scaledAr.min / field.displayScale.scale,
                  max: scaledAr.max / field.displayScale.scale,
                }
              : scaledAr;

            const nextConfig = setNestedValue(config, field.audioReactive!.path, storeAr);
            onChange(nextConfig);
          }}
          min={field.audioReactive.min ?? field.min ?? 0}
          max={field.audioReactive.max ?? field.max ?? 1}
          step={field.audioReactive.step ?? field.step}
          propertyPrefix={field.audioReactive.path}
        />
      </div>
    );
  };

  return (
    <React.Fragment>
      {/* Section header */}
      {field.sectionHeader && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginTop: 8,
            marginBottom: 4,
          }}
        >
          {field.sectionHeader}
        </div>
      )}

      {/* ── Field Row: [AR toggle] [control] ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          width: '100%',
        }}
      >
        {/* Column 1: AR toggle (only for AR-capable fields) */}
        {hasAr ? (
          <ArToggleIcon enabled={arEnabled} onClick={handleArToggle} />
        ) : (
          /* Empty spacer to keep alignment consistent */
          <div style={{ width: 18, flexShrink: 0 }} />
        )}

        {/* Column 2+3: The control (label + slider + value) */}
        <div style={{ flex: 1, minWidth: 0 }}>{renderControl()}</div>

        {/* Collapsed AR indicator: small expand chevron when AR is on but panel collapsed */}
        {hasAr && arEnabled && !arExpanded && (
          <button
            type="button"
            onClick={() => setArExpanded(true)}
            title="Expand audio reactive settings"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 14,
              height: 14,
              padding: 0,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--accent-main)',
              fontSize: 8,
              flexShrink: 0,
              opacity: 0.7,
              transition: 'opacity 0.15s',
            }}
          >
            ▼
          </button>
        )}
      </div>

      {/* Hint text */}
      {field.hint && !hideBase && (
        <p
          style={{
            fontSize: '9px',
            color: 'var(--text-muted)',
            marginTop: '-2px',
            marginBottom: '2px',
            paddingLeft: '26px', // past the AR toggle
          }}
        >
          {field.hint}
        </p>
      )}

      {/* Audio Reactive Expanded Panel */}
      {renderArPanel()}

      {/* Divider */}
      {field.dividerAfter && (
        <div
          style={{
            height: 1,
            background: 'var(--border-subtle)',
            margin: '8px 0',
          }}
        />
      )}
    </React.Fragment>
  );
}

// ───────────────────────────────────────────────────────────────
// Main Component
// ───────────────────────────────────────────────────────────────

export function GenericEffectEditor({
  schema,
  config,
  onChange,
  shaderFxEnabled = false,
}: GenericEffectEditorProps) {
  const { updateProperty, selectedKeyframeId } = useKeyframes();
  const editorCtx = useEffectEditor();

  // Split fields into grouped and ungrouped
  const { ungroupedFields, groupedFieldsMap } = useMemo(() => {
    const ungrouped: FieldDef[] = [];
    const grouped = new Map<string, FieldDef[]>();

    for (const field of schema.fields) {
      if (field.group) {
        const list = grouped.get(field.group) || [];
        list.push(field);
        grouped.set(field.group, list);
      } else {
        ungrouped.push(field);
      }
    }

    return { ungroupedFields: ungrouped, groupedFieldsMap: grouped };
  }, [schema.fields]);

  const renderField = (field: FieldDef) => (
    <SchemaField
      key={field.property || field.propertyLow || field.label}
      field={field}
      config={config}
      onChange={onChange}
      editorCtx={editorCtx}
      updateProperty={updateProperty}
      selectedKeyframeId={selectedKeyframeId}
    />
  );

  // Whether to show the schema note (respects the shader-FX-only gate).
  const showNote = !!schema.note && (!schema.note.onlyWhenShaderFxEnabled || shaderFxEnabled);

  return (
    <div className={styles.effectEditor}>
      {/* Schema note (e.g. background transforms don't affect Shader FX backgrounds) */}
      {showNote && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
            fontSize: 10,
            lineHeight: 1.4,
            color: 'var(--text-muted)',
            background: 'var(--accent-subtle, rgba(255,255,255,0.04))',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            padding: '6px 8px',
            marginBottom: 8,
          }}
        >
          <span style={{ flexShrink: 0, opacity: 0.8 }}>ⓘ</span>
          <span>{schema.note!.text}</span>
        </div>
      )}

      {/* Render ungrouped fields first */}
      {ungroupedFields.map(renderField)}

      {/* Render grouped fields */}
      {schema.groups?.map((group) => {
        const fields = groupedFieldsMap.get(group.id);
        if (!fields || fields.length === 0) return null;

        return (
          <CollapsibleGroup key={group.id} group={group}>
            {fields.map(renderField)}
          </CollapsibleGroup>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// CollapsibleGroup
// ───────────────────────────────────────────────────────────────

function CollapsibleGroup({ group, children }: { group: GroupDef; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(group.defaultOpen ?? true);

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
          cursor: 'pointer',
          padding: '4px 0',
          marginBottom: open ? 4 : 0,
        }}
      >
        <span
          style={{
            transition: 'transform 0.2s',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            fontSize: 8,
          }}
        >
          ▶
        </span>
        {group.label}
      </button>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>}
    </div>
  );
}
