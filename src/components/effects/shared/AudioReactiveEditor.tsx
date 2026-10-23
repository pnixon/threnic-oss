'use client';

import React, { useEffect, useRef, useState } from 'react';
import styles from '../../modals/EffectsModal.module.css';
import { AudioReactiveConfig, DEFAULT_AUDIO_REACTIVE } from '@/types/effects';
import { AutoResizingText } from './AutoResizingText';
import { SliderField } from './SliderField';
import { useKeyframes } from '@/hooks/useKeyframes';
import { useEffectEditor } from './EffectEditorContext';
import { audioStore } from '@/engine/stores/audioStore';

/**
 * Apply box plot curve to audio input (matches useAudioReactive.ts logic)
 */
function applyBoxPlotCurve(
  rawAudio: number,
  lowerThreshold: number,
  upperThreshold: number,
  boxCenter: number,
  boxWidth: number,
): number {
  const boxMin = Math.max(lowerThreshold, boxCenter - boxWidth / 2);
  const boxMax = Math.min(upperThreshold, boxCenter + boxWidth / 2);

  if (rawAudio <= lowerThreshold) return 0;
  if (rawAudio >= upperThreshold) return 1;

  const normalized = (rawAudio - lowerThreshold) / (upperThreshold - lowerThreshold);
  const boxMinNorm = (boxMin - lowerThreshold) / (upperThreshold - lowerThreshold);
  const boxMaxNorm = (boxMax - lowerThreshold) / (upperThreshold - lowerThreshold);

  if (normalized < boxMinNorm) {
    const regionWidth = boxMinNorm;
    const t = normalized / regionWidth;
    return 0.1 * Math.log10(1 + 9 * t);
  } else if (normalized <= boxMaxNorm) {
    const regionWidth = boxMaxNorm - boxMinNorm;
    const t = (normalized - boxMinNorm) / regionWidth;
    return 0.1 + 0.8 * t;
  } else {
    const regionWidth = 1 - boxMaxNorm;
    const t = (normalized - boxMaxNorm) / regionWidth;
    return 0.9 + 0.1 * Math.log10(1 + 9 * t);
  }
}

interface AudioReactiveEditorProps {
  label: string;
  config?: AudioReactiveConfig;
  onChange: (config: AudioReactiveConfig) => void;
  step?: number;
  min?: number;
  max?: number;
  propertyPrefix?: string;
  /** When true, hide the internal enable/disable checkbox (parent manages toggle) */
  hideToggle?: boolean;
}

/**
 * Interactive box plot curve editor - drag handles to adjust audio reactivity
 */
function InteractiveBoxPlotEditor({
  config,
  onChange,
  min,
  max,
  step,
  propertyPrefix: propPrefix,
}: {
  config: AudioReactiveConfig;
  onChange: (config: AudioReactiveConfig) => void;
  min: number;
  max: number;
  step: number;
  propertyPrefix?: string;
}) {
  const { updateProperty, selectedKeyframeId } = useKeyframes();
  const editorCtx = useEffectEditor();
  const propertyPrefix = propPrefix ?? editorCtx?.propertyPrefix;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDragging, setIsDragging] = useState<string | null>(null);
  const [hoverHandle, setHoverHandle] = useState<string | null>(null);
  const currentAudioLevelRef = useRef(0);
  const animationFrameRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(true);

  // --- Local drag config to prevent parent re-renders from killing the drag ---
  // During drag, we keep a local copy of config and only commit on mouseup.
  // This avoids the chain: onChange → updateTrackEffects → tracks update →
  // AppContent sync effect overwrites localEffectsConfig → component re-renders →
  // drag useEffect torn down → window mouse handlers removed → drag interrupted.
  const [dragConfig, setDragConfig] = useState<AudioReactiveConfig | null>(null);
  // Ref mirrors to avoid stale closures in window-level event handlers
  const dragConfigRef = useRef<AudioReactiveConfig | null>(null);
  const isDraggingRef = useRef<string | null>(null);

  // The "effective" config: use dragConfig while dragging, otherwise use props
  const effectiveConfig = dragConfig ?? config;

  useEffect(() => {
    // Check theme
    const checkTheme = () => {
      const theme = document.documentElement.getAttribute('data-theme');
      setIsDarkMode(theme !== 'light');
    };

    checkTheme();

    // Observe theme changes
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const padding = isMobile ? 18 : 30;
  const intensityBarWidth = 20;

  // Calculate actual display range - use min/max as primary bounds
  const getDisplayRange = () => {
    // Use the effect's min/max range as the primary display bounds
    // This allows the graph to "zoom in" on the actual range being used
    const displayMin = Math.min(min, max, effectiveConfig.min, effectiveConfig.max);
    const displayMax = Math.max(min, max, effectiveConfig.min, effectiveConfig.max);

    // Add small padding (5%) for visual comfort
    const displayPadding = Math.abs(displayMax - displayMin) * 0.05;
    return {
      displayMin: displayMin - displayPadding,
      displayMax: displayMax + displayPadding,
    };
  };

  // Convert audio value (0-1) to canvas x coordinate
  const audioToX = (value: number, width: number) => {
    return padding + (width - 2 * padding - intensityBarWidth) * value;
  };

  // Convert canvas x to audio value (0-1)
  const xToAudio = (x: number, width: number) => {
    return Math.max(0, Math.min(1, (x - padding) / (width - 2 * padding - intensityBarWidth)));
  };

  // Convert effect value to canvas y coordinate (using display range)
  const effectToY = (value: number, height: number) => {
    const { displayMin, displayMax } = getDisplayRange();
    const normalized = (value - displayMin) / (displayMax - displayMin);
    return height - padding - (height - 2 * padding) * normalized;
  };

  // Convert canvas y to effect value (using min-max range for editing)
  const yToEffect = (y: number, height: number) => {
    const normalized = 1 - (y - padding) / (height - 2 * padding);
    const rawValue = min + normalized * (max - min);
    // Apply step rounding
    const steppedValue = Math.round(rawValue / step) * step;
    return Math.max(min, Math.min(max, steppedValue));
  };

  // Detect which handle the mouse is over
  const detectHandle = (mouseX: number, mouseY: number, width: number, height: number) => {
    const handleRadius = 12; // Increased radius for better touch/mouse targetting
    const cfg = effectiveConfig;
    const lowerThreshold = cfg.lowerThreshold ?? 0;
    const upperThreshold = cfg.upperThreshold ?? 1;
    const boxCenter = cfg.boxCenter ?? 0.5;
    const boxWidth = cfg.boxWidth ?? 0.3;
    const boxMin = Math.max(lowerThreshold, boxCenter - boxWidth / 2);
    const boxMax = Math.min(upperThreshold, boxCenter + boxWidth / 2);

    const lowerX = audioToX(lowerThreshold, width);
    const upperX = audioToX(upperThreshold, width);
    const boxMinX = audioToX(boxMin, width);
    const boxMaxX = audioToX(boxMax, width);
    const minY = effectToY(cfg.min, height);
    const maxY = effectToY(cfg.max, height);
    const intensityX = width - padding + 10;

    // Check vertical handles (threshold and box edges)
    if (Math.abs(mouseX - lowerX) < handleRadius) return 'lowerThreshold';
    if (Math.abs(mouseX - upperX) < handleRadius) return 'upperThreshold';
    if (Math.abs(mouseX - boxMinX) < handleRadius && mouseY > padding && mouseY < height - padding)
      return 'boxMin';
    if (Math.abs(mouseX - boxMaxX) < handleRadius && mouseY > padding && mouseY < height - padding)
      return 'boxMax';

    // Check horizontal handles (min/max)
    // Priority check: If max and min are very close (stuck at bottom), prioritize picking 'max'
    // so the user can actually pull the range apart.
    const isOverMax =
      Math.abs(mouseY - maxY) < handleRadius && mouseX > padding && mouseX < width - padding;
    const isOverMin =
      Math.abs(mouseY - minY) < handleRadius && mouseX > padding && mouseX < width - padding;

    if (isOverMax && (isOverMin || cfg.max <= cfg.min + step * 2)) return 'max';
    if (isOverMin) return 'min';
    if (isOverMax) return 'max';

    // Check intensity slider
    if (
      Math.abs(mouseX - intensityX) < handleRadius &&
      mouseY > padding &&
      mouseY < height - padding
    )
      return 'intensity';

    return null;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const handle = detectHandle(mouseX, mouseY, canvas.width, canvas.height);
    if (handle) {
      e.preventDefault();
      e.stopPropagation();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
      // Capture a local copy of config for the drag session
      const localCopy = { ...config };
      setDragConfig(localCopy);
      dragConfigRef.current = localCopy;
      isDraggingRef.current = handle;
      setIsDragging(handle);
    }
  };

  // Hover/move detection
  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDragging) return; // Window handler takes over during drag
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;
    setHoverHandle(detectHandle(mouseX, mouseY, canvas.width, canvas.height));
  };

  // Window-level drag handlers — attached only while dragging.
  // Uses refs to read latest drag state, so the effect only depends on
  // isDragging (mount/unmount). This prevents parent re-renders from
  // tearing down the window handlers mid-drag.
  useEffect(() => {
    if (!isDragging) return;

    const handleWindowPointerMove = (e: PointerEvent) => {
      const canvas = canvasRef.current;
      const currentDragConfig = dragConfigRef.current;
      if (!canvas || !currentDragConfig) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const mouseX = (e.clientX - rect.left) * scaleX;
      const mouseY = (e.clientY - rect.top) * scaleY;

      const width = canvas.width;
      const height = canvas.height;

      const newConfig = { ...currentDragConfig };
      const lowerThreshold = currentDragConfig.lowerThreshold ?? 0;
      const upperThreshold = currentDragConfig.upperThreshold ?? 1;
      const boxCenter = currentDragConfig.boxCenter ?? 0.5;
      const boxWidth = currentDragConfig.boxWidth ?? 0.3;
      const currentHandle = isDraggingRef.current;

      switch (currentHandle) {
        case 'lowerThreshold':
          newConfig.lowerThreshold = Math.min(xToAudio(mouseX, width), upperThreshold - 0.05);
          break;
        case 'upperThreshold':
          newConfig.upperThreshold = Math.max(xToAudio(mouseX, width), lowerThreshold + 0.05);
          break;
        case 'boxMin': {
          const currentBoxMax = Math.min(upperThreshold, boxCenter + boxWidth / 2);
          let newBoxMin = Math.max(lowerThreshold, xToAudio(mouseX, width));
          let newBoxMax = currentBoxMax;

          if (newBoxMin > currentBoxMax - 0.05) {
            newBoxMax = Math.min(upperThreshold, newBoxMin + 0.05);
            if (newBoxMax === upperThreshold) {
              newBoxMin = Math.min(newBoxMin, newBoxMax - 0.05);
            }
          }

          const newBoxWidth = newBoxMax - newBoxMin;
          newConfig.boxCenter = newBoxMin + newBoxWidth / 2;
          newConfig.boxWidth = newBoxWidth;
          break;
        }
        case 'boxMax': {
          const currentBoxMin = Math.max(lowerThreshold, boxCenter - boxWidth / 2);
          let newBoxMax = Math.min(upperThreshold, xToAudio(mouseX, width));
          let newBoxMin = currentBoxMin;

          if (newBoxMax < currentBoxMin + 0.05) {
            newBoxMin = Math.max(lowerThreshold, newBoxMax - 0.05);
            if (newBoxMin === lowerThreshold) {
              newBoxMax = Math.max(newBoxMax, newBoxMin + 0.05);
            }
          }

          const newBoxWidth = newBoxMax - newBoxMin;
          newConfig.boxCenter = newBoxMin + newBoxWidth / 2;
          newConfig.boxWidth = newBoxWidth;
          break;
        }
        case 'min':
          newConfig.min = Math.min(yToEffect(mouseY, height), currentDragConfig.max - step);
          break;
        case 'max':
          newConfig.max = Math.max(yToEffect(mouseY, height), currentDragConfig.min + step);
          break;
        case 'intensity': {
          const normalized = 1 - (mouseY - padding) / (height - 2 * padding);
          newConfig.intensity = Math.max(0, Math.min(2, normalized * 2));
          break;
        }
      }

      // Update local drag state only — no parent re-render
      dragConfigRef.current = newConfig;
      setDragConfig(newConfig);
    };

    const handleWindowPointerUp = (e: PointerEvent) => {
      const finalConfig = dragConfigRef.current;
      if (finalConfig) {
        // Commit to parent state + keyframe persistence in one go
        onChange(finalConfig);
        if (propertyPrefix) {
          // Write each numeric sub-value as its own dot-path (e.g. arP0.min) so
          // the keyframe system can INTERPOLATE each AR value between keyframes.
          // Committing the whole object under one path would store an opaque
          // object that holds (not interpolates) across time.
          const numericKeys: (keyof AudioReactiveConfig)[] = [
            'min',
            'max',
            'intensity',
            'lowerThreshold',
            'upperThreshold',
            'boxCenter',
            'boxWidth',
            'attack',
            'decay',
          ];
          for (const key of numericKeys) {
            const v = finalConfig[key];
            if (typeof v === 'number') {
              updateProperty(`${propertyPrefix}.${key}`, v, selectedKeyframeId);
            }
          }
        }
      }
      const canvas = canvasRef.current;
      if (canvas) {
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {}
      }
      // Clear drag state
      dragConfigRef.current = null;
      isDraggingRef.current = null;
      setDragConfig(null);
      setIsDragging(null);
      setHoverHandle(null);
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
    };
    // Only re-attach when drag starts/stops. Refs are used for all mutable state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  // Animate audio level updates — uses refs only to avoid React re-renders
  // that would steal focus from sibling SliderField inputs.
  const lastUpdateRef = useRef<number>(0);
  const smoothedLevelRef = useRef<number>(0);

  useEffect(() => {
    lastUpdateRef.current = performance.now();
  }, []);

  // Draw the canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(document.documentElement);
    const colors = {
      bg: style.getPropertyValue('--bg-app').trim() || (isDarkMode ? '#1a1a1a' : '#f8fafc'),
      grid:
        style.getPropertyValue('--border-subtle').trim() ||
        (isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)'),
      textPrimary:
        style.getPropertyValue('--text-primary').trim() ||
        (isDarkMode ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.6)'),
      textMuted:
        style.getPropertyValue('--text-muted').trim() ||
        (isDarkMode ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.3)'),
      rangeBg:
        style.getPropertyValue('--accent-muted').trim() ||
        (isDarkMode ? 'rgba(150, 100, 200, 0.05)' : 'rgba(150, 100, 200, 0.08)'),
      boxBg:
        style.getPropertyValue('--bg-hover').trim() ||
        (isDarkMode ? 'rgba(100, 200, 255, 0.15)' : 'rgba(100, 200, 255, 0.1)'),
      threshold:
        style.getPropertyValue('--accent-glow').trim() ||
        (isDarkMode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.2)'),
      baseline:
        style.getPropertyValue('--border-subtle').trim() ||
        (isDarkMode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.2)'),
    };

    // Draw background
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, height);

    const cfg = effectiveConfig;
    const lowerThreshold = cfg.lowerThreshold ?? 0;
    const upperThreshold = cfg.upperThreshold ?? 1;
    const boxCenter = cfg.boxCenter ?? 0.5;
    const boxWidth = cfg.boxWidth ?? 0.3;

    const boxMin = Math.max(lowerThreshold, boxCenter - boxWidth / 2);
    const boxMax = Math.min(upperThreshold, boxCenter + boxWidth / 2);

    // Draw baseline (resting line) — when inverted, resting state is at max
    const baselineValue = cfg.invert ? cfg.max : cfg.min;
    const baselineY = effectToY(baselineValue, height);
    ctx.strokeStyle = colors.baseline;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(padding, baselineY);
    ctx.lineTo(width - padding - intensityBarWidth, baselineY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw min/max range background
    const minY = effectToY(cfg.min, height);
    const maxY = effectToY(cfg.max, height);
    ctx.fillStyle = colors.rangeBg;
    ctx.fillRect(padding, maxY, width - 2 * padding - intensityBarWidth, minY - maxY);

    // Draw box region (inner quartile)
    const boxMinX = audioToX(boxMin, width);
    const boxMaxX = audioToX(boxMax, width);
    ctx.fillStyle = colors.boxBg;
    ctx.fillRect(boxMinX, padding, boxMaxX - boxMinX, height - 2 * padding);

    // Draw threshold boundary lines
    ctx.strokeStyle = colors.threshold;
    ctx.lineWidth = 2;
    const lowerX = audioToX(lowerThreshold, width);
    const upperX = audioToX(upperThreshold, width);
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(lowerX, padding);
    ctx.lineTo(lowerX, height - padding);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(upperX, padding);
    ctx.lineTo(upperX, height - padding);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw min/max lines
    ctx.strokeStyle = 'rgba(150, 100, 200, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding, minY);
    ctx.lineTo(width - padding - intensityBarWidth, minY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(padding, maxY);
    ctx.lineTo(width - padding - intensityBarWidth, maxY);
    ctx.stroke();

    // Draw response curve
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 3;
    ctx.beginPath();

    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let effectValue = 0;

      // Check for no-effect / max-effect conditions (matches runtime processEnvelope)
      if (!cfg.invert && t <= lowerThreshold) {
        // Normal mode: below lower threshold = min value
        effectValue = cfg.min;
      } else if (!cfg.invert && t >= upperThreshold) {
        // Normal mode: above upper threshold = max value (clamped by intensity)
        const range = (cfg.max - cfg.min) * cfg.intensity;
        effectValue = cfg.min + range;
      } else if (cfg.invert && t >= upperThreshold) {
        // Inverted mode: above upper threshold = min value
        effectValue = cfg.min;
      } else if (cfg.invert && t <= lowerThreshold) {
        // Inverted mode: below lower threshold = resting state (max)
        effectValue = cfg.max;
      } else {
        // Apply box plot curve in the active range
        const curveResponse = applyBoxPlotCurve(
          t,
          lowerThreshold,
          upperThreshold,
          boxCenter,
          boxWidth,
        );
        // Map to min-max range with inversion support
        let start = cfg.min;
        let end = cfg.max;
        if (cfg.invert) {
          start = cfg.max;
          end = cfg.min;
        }
        const range = end - start;
        effectValue = start + curveResponse * range * cfg.intensity;
      }

      // Clamp to ensure we never fall outside the user-defined min/max bounds
      const actualMin = Math.min(cfg.min, cfg.max);
      const actualMax = Math.max(cfg.min, cfg.max);
      effectValue = Math.max(actualMin, Math.min(actualMax, effectValue));

      const x = audioToX(t, width);
      const y = effectToY(effectValue, height);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Draw intensity bar
    const intensityX = width - padding + 10;
    ctx.fillStyle = 'rgba(255, 200, 100, 0.2)';
    ctx.fillRect(intensityX - 5, padding, 10, height - 2 * padding);
    const intensityY = padding + (height - 2 * padding) * (1 - cfg.intensity / 2);
    ctx.fillStyle =
      hoverHandle === 'intensity' || isDragging === 'intensity' ? '#ffcc44' : '#ff8844';
    ctx.beginPath();
    ctx.arc(intensityX, intensityY, 6, 0, 2 * Math.PI);
    ctx.fill();

    // Draw draggable handles
    const drawHandle = (x: number, y: number, handleName: string, color: string) => {
      const isActive = hoverHandle === handleName || isDragging === handleName;
      ctx.fillStyle = isActive ? color : color.replace('1)', '0.7)');
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, isActive ? 7 : 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    };

    // Threshold handles
    drawHandle(lowerX, height / 2, 'lowerThreshold', 'rgba(255, 100, 100, 1)');
    drawHandle(upperX, height / 2, 'upperThreshold', 'rgba(255, 100, 100, 1)');

    // Box handles
    drawHandle(boxMinX, height / 2, 'boxMin', 'rgba(100, 200, 255, 1)');
    drawHandle(boxMaxX, height / 2, 'boxMax', 'rgba(100, 200, 255, 1)');

    // Min/Max handles
    drawHandle(width / 2, minY, 'min', 'rgba(150, 100, 200, 1)');
    drawHandle(width / 2, maxY, 'max', 'rgba(150, 100, 200, 1)');

    // Draw axis labels
    ctx.fillStyle = colors.textPrimary;
    ctx.font = '11px monospace';
    ctx.fillText('Audio Input →', width / 2 - 40, height - 8);
    ctx.save();
    ctx.translate(10, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Effect Value', -30, 0);
    ctx.restore();

    // Draw value labels with descriptions
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(150, 100, 200, 0.8)';
    if (!isMobile) {
      ctx.fillText('Range', padding + 5, (minY + maxY) / 2);
    }
    ctx.fillText(`Min: ${cfg.min.toFixed(2)}`, padding + 5, minY + 12);
    ctx.fillText(`Max: ${cfg.max.toFixed(2)}`, padding + 5, maxY - 4);

    // Draw baseline label
    ctx.fillStyle = colors.textPrimary;
    ctx.fillText(
      isMobile ? `Base: ${baselineValue.toFixed(1)}` : `Baseline (${baselineValue.toFixed(1)})`,
      width - padding - intensityBarWidth - (isMobile ? 65 : 85),
      baselineY - 4,
    );

    ctx.fillStyle = 'rgba(255, 100, 100, 0.8)';
    if (!isMobile) {
      ctx.fillText('Thresholds', padding + 5, height - padding + 15);
    }
    ctx.fillText(
      `L: ${lowerThreshold.toFixed(2)}`,
      lowerX - 18,
      height - padding + (isMobile ? 12 : 15),
    );
    ctx.fillText(
      `U: ${upperThreshold.toFixed(2)}`,
      upperX - 18,
      height - padding + (isMobile ? 12 : 15),
    );

    if (!isMobile) {
      // Draw box label
      ctx.fillStyle = 'rgba(100, 200, 255, 0.8)';
      const boxCenterX = (boxMinX + boxMaxX) / 2;
      ctx.fillText('Box (Peak Reactivity)', boxCenterX - 60, padding + 12);

      // Draw intensity label
      ctx.fillStyle = 'rgba(255, 200, 100, 0.8)';
      ctx.fillText(`Intensity: ${cfg.intensity.toFixed(2)}`, intensityX - 25, padding + 12);
    }

    // NOTE: Audio level indicator is drawn by the rAF loop below (not here)
    // to avoid React state-driven re-renders that steal input focus.

    if (!isMobile) {
      // Draw usage hint at top
      ctx.fillStyle = colors.textMuted;
      ctx.font = '9px monospace';
      ctx.fillText('← Drag any handle to adjust', padding + 5, padding - 15);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- audioToX/effectToY/padding are re-derived each render from the deps already listed
  }, [effectiveConfig, hoverHandle, isDragging, min, max, isDarkMode, isMobile]);

  // Separate rAF loop for live audio level indicator — writes directly to
  // the canvas overlay without triggering React re-renders. This is the key
  // fix: previously setCurrentAudioLevel() caused ~60fps component re-renders
  // which stole focus from sibling SliderField inputs.
  useEffect(() => {
    // Hold refs to latest config values so the rAF loop always reads fresh data
    // without needing React state.
    const configRef = {
      band: effectiveConfig.band,
      // Match the engine's envelope defaults (arParam.ts / useAudioReactive.ts:
      // attack 20ms, decay 50ms) so the live yellow indicator tracks the SAME
      // smoothing the render pass uses. Previously these were 1.0s, which made
      // the overlay lag ~1s behind the effect and disagree about when the effect
      // is active.
      attack: effectiveConfig.attack ?? 0.02,
      decay: effectiveConfig.decay ?? 0.05,
      lowerThreshold: effectiveConfig.lowerThreshold ?? 0,
      upperThreshold: effectiveConfig.upperThreshold ?? 1,
      boxCenter: effectiveConfig.boxCenter ?? 0.5,
      boxWidth: effectiveConfig.boxWidth ?? 0.3,
      intensity: effectiveConfig.intensity,
      invert: effectiveConfig.invert,
      min: effectiveConfig.min,
      max: effectiveConfig.max,
    };

    const drawAudioOverlay = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        animationFrameRef.current = setTimeout(drawAudioOverlay, 33);
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        animationFrameRef.current = setTimeout(drawAudioOverlay, 33);
        return;
      }

      // --- smoothing (same logic as before, but all via refs) ---
      const now = performance.now();
      const dt = (now - (lastUpdateRef.current || now)) / 1000;
      lastUpdateRef.current = now;

      const rawLevel = audioStore.getState()[configRef.band];
      const isRising = rawLevel > smoothedLevelRef.current;
      const smoothingTime = isRising ? configRef.attack : configRef.decay;
      const safeTime = Math.max(0.001, smoothingTime);
      const factor = 1 - Math.exp(-dt / safeTime);
      smoothedLevelRef.current += (rawLevel - smoothedLevelRef.current) * factor;
      currentAudioLevelRef.current = smoothedLevelRef.current;

      const currentAudioLevel = currentAudioLevelRef.current;
      const width = canvas.width;
      const height = canvas.height;

      // Full canvas redraw — duplicated from the static useEffect so the rAF
      // loop can drive all drawing without React state updates.
      ctx.clearRect(0, 0, width, height);

      const style = getComputedStyle(document.documentElement);
      const colors = {
        bg: style.getPropertyValue('--bg-app').trim() || (isDarkMode ? '#1a1a1a' : '#f8fafc'),
        grid:
          style.getPropertyValue('--border-subtle').trim() ||
          (isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)'),
        textPrimary:
          style.getPropertyValue('--text-primary').trim() ||
          (isDarkMode ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.6)'),
        textMuted:
          style.getPropertyValue('--text-muted').trim() ||
          (isDarkMode ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.3)'),
        rangeBg:
          style.getPropertyValue('--accent-muted').trim() ||
          (isDarkMode ? 'rgba(150, 100, 200, 0.05)' : 'rgba(150, 100, 200, 0.08)'),
        boxBg:
          style.getPropertyValue('--bg-hover').trim() ||
          (isDarkMode ? 'rgba(100, 200, 255, 0.15)' : 'rgba(100, 200, 255, 0.1)'),
        threshold:
          style.getPropertyValue('--accent-glow').trim() ||
          (isDarkMode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.2)'),
        baseline:
          style.getPropertyValue('--border-subtle').trim() ||
          (isDarkMode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.2)'),
      };

      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, width, height);

      const { lowerThreshold, upperThreshold, boxCenter, boxWidth: bw } = configRef;
      const boxMin = Math.max(lowerThreshold, boxCenter - bw / 2);
      const boxMax = Math.min(upperThreshold, boxCenter + bw / 2);

      // Baseline (resting line) — when inverted, resting state is at max
      const baselineValue = configRef.invert ? configRef.max : configRef.min;
      const baselineY = effectToY(baselineValue, height);
      ctx.strokeStyle = colors.baseline;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(padding, baselineY);
      ctx.lineTo(width - padding - intensityBarWidth, baselineY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Min/max range background
      const minY = effectToY(configRef.min, height);
      const maxY = effectToY(configRef.max, height);
      ctx.fillStyle = colors.rangeBg;
      ctx.fillRect(padding, maxY, width - 2 * padding - intensityBarWidth, minY - maxY);

      // Box region
      const boxMinX = audioToX(boxMin, width);
      const boxMaxX = audioToX(boxMax, width);
      ctx.fillStyle = colors.boxBg;
      ctx.fillRect(boxMinX, padding, boxMaxX - boxMinX, height - 2 * padding);

      // Threshold lines
      ctx.strokeStyle = colors.threshold;
      ctx.lineWidth = 2;
      const lowerX = audioToX(lowerThreshold, width);
      const upperX = audioToX(upperThreshold, width);
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(lowerX, padding);
      ctx.lineTo(lowerX, height - padding);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(upperX, padding);
      ctx.lineTo(upperX, height - padding);
      ctx.stroke();
      ctx.setLineDash([]);

      // Min/max lines
      ctx.strokeStyle = 'rgba(150, 100, 200, 0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(padding, minY);
      ctx.lineTo(width - padding - intensityBarWidth, minY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(padding, maxY);
      ctx.lineTo(width - padding - intensityBarWidth, maxY);
      ctx.stroke();

      // Response curve
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 3;
      ctx.beginPath();
      const steps = 200;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        let effectValue = 0;
        if (!configRef.invert && t <= lowerThreshold) {
          effectValue = configRef.min;
        } else if (!configRef.invert && t >= upperThreshold) {
          const range = (configRef.max - configRef.min) * configRef.intensity;
          effectValue = configRef.min + range;
        } else if (configRef.invert && t >= upperThreshold) {
          effectValue = configRef.min;
        } else if (configRef.invert && t <= lowerThreshold) {
          effectValue = configRef.max;
        } else {
          const curveResponse = applyBoxPlotCurve(t, lowerThreshold, upperThreshold, boxCenter, bw);
          let start = configRef.min;
          let end = configRef.max;
          if (configRef.invert) {
            start = configRef.max;
            end = configRef.min;
          }
          const range = end - start;
          effectValue = start + curveResponse * range * configRef.intensity;
        }
        const actualMin = Math.min(configRef.min, configRef.max);
        const actualMax = Math.max(configRef.min, configRef.max);
        effectValue = Math.max(actualMin, Math.min(actualMax, effectValue));
        const x = audioToX(t, width);
        const y = effectToY(effectValue, height);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // Intensity bar
      const intensityX = width - padding + 10;
      ctx.fillStyle = 'rgba(255, 200, 100, 0.2)';
      ctx.fillRect(intensityX - 5, padding, 10, height - 2 * padding);
      const intensityY = padding + (height - 2 * padding) * (1 - configRef.intensity / 2);
      ctx.fillStyle =
        hoverHandle === 'intensity' || isDragging === 'intensity' ? '#ffcc44' : '#ff8844';
      ctx.beginPath();
      ctx.arc(intensityX, intensityY, 6, 0, 2 * Math.PI);
      ctx.fill();

      // Handles
      const drawHandle = (x: number, y: number, handleName: string, color: string) => {
        const isActive = hoverHandle === handleName || isDragging === handleName;
        ctx.fillStyle = isActive ? color : color.replace('1)', '0.7)');
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, isActive ? 7 : 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      };
      drawHandle(lowerX, height / 2, 'lowerThreshold', 'rgba(255, 100, 100, 1)');
      drawHandle(upperX, height / 2, 'upperThreshold', 'rgba(255, 100, 100, 1)');
      drawHandle(boxMinX, height / 2, 'boxMin', 'rgba(100, 200, 255, 1)');
      drawHandle(boxMaxX, height / 2, 'boxMax', 'rgba(100, 200, 255, 1)');
      drawHandle(width / 2, minY, 'min', 'rgba(150, 100, 200, 1)');
      drawHandle(width / 2, maxY, 'max', 'rgba(150, 100, 200, 1)');

      // Labels
      ctx.fillStyle = colors.textPrimary;
      ctx.font = '11px monospace';
      ctx.fillText('Audio Input →', width / 2 - 40, height - 8);
      ctx.save();
      ctx.translate(10, height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('Effect Value', -30, 0);
      ctx.restore();

      ctx.font = '9px monospace';
      ctx.fillStyle = 'rgba(150, 100, 200, 0.8)';
      if (!isMobile) {
        ctx.fillText('Range', padding + 5, (minY + maxY) / 2);
      }
      ctx.fillText(`Min: ${configRef.min.toFixed(2)}`, padding + 5, minY + 12);
      ctx.fillText(`Max: ${configRef.max.toFixed(2)}`, padding + 5, maxY - 4);

      ctx.fillStyle = colors.textPrimary;
      ctx.fillText(
        isMobile ? `Base: ${baselineValue.toFixed(1)}` : `Baseline (${baselineValue.toFixed(1)})`,
        width - padding - intensityBarWidth - (isMobile ? 65 : 85),
        baselineY - 4,
      );

      ctx.fillStyle = 'rgba(255, 100, 100, 0.8)';
      if (!isMobile) {
        ctx.fillText('Thresholds', padding + 5, height - padding + 15);
      }
      ctx.fillText(
        `L: ${lowerThreshold.toFixed(2)}`,
        lowerX - 18,
        height - padding + (isMobile ? 12 : 15),
      );
      ctx.fillText(
        `U: ${upperThreshold.toFixed(2)}`,
        upperX - 18,
        height - padding + (isMobile ? 12 : 15),
      );

      if (!isMobile) {
        ctx.fillStyle = 'rgba(100, 200, 255, 0.8)';
        const boxCenterX = (boxMinX + boxMaxX) / 2;
        ctx.fillText('Box (Peak Reactivity)', boxCenterX - 60, padding + 12);

        ctx.fillStyle = 'rgba(255, 200, 100, 0.8)';
        ctx.fillText(`Intensity: ${configRef.intensity.toFixed(2)}`, intensityX - 25, padding + 12);
      }

      // --- Audio level indicator (the live part) ---
      if (currentAudioLevel > 0) {
        const audioX = audioToX(currentAudioLevel, width);
        ctx.shadowColor = '#ffff00';
        ctx.shadowBlur = 15;
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(audioX, padding);
        ctx.lineTo(audioX, height - padding);
        ctx.stroke();
        ctx.shadowBlur = 0;

        let currentEffectValue = 0;
        if (!configRef.invert && currentAudioLevel <= lowerThreshold) {
          currentEffectValue = configRef.min;
        } else if (!configRef.invert && currentAudioLevel >= upperThreshold) {
          const range = (configRef.max - configRef.min) * configRef.intensity;
          currentEffectValue = configRef.min + range;
        } else if (configRef.invert && currentAudioLevel >= upperThreshold) {
          currentEffectValue = configRef.min;
        } else if (configRef.invert && currentAudioLevel <= lowerThreshold) {
          currentEffectValue = configRef.max;
        } else {
          const curveResponse = applyBoxPlotCurve(
            currentAudioLevel,
            lowerThreshold,
            upperThreshold,
            boxCenter,
            bw,
          );
          let start = configRef.min;
          let end = configRef.max;
          if (configRef.invert) {
            start = configRef.max;
            end = configRef.min;
          }
          const range = end - start;
          currentEffectValue = start + curveResponse * range * configRef.intensity;
        }
        const actualMin = Math.min(configRef.min, configRef.max);
        const actualMax = Math.max(configRef.min, configRef.max);
        currentEffectValue = Math.max(actualMin, Math.min(actualMax, currentEffectValue));

        const currentY = effectToY(currentEffectValue, height);
        ctx.fillStyle = '#ffff00';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(audioX, currentY, 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffff00';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(`Live: ${currentAudioLevel.toFixed(2)}`, audioX - 20, padding - 5);
      }

      // Usage hint
      if (!isMobile) {
        ctx.fillStyle = colors.textMuted;
        ctx.font = '9px monospace';
        ctx.fillText('← Drag any handle to adjust', padding + 5, padding - 15);
      }

      animationFrameRef.current = setTimeout(drawAudioOverlay, 33);
    };

    animationFrameRef.current = setTimeout(drawAudioOverlay, 33);

    return () => {
      if (animationFrameRef.current !== null) {
        clearTimeout(animationFrameRef.current);
      }
    };
    // Re-create the loop when config or visual state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveConfig, hoverHandle, isDragging, min, max, isDarkMode, isMobile]);

  return (
    <div
      style={{
        padding: '12px 0 4px 0',
        cursor: isDragging ? 'grabbing' : hoverHandle ? 'grab' : 'default',
        touchAction: 'none',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <canvas
        ref={canvasRef}
        width={400}
        height={isMobile ? 130 : 220}
        style={{
          width: '100%',
          height: 'auto',
          display: 'block',
          borderRadius: '4px',
          border: '1px solid var(--border-subtle)',
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handleCanvasPointerMove}
      />
      {!isMobile && (
        <div className={styles.infoBox} style={{ marginTop: '12px' }}>
          <span>
            Click and drag handles to adjust reactivity curve. The green line shows the effect value
            response to audio intensity.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * AudioReactiveEditor - Reusable component for editing audio reactive settings
 */
export function AudioReactiveEditor({
  label,
  config: providedConfig,
  onChange,
  step = 0.1,
  min = -2,
  max = 3,
  propertyPrefix: propPrefix,
  hideToggle = false,
}: AudioReactiveEditorProps) {
  const { updateProperty, selectedKeyframeId } = useKeyframes();
  const editorCtx = useEffectEditor();
  const propertyPrefix = propPrefix ?? editorCtx?.propertyPrefix;

  // Use default if missing or incomplete, but don't return null so the UI is visible for enabling
  const config = React.useMemo(() => {
    const base = { ...DEFAULT_AUDIO_REACTIVE, min, max };
    if (!providedConfig) return base;
    return { ...base, ...providedConfig };
  }, [providedConfig, min, max]);

  return (
    <div className={styles.audioReactiveSection}>
      {/* Show the toggle row only when parent hasn't taken over toggle duty */}
      {!hideToggle && (
        <div className={styles.field}>
          <label
            className={styles.fieldHeader}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <input
              type="checkbox"
              checked={config.enabled || false}
              onChange={(e) => {
                const enabled = e.target.checked;
                onChange({ ...config, enabled });
                if (propertyPrefix) {
                  updateProperty(`${propertyPrefix}.enabled`, enabled, selectedKeyframeId);
                }
              }}
              className={styles.toggleCheckbox}
            />
            <AutoResizingText
              className={styles.fieldLabel}
              style={{ flex: 1, width: 'auto', marginRight: 0 }}
            >
              {label}
            </AutoResizingText>
          </label>
        </div>
      )}

      {(hideToggle || config.enabled) && (
        <>
          <div className={styles.field}>
            <AutoResizingText className={styles.fieldLabel} tagName="label">
              Band
            </AutoResizingText>
            <div
              className={styles.buttonGroup}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}
            >
              {(['bass', 'mid', 'high', 'energy'] as const).map((band) => (
                <button
                  key={band}
                  className={`${styles.bandButton} ${config.band === band ? styles.active : ''}`}
                  onClick={() => {
                    onChange({ ...config, band });
                    if (propertyPrefix) {
                      updateProperty(`${propertyPrefix}.band`, band, selectedKeyframeId);
                    }
                  }}
                  type="button"
                >
                  {band}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.field}>
            <label
              className={styles.toggle}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={config.invert || false}
                onChange={(e) => {
                  const invert = e.target.checked;
                  onChange({ ...config, invert });
                  if (propertyPrefix) {
                    updateProperty(`${propertyPrefix}.invert`, invert, selectedKeyframeId);
                  }
                }}
                className={styles.toggleCheckbox}
              />
              <AutoResizingText className={styles.fieldLabel} style={{ flex: 1, margin: 0 }}>
                Invert (max → min on beat)
              </AutoResizingText>
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <SliderField
              label="Attack (Rise)"
              value={config.attack ?? 0.02}
              onChange={(v) => onChange({ ...config, attack: v })}
              min={0}
              max={2.0}
              step={0.001}
              property={propertyPrefix ? `${propertyPrefix}.attack` : undefined}
            />
            <SliderField
              label="Decay (Fall)"
              value={config.decay ?? 0.05}
              onChange={(v) => onChange({ ...config, decay: v })}
              min={0}
              max={2.0}
              step={0.001}
              property={propertyPrefix ? `${propertyPrefix}.decay` : undefined}
            />
          </div>

          <InteractiveBoxPlotEditor
            config={config}
            onChange={onChange}
            min={min}
            max={max}
            step={step}
            propertyPrefix={propertyPrefix}
          />
        </>
      )}
    </div>
  );
}
