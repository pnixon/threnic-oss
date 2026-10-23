'use client';

import React, { useRef, useCallback, forwardRef, useImperativeHandle, useEffect } from 'react';
import { Canvas, useFrame, useThree, RootState } from '@react-three/fiber';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { timeStore } from '@/engine/stores/timeStore';
import { audioStore } from '@/engine/stores/audioStore';
import { runFrameUpdates } from './EngineLoop';

// Global renderer instance counter for debugging context issues during HMR
type RendererCountWindow = Window & { __threeRendererCount?: number };

let rendererInstanceCount = 0;
if (typeof window !== 'undefined') {
  (window as RendererCountWindow).__threeRendererCount = rendererInstanceCount;
}

interface RenderEngineProps {
  children: React.ReactNode;
  width?: number;
  height?: number;
  orthographic?: boolean;
  cameraPosition?: [number, number, number];
  backgroundColor?: string;
  onFrameRendered?: () => void;
}

interface Composer {
  setSize: (w: number, h: number) => void;
  render?: (delta?: number) => void;
}

export interface RenderEngineRef {
  getRenderer: () => RootState['gl'] | null; // WebGPURenderer
  getScene: () => THREE.Scene | null;
  getCamera: () => THREE.Camera | null;
  getComposer: () => Composer | null;
  setComposer: (composer: Composer) => void;
  renderFrame: () => void;
  set: (props: Partial<RootState>) => void;
  advance: (timestamp: number, runGlobalEffects?: boolean) => void;
  getSize: () => { width: number; height: number };
  getState: () => RootState;
}

interface SceneAccessWrapperProps {
  onMount: (ref: RenderEngineRef) => void;
}

function TimeController({ onFrameRendered }: { onFrameRendered?: () => void }): null {
  const lastAudioTimeRef = useRef(0);
  const driftRef = useRef(0);

  useFrame(function (_state, delta): void {
    if (timeStore.getState().mode === 'preview') {
      // 1. Process Keyframe/Engine updates BEFORE anything else in the frame
      runFrameUpdates();

      // Handle external seeks
      if (timeStore.getState().lastSeekTime !== -1) {
        lastAudioTimeRef.current = timeStore.getState().lastSeekTime;
        timeStore.setState({ lastSeekTime: -1 });
        driftRef.current = 0;
      }

      if (timeStore.getState().isPlaying) {
        const sourceEl = audioStore.getState().sourceElement;
        if (sourceEl) {
          const audioTime = sourceEl.currentTime;

          // If audio time jumped (seek), reset our smoothed time
          if (Math.abs(audioTime - lastAudioTimeRef.current) > 0.3) {
            timeStore.getState().setCurrentTime(audioTime);
            driftRef.current = 0;
          } else {
            // Otherwise, increment current time by delta for smoothness
            // but stay within a small window of the actual audio time to avoid long-term drift
            const nextTime = timeStore.getState().currentTime + delta;
            const maxDrift = 0.05; // 50ms max drift

            if (Math.abs(nextTime - audioTime) < maxDrift) {
              timeStore.getState().setCurrentTime(nextTime);
            } else {
              // Snapping or slow correction
              timeStore.getState().setCurrentTime(audioTime);
            }
          }
          lastAudioTimeRef.current = audioTime;
        } else {
          // No audio element, just pure delta
          timeStore.getState().setCurrentTime(timeStore.getState().currentTime + delta);
        }
      }
    }

    onFrameRendered?.();
  });

  return null;
}

/**
 * Custom hook to monitor and configure the WebGPU renderer for stability
 */
function useWebGPUInstrumentation(gl: RootState['gl']) {
  useEffect(() => {
    // Track renderer instances for debugging
    rendererInstanceCount++;
    if (typeof window !== 'undefined') {
      (window as RendererCountWindow).__threeRendererCount = rendererInstanceCount;
    }

    // WebGPU renderer configuration
    if (gl.setPixelRatio) gl.setPixelRatio(1);
    gl.outputColorSpace = THREE.SRGBColorSpace;

    // Add context loss/restore handlers if applicable (WebGPU has device.lost)
    // For now, we rely on Three.js internal handling of WebGPU device loss

    return () => {
      rendererInstanceCount = Math.max(0, rendererInstanceCount - 1);
      if (typeof window !== 'undefined') {
        (window as RendererCountWindow).__threeRendererCount = rendererInstanceCount;
      }
    };
  }, [gl]);
}

// Using a wrapper component to avoid forwardRef typing issues
function SceneAccessWrapper({ onMount }: SceneAccessWrapperProps): null {
  const state = useThree();
  const { gl, scene, camera, set, advance, size } = state;
  const composerRef = React.useRef<Composer | null>(null);

  useWebGPUInstrumentation(gl);

  React.useEffect(
    function (): () => void {
      const refObject: RenderEngineRef = {
        getRenderer: function (): RootState['gl'] {
          return gl;
        },
        getScene: function (): THREE.Scene {
          return scene;
        },
        getCamera: function (): THREE.Camera {
          return camera;
        },
        getComposer: function (): Composer | null {
          return composerRef.current;
        },
        setComposer: function (composer: Composer): void {
          composerRef.current = composer;
        },
        renderFrame: function (): void {
          if (composerRef.current?.render) {
            composerRef.current.render();
          } else {
            // Use renderAsync for WebGPU
            const asyncGl = gl as unknown as {
              renderAsync?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<void>;
            };
            if (asyncGl.renderAsync) {
              asyncGl.renderAsync(scene, camera);
            } else {
              gl.render(scene, camera);
            }
          }
        },
        set,
        advance,
        getSize: () => ({ width: size.width, height: size.height }),
        getState: () => state,
      };
      onMount(refObject);

      // Cleanup function to dispose resources
      return function (): void {
        // Composer cleanup is handled by ScheduleAwareEffects
        // Scene and renderer are managed by Canvas and cleaned up automatically
        composerRef.current = null;
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- size/state are read lazily; re-running on resize would reset the composer
    [gl, scene, camera, set, advance, onMount],
  );

  return null;
}

export const RenderEngine = forwardRef<RenderEngineRef, RenderEngineProps>(function RenderEngine(
  {
    children,
    width,
    height,
    orthographic = false,
    cameraPosition = [0, 0, 10],
    backgroundColor = '#0f0b15',
    onFrameRendered,
  },
  ref,
) {
  const internalRef = useRef<RenderEngineRef | null>(null);

  useImperativeHandle(
    ref,
    function (): RenderEngineRef {
      return {
        getRenderer: function (): RootState['gl'] | null {
          return internalRef.current?.getRenderer() ?? null;
        },
        getScene: function (): THREE.Scene | null {
          return internalRef.current?.getScene() ?? null;
        },
        getCamera: function (): THREE.Camera | null {
          return internalRef.current?.getCamera() ?? null;
        },
        getComposer: function (): Composer | null {
          return internalRef.current?.getComposer() ?? null;
        },
        setComposer: function (composer: Composer): void {
          internalRef.current?.setComposer(composer);
        },
        renderFrame: function (): void {
          internalRef.current?.renderFrame();
        },
        set: function (props: Partial<RootState>): void {
          internalRef.current?.set(props);
        },
        advance: function (timestamp: number, runGlobalEffects?: boolean): void {
          internalRef.current?.advance(timestamp, runGlobalEffects);
        },
        getSize: function (): { width: number; height: number } {
          return internalRef.current?.getSize() ?? { width: 0, height: 0 };
        },
        getState: function (): RootState {
          const state = internalRef.current?.getState();
          if (!state) {
            throw new Error('RenderEngine state requested before initialization');
          }
          return state;
        },
      };
    },
    [],
  );

  const handleMount = useCallback(function (engineRef: RenderEngineRef): void {
    internalRef.current = engineRef;
  }, []);

  // Cleanup on unmount to prevent context leaks during HMR
  useEffect(() => {
    return () => {
      // Cleanup is handled by Canvas's internal disposal
      internalRef.current = null;
    };
  }, []);

  return (
    <Canvas
      dpr={1}
      style={{ width: width ?? '100%', height: height ?? '100%' }}
      camera={{
        position: cameraPosition,
        fov: orthographic ? undefined : 50,
        near: 0.1,
        far: 1000,
      }}
      orthographic={orthographic}
      gl={async (props) => {
        const { canvas } = props;

        // Attempt WebGPU first
        if (typeof navigator !== 'undefined') {
          try {
            if (canvas && typeof (canvas as HTMLCanvasElement).getContext === 'function') {
              let renderer: WebGPURenderer | null = null;

              // Stage 1: Try native WebGPU if API exists
              if (navigator.gpu) {
                try {
                  const isWindows =
                    typeof navigator !== 'undefined' &&
                    /Win/i.test(navigator.userAgent || navigator.platform || '');
                  const glOpts: NonNullable<ConstructorParameters<typeof WebGPURenderer>[0]> = {
                    canvas: canvas as HTMLCanvasElement,
                    forceWebGL: false,
                  };
                  if (!isWindows) {
                    glOpts.powerPreference = 'high-performance';
                  }
                  renderer = new WebGPURenderer(glOpts);

                  if (typeof renderer.init === 'function') {
                    const ok = await renderer.init();
                    if (!ok) throw new Error('WebGPU init returned false');
                  }

                  if (
                    !(renderer.backend as unknown as { device?: GPUDevice } | undefined)?.device
                  ) {
                    throw new Error('WebGPU backend has no device');
                  }
                } catch (e) {
                  console.warn('[RenderEngine] Native WebGPU failed, trying WebGL backend...', e);
                  renderer = null;
                }
              }

              // Stage 2: Try WebGPURenderer with WebGL backend (critical for TSL nodes)
              if (!renderer) {
                renderer = new WebGPURenderer({
                  canvas: canvas as HTMLCanvasElement,
                  antialias: true,
                  alpha: true,
                  forceWebGL: true,
                });

                if (typeof renderer.init === 'function') {
                  const ok = await renderer.init();
                  if (!ok) throw new Error('WebGL backend init failed');
                }
              }

              if (renderer.backend && !renderer.backend.renderer) {
                renderer.backend.renderer = renderer;
              }

              // R3F compatibility shim: GPUCanvasContext/WebGLBackend lacks getContextAttributes()
              type ShimmedContext = { getContextAttributes?: () => WebGLContextAttributes };
              const originalGetContext = renderer.getContext.bind(
                renderer,
              ) as unknown as () => ShimmedContext | null;
              (renderer as unknown as { getContext: () => ShimmedContext | null }).getContext =
                () => {
                  const ctx = originalGetContext();
                  if (ctx && typeof ctx.getContextAttributes !== 'function') {
                    ctx.getContextAttributes = () => ({
                      alpha: false,
                      antialias: true,
                      depth: true,
                      stencil: false,
                      premultipliedAlpha: true,
                      preserveDrawingBuffer: false,
                      powerPreference: 'high-performance',
                      failIfMajorPerformanceCaveat: false,
                    });
                  }
                  return ctx;
                };

              return renderer;
            }
          } catch (e) {
            console.error('[RenderEngine] All WebGPURenderer stages failed:', e);
          }
        }

        // Fallback to legacy WebGL (last resort, TSL effects will be broken)
        console.warn(
          '[RenderEngine] Using Legacy WebGLRenderer fallback (Effects will be disabled)',
        );
        const legacyRenderer = new THREE.WebGLRenderer({
          ...props,
          powerPreference: 'high-performance',
        });
        legacyRenderer.outputColorSpace = THREE.SRGBColorSpace;
        return legacyRenderer;
      }}
      resize={{ scroll: false, debounce: { scroll: 0, resize: 0 }, offsetSize: true }}
    >
      {backgroundColor && backgroundColor !== 'transparent' && (
        <color attach="background" args={[backgroundColor]} />
      )}
      <TimeController onFrameRendered={onFrameRendered} />
      <SceneAccessWrapper onMount={handleMount} />
      {children}
    </Canvas>
  );
});
