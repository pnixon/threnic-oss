'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Image as ImageIcon, Type as TypeIcon, Lock as LockClosedIcon } from 'lucide-react';
import { useStore } from 'zustand';
import { EffectRow, AudioChannel } from './EffectRow';
import { effectUnavailableReason } from './effectAvailability';
import { systemStore, selectStagePipeline } from '@/stores/systemStore';
import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';
import {
  EFFECT_LABELS,
  POST_PROCESSING_EFFECT_TYPES,
  SCENE_EFFECT_TYPES,
  DEFAULT_GLSL_GUEST_CONFIG,
  type EffectType,
  type GLSLGuestConfig,
  type CustomShaderConfig,
} from '@/types/effects/effect-instances';
import { resolveLayerOrder, layerTokenKey, type LayerToken } from '@/types/effects/layer-order';
import { isPinnedSceneInstance, pinnedReasonForInstance } from '@/types/effects/layer-order';
import { createDefaultInstance } from '@/types/effects/effect-instance-factory';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  attachClosestEdge,
  extractClosestEdge,
  Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { Keyframe } from '@/types/keyframes';

// Schema-driven editor
import { GenericEffectEditor } from '@/components/effects/shared/GenericEffectEditor';
import { getEffectSchema } from '@/types/effects/effect-schemas';
import { getPresetById } from '@/engine/gpu/shaderPresets';
import { GameSceneAssetUploader } from './GameSceneAssetUploader';
import { GLSLSourceEditor } from './GLSLSourceEditor';
import { CustomShaderEditor } from './CustomShaderEditor';
import { EffectEditorProvider } from '@/components/effects/shared/EffectEditorContext';

interface DraggableEffectListProps {
  effectOrder?: string[];
  effectsConfig: EffectsConfig;
  onOrderChange?: (newOrder: string[]) => void;
  onToggleEffect?: (effectId: string, enabled: boolean) => void;
  onEffectsConfigChange: (newConfig: EffectsConfig) => void;
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
  forceShowSection?: Section;
  /**
   * Owning renderer's GPU device, resolved from the live WebGPURenderer. Passed
   * through to the CustomShaderEditor so its in-editor WGSL compile diagnostics
   * use the real device. Null on software renderers / SSR (editor then degrades
   * to persist-optimistically; the render pass is the compile guard).
   */
  device?: GPUDevice | null;
}

// Retained for prop compatibility with callers that still pass `forceShowSection`.
type Section = 'scene' | 'postProcessing';

// DnD identity for the unified layer stack. Every draggable row in the active
// stack (lyrics + each enabled effect) is addressed by its index in the
// resolved order; background is pinned and never a drag source/target.
const LAYER_SECTION = 'layer';

/** Get the audio band for display in the EffectRow badge */
function getInstanceAudioBand(instance: EffectInstance): AudioChannel {
  const cfg = instance.config as Record<string, unknown>;
  const arIntensity = cfg.audioReactiveIntensity as
    | { enabled?: boolean; band?: string }
    | undefined;
  if (arIntensity?.enabled && typeof arIntensity.band === 'string') {
    return arIntensity.band as AudioChannel;
  }
  return 'none';
}

/** Render the appropriate editor for an effect instance */
function InstanceEditor({
  instance,
  effectsConfig,
  onEffectsConfigChange,
  currentTime,
  device,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  trackId: _trackId,
  selectedKeyframeId,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateTrackProperty: _updateTrackProperty,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateTrackEffectInstance: _updateTrackEffectInstance,
}: {
  instance: EffectInstance;
  effectsConfig: EffectsConfig;
  onEffectsConfigChange: (c: EffectsConfig) => void;
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
  /** Owning renderer's GPU device for the CustomShaderEditor (null when absent). */
  device?: GPUDevice | null;
}) {
  const update = useCallback(
    (newConfig: Record<string, unknown>) => {
      // Always update the effectInstances array via onEffectsConfigChange.
      // This correctly flows through handleEffectsChange in AppContent, which
      // handles keyframe vs. base-state persistence.
      // Merge newConfig into existing config so that editors using Partial updates
      // (e.g. DistortionEditor, StarfieldEditor) don't obliterate sibling properties.
      const existingInstances = (effectsConfig.effectInstances || []).filter(
        (inst) => inst != null,
      );
      const present = existingInstances.some((inst) => inst.id === instance.id);

      // The per-instance config is a discriminated union; a dynamic partial
      // merge can't be expressed in that union's static shape, so build the
      // next instance array through a widened view and re-narrow on assignment.
      const mergeConfig = (base: EffectInstance): EffectInstance =>
        ({ ...base, config: { ...base.config, ...newConfig } }) as EffectInstance;

      const nextInstances: EffectInstance[] = present
        ? existingInstances.map((inst) => (inst.id === instance.id ? mergeConfig(inst) : inst))
        : // Synthetic "all effects" instance edited before it exists — add it.
          [...existingInstances, mergeConfig(instance)];

      onEffectsConfigChange({ ...effectsConfig, effectInstances: nextInstances });
    },
    [instance, effectsConfig, onEffectsConfigChange],
  );

  // Use instance-aware property prefix: fx.<instanceId>
  const propertyPrefix = useMemo(() => `fx.${instance.id}`, [instance.id]);

  const schema = useMemo(() => {
    const baseSchema = getEffectSchema(instance.type);
    if (!baseSchema) return undefined;

    // For shaderFx, dynamically inject the active preset's params after opacity
    if (instance.type === 'shaderFx') {
      const config = instance.config as { shader?: { presetId?: string } };
      const presetId = config?.shader?.presetId;
      const preset = presetId ? getPresetById(presetId) : undefined;

      if (preset?.params?.length) {
        const dynamicFields = preset.params.map((param) => ({
          type: 'slider' as const,
          property: `shader.${param.slot}`,
          label: param.label,
          min: param.min,
          max: param.max,
          step: param.step,
          default: param.default,
          showWhen: { field: 'mode', value: 'shader' },
          audioReactive: {
            path: `shader.ar${param.slot.charAt(0).toUpperCase()}${param.slot.slice(1)}`,
            label: `${param.label} AR`,
            min: param.min,
            max: param.max,
          },
        }));

        // Insert after the opacity slider (find its index)
        const fields = [...baseSchema.fields];
        const opacityIdx = fields.findIndex(
          (f) => 'property' in f && f.property === 'shader.opacity',
        );
        const insertAt = opacityIdx >= 0 ? opacityIdx + 1 : fields.length;
        fields.splice(insertAt, 0, ...dynamicFields);

        return { ...baseSchema, fields };
      }
    }

    return baseSchema;
  }, [instance.type, instance.config]);

  // customShader is a bespoke post-processing type with NO schema (its body is
  // multiline WGSL with live compile diagnostics, which the generic field
  // editor can't render). Dispatch it BEFORE the `!schema` gate below, wrapped
  // in the same layer selector + editor provider the schema-driven path uses.
  // It CAN target the lyric layer, so the Above/Below Lyrics toggle is shown.
  if (instance.type === 'customShader') {
    return (
      <EffectEditorProvider
        propertyPrefix={propertyPrefix}
        instanceId={instance.id}
        currentTime={currentTime || 0}
        targetKeyframeId={selectedKeyframeId}
      >
        <div
          className="mt-2 pt-2 border-t border-[var(--border-subtle)]"
          onClick={(e) => e.stopPropagation()}
        >
          <CustomShaderEditor
            config={instance.config as CustomShaderConfig}
            onChange={(cfg) => update(cfg as unknown as Record<string, unknown>)}
            // Live in-editor WGSL diagnostics use the owning renderer's GPU
            // device, threaded down from the Inspector. Null on software
            // renderers / SSR — the editor then persists optimistically and the
            // render pass is the ultimate compile guard.
            device={device ?? null}
          />
        </div>
      </EffectEditorProvider>
    );
  }

  if (!schema) return null;

  // Determine if game scene asset uploader should show
  const isLittlejsMode =
    instance.type === 'shaderFx' &&
    (instance.config as Record<string, unknown>)?.mode === 'littlejs';
  const gameSceneId = isLittlejsMode
    ? ((instance.config as { littlejs?: { sceneId?: string } })?.littlejs?.sceneId ?? 'rpgCombat')
    : null;

  // GLSL guest mode (Stage 3a): render the dedicated source editor + live preview.
  const isGlslMode =
    instance.type === 'shaderFx' && (instance.config as Record<string, unknown>)?.mode === 'glsl';
  const glslConfig = isGlslMode
    ? ((instance.config as { glsl?: GLSLGuestConfig })?.glsl ?? DEFAULT_GLSL_GUEST_CONFIG)
    : null;

  // Whether any Shader FX instance is enabled on this track. Background
  // transform effects (slide, rotate, zoom) don't affect shader-driven
  // backgrounds, so their schema note is shown only in that case.
  const shaderFxEnabled = (effectsConfig.effectInstances || []).some(
    (inst) => inst?.type === 'shaderFx' && (inst.config as { enabled?: boolean })?.enabled,
  );

  return (
    <EffectEditorProvider
      propertyPrefix={propertyPrefix}
      instanceId={instance.id}
      currentTime={currentTime || 0}
      targetKeyframeId={selectedKeyframeId}
    >
      <div
        className="mt-2 pt-2 border-t border-[var(--border-subtle)]"
        onClick={(e) => e.stopPropagation()}
      >
        <GenericEffectEditor
          schema={schema}
          config={instance.config as Record<string, unknown>}
          onChange={update}
          shaderFxEnabled={shaderFxEnabled}
        />
        {isLittlejsMode && gameSceneId && <GameSceneAssetUploader sceneId={gameSceneId} />}
        {isGlslMode && glslConfig && (
          <GLSLSourceEditor
            config={glslConfig}
            onChange={(glsl) => update({ glsl })}
            guestId={instance.id}
          />
        )}
      </div>
    </EffectEditorProvider>
  );
}

/**
 * A pinned pseudo-row for the `background` / `lyrics` layer tokens. These have
 * no enable toggle and no expandable editor body — they exist purely to occupy
 * a slot in the compositing order.
 *
 * `lyrics` IS draggable (the user can place it below a given effect so that
 * effect warps the lyrics). `background` is NOT draggable — it is permanently
 * pinned to the lowest layer, so it renders as a static, non-grabbable row.
 */
function PseudoLayerRow({
  token,
  index,
  label,
  icon,
  draggable: isDraggableRow,
  dragOverEdge,
  setDragOverInfo,
}: {
  token: LayerToken;
  index: number;
  label: string;
  icon: React.ReactNode;
  draggable: boolean;
  dragOverEdge: Edge | null;
  setDragOverInfo: (info: { index: number; edge: Edge | null; section: string } | null) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const key = layerTokenKey(token);

  useEffect(() => {
    const el = ref.current;
    if (!el || !isDraggableRow) return; // pinned rows (background) register no DnD
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({ id: key, index, section: LAYER_SECTION, type: 'layer' }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        getData: ({ input }) =>
          attachClosestEdge(
            { id: key, index, section: LAYER_SECTION, type: 'layer' },
            { element: el, input, allowedEdges: ['top', 'bottom'] },
          ),
        onDragEnter: ({ self }) =>
          setDragOverInfo({ index, edge: extractClosestEdge(self.data), section: LAYER_SECTION }),
        onDrag: ({ self }) =>
          setDragOverInfo({ index, edge: extractClosestEdge(self.data), section: LAYER_SECTION }),
        onDragLeave: () => setDragOverInfo(null),
        onDrop: () => setDragOverInfo(null),
      }),
    );
  }, [key, index, isDraggableRow, setDragOverInfo]);

  return (
    <div>
      {/* Top drop indicator */}
      <div
        className={`h-0.5 mx-2 mb-0.5 rounded-full transition-all duration-150 ${
          dragOverEdge === 'top'
            ? 'bg-gradient-to-r from-transparent via-red-500 to-transparent opacity-100'
            : 'opacity-0'
        }`}
      />
      <div
        ref={ref}
        className={`relative overflow-hidden rounded-xl transition-all duration-200 ${
          isDraggableRow ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
        } ${isDragging ? 'opacity-50 ring-2 ring-red-500/50' : 'opacity-100'}`}
      >
        <div
          className={`select-none relative overflow-hidden p-3 rounded-xl border backdrop-blur-md ${
            isDraggableRow
              ? 'bg-[var(--bg-hover)] border-[var(--border-hover)]'
              : 'bg-[var(--bg-panel)] border-[var(--border-subtle)]'
          }`}
        >
          <div className="relative z-10 flex items-center gap-3">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--bg-panel)] text-[var(--text-muted)] shrink-0">
              {icon}
            </span>
            <span className="flex-1 font-medium text-sm text-[var(--text-primary)] truncate">
              {label}
            </span>
            {!isDraggableRow && (
              <span
                className="shrink-0 inline-flex items-center justify-center text-[var(--text-muted)] cursor-help"
                title="The background is the base composite — every other layer renders on top of it. Its position is fixed by the renderer and cannot be dragged."
                aria-label="Pinned base layer. The background is the base composite; every other layer renders on top of it and its position is fixed by the renderer."
                role="img"
              >
                <LockClosedIcon size={13} />
              </span>
            )}
            <span className="text-[8px] uppercase tracking-widest text-[var(--text-muted)] px-1.5 py-0.5 rounded bg-[var(--bg-panel)] shrink-0">
              {isDraggableRow ? 'Layer' : 'Base'}
            </span>
          </div>
        </div>
      </div>
      {/* Bottom drop indicator */}
      <div
        className={`h-0.5 mx-2 mt-0.5 rounded-full transition-all duration-150 ${
          dragOverEdge === 'bottom'
            ? 'bg-gradient-to-r from-transparent via-red-500 to-transparent opacity-100'
            : 'opacity-0'
        }`}
      />
    </div>
  );
}

export function DraggableEffectList({
  effectsConfig,
  onEffectsConfigChange,
  keyframes,
  onKeyframesChange,
  currentTime,
  trackId,
  selectedKeyframeId,
  updateTrackProperty,
  updateTrackEffectInstance,
  device,
}: DraggableEffectListProps) {
  // Accordion state: at most one effect row is expanded at a time. `null`
  // means every row is collapsed. Modeling this as a single expanded id (rather
  // than an opt-out "collapsed" map) makes COLLAPSED the default for any row we
  // haven't tracked yet — so a freshly synthesized `fx-<type>` row, a newly
  // materialized real instance (whose id changes on toggle), and the very first
  // paint before any effect runs are all collapsed by construction.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [dragOverInfo, setDragOverInfo] = useState<{
    section: string;
    index: number;
    edge: Edge | null;
  } | null>(null);

  const instances = useMemo(
    () => (effectsConfig.effectInstances || []).filter((i) => i != null),
    [effectsConfig.effectInstances],
  );

  const instanceById = useMemo(() => {
    const m = new Map<string, EffectInstance>();
    for (const inst of instances) m.set(inst.id, inst);
    return m;
  }, [instances]);

  // The active layer stack, in compositing order (front-to-back). Contains one
  // background token, one lyrics token, and one token per ENABLED effect.
  const layerTokens = useMemo(
    () => resolveLayerOrder(instances, effectsConfig.layerOrder),
    [instances, effectsConfig.layerOrder],
  );

  // Discovery rows: one synthesized DISABLED instance per effect type that has
  // no ENABLED instance yet. Parked below the active stack, NOT draggable.
  const ALL_EFFECT_TYPES = useMemo(
    () => [...SCENE_EFFECT_TYPES, ...POST_PROCESSING_EFFECT_TYPES] as readonly string[],
    [],
  );

  const discoveryInstances = useMemo(() => {
    // Types that already have an enabled instance are hidden from discovery
    // (they're already in the stack above).
    const enabledTypes = new Set<string>();
    for (const inst of instances) {
      if ((inst.config as { enabled?: boolean })?.enabled) enabledTypes.add(inst.type);
    }
    const rows: EffectInstance[] = [];
    for (const type of ALL_EFFECT_TYPES) {
      if (enabledTypes.has(type)) continue;
      // Prefer an existing (disabled) instance of this type so toggling it on
      // preserves the user's saved config; otherwise synthesize a default.
      const existing = instances.find((i) => i.type === type);
      if (existing) {
        rows.push(existing);
      } else {
        const def = createDefaultInstance(type as EffectType);
        rows.push({
          ...def,
          id: `fx-${type}`,
          config: { ...def.config, enabled: false },
        } as EffectInstance);
      }
    }
    rows.sort((a, b) =>
      (EFFECT_LABELS[a.type] ?? a.type).localeCompare(EFFECT_LABELS[b.type] ?? b.type),
    );
    return rows;
  }, [instances, ALL_EFFECT_TYPES]);

  // All rows currently displayed anywhere (active stack effects + discovery),
  // used to collapse a dangling expandedId if its row disappears.
  const displayedEffectIds = useMemo(() => {
    const ids = layerTokens
      .filter((t): t is Extract<LayerToken, { kind: 'effect' }> => t.kind === 'effect')
      .map((t) => t.id);
    for (const d of discoveryInstances) ids.push(d.id);
    return ids;
  }, [layerTokens, discoveryInstances]);

  useEffect(() => {
    if (expandedId && !displayedEffectIds.includes(expandedId)) {
      setExpandedId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedEffectIds.join('|')]);

  // Monitor drops within the active layer stack and reorder LAYER TOKENS.
  // Background is pinned to the lowest layer (index 0) and never moves.
  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const destination = location.current.dropTargets[0];
        if (!destination) return;

        const sourceData = source.data as { id: string; index: number; section: string };
        const destinationData = destination.data as {
          id: string;
          index: number;
          section: string;
        };

        if (sourceData.section !== LAYER_SECTION || destinationData.section !== LAYER_SECTION) {
          return;
        }

        const sourceIndex = sourceData.index;
        if (sourceIndex === destinationData.index) {
          setDragOverInfo(null);
          return;
        }

        const edge = extractClosestEdge(destination.data);
        const next = Array.from(layerTokens);
        if (sourceIndex < 0 || sourceIndex >= next.length) return;

        const isPinnedToken = (t: LayerToken): boolean => {
          if (t.kind === 'background') return true;
          if (t.kind !== 'effect') return false;
          const inst = instanceById.get(t.id);
          return inst ? isPinnedSceneInstance(inst) : false;
        };

        // Pinned rows (background + butterchurn + non-shader-mode shaderFx scene
        // sources) are never drag sources — the pipeline forces their order.
        if (isPinnedToken(next[sourceIndex])) {
          setDragOverInfo(null);
          return;
        }
        const [moved] = next.splice(sourceIndex, 1);
        if (!moved) return;

        let insertAt = destinationData.index;
        if (sourceIndex < destinationData.index) insertAt -= 1;
        if (edge === 'bottom') insertAt += 1;
        insertAt = Math.max(0, Math.min(insertAt, next.length));
        // Never allow anything to land at or below the fixed bottom group
        // (background followed by any butterchurn/shaderFx scene tokens). Find
        // the last pinned token and force insertion strictly above it.
        let lastPinned = -1;
        for (let i = 0; i < next.length; i++) {
          if (isPinnedToken(next[i])) lastPinned = i;
        }
        insertAt = Math.max(insertAt, lastPinned + 1);
        next.splice(insertAt, 0, moved);

        onEffectsConfigChange({ ...effectsConfig, layerOrder: next });
        setDragOverInfo(null);
      },
    });
  }, [layerTokens, effectsConfig, onEffectsConfigChange, instanceById]);

  /** Get which effect instance IDs / types have keyframes in the current track */
  const scheduledTypes = useMemo(() => {
    const types = new Set<string>();
    if (!keyframes) return types;
    keyframes.forEach((kf) => {
      if (kf.time === 0) return;
      Object.keys(kf.properties).forEach((prop) => {
        if (prop.startsWith('fx.')) {
          const instanceId = prop.split('.')[1];
          if (instanceId) types.add(instanceId);
        } else if (prop.startsWith('effects.')) {
          const parts = prop.split('.');
          if (parts[1] === 'postProcessing') types.add(parts[2]);
          else types.add(parts[1]);
        }
      });
    });
    return types;
  }, [keyframes]);

  /**
   * Toggle an effect's enabled state. Newly-materialized effects default to the
   * background bucket (target 'background'); scene sources are background-only
   * regardless. Order/target live on the instances, so no layerOrder is written.
   */
  const toggleEffect = (id: string, enabled: boolean) => {
    const inst = instanceById.get(id);

    // Synthetic discovery row (id `fx-<type>`) with no real instance yet —
    // materialize it so toggling on creates a real instance.
    if (!inst && id.startsWith('fx-')) {
      const type = id.slice(3);
      const def = createDefaultInstance(type as EffectType);
      const created = {
        ...def,
        id: `${type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        config: { ...def.config, enabled },
      } as EffectInstance;
      const nextInstances = [...instances, created];

      const isKeyframeMode = selectedKeyframeId && selectedKeyframeId !== 'default';
      if (isKeyframeMode && trackId && updateTrackProperty) {
        // Persist the instance first (base state), then keyframe the toggle.
        onEffectsConfigChange({
          ...effectsConfig,
          effectInstances: nextInstances,
          layerOrder: resolveLayerOrder(nextInstances, effectsConfig.layerOrder),
        } as EffectsConfig);
        updateTrackProperty(trackId, `fx.${created.id}.enabled`, enabled, selectedKeyframeId);
        return;
      }

      onEffectsConfigChange({
        ...effectsConfig,
        effectInstances: nextInstances,
        layerOrder: resolveLayerOrder(nextInstances, effectsConfig.layerOrder),
      } as EffectsConfig);
      return;
    }

    if (!inst) return;

    const isKeyframeMode = selectedKeyframeId && selectedKeyframeId !== 'default';
    if (isKeyframeMode && trackId && updateTrackProperty) {
      updateTrackProperty(trackId, `fx.${inst.id}.enabled`, enabled, selectedKeyframeId);
      return;
    }

    const staticInstances = instances.filter((i) => i != null && !i.id.startsWith('dynamic-'));
    const nextInstances = staticInstances.map((item) =>
      item.id === id ? { ...item, config: { ...item.config, enabled } } : item,
    ) as EffectInstance[];
    onEffectsConfigChange({
      ...effectsConfig,
      effectInstances: nextInstances,
      layerOrder: resolveLayerOrder(nextInstances, effectsConfig.layerOrder),
    } as EffectsConfig);
  };

  /** Single-open accordion: opening one collapses the rest. */
  const onToggleExpand = (instanceId: string) => {
    setExpandedId((prev) => (prev === instanceId ? null : instanceId));
  };

  const shaderFxEnabled = useMemo(
    () =>
      instances.some(
        (inst) => inst?.type === 'shaderFx' && (inst.config as { enabled?: boolean })?.enabled,
      ),
    [instances],
  );

  // On the fallback stage (no WebGPU) most effects can't render — mark those
  // rows unavailable instead of letting the toggle silently do nothing.
  const stagePipeline = useStore(systemStore, selectStagePipeline);

  const dragEdgeFor = (index: number): Edge | null =>
    dragOverInfo?.section === LAYER_SECTION && dragOverInfo?.index === index
      ? dragOverInfo.edge
      : null;

  /** Render a single effect token as a draggable EffectRow in the layer stack. */
  const renderEffectRow = (instance: EffectInstance, index: number) => {
    const audioBand = getInstanceAudioBand(instance);
    let displayName = EFFECT_LABELS[instance.type] ?? instance.type;
    if (instance.type === 'particles') {
      const style = (instance.config as { style?: string }).style;
      displayName = style === 'snow' ? 'Snow Particles' : 'Dust Particles';
    }
    const isExpanded = expandedId === instance.id;
    const isScheduled = scheduledTypes.has(instance.id) || scheduledTypes.has(instance.type);
    const isEnabled = ((instance.config as Record<string, unknown>).enabled as boolean) ?? true;
    // Every shaderFx instance (WGSL shader, GLSL guest, butterchurn, littlejs)
    // and butterchurn-type composite at the fixed background boundary in the
    // renderer, below all post-processing passes. The renderer does NOT honor a
    // dragged position for them, so they are pinned (non-draggable) and carry a
    // symbol + tooltip explaining why they break the draggable contract.
    const isPinnedScene = isPinnedSceneInstance(instance);
    const pinnedReason = isPinnedScene ? pinnedReasonForInstance(instance) : null;

    const schema = getEffectSchema(instance.type);
    const warningNote =
      schema?.note && (!schema.note.onlyWhenShaderFxEnabled || shaderFxEnabled)
        ? schema.note.text
        : undefined;

    return (
      <div key={instance.id} style={{ position: 'relative' }}>
        <EffectRow
          id={instance.id}
          index={index}
          name={displayName}
          isEnabled={isEnabled}
          selectedChannel={audioBand}
          onToggle={(val) => toggleEffect(instance.id, val)}
          onSettingsClick={() => onToggleExpand(instance.id)}
          isDraggable={!isPinnedScene}
          pinnedReason={pinnedReason}
          expanded={isExpanded}
          warningNote={warningNote}
          unavailableReason={effectUnavailableReason(instance.type, stagePipeline)}
          section={LAYER_SECTION}
          dragOverEdge={isPinnedScene ? null : dragEdgeFor(index)}
          setDragOverInfo={(info) => setDragOverInfo(info)}
          isScheduled={isScheduled}
        >
          {isExpanded && (
            <InstanceEditor
              instance={instance}
              effectsConfig={effectsConfig}
              onEffectsConfigChange={onEffectsConfigChange}
              keyframes={keyframes}
              onKeyframesChange={onKeyframesChange}
              currentTime={currentTime}
              trackId={trackId}
              selectedKeyframeId={selectedKeyframeId}
              updateTrackProperty={updateTrackProperty}
              updateTrackEffectInstance={updateTrackEffectInstance}
              device={device}
            />
          )}
        </EffectRow>
      </div>
    );
  };

  /** Render a discovery (disabled/unused) effect row — toggle only, no drag. */
  const renderDiscoveryRow = (instance: EffectInstance) => {
    const audioBand = getInstanceAudioBand(instance);
    let displayName = EFFECT_LABELS[instance.type] ?? instance.type;
    if (instance.type === 'particles') {
      const style = (instance.config as { style?: string }).style;
      displayName = style === 'snow' ? 'Snow Particles' : 'Dust Particles';
    }
    const isExpanded = expandedId === instance.id;
    const schema = getEffectSchema(instance.type);
    const warningNote =
      schema?.note && (!schema.note.onlyWhenShaderFxEnabled || shaderFxEnabled)
        ? schema.note.text
        : undefined;

    return (
      <div key={instance.id} style={{ position: 'relative' }}>
        <EffectRow
          id={instance.id}
          name={displayName}
          isEnabled={false}
          selectedChannel={audioBand}
          onToggle={(val) => toggleEffect(instance.id, val)}
          onSettingsClick={() => onToggleExpand(instance.id)}
          isDraggable={false}
          expanded={isExpanded}
          warningNote={warningNote}
          unavailableReason={effectUnavailableReason(instance.type, stagePipeline)}
        >
          {isExpanded && (
            <InstanceEditor
              instance={instance}
              effectsConfig={effectsConfig}
              onEffectsConfigChange={onEffectsConfigChange}
              keyframes={keyframes}
              onKeyframesChange={onKeyframesChange}
              currentTime={currentTime}
              trackId={trackId}
              selectedKeyframeId={selectedKeyframeId}
              updateTrackProperty={updateTrackProperty}
              updateTrackEffectInstance={updateTrackEffectInstance}
              device={device}
            />
          )}
        </EffectRow>
      </div>
    );
  };

  return (
    <div className="w-full">
      {/* Single flat layer stack — background (pinned lowest), lyrics, and
          enabled effects in compositing order. List position = layer;
          top = front. */}
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest font-semibold">
          Layers
        </span>
        <span className="text-[9px] text-[var(--text-muted)] opacity-50 italic">
          drag to reorder · top = front
        </span>
      </div>

      <div className="space-y-1.5">
        {layerTokens.map((token, index) => {
          if (token.kind === 'background') {
            return (
              <PseudoLayerRow
                key={layerTokenKey(token)}
                token={token}
                index={index}
                label="Background"
                icon={<ImageIcon size={14} />}
                draggable={false}
                dragOverEdge={dragEdgeFor(index)}
                setDragOverInfo={setDragOverInfo}
              />
            );
          }
          if (token.kind === 'lyrics') {
            return (
              <PseudoLayerRow
                key={layerTokenKey(token)}
                token={token}
                index={index}
                label="Lyrics"
                icon={<TypeIcon size={14} />}
                draggable={true}
                dragOverEdge={dragEdgeFor(index)}
                setDragOverInfo={setDragOverInfo}
              />
            );
          }
          const inst = instanceById.get((token as { id: string }).id);
          if (!inst) return null;
          return renderEffectRow(inst, index);
        })}
      </div>

      {/* Separator + discovery group */}
      {discoveryInstances.length > 0 && (
        <>
          <div className="h-px bg-gradient-to-r from-transparent via-[var(--border-subtle)] to-transparent my-3" />
          <div className="mb-2 px-1">
            <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest font-semibold">
              Add Effects
            </span>
            <p className="text-[9px] text-[var(--text-muted)] opacity-60 mt-0.5">
              Enable an effect to add it as a layer (inserted just below Lyrics).
            </p>
          </div>
          <div className="space-y-1.5">{discoveryInstances.map(renderDiscoveryRow)}</div>
        </>
      )}
    </div>
  );
}
