'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import styles from '../../modals/EffectsModal.module.css';
import rangeStyles from './RangeSliderField.module.css';
import { AutoResizingText } from './AutoResizingText';
import { useKeyframes } from '@/hooks/useKeyframes';
import { useEffectEditor } from './EffectEditorContext';
import { randomIntervalRegistry } from './useRandomInterval';
import { timeStore } from '@/engine/stores/timeStore';

interface RangeSliderFieldProps {
  label: string;
  /** Current low value */
  valueLow: number;
  /** Current high value */
  valueHigh: number;
  /** Called when either value changes */
  onChange: (low: number, high: number) => void;
  /** Absolute minimum for the slider range */
  min: number;
  /** Absolute maximum for the slider range */
  max: number;
  step?: number;
  /** Keyframe property path for the low value */
  propertyLow?: string;
  /** Keyframe property path for the high value */
  propertyHigh?: string;
  disabled?: boolean;
  effectId?: string;
  hudType?: 'interval' | 'duration';
}

export function RangeSliderField({
  label,
  valueLow,
  valueHigh,
  onChange,
  min,
  max,
  step = 0.01,
  propertyLow,
  propertyHigh,
  disabled = false,
  effectId,
  hudType,
}: RangeSliderFieldProps) {
  const { updateProperty, selectedKeyframeId } = useKeyframes();
  const editorCtx = useEffectEditor();

  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<'low' | 'high' | null>(null);
  const [isLowInputFocused, setIsLowInputFocused] = useState(false);
  const [isHighInputFocused, setIsHighInputFocused] = useState(false);

  const getPrecision = (s: number) => {
    const parts = s.toString().split('.');
    return parts.length > 1 ? parts[1].length : 0;
  };

  const precision = getPrecision(step);

  // Build full property paths
  const fullPropLow =
    editorCtx?.propertyPrefix && propertyLow && !propertyLow.startsWith(editorCtx.propertyPrefix)
      ? `${editorCtx.propertyPrefix}.${propertyLow}`
      : propertyLow;
  const fullPropHigh =
    editorCtx?.propertyPrefix && propertyHigh && !propertyHigh.startsWith(editorCtx.propertyPrefix)
      ? `${editorCtx.propertyPrefix}.${propertyHigh}`
      : propertyHigh;

  // Clamp & step-round a raw value
  const clampAndStep = useCallback(
    (raw: number) => {
      const stepped = Math.round(raw / step) * step;
      return Math.max(min, Math.min(max, stepped));
    },
    [min, max, step],
  );

  // Convert a pixel x relative to the track into a value
  const xToValue = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return min;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return clampAndStep(min + ratio * (max - min));
    },
    [min, max, clampAndStep],
  );

  // Percentage position for a given value
  const valueToPercent = (v: number) => {
    if (max === min) return 0;
    return ((v - min) / (max - min)) * 100;
  };

  const lowPercent = valueToPercent(valueLow);
  const highPercent = valueToPercent(valueHigh);

  const handleChange = useCallback(
    (newLow: number, newHigh: number) => {
      onChange(newLow, newHigh);
      const targetId = editorCtx?.targetKeyframeId ?? selectedKeyframeId;
      if (fullPropLow) updateProperty(fullPropLow, newLow, targetId);
      if (fullPropHigh) updateProperty(fullPropHigh, newHigh, targetId);
    },
    [onChange, fullPropLow, fullPropHigh, updateProperty, selectedKeyframeId, editorCtx],
  );

  // Pointer down on a thumb
  const handleThumbDown = useCallback(
    (which: 'low' | 'high') => (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      setDragging(which);
    },
    [disabled],
  );

  // Pointer down on the track (pick the nearest thumb)
  const handleTrackDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const val = xToValue(e.clientX);
      const distLow = Math.abs(val - valueLow);
      const distHigh = Math.abs(val - valueHigh);
      // Pick the closer thumb; prefer high if equal (so you can push apart from min)
      const which = distLow < distHigh ? 'low' : 'high';
      setDragging(which);
      // Immediately move
      if (which === 'low') {
        const clamped = Math.min(val, valueHigh);
        handleChange(clamped, valueHigh);
      } else {
        const clamped = Math.max(val, valueLow);
        handleChange(valueLow, clamped);
      }
    },
    [disabled, xToValue, valueLow, valueHigh, handleChange],
  );

  // Global pointer move/up while dragging
  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e: PointerEvent) => {
      const val = xToValue(e.clientX);
      if (dragging === 'low') {
        handleChange(Math.min(val, valueHigh), valueHigh);
      } else {
        handleChange(valueLow, Math.max(val, valueLow));
      }
    };

    const handleUp = () => setDragging(null);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragging, xToValue, valueLow, valueHigh, handleChange]);

  const hudProgressRef = useRef<HTMLDivElement>(null);
  const hudGhostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!effectId || !hudType) return;

    let frameId: number;
    const updateHud = () => {
      const liveState = randomIntervalRegistry[effectId];

      if (liveState) {
        const now = timeStore.getState().currentTime;
        let progress = 0;
        let showProgress = false;
        let ghostVal: number | undefined;

        if (hudType === 'interval') {
          ghostVal = liveState.lastInterval;
          if (!liveState.isActive && ghostVal !== undefined) {
            const waitStart = liveState.activeEndTime;
            const waitEnd = liveState.nextTriggerTime;
            const totalWait = waitEnd - waitStart;
            if (totalWait > 0) {
              const elapsed = now - waitStart;
              progress = Math.max(0, Math.min(1, elapsed / totalWait));
              showProgress = true;
            }
          }
        } else if (hudType === 'duration') {
          ghostVal = liveState.lastDuration;
          if (liveState.isActive && ghostVal !== undefined) {
            const durStart = liveState.activeStartTime;
            const duration = liveState.activeDuration;
            if (duration > 0) {
              const elapsed = now - durStart;
              progress = Math.max(0, Math.min(1, elapsed / duration));
              showProgress = true;
            }
          }
        }

        // Ghost notch position (mapped to slider scale)
        if (hudGhostRef.current) {
          if (ghostVal !== undefined && ghostVal >= min && ghostVal <= max) {
            const ghostPercent = ((ghostVal - min) / (max - min)) * 100;
            hudGhostRef.current.style.display = 'block';
            hudGhostRef.current.style.left = `${ghostPercent}%`;
          } else {
            hudGhostRef.current.style.display = 'none';
          }
        }

        // Progress bar: fill from 0 to (progress × ghostPercent)
        if (hudProgressRef.current) {
          if (showProgress && ghostVal !== undefined && ghostVal >= min && ghostVal <= max) {
            const ghostPercent = ((ghostVal - min) / (max - min)) * 100;
            const fillWidth = progress * ghostPercent;
            hudProgressRef.current.style.display = 'block';
            hudProgressRef.current.style.width = `${fillWidth}%`;
          } else {
            hudProgressRef.current.style.display = 'none';
          }
        }
      } else {
        if (hudProgressRef.current) hudProgressRef.current.style.display = 'none';
        if (hudGhostRef.current) hudGhostRef.current.style.display = 'none';
      }

      frameId = requestAnimationFrame(updateHud);
    };

    updateHud();
    return () => cancelAnimationFrame(frameId);
  }, [effectId, hudType, min, max]);

  // Input handling for low value
  const [lowInput, setLowInput] = useState(valueLow.toFixed(precision));
  const [highInput, setHighInput] = useState(valueHigh.toFixed(precision));
  const lowInputRef = useRef<HTMLInputElement>(null);
  const highInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== lowInputRef.current) {
      const newVal = valueLow.toFixed(precision);
      requestAnimationFrame(() => {
        setLowInput((prev) => (prev !== newVal ? newVal : prev));
      });
    }
  }, [valueLow, precision]);

  useEffect(() => {
    if (document.activeElement !== highInputRef.current) {
      const newVal = valueHigh.toFixed(precision);
      requestAnimationFrame(() => {
        setHighInput((prev) => (prev !== newVal ? newVal : prev));
      });
    }
  }, [valueHigh, precision]);

  const commitLowInput = () => {
    const parsed = parseFloat(lowInput);
    if (!isNaN(parsed)) {
      const clamped = clampAndStep(Math.min(parsed, valueHigh));
      setLowInput(clamped.toFixed(precision));
      handleChange(clamped, valueHigh);
    } else {
      setLowInput(valueLow.toFixed(precision));
    }
  };

  const commitHighInput = () => {
    const parsed = parseFloat(highInput);
    if (!isNaN(parsed)) {
      const clamped = clampAndStep(Math.max(parsed, valueLow));
      setHighInput(clamped.toFixed(precision));
      handleChange(valueLow, clamped);
    } else {
      setHighInput(valueHigh.toFixed(precision));
    }
  };

  return (
    <div className={rangeStyles.container} style={{ opacity: disabled ? 0.5 : 1 }}>
      {/* Label row */}
      <div className={rangeStyles.header}>
        <AutoResizingText className={styles.fieldLabel} tagName="label">
          {label}
        </AutoResizingText>
        <div className={rangeStyles.valueReadouts}>
          <input
            ref={lowInputRef}
            type="number"
            className={`${rangeStyles.valueInput} ${
              dragging === 'low' || isLowInputFocused ? rangeStyles.valueInputActive : ''
            }`}
            value={lowInput}
            onChange={(e) => {
              setLowInput(e.target.value);
              const parsed = parseFloat(e.target.value);
              if (!isNaN(parsed)) {
                const clamped = clampAndStep(Math.min(parsed, valueHigh));
                handleChange(clamped, valueHigh);
              }
            }}
            onFocus={() => setIsLowInputFocused(true)}
            onBlur={() => {
              setIsLowInputFocused(false);
              commitLowInput();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              e.stopPropagation();
            }}
            step={step}
            min={min}
            max={max}
            disabled={disabled}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <span className={rangeStyles.valueSeparator}>–</span>
          <input
            ref={highInputRef}
            type="number"
            className={`${rangeStyles.valueInput} ${
              dragging === 'high' || isHighInputFocused ? rangeStyles.valueInputActive : ''
            }`}
            value={highInput}
            onChange={(e) => {
              setHighInput(e.target.value);
              const parsed = parseFloat(e.target.value);
              if (!isNaN(parsed)) {
                const clamped = clampAndStep(Math.max(parsed, valueLow));
                handleChange(valueLow, clamped);
              }
            }}
            onFocus={() => setIsHighInputFocused(true)}
            onBlur={() => {
              setIsHighInputFocused(false);
              commitHighInput();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              e.stopPropagation();
            }}
            step={step}
            min={min}
            max={max}
            disabled={disabled}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>

      {/* Track */}
      <div ref={trackRef} className={rangeStyles.trackContainer} onPointerDown={handleTrackDown}>
        <div className={rangeStyles.track}>
          {/* Filled active region */}
          <div
            className={rangeStyles.trackFill}
            style={{
              left: `${lowPercent}%`,
              width: `${highPercent - lowPercent}%`,
            }}
          />

          {/* HUD elements */}
          <div
            ref={hudProgressRef}
            className={rangeStyles.hudProgress}
            style={{ display: 'none' }}
          />
          <div
            ref={hudGhostRef}
            className={rangeStyles.hudGhostNotch}
            style={{ display: 'none' }}
          />

          {/* Low thumb */}
          <div
            className={`${rangeStyles.thumb} ${dragging === 'low' ? rangeStyles.thumbActive : ''}`}
            style={{ left: `${lowPercent}%` }}
            onPointerDown={handleThumbDown('low')}
          />

          {/* High thumb */}
          <div
            className={`${rangeStyles.thumb} ${dragging === 'high' ? rangeStyles.thumbActive : ''}`}
            style={{ left: `${highPercent}%` }}
            onPointerDown={handleThumbDown('high')}
          />
        </div>
      </div>
    </div>
  );
}
