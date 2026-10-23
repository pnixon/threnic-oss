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
  currentTime?: number;
  property?: string;
}

export function LogSliderField({
  label,
  value,
  onChange,
  min,
  max,
  currentTime: propTime,
  property: propName,
}: SliderFieldProps) {
  const { keyframes, selectedKeyframeId, updateProperty } = useKeyframes();
  const editorCtx = useEffectEditor();

  const currentTime = propTime ?? editorCtx?.currentTime;
  const property =
    editorCtx?.propertyPrefix && propName && !propName.startsWith(editorCtx.propertyPrefix)
      ? `${editorCtx.propertyPrefix}.${propName}`
      : propName;

  const safeValue = Math.max(min, Math.min(max, value));
  const minLog = Math.log(min);
  const maxLog = Math.log(max);

  // Calculate 0-1 position for the range input
  const position = (Math.log(safeValue) - minLog) / (maxLog - minLog);

  const [inputValue, setInputValue] = useState(Math.round(safeValue).toString());
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      requestAnimationFrame(() => {
        setInputValue(Math.round(value).toString());
      });
    }
  }, [value]);

  const handleChange = (val: number) => {
    onChange(val);
    if (property) {
      updateProperty(property, val, selectedKeyframeId);
    }
  };

  const handleSliderChange = (t: number) => {
    const newValue = Math.exp(minLog + t * (maxLog - minLog));
    handleChange(newValue);
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
      setInputValue(Math.round(clamped).toString());
      if (clamped !== value) handleChange(clamped);
    } else {
      setInputValue(Math.round(value).toString());
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
      style={{ cursor: keyframes ? 'context-menu' : 'default' }}
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
            min={min}
            max={max}
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
        min={0}
        max={1}
        step={0.001}
        value={position}
        onChange={(e) => handleSliderChange(parseFloat(e.target.value))}
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
