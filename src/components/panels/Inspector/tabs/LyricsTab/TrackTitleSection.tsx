import React from 'react';
import { Type, FolderSync, CheckCircle2 } from 'lucide-react';

import { CollapsibleSection } from '../../CollapsibleSection';
import { SliderField } from '@/components/effects/shared/SliderField';
import { ColorField } from '@/components/effects/shared/ColorField';
import { FONTS, DEFAULT_FONT_ID } from '@/constants/fonts';
import { DEFAULT_TRACK_TITLE_CONFIG } from '@/types/effects';
import { useKeyframeSelection } from '@/contexts';
import styles from '../../Inspector.module.css';
import type { EffectsConfig } from '@/types/effects';
import type { Track } from '@/contexts/types';
import type { Keyframe } from '@/types/keyframes';

interface TrackTitleSectionProps {
  effectsConfig: EffectsConfig | undefined;
  onEffectsConfigChange: (config: EffectsConfig) => void;
  tracks: Track[];
  titleApplied: boolean;
  onApplyTrackTitleToAll: () => void;
  forceOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
  keyframes?: Keyframe[];
  onKeyframesChange?: (keyframes: Keyframe[]) => void;
  currentTime?: number;
  trackId?: string;
  selectedKeyframeId?: string;
  updateTrackProperty?: (
    trackId: string,
    property: string,
    value: unknown,
    keyframeId?: string,
  ) => void;
}

export function TrackTitleSection({
  effectsConfig,
  onEffectsConfigChange,
  tracks,
  titleApplied,
  onApplyTrackTitleToAll,
  forceOpen,
  open,
  onToggle,
  keyframes = [],
  onKeyframesChange,
  currentTime = 0,
  trackId,
  selectedKeyframeId,
  updateTrackProperty,
}: TrackTitleSectionProps) {
  const { selectedKeyframeId: ctxKeyframeId } = useKeyframeSelection();

  if (!effectsConfig) return null;

  const activeKeyframeId = selectedKeyframeId || ctxKeyframeId;

  const sharedProps = {
    keyframes,
    onKeyframesChange,
    currentTime,
    targetType: 'attribute' as const,
    trackId,
    selectedKeyframeId: activeKeyframeId,
    updateTrackProperty,
  };

  return (
    <CollapsibleSection
      title="Track Title"
      icon={<Type size={14} />}
      defaultOpen={false}
      forceOpen={forceOpen}
      fitContent={true}
      open={open}
      onToggle={onToggle}
    >
      <div className={styles.fieldGroup} style={{ paddingTop: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className={styles.fieldLabel} style={{ marginBottom: 0 }}>
            Show Track Title
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={effectsConfig.trackTitle?.enabled ?? false}
            onClick={() => {
              const checked = !(effectsConfig.trackTitle?.enabled ?? false);
              onEffectsConfigChange?.({
                ...effectsConfig,
                trackTitle: {
                  ...DEFAULT_TRACK_TITLE_CONFIG,
                  ...(effectsConfig.trackTitle || {}),
                  enabled: checked,
                },
              });
              if (trackId && updateTrackProperty) {
                updateTrackProperty(
                  trackId,
                  'effects.trackTitle.enabled',
                  checked,
                  activeKeyframeId,
                );
              }
            }}
            className={`
              relative inline-flex h-5 w-10 items-center rounded-full transition-colors
              focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:ring-offset-2 focus:ring-offset-transparent
              ${effectsConfig.trackTitle?.enabled ? '' : 'bg-white/10'}
            `}
            style={
              effectsConfig.trackTitle?.enabled
                ? {
                    background: 'linear-gradient(to right, #991b1b, #ef4444)',
                    boxShadow: '0 0 10px rgba(239, 68, 68, 0.3)',
                  }
                : undefined
            }
          >
            <span
              className={`
                inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-md
                transition-transform duration-200
                ${effectsConfig.trackTitle?.enabled ? 'translate-x-5' : 'translate-x-1'}
              `}
            />
          </button>
        </div>
      </div>

      {effectsConfig.trackTitle?.enabled && (
        <>
          {/* Font Family */}
          <div className={styles.fieldGroup}>
            <label htmlFor="track-title-font-select" className={styles.fieldLabel}>
              Font Family
            </label>
            <select
              id="track-title-font-select"
              className={styles.select}
              value={effectsConfig.trackTitle.fontId ?? DEFAULT_FONT_ID}
              onChange={(e) => {
                const fontId = e.target.value;
                onEffectsConfigChange?.({
                  ...effectsConfig,
                  trackTitle: {
                    ...effectsConfig.trackTitle!,
                    fontId,
                  },
                });
                if (trackId && updateTrackProperty) {
                  updateTrackProperty(
                    trackId,
                    'effects.trackTitle.fontId',
                    fontId,
                    activeKeyframeId,
                  );
                }
              }}
            >
              {FONTS.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.name}
                </option>
              ))}
            </select>
          </div>

          {/* Font Size */}
          <SliderField
            label="Font Size"
            value={effectsConfig.trackTitle.fontSize || 0.4}
            onChange={(value) =>
              onEffectsConfigChange?.({
                ...effectsConfig,
                trackTitle: {
                  ...effectsConfig.trackTitle!,
                  fontSize: value,
                },
              })
            }
            min={0.1}
            max={1.5}
            step={0.05}
            {...sharedProps}
            property="effects.trackTitle.fontSize"
          />

          {/* Position X */}
          <SliderField
            label="Position X"
            value={effectsConfig.trackTitle.positionX || 50}
            onChange={(value) =>
              onEffectsConfigChange?.({
                ...effectsConfig,
                trackTitle: {
                  ...effectsConfig.trackTitle!,
                  positionX: value,
                },
              })
            }
            min={0}
            max={100}
            step={1}
            {...sharedProps}
            property="effects.trackTitle.positionX"
          />

          {/* Position Y */}
          <SliderField
            label="Position Y"
            value={effectsConfig.trackTitle.positionY || 10}
            onChange={(value) =>
              onEffectsConfigChange?.({
                ...effectsConfig,
                trackTitle: {
                  ...effectsConfig.trackTitle!,
                  positionY: value,
                },
              })
            }
            min={0}
            max={100}
            step={1}
            {...sharedProps}
            property="effects.trackTitle.positionY"
          />

          {/* Color */}
          <ColorField
            label="Title Color"
            value={effectsConfig.trackTitle.color || '#ef4444'}
            onChange={(color) =>
              onEffectsConfigChange?.({
                ...effectsConfig,
                trackTitle: {
                  ...effectsConfig.trackTitle!,
                  color,
                },
              })
            }
            {...sharedProps}
            property="effects.trackTitle.color"
          />

          {/* Duration */}
          <SliderField
            label="Duration"
            value={effectsConfig.trackTitle.duration || 3.0}
            onChange={(value) =>
              onEffectsConfigChange?.({
                ...effectsConfig,
                trackTitle: {
                  ...effectsConfig.trackTitle!,
                  duration: value,
                },
              })
            }
            min={0.5}
            max={10.0}
            step={0.5}
            {...sharedProps}
            property="trackTitle.duration"
          />

          {/* Apply to All Tracks */}
          {tracks.length > 1 && (!activeKeyframeId || activeKeyframeId === 'default') && (
            <button
              className={`${styles.actionBtn} ${titleApplied ? 'bg-green-600/20 text-green-400' : ''}`}
              onClick={onApplyTrackTitleToAll}
              style={{
                marginTop: 8,
                width: '100%',
                display: 'flex',
                justifyContent: 'center',
                gap: 6,
                padding: '6px 0',
                fontSize: '11px',
                borderRadius: 4,
                background: titleApplied ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.05)',
                color: titleApplied ? '#4ade80' : 'rgba(255,255,255,0.6)',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {titleApplied ? <CheckCircle2 size={12} /> : <FolderSync size={12} />}
              <span>{titleApplied ? 'Applied to All' : 'Apply to All Tracks'}</span>
            </button>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}
