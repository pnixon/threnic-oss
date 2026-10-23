'use client';

import React, { useRef, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { RenderEngine, RenderEngineRef } from '@/engine/RenderEngine';
import { CameraAspectUpdater } from './components/CameraAspectUpdater';
import { ScheduleAwareBackground } from './components/ScheduleAwareBackground';
import { ScheduleAwareEffects } from './components/ScheduleAwareEffects';
import { useScheduleAwareEffectsConfig } from './hooks/useScheduleAware';
import { useFrame, useThree } from '@react-three/fiber';

import type { EffectsConfig } from '@/types/effects';
import { keyframeStore } from '@/engine/stores/keyframeStore';

interface CenterStageProps {
  isPlaying: boolean;
  backgroundImage?: string | null;
  effectsConfig?: EffectsConfig;
  isExporting?: boolean;
  currentTrackId?: string;
}

interface CenterStageRef {
  getRenderEngine: () => RenderEngineRef | null;
}

function BackdropColorController({ defaultConfig }: { defaultConfig?: EffectsConfig }): null {
  const { scene } = useThree();
  const effectiveConfig = useScheduleAwareEffectsConfig(defaultConfig);
  const lastColorRef = useRef<string | null>(null);

  useFrame(() => {
    let bgColor = keyframeStore.getState().scene.backgroundColor;
    if (!bgColor) {
      bgColor =
        effectiveConfig?.backgroundColor ||
        effectiveConfig?.visualizer?.backgroundColor ||
        '#000000';
    }

    if (lastColorRef.current !== bgColor) {
      lastColorRef.current = bgColor;
      scene.background = new THREE.Color(bgColor);
    }
  });

  return null;
}

export const CenterStage = React.memo(
  forwardRef<CenterStageRef, CenterStageProps>(function CenterStage(
    { isPlaying, backgroundImage, effectsConfig, isExporting = false, currentTrackId },
    ref,
  ) {
    const renderEngineRef = useRef<RenderEngineRef>(null);

    // DEBUG — log what props CenterStage receives (removed for performance)

    useImperativeHandle(
      ref,
      function (): CenterStageRef {
        return {
          getRenderEngine: function (): RenderEngineRef | null {
            return renderEngineRef.current;
          },
        };
      },
      [],
    );

    return (
      <RenderEngine ref={renderEngineRef} backgroundColor="transparent">
        <CameraAspectUpdater />
        <BackdropColorController defaultConfig={effectsConfig} />
        <ScheduleAwareBackground
          defaultUrl={backgroundImage}
          effectsConfig={effectsConfig}
          isPlaying={isPlaying || isExporting}
          currentTrackId={currentTrackId}
        />
        <ScheduleAwareEffects defaultConfig={effectsConfig} currentTrackId={currentTrackId} />
      </RenderEngine>
    );
  }),
);

CenterStage.displayName = 'CenterStage';
