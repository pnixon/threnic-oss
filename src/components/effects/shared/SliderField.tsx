'use client';

import React, { useState, useEffect, useRef } from 'react';
import styles from '../../modals/EffectsModal.module.css';

import { AutoResizingText } from './AutoResizingText';
import { KeyframeMenu } from './KeyframeMenu';

import { useKeyframes } from '@/hooks/useKeyframes';
import { useEffectEditor } from './EffectEditorContext';

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  currentTime?: number;
  property?: string;
  disabled?: boolean;
}

export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  currentTime: propTime,
  property: propName,
  disabled = false,
}: SliderFieldProps) {
  const { keyframes, selectedKeyframeId, updateProperty } = useKeyframes();
  const editorCtx = useEffectEditor();

  const currentTime = propTime ?? editorCtx?.currentTime;
  // If property is just a name like 'intensity', and context has 'effects.postProcessing.bloom',
  // full path becomes 'effects.postProcessing.bloom.intensity'
  const property =
    editorCtx?.propertyPrefix && propName && !propName.startsWith(editorCtx.propertyPrefix)
      ? `${editorCtx.propertyPrefix}.${propName}`
      : propName;

  const getPrecision = (s: number) => {
    const parts = s.toString().split('.');
    return parts.length > 1 ? parts[1].length : 0;
  };

  const safeValue = typeof value === 'number' && !isNaN(value) ? value : min;
  const precision = getPrecision(step);
  const [inputValue, setInputValue] = useState(safeValue.toFixed(precision));
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      const newVal = safeValue.toFixed(precision);
      requestAnimationFrame(() => {
        setInputValue((prev) => (prev !== newVal ? newVal : prev));
      });
    }
  }, [safeValue, precision]);

  const handleChange = (val: number) => {
    onChange(val);
    if (property) {
      // Use the targeted keyframe ID from context if available, otherwise fallback to selected
      const targetId = editorCtx?.targetKeyframeId ?? selectedKeyframeId;
      updateProperty(property, val, targetId);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setInputValue(newVal);

    const parsed = parseFloat(newVal);
    if (!isNaN(parsed)) {
      const clamped = Math.min(Math.max(parsed, min), max);
      handleChange(clamped);
    }
  };

  const handleBlur = () => {
    const parsed = parseFloat(inputValue);
    if (!isNaN(parsed)) {
      const clamped = Math.min(Math.max(parsed, min), max);
      setInputValue(clamped.toFixed(precision));
      if (clamped !== value) handleChange(clamped);
    } else {
      setInputValue(value.toFixed(precision));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
    e.stopPropagation();
  };

  const hasKeyframeAtCurrentTime = () => {
    if (!keyframes || currentTime === undefined || !property) return false;
    return keyframes.some(
      (kf) => kf.properties[property] !== undefined && Math.abs(kf.time - currentTime) < 0.01,
    );
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (keyframes && currentTime !== undefined && property) {
      e.preventDefault();
      e.stopPropagation();
      setMenuPos({ x: e.clientX, y: e.clientY });
    }
  };

  const isKeyframed = hasKeyframeAtCurrentTime();

  return (
    <div
      className={`${styles.field} ${isKeyframed ? styles.keyframed : ''}`}
      onContextMenu={handleContextMenu}
      style={{ cursor: keyframes ? 'context-menu' : 'default', opacity: disabled ? 0.5 : 1 }}
    >
      <div className={styles.fieldHeader}>
        <AutoResizingText className={styles.fieldLabel} tagName="label">
          {isKeyframed && (
            <span
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                background: '#22d3ee',
                transform: 'rotate(45deg)',
                marginRight: 6,
                marginBottom: 1,
              }}
            />
          )}
          {label}
        </AutoResizingText>
        <div className="relative" style={{ order: 3, marginLeft: '8px' }}>
          <input
            ref={inputRef}
            type="number"
            className={styles.fieldValue}
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            step={step}
            min={min}
            max={max}
            disabled={disabled}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: '44px',
              border: 'none',
              outline: 'none',
              appearance: 'textfield',
              MozAppearance: 'textfield',
              padding: '1px 4px',
              margin: 0,
              cursor: 'text',
              color: isKeyframed ? '#22d3ee' : 'inherit',
            }}
          />
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => handleChange(parseFloat(e.target.value))}
        className={`${styles.slider} ${isKeyframed ? styles.keyframedSlider : ''}`}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />

      {menuPos && keyframes && currentTime !== undefined && property && (
        <KeyframeMenu
          pos={menuPos}
          currentTime={currentTime}
          property={property}
          currentValue={value}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}
