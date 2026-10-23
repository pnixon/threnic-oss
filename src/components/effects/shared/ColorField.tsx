'use client';

import React, { useState } from 'react';
import styles from '../../modals/EffectsModal.module.css';
import { KeyframeMenu } from './KeyframeMenu';

import { useKeyframes } from '@/hooks/useKeyframes';
import { useEffectEditor } from './EffectEditorContext';

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  currentTime?: number;
  property?: string;
}

export function ColorField({
  label,
  value,
  onChange,
  currentTime: propTime,
  property: propName,
}: ColorFieldProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const { keyframes, selectedKeyframeId, updateProperty } = useKeyframes();
  const editorCtx = useEffectEditor();

  const currentTime = propTime ?? editorCtx?.currentTime;
  const property =
    editorCtx?.propertyPrefix && propName && !propName.startsWith(editorCtx.propertyPrefix)
      ? `${editorCtx.propertyPrefix}.${propName}`
      : propName;

  const handleColorChange = (val: string) => {
    onChange(val);
    if (property) {
      updateProperty(property, val, selectedKeyframeId);
    }
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
      className={styles.field}
      onContextMenu={handleContextMenu}
      style={{ cursor: keyframes ? 'context-menu' : 'default' }}
    >
      <div className={styles.fieldHeader} style={{ marginBottom: 4 }}>
        <label className={styles.fieldLabel}>
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
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="relative w-10 h-7 rounded overflow-hidden border border-white/10 shrink-0">
          <input
            type="color"
            value={value || '#ffffff'}
            onChange={(e) => handleColorChange(e.target.value)}
            className="absolute inset-0 w-[150%] h-[150%] -top-[25%] -left-[25%] cursor-pointer p-0 border-0"
          />
        </div>
        <span
          style={{
            fontSize: '10px',
            fontFamily: 'monospace',
            color: isKeyframed ? '#22d3ee' : 'var(--text-muted)',
            textTransform: 'uppercase',
          }}
        >
          {value}
        </span>
      </div>

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
