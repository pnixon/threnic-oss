import React, { useMemo, useCallback, useState } from 'react';
import { Type, Paintbrush, X, Copy, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import { CollapsibleSection, SubCollapsibleSection } from '../../CollapsibleSection';
import { ApplyToAllButton } from '../../../shared';
import { SliderField } from '@/components/effects/shared/SliderField';
import { ColorField } from '@/components/effects/shared/ColorField';
import { FONTS } from '@/constants/fonts';
import { useKeyframeSelection, usePlaylistState } from '@/contexts';
import { useScheduleAwareThemeUI } from '@/components/stage/hooks/useScheduleAware';
import { useStore } from 'zustand';
import { systemStore, selectWebgpuActive } from '@/stores/systemStore';
import {
  uiToEngineAnimationType,
  uiToEngineStagger,
  engineToUIAnimationType,
  engineToUIStagger,
} from '@/engine/lyrics/animationMap';
import type { LyricTheme, LineStyleOverride } from '@/types/lyrics';
import styles from '../../Inspector.module.css';

interface LyricSettingsSectionProps {
  selectedFontId: string;
  onFontChange: (fontId: string) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  wordSpacing: number;
  onWordSpacingChange: (spacing: number) => void;
  lineSpacing: number;
  onLineSpacingChange: (spacing: number) => void;
  verticalPosition: number;
  onVerticalPositionChange: (position: number) => void;
  horizontalPosition: 'left' | 'center' | 'right';
  onHorizontalPositionChange: (position: 'left' | 'center' | 'right') => void;
  wrapWidth: number;
  onWrapWidthChange: (width: number) => void;
  lyricColors: { pre: string; active: string; post: string };
  onLyricColorsChange: (colors: { pre: string; active: string; post: string }) => void;
  glowEnabled: boolean;
  onGlowEnabledChange: (enabled: boolean) => void;
  glowColor: string;
  onGlowColorChange: (color: string) => void;
  glowIntensity: number;
  onGlowIntensityChange: (intensity: number) => void;
  outlineColor: string;
  onOutlineColorChange: (color: string) => void;
  animationType: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
  onAnimationTypeChange: (
    type: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter',
  ) => void;
  animationStagger: 'letter' | 'word' | 'line';
  onAnimationStaggerChange: (stagger: 'letter' | 'word' | 'line') => void;
  fadeInDuration: number;
  onFadeInDurationChange: (duration: number) => void;
  fadeOutDuration: number;
  onFadeOutDurationChange: (duration: number) => void;
  highlightFadeIn?: number;
  highlightFadeOut?: number;
  lyricsApplied: boolean;
  onApplyLyricsToAll: () => void;
  forceOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
  currentTime?: number;
  trackId?: string;
  selectedKeyframeId?: string;
  updateTrackProperty?: (
    trackId: string,
    property: string,
    value: unknown,
    keyframeId?: string,
  ) => void;

  // Lane
  selectedLane: number;
  laneCount: number;
  laneStyles: Record<number, LineStyleOverride>;
  onLaneStyleChange: (laneIndex: number, style: LineStyleOverride | undefined) => void;
}

function OverrideBadge({ onClear }: { onClear: () => void }) {
  return (
    <button
      className={styles.overrideBadge}
      onClick={(e) => {
        e.stopPropagation();
        onClear();
      }}
      title="This field has a per-lane override. Click to reset to track default."
    >
      ×
    </button>
  );
}

const LANE_COLORS = [
  '#ef4444', // red
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#06b6d4', // cyan
];

export function LyricSettingsSection({
  selectedFontId: baseFontId,
  onFontChange,
  fontSize: baseFontSize,
  onFontSizeChange,
  wordSpacing: baseWordSpacing,
  onWordSpacingChange,
  lineSpacing: baseLineSpacing,
  onLineSpacingChange,
  verticalPosition: baseVerticalPosition,
  onVerticalPositionChange,
  horizontalPosition: baseHorizontalPosition,
  onHorizontalPositionChange,
  wrapWidth: baseWrapWidth,
  onWrapWidthChange,
  lyricColors: baseColors,
  onLyricColorsChange,
  glowEnabled: baseGlowEnabled,
  onGlowEnabledChange,
  glowColor: baseGlowColor,
  onGlowColorChange,
  glowIntensity: baseGlowIntensity,
  onGlowIntensityChange,
  outlineColor: baseOutlineColor,
  onOutlineColorChange,
  animationType: baseAnimType,
  onAnimationTypeChange,
  animationStagger: baseAnimStagger,
  onAnimationStaggerChange,
  fadeInDuration: baseFadeIn,
  onFadeInDurationChange,
  fadeOutDuration: baseFadeOut,
  onFadeOutDurationChange,
  highlightFadeIn: baseHighlightFadeIn = 1.0,
  highlightFadeOut: baseHighlightFadeOut = 1.0,
  lyricsApplied,
  onApplyLyricsToAll,
  forceOpen,
  open,
  onToggle,
  currentTime = 0,
  trackId,
  selectedKeyframeId,
  updateTrackProperty,
  selectedLane,
  laneCount,
  laneStyles,
  onLaneStyleChange,
}: LyricSettingsSectionProps) {
  const { selectedKeyframeId: ctxKeyframeId } = useKeyframeSelection();
  const { tracks } = usePlaylistState();
  const activeKeyframeId = selectedKeyframeId || ctxKeyframeId;

  // Persisted anti-aliasing flag for the selected track (authoritative — the
  // locally-reconstructed baseTheme does not carry it). Defaults ON when unset.
  const trackAntialiasing = tracks.find((t) => t.id === trackId)?.lyricsTheme?.antialiasing ?? true;

  // Single-open accordion for the styling sub-sections. Only one of
  // Appearance / Colors / Animation is expanded at a time; "Appearance"
  // is open by default.
  type StyleSubSection = 'appearance' | 'colors' | 'animation';
  const [openStyleSection, setOpenStyleSection] = useState<StyleSubSection | ''>('appearance');
  const toggleStyleSection = useCallback((id: StyleSubSection) => {
    setOpenStyleSection((cur) => (cur === id ? '' : id));
  }, []);

  // When the WebGPU lyric renderer is live, lyric animation is configured in the
  // Lyric FX panel (five lifecycle phases), so the styling Animation subsection
  // is hidden here to avoid two competing controls.
  const webgpuActive = useStore(systemStore, selectWebgpuActive);

  // Base Theme
  const baseTheme: LyricTheme = useMemo(
    () => ({
      fontId: baseFontId,
      fontSize: baseFontSize,
      wordSpacing: baseWordSpacing,
      verticalPosition: baseVerticalPosition,
      horizontalPosition: baseHorizontalPosition,
      wrapWidth: baseWrapWidth,
      lineSpacing: baseLineSpacing,
      colorPre: baseColors.pre,
      colorActive: baseColors.active,
      colorPost: baseColors.post,
      colors: {
        pre: baseColors.pre,
        active: baseColors.active,
        post: baseColors.post,
      },
      glowEnabled: baseGlowEnabled,
      glowColor: baseGlowColor,
      glowIntensity: baseGlowIntensity,
      outlineColor: baseOutlineColor,
      effect: 'none',
      audioReactive: false,
      animationIn: {
        type: uiToEngineAnimationType(baseAnimType),
        duration: baseFadeIn,
        granularity: uiToEngineStagger(baseAnimStagger),
        stagger: 0.1,
      },
      animationOut: {
        type: 'fade',
        granularity: uiToEngineStagger(baseAnimStagger),
        duration: baseFadeOut,
      },
      highlightFadeIn: baseHighlightFadeIn,
      highlightFadeOut: baseHighlightFadeOut,
    }),
    [
      baseFontId,
      baseFontSize,
      baseWordSpacing,
      baseVerticalPosition,
      baseHorizontalPosition,
      baseWrapWidth,
      baseLineSpacing,
      baseColors,
      baseGlowEnabled,
      baseGlowColor,
      baseGlowIntensity,
      baseOutlineColor,
      baseAnimType,
      baseFadeIn,
      baseAnimStagger,
      baseFadeOut,
      baseHighlightFadeIn,
      baseHighlightFadeOut,
    ],
  );

  const effectiveTheme = useScheduleAwareThemeUI(baseTheme);

  // Derive Base Display Values
  const defaultFontId = effectiveTheme?.fontId ?? baseFontId;
  const defaultFontSize = effectiveTheme?.fontSize ?? baseFontSize;
  const defaultWordSpacing = effectiveTheme?.wordSpacing ?? baseWordSpacing;
  const defaultLineSpacing = effectiveTheme?.lineSpacing ?? baseLineSpacing ?? 1.35;
  const defaultVerticalPosition = effectiveTheme?.verticalPosition ?? baseVerticalPosition;
  const defaultHorizontalPosition =
    effectiveTheme?.horizontalPosition ?? baseHorizontalPosition ?? 'center';
  const defaultWrapWidth = effectiveTheme?.wrapWidth ?? baseWrapWidth ?? 90;
  const defaultColors = {
    pre: effectiveTheme?.colorPre ?? baseColors.pre,
    active: effectiveTheme?.colorActive ?? baseColors.active,
    post: effectiveTheme?.colorPost ?? baseColors.post,
  };
  const defaultGlowEnabled = effectiveTheme?.glowEnabled ?? baseGlowEnabled;
  const defaultGlowColor = effectiveTheme?.glowColor ?? baseGlowColor;
  const defaultGlowIntensity = effectiveTheme?.glowIntensity ?? baseGlowIntensity;
  const defaultOutlineColor = effectiveTheme?.outlineColor ?? baseOutlineColor;

  const defaultAnimType = engineToUIAnimationType(
    effectiveTheme?.animationIn?.type ?? baseAnimType,
  );
  const defaultAnimStagger = engineToUIStagger(
    effectiveTheme?.animationIn?.granularity ?? baseAnimStagger,
  );
  const defaultFadeIn = effectiveTheme?.animationIn?.duration ?? baseFadeIn;
  const defaultFadeOut = effectiveTheme?.animationOut?.duration ?? baseFadeOut;

  // Helper overrides
  const isSingleLaneMode = laneCount <= 1;
  const isBaseTheme = selectedLane === -1;
  // In single-lane mode selectedLane is 0, but we treat it like base for display
  const isBaseDisplay = isBaseTheme || isSingleLaneMode;
  const s = isBaseTheme ? {} : (laneStyles[selectedLane] ?? {});
  const hasOverrides = !isBaseTheme && !isSingleLaneMode && Object.keys(s).length > 0;

  const handleOverrideChange = useCallback(
    <K extends keyof LineStyleOverride>(field: K, value: LineStyleOverride[K]) => {
      const existing = laneStyles[selectedLane] ?? {};
      onLaneStyleChange(selectedLane, { ...existing, [field]: value });
    },
    [laneStyles, selectedLane, onLaneStyleChange],
  );

  const handleClearOverride = useCallback(
    (field: keyof LineStyleOverride) => {
      const existing = laneStyles[selectedLane];
      if (!existing) return;
      const updated = { ...existing };
      delete updated[field];
      const hasAny = Object.keys(updated).length > 0;
      onLaneStyleChange(selectedLane, hasAny ? updated : undefined);
    },
    [laneStyles, selectedLane, onLaneStyleChange],
  );

  const handleClearAllOverrides = useCallback(() => {
    onLaneStyleChange(selectedLane, undefined);
  }, [selectedLane, onLaneStyleChange]);

  const handleCopyToAllLanes = useCallback(() => {
    const source = laneStyles[selectedLane];
    if (!source) return;
    for (let i = 0; i < laneCount; i++) {
      if (i !== selectedLane) {
        onLaneStyleChange(i, { ...source });
      }
    }
  }, [laneStyles, selectedLane, laneCount, onLaneStyleChange]);

  const setValueFor = <K extends keyof LineStyleOverride>(
    field: K,
    value: NonNullable<LineStyleOverride[K]>,
    baseCallback: (v: NonNullable<LineStyleOverride[K]>) => void,
    propertyName?: string,
  ) => {
    if (isBaseTheme) {
      // Pure base-theme mode: only update the global/base callbacks
      baseCallback(value);
      if (trackId && updateTrackProperty && propertyName) {
        updateTrackProperty(trackId, propertyName, value, activeKeyframeId);
      }
    } else if (isSingleLaneMode) {
      // Single-lane mode: update BOTH the lane override (so the renderer sees it)
      // AND the base callback (so page-level state stays in sync for saves/export)
      handleOverrideChange(field, value);
      baseCallback(value);
      if (trackId && updateTrackProperty && propertyName) {
        updateTrackProperty(trackId, propertyName, value, activeKeyframeId);
      }
    } else {
      // Multi-lane: only update the lane override
      handleOverrideChange(field, value);
    }
  };

  const laneColor = LANE_COLORS[Math.max(0, selectedLane) % LANE_COLORS.length];

  return (
    <CollapsibleSection
      title={isBaseDisplay ? 'Lyric Styling' : 'Lane Override Styling'}
      icon={isBaseDisplay ? <Type size={14} /> : <Paintbrush size={14} />}
      defaultOpen={true}
      maxHeight={500}
      forceOpen={forceOpen}
      open={open}
      onToggle={onToggle}
      wrapperClassName={!isBaseDisplay ? styles.lineOverrideEditor : undefined}
      wrapperStyle={
        !isBaseDisplay ? { borderLeftColor: laneColor, position: 'relative' } : undefined
      }
    >
      <SubCollapsibleSection
        title="Appearance"
        open={openStyleSection === 'appearance'}
        onToggle={() => toggleStyleSection('appearance')}
      >
        {!isBaseDisplay && (
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Lane Alias</label>
            <input
              className={styles.textInput}
              type="text"
              placeholder="e.g. Vocals, Harmony..."
              value={s.label ?? ''}
              onChange={(e) => handleOverrideChange('label', e.target.value || undefined)}
            />
          </div>
        )}

        <div className={styles.fieldGroup}>
          <label htmlFor="font-family-select" className={styles.fieldLabel}>
            Font Family
            {!isBaseDisplay && s.fontId !== undefined && (
              <OverrideBadge onClear={() => handleClearOverride('fontId')} />
            )}
          </label>
          <select
            id="font-family-select"
            className={styles.select}
            value={s.fontId !== undefined ? s.fontId : defaultFontId}
            onChange={(e) => {
              setValueFor('fontId', e.target.value, onFontChange, 'lyrics.fontId');
            }}
          >
            {FONTS.map((font) => (
              <option key={font.id} value={font.id}>
                {font.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <SliderField
            label={!isBaseDisplay && s.fontSize !== undefined ? 'Font Size ●' : 'Font Size'}
            value={s.fontSize !== undefined ? s.fontSize : defaultFontSize}
            onChange={(v) => setValueFor('fontSize', v, onFontSizeChange, 'lyrics.fontSize')}
            min={0.1}
            max={1.5}
            step={0.05}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.fontSize' : undefined}
          />
          {!isBaseDisplay && s.fontSize !== undefined && (
            <OverrideBadge onClear={() => handleClearOverride('fontSize')} />
          )}
        </div>

        <div>
          <SliderField
            label={
              !isBaseDisplay && s.wordSpacing !== undefined ? 'Word Spacing ●' : 'Word Spacing'
            }
            value={s.wordSpacing !== undefined ? s.wordSpacing : defaultWordSpacing}
            onChange={(v) =>
              setValueFor('wordSpacing', v, onWordSpacingChange, 'lyrics.wordSpacing')
            }
            min={0.0}
            max={2.0}
            step={0.05}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.wordSpacing' : undefined}
          />
          {!isBaseDisplay && s.wordSpacing !== undefined && (
            <OverrideBadge onClear={() => handleClearOverride('wordSpacing')} />
          )}
        </div>

        <div>
          <SliderField
            label={
              !isBaseDisplay && s.lineSpacing !== undefined ? 'Line Spacing ●' : 'Line Spacing'
            }
            value={s.lineSpacing !== undefined ? s.lineSpacing : defaultLineSpacing}
            onChange={(v) =>
              setValueFor('lineSpacing', v, onLineSpacingChange, 'lyrics.lineSpacing')
            }
            min={1.0}
            max={2.5}
            step={0.05}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.lineSpacing' : undefined}
          />
          {!isBaseDisplay && s.lineSpacing !== undefined && (
            <OverrideBadge onClear={() => handleClearOverride('lineSpacing')} />
          )}
        </div>

        <div>
          <SliderField
            label={
              !isBaseDisplay && s.letterSpacing !== undefined
                ? 'Letter Spacing ●'
                : 'Letter Spacing'
            }
            value={
              s.letterSpacing !== undefined ? s.letterSpacing : (effectiveTheme?.letterSpacing ?? 0)
            }
            onChange={(v) =>
              setValueFor(
                'letterSpacing',
                v,
                () => {
                  if (trackId && updateTrackProperty)
                    updateTrackProperty(trackId, 'lyrics.letterSpacing', v, activeKeyframeId);
                },
                'lyrics.letterSpacing',
              )
            }
            min={-0.1}
            max={0.3}
            step={0.01}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.letterSpacing' : undefined}
          />
          {!isBaseDisplay && s.letterSpacing !== undefined && (
            <OverrideBadge onClear={() => handleClearOverride('letterSpacing')} />
          )}
        </div>

        <div>
          <SliderField
            label={
              !isBaseDisplay && s.verticalPosition !== undefined ? 'Position Y ●' : 'Position Y'
            }
            value={s.verticalPosition !== undefined ? s.verticalPosition : defaultVerticalPosition}
            onChange={(v) =>
              setValueFor(
                'verticalPosition',
                v,
                onVerticalPositionChange,
                'lyrics.verticalPosition',
              )
            }
            min={0}
            max={100}
            step={1}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.verticalPosition' : undefined}
          />
          {!isBaseDisplay && s.verticalPosition !== undefined && (
            <OverrideBadge onClear={() => handleClearOverride('verticalPosition')} />
          )}
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>
            Position X
            {!isBaseDisplay && s.horizontalPosition !== undefined && (
              <OverrideBadge onClear={() => handleClearOverride('horizontalPosition')} />
            )}
          </label>
          <div style={{ display: 'flex', gap: 4 }}>
            {(
              [
                ['left', AlignLeft, 'Align left'],
                ['center', AlignCenter, 'Align center'],
                ['right', AlignRight, 'Align right'],
              ] as const
            ).map(([val, Icon, title]) => {
              const active =
                (s.horizontalPosition !== undefined
                  ? s.horizontalPosition
                  : defaultHorizontalPosition) === val;
              return (
                <button
                  key={val}
                  type="button"
                  title={title}
                  aria-pressed={active}
                  onClick={() =>
                    setValueFor(
                      'horizontalPosition',
                      val,
                      onHorizontalPositionChange,
                      'lyrics.horizontalPosition',
                    )
                  }
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '6px 0',
                    borderRadius: 6,
                    border: active
                      ? '1px solid var(--accent, #6366f1)'
                      : '1px solid var(--border, #333)',
                    background: active ? 'var(--accent, #6366f1)' : 'transparent',
                    color: active ? '#fff' : 'var(--text-secondary, #aaa)',
                    cursor: 'pointer',
                  }}
                >
                  <Icon size={14} />
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <SliderField
            label={!isBaseDisplay && s.wrapWidth !== undefined ? 'Wrap Width ●' : 'Wrap Width'}
            value={s.wrapWidth !== undefined ? s.wrapWidth : defaultWrapWidth}
            onChange={(v) => setValueFor('wrapWidth', v, onWrapWidthChange, 'lyrics.wrapWidth')}
            min={10}
            max={100}
            step={1}
            currentTime={currentTime}
          />
          {!isBaseDisplay && s.wrapWidth !== undefined && (
            <OverrideBadge onClear={() => handleClearOverride('wrapWidth')} />
          )}
        </div>

        {webgpuActive && isBaseDisplay && (
          <div className="flex items-center justify-between px-1 py-1 border-t border-white/5 pt-3 mt-2">
            <label htmlFor="lyric-antialiasing" className="text-xs text-gray-400">
              Anti-aliasing
              <span className="block text-[10px] text-gray-500">
                Smooth GPU glyph edges (off = crisp/pixel)
              </span>
            </label>
            <input
              id="lyric-antialiasing"
              type="checkbox"
              checked={trackAntialiasing}
              onChange={(e) => {
                if (trackId && updateTrackProperty)
                  updateTrackProperty(
                    trackId,
                    'lyrics.antialiasing',
                    e.target.checked,
                    activeKeyframeId,
                  );
              }}
            />
          </div>
        )}
      </SubCollapsibleSection>

      <SubCollapsibleSection
        title="Colors"
        open={openStyleSection === 'colors'}
        onToggle={() => toggleStyleSection('colors')}
      >
        <div className="flex flex-col gap-3 px-1">
          <ColorField
            label="Upcoming"
            value={s.colorPre !== undefined ? s.colorPre : defaultColors.pre}
            onChange={(val) => {
              if (isBaseTheme) {
                onLyricColorsChange({ ...baseColors, pre: val });
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.colors.pre', val, activeKeyframeId);
              } else if (isSingleLaneMode) {
                handleOverrideChange('colorPre', val);
                onLyricColorsChange({ ...baseColors, pre: val });
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.colors.pre', val, activeKeyframeId);
              } else {
                handleOverrideChange('colorPre', val);
              }
            }}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.colors.pre' : undefined}
          />
          <ColorField
            label="Active"
            value={s.colorActive !== undefined ? s.colorActive : defaultColors.active}
            onChange={(val) => {
              if (isBaseTheme) {
                onLyricColorsChange({ ...baseColors, active: val });
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.colors.active', val, activeKeyframeId);
              } else if (isSingleLaneMode) {
                handleOverrideChange('colorActive', val);
                onLyricColorsChange({ ...baseColors, active: val });
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.colors.active', val, activeKeyframeId);
              } else {
                handleOverrideChange('colorActive', val);
              }
            }}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.colors.active' : undefined}
          />
          <ColorField
            label="Played"
            value={s.colorPost !== undefined ? s.colorPost : defaultColors.post}
            onChange={(val) => {
              if (isBaseTheme) {
                onLyricColorsChange({ ...baseColors, post: val });
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.colors.post', val, activeKeyframeId);
              } else if (isSingleLaneMode) {
                handleOverrideChange('colorPost', val);
                onLyricColorsChange({ ...baseColors, post: val });
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.colors.post', val, activeKeyframeId);
              } else {
                handleOverrideChange('colorPost', val);
              }
            }}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.colors.post' : undefined}
          />
          <ColorField
            label="Outline"
            value={s.outlineColor !== undefined ? s.outlineColor : defaultOutlineColor}
            onChange={(val) =>
              setValueFor('outlineColor', val, onOutlineColorChange, 'lyrics.outlineColor')
            }
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.outlineColor' : undefined}
          />
        </div>

        <div className="flex flex-col gap-2 mt-4">
          <div className="flex items-center justify-between px-1 py-1 border-t border-white/5 pt-3">
            <label className="text-xs text-gray-400">
              Glow Effect
              {!isBaseDisplay && s.glowEnabled !== undefined && (
                <OverrideBadge onClear={() => handleClearOverride('glowEnabled')} />
              )}
            </label>
            <input
              type="checkbox"
              checked={s.glowEnabled !== undefined ? s.glowEnabled : defaultGlowEnabled}
              onChange={(e) =>
                setValueFor(
                  'glowEnabled',
                  e.target.checked,
                  onGlowEnabledChange,
                  'lyrics.glowEnabled',
                )
              }
            />
          </div>

          {(s.glowEnabled !== undefined ? s.glowEnabled : defaultGlowEnabled) && (
            <div className="mt-1 space-y-2">
              <ColorField
                label={!isBaseDisplay && s.glowColor !== undefined ? 'Glow Color ●' : 'Glow Color'}
                value={s.glowColor !== undefined ? s.glowColor : defaultGlowColor}
                onChange={(val) =>
                  setValueFor('glowColor', val, onGlowColorChange, 'lyrics.glowColor')
                }
                currentTime={currentTime}
                property={isBaseDisplay ? 'lyrics.glowColor' : undefined}
              />
              <SliderField
                label={
                  !isBaseDisplay && s.glowIntensity !== undefined
                    ? 'Glow Intensity ●'
                    : 'Glow Intensity'
                }
                value={s.glowIntensity !== undefined ? s.glowIntensity : defaultGlowIntensity}
                onChange={(val) =>
                  setValueFor('glowIntensity', val, onGlowIntensityChange, 'lyrics.glowIntensity')
                }
                min={0}
                max={1}
                step={0.05}
                currentTime={currentTime}
                property={isBaseDisplay ? 'lyrics.glowIntensity' : undefined}
              />
            </div>
          )}
        </div>
      </SubCollapsibleSection>

      {!webgpuActive && (
        <SubCollapsibleSection
          title="Animation"
          open={openStyleSection === 'animation'}
          onToggle={() => toggleStyleSection('animation')}
        >
          <div className={styles.fieldGroup}>
            <label htmlFor="animation-style-select" className={styles.fieldLabel}>
              Style
            </label>
            <select
              id="animation-style-select"
              className={styles.select}
              value={engineToUIAnimationType(
                s.animationIn?.type ?? uiToEngineAnimationType(defaultAnimType),
              )}
              onChange={(e) => {
                const type = e.target.value as LyricSettingsSectionProps['animationType'];
                if (isBaseTheme) {
                  onAnimationTypeChange(type);
                  if (trackId && updateTrackProperty)
                    updateTrackProperty(trackId, 'lyrics.animationType', type, activeKeyframeId);
                } else if (isSingleLaneMode) {
                  const ex = s.animationIn ?? baseTheme.animationIn!;
                  handleOverrideChange('animationIn', {
                    ...ex,
                    type: uiToEngineAnimationType(type),
                  });
                  onAnimationTypeChange(type);
                  if (trackId && updateTrackProperty)
                    updateTrackProperty(trackId, 'lyrics.animationType', type, activeKeyframeId);
                } else {
                  const ex = s.animationIn ?? baseTheme.animationIn!;
                  handleOverrideChange('animationIn', {
                    ...ex,
                    type: uiToEngineAnimationType(type),
                  });
                }
              }}
            >
              <option value="none">None</option>
              <option value="fadeIn">Fade In</option>
              <option value="popIn">Pop In</option>
              <option value="slideUp">Slide Up</option>
              <option value="flyIn">Fly In</option>
              <option value="typewriter">Typewriter</option>
            </select>
          </div>

          <div className={styles.fieldGroup}>
            <label htmlFor="animation-stagger-select" className={styles.fieldLabel}>
              Stagger
            </label>
            <select
              id="animation-stagger-select"
              className={styles.select}
              value={engineToUIStagger(
                s.animationIn?.granularity ?? uiToEngineStagger(defaultAnimStagger),
              )}
              onChange={(e) => {
                const stagger = e.target.value as LyricSettingsSectionProps['animationStagger'];
                if (isBaseTheme) {
                  onAnimationStaggerChange(stagger);
                  if (trackId && updateTrackProperty)
                    updateTrackProperty(
                      trackId,
                      'lyrics.animationStagger',
                      stagger,
                      activeKeyframeId,
                    );
                } else if (isSingleLaneMode) {
                  const exIn = s.animationIn ?? baseTheme.animationIn!;
                  const exOut = s.animationOut ?? baseTheme.animationOut!;
                  const gran = uiToEngineStagger(stagger);
                  // Batch both into one call — two sequential handleOverrideChange calls
                  // would overwrite each other (stale laneStyles read).
                  onLaneStyleChange(selectedLane, {
                    ...(laneStyles[selectedLane] ?? {}),
                    animationIn: { ...exIn, granularity: gran },
                    animationOut: { ...exOut, granularity: gran },
                  });
                  onAnimationStaggerChange(stagger);
                  if (trackId && updateTrackProperty)
                    updateTrackProperty(
                      trackId,
                      'lyrics.animationStagger',
                      stagger,
                      activeKeyframeId,
                    );
                } else {
                  const exIn = s.animationIn ?? baseTheme.animationIn!;
                  const exOut = s.animationOut ?? baseTheme.animationOut!;
                  const gran = uiToEngineStagger(stagger);
                  onLaneStyleChange(selectedLane, {
                    ...(laneStyles[selectedLane] ?? {}),
                    animationIn: { ...exIn, granularity: gran },
                    animationOut: { ...exOut, granularity: gran },
                  });
                }
              }}
            >
              <option value="letter">By Letter</option>
              <option value="word">By Word</option>
              <option value="line">By Line</option>
            </select>
          </div>

          <SliderField
            label="Fade In (s)"
            value={s.animationIn?.duration !== undefined ? s.animationIn.duration : defaultFadeIn}
            onChange={(v) => {
              if (isBaseTheme) {
                onFadeInDurationChange(v);
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.fadeInDuration', v, activeKeyframeId);
              } else if (isSingleLaneMode) {
                const ex = s.animationIn ?? baseTheme.animationIn!;
                handleOverrideChange('animationIn', { ...ex, duration: v });
                onFadeInDurationChange(v);
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.fadeInDuration', v, activeKeyframeId);
              } else {
                const ex = s.animationIn ?? baseTheme.animationIn!;
                handleOverrideChange('animationIn', { ...ex, duration: v });
              }
            }}
            min={0.1}
            max={5.0}
            step={0.1}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.fadeInDuration' : undefined}
          />

          <SliderField
            label="Fade Out (s)"
            value={
              s.animationOut?.duration !== undefined ? s.animationOut.duration : defaultFadeOut
            }
            onChange={(v) => {
              if (isBaseTheme) {
                onFadeOutDurationChange(v);
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.fadeOutDuration', v, activeKeyframeId);
              } else if (isSingleLaneMode) {
                const ex = s.animationOut ?? baseTheme.animationOut!;
                handleOverrideChange('animationOut', { ...ex, duration: v });
                onFadeOutDurationChange(v);
                if (trackId && updateTrackProperty)
                  updateTrackProperty(trackId, 'lyrics.fadeOutDuration', v, activeKeyframeId);
              } else {
                const ex = s.animationOut ?? baseTheme.animationOut!;
                handleOverrideChange('animationOut', { ...ex, duration: v });
              }
            }}
            min={0.1}
            max={5.0}
            step={0.1}
            currentTime={currentTime}
            property={isBaseDisplay ? 'lyrics.fadeOutDuration' : undefined}
          />
        </SubCollapsibleSection>
      )}

      {!isBaseDisplay && (
        <div
          className="flex gap-2 mt-2 pt-2"
          style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
        >
          {laneCount > 1 && (
            <button
              className={styles.lineStyleActionBtn}
              onClick={handleCopyToAllLanes}
              title="Copy this lane's style to all other lanes"
            >
              <Copy size={11} />
              <span>Copy to All</span>
            </button>
          )}
          {hasOverrides && (
            <button
              className={`${styles.lineStyleActionBtn} ${styles.lineStyleActionBtnDanger}`}
              onClick={handleClearAllOverrides}
              title="Reset all overrides for this lane"
            >
              <X size={11} />
              <span>Clear All</span>
            </button>
          )}
        </div>
      )}

      {isBaseDisplay && (!activeKeyframeId || activeKeyframeId === 'default') && (
        <ApplyToAllButton
          applied={lyricsApplied}
          onClick={onApplyLyricsToAll}
          label="Apply Lyric Settings to All Tracks"
          title="Apply these lyric settings to all tracks in playlist"
          className={styles.actionBtn}
        />
      )}
    </CollapsibleSection>
  );
}
