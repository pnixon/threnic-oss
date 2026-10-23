'use client';

import React from 'react';
import { NodeEffectComposer } from '@/components/effects/shared/NodeEffectComposer';
import { useScheduleAwareEffectsConfig } from '../hooks/useScheduleAware';
import { EffectErrorBoundary } from '@/components/effects/shared/EffectErrorBoundary';
import { getEffectComponent, isRegisteredEffect } from '@/constants/effects-registry';
import {
  isPostProcessingEffect as isPostProcessing,
  isSceneEffect as isScene,
  isBackgroundTransformEffect,
} from '@/constants/effects';
import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';

// Particles, Starfield, and Rain are now processed fully in WebGPU (SceneEffectPasses.ts)

interface ScheduleAwareEffectsProps {
  defaultConfig?: EffectsConfig;
  currentTrackId?: string;
}

/**
 * Render a single EffectInstance inside the NodeEffectComposer.
 *
 * Uses the effect registry for type-safe component lookup.
 * Scene effects (particles, rain, etc.) are rendered outside the composer.
 * Background transform effects (zoom, slide, rotate) are handled by ScheduleAwareBackground.
 */
function renderInstanceInComposer(instance: EffectInstance): React.ReactElement | null {
  const key = instance.id;

  // Skip scene effects - they're rendered outside the composer
  if (isScene(instance.type)) {
    return null;
  }

  // Skip background transform effects - they're handled at the texture level
  if (isBackgroundTransformEffect(instance.type)) {
    return null;
  }

  // Handle post-processing effects via registry
  if (isPostProcessing(instance.type) && isRegisteredEffect(instance.type)) {
    const EffectComponent = getEffectComponent(instance.type);
    if (!EffectComponent) return null;
    return (
      <EffectErrorBoundary key={key} effectName={instance.type}>
        <EffectComponent enabled={instance.config.enabled} config={instance.config as never} />
      </EffectErrorBoundary>
    );
  }

  // Unknown effect type
  console.warn(`Unknown effect type: ${instance.type}`);
  return null;
}

export function ScheduleAwareEffects({
  defaultConfig,
  currentTrackId,
}: ScheduleAwareEffectsProps): React.ReactElement {
  const effectiveConfig = useScheduleAwareEffectsConfig(defaultConfig);

  const instances: EffectInstance[] = effectiveConfig?.effectInstances ?? [];

  // Scene effects rendered outside the composer
  // NOTE: All scene effects (particles, starfield, visualizer, rain)
  // are now GPU-native (WGSL passes) and processed by the RenderGraph
  // via EffectsManager.

  // Post-processing instances (inside composer)
  const composerInstances = instances.filter((i) => isPostProcessing(i.type));

  return (
    <group key={currentTrackId || 'none'}>
      {/* NodeEffectComposer: WebGPU-compatible post-processing via TSL */}
      <NodeEffectComposer>
        {composerInstances
          .filter((inst) => inst.config.enabled)
          .map(renderInstanceInComposer)
          .filter((el): el is React.ReactElement => el !== null)}
      </NodeEffectComposer>
    </group>
  );
}
