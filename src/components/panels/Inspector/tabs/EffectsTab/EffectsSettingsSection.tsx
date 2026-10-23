'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Wand2, Download, Upload } from 'lucide-react';
import { CollapsibleSection } from '../../CollapsibleSection';
import { DraggableEffectList } from './DraggableEffectList';
import { ApplyToAllButton } from '../../../shared';
import { useKeyframeSelection } from '@/contexts';
import type { Keyframe } from '@/types/keyframes';
import styles from '../../Inspector.module.css';
import type { EffectsConfig } from '@/types/effects';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import type { GPUCanvasRef } from '@/components/stage/GPUCanvas';
import { serializeLook, applyLook } from '@/lib/looks/serialize';
import { projectStore } from '@/stores/projectStore';

interface EffectsSettingsSectionProps {
  effectsConfig: EffectsConfig | undefined;
  onEffectsConfigChange: (config: EffectsConfig) => void;
  effectsApplied: boolean;
  onApplyEffectsToAll: () => void;
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
  updateTrackEffectInstance?: (
    trackId: string,
    instanceId: string,
    config: unknown,
    keyframeId?: string,
  ) => void;
  /** Live renderer ref, used to resolve the GPU device for the custom-shader editor. */
  centerStageRef?: React.RefObject<GPUCanvasRef | null>;
}

export function EffectsSettingsSection({
  effectsConfig,
  onEffectsConfigChange,
  effectsApplied,
  onApplyEffectsToAll,
  forceOpen,
  open,
  onToggle,
  keyframes = [],
  onKeyframesChange,
  currentTime = 0,
  trackId,
  selectedKeyframeId,
  updateTrackProperty,
  updateTrackEffectInstance,
  centerStageRef,
}: EffectsSettingsSectionProps) {
  const { selectedKeyframeId: ctxKeyframeId } = useKeyframeSelection();
  const activeKeyframeId = selectedKeyframeId || ctxKeyframeId;

  // Resolve the owning renderer's GPU device (null on software renderers / SSR)
  // so the custom-shader editor can run live WGSL compile diagnostics.
  const device = centerStageRef?.current?.getRenderer?.()?.getDevice?.() ?? null;

  // ── Look template export / import ────────────────────────────────
  const lookInputRef = useRef<HTMLInputElement>(null);
  const [lookBusy, setLookBusy] = useState<null | 'export' | 'import'>(null);
  const [lookMsg, setLookMsg] = useState<string | null>(null);

  const handleExportLook = useCallback(async () => {
    if (!trackId) return;
    const track = projectStore.getState().tracks.find((t) => t.id === trackId);
    if (!track) return;
    setLookBusy('export');
    setLookMsg(null);
    try {
      const { look, warnings } = await serializeLook(track, track.name || 'Look');
      const json = JSON.stringify(look, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = (look.name || 'look').replace(/[^\w.-]+/g, '-').toLowerCase();
      a.download = `${safe}.threnic-look`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLookMsg(
        warnings.length ? `Exported (${warnings.length} asset warning(s))` : 'Look exported',
      );
    } catch (err) {
      console.error('[Looks] export failed:', err);
      setLookMsg('Export failed — see console');
    } finally {
      setLookBusy(null);
      setTimeout(() => setLookMsg(null), 4000);
    }
  }, [trackId]);

  const handleImportLookFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !trackId) return;
      setLookBusy('import');
      setLookMsg(null);
      try {
        const raw = JSON.parse(await file.text());
        const result = await applyLook(raw, trackId);
        if (result.ok) {
          setLookMsg(
            result.warnings.length
              ? `Applied (${result.warnings.length} warning(s))`
              : 'Look applied',
          );
        } else {
          setLookMsg(`Import rejected: ${result.reason}`);
        }
      } catch (err) {
        console.error('[Looks] import failed:', err);
        setLookMsg('Import failed — not a valid .threnic-look file');
      } finally {
        setLookBusy(null);
        setTimeout(() => setLookMsg(null), 4000);
      }
    },
    [trackId],
  );

  const handleToggleEffect = (effectId: string, enabled: boolean) => {
    if (!effectsConfig) return;

    // Update the effect's enabled state in the config
    const effectConfig = (effectsConfig as unknown as Record<string, unknown>)[effectId];
    if (effectConfig && typeof effectConfig === 'object') {
      const updatedConfig = {
        ...effectsConfig,
        [effectId]: {
          ...effectConfig,
          enabled,
        },
      };
      onEffectsConfigChange(updatedConfig);

      // Direct commit for toggle
      if (trackId && updateTrackProperty) {
        const propPath = `effects.${effectId}.enabled`;
        updateTrackProperty(trackId, propPath, enabled, activeKeyframeId);
      }
    }
  };

  return (
    <CollapsibleSection
      title="Effects"
      icon={<Wand2 size={14} />}
      defaultOpen={true}
      maxHeight={500}
      forceOpen={forceOpen}
      open={open}
      onToggle={onToggle}
    >
      <div className="px-2 py-1">
        <div className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
          Effects (3D & 2D)
        </div>
        <DraggableEffectList
          effectOrder={[]}
          effectsConfig={effectsConfig || DEFAULT_EFFECTS_CONFIG}
          onEffectsConfigChange={(newConfig) => onEffectsConfigChange?.(newConfig)}
          onOrderChange={() => {}}
          onToggleEffect={handleToggleEffect}
          keyframes={keyframes}
          onKeyframesChange={onKeyframesChange}
          currentTime={currentTime}
          trackId={trackId}
          selectedKeyframeId={activeKeyframeId || undefined}
          updateTrackProperty={updateTrackProperty}
          updateTrackEffectInstance={updateTrackEffectInstance}
          device={device}
        />
      </div>

      {/* ── Look templates: export / import the whole visual identity ── */}
      <div style={{ padding: '0 8px 4px 8px', marginTop: 12 }}>
        <div className="text-[10px] font-semibold text-gray-500 mb-1.5 uppercase tracking-wider">
          Look Template
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={styles.actionBtn}
            style={{ flex: 1 }}
            disabled={!trackId || lookBusy !== null}
            onClick={handleExportLook}
            title="Save this track's effects, layers, theme and packed assets as a portable .threnic-look file"
          >
            <Download size={13} />
            <span>{lookBusy === 'export' ? 'Exporting…' : 'Export Look'}</span>
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            style={{ flex: 1 }}
            disabled={!trackId || lookBusy !== null}
            onClick={() => lookInputRef.current?.click()}
            title="Apply a .threnic-look file to this track (imports through the standard preset-look path)"
          >
            <Upload size={13} />
            <span>{lookBusy === 'import' ? 'Importing…' : 'Import Look'}</span>
          </button>
        </div>
        {lookMsg && (
          <div className="text-[10px] text-[var(--text-muted)] mt-1.5" role="status">
            {lookMsg}
          </div>
        )}
        <input
          ref={lookInputRef}
          type="file"
          accept=".threnic-look,.json,application/json"
          onChange={handleImportLookFile}
          style={{ display: 'none' }}
        />
      </div>

      {(!activeKeyframeId || activeKeyframeId === 'default') && (
        <div style={{ padding: '0 8px 8px 8px', marginTop: 12 }}>
          <ApplyToAllButton
            applied={effectsApplied}
            onClick={onApplyEffectsToAll}
            label="Apply Effects to All Tracks"
            title="Apply these effect settings to all tracks in playlist"
            className={styles.actionBtn}
          />
        </div>
      )}
    </CollapsibleSection>
  );
}
