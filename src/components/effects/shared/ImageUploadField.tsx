'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  saveEffectImageAsset,
  loadEffectImageBlob,
  removeEffectImageAsset,
  newEffectImageAssetId,
} from '@/engine/gpu/effectImageAssets';

/**
 * ImageUploadField — a compact file-upload control for effect schemas.
 *
 * Stores the selected image in IndexedDB (via effectImageAssets) and reports
 * only the opaque asset id up to the effect config. Shows a thumbnail preview
 * (loaded back from IDB) and a Remove button.
 *
 * Inline-style conventions mirror TriggerLevelWidget (var(--text-muted),
 * var(--border), fontSize ~9–10).
 */

interface ImageUploadFieldProps {
  label: string;
  /** The current image asset id, or undefined when none is set. */
  value: string | undefined;
  /** Called with the new asset id (on upload) or undefined (on remove). */
  onChange: (newAssetId: string | undefined) => void;
}

export function ImageUploadField({ label, value, onChange }: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);

  // ── Load a preview object URL from IDB whenever the value changes ──
  // All setState happens asynchronously (inside the resolved promise), never
  // synchronously in the effect body, to avoid cascading-render lint/perf.
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;

    const load = async () => {
      const blob = value ? await loadEffectImageBlob(value) : undefined;
      if (cancelled) return;
      if (blob) {
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      } else {
        setPreviewUrl(undefined);
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [value]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so selecting the same file again re-fires onChange.
    e.target.value = '';
    if (!file) return;
    const assetId = newEffectImageAssetId();
    await saveEffectImageAsset(assetId, file);
    onChange(assetId);
  };

  const handleRemove = async () => {
    if (value) {
      await removeEffectImageAsset(value);
    }
    onChange(undefined);
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 4,
        }}
      >
        {label}
      </div>

      {previewUrl && (
        <div style={{ marginBottom: 4 }}>
          <img
            src={previewUrl}
            alt={label}
            style={{
              display: 'block',
              width: '100%',
              maxHeight: 96,
              objectFit: 'contain',
              borderRadius: 3,
              border: '1px solid var(--border)',
              background: 'rgba(0,0,0,0.2)',
            }}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          style={{
            flex: 1,
            padding: '4px 8px',
            fontSize: 9,
            fontWeight: 600,
            border: '1px solid var(--border)',
            borderRadius: 3,
            cursor: 'pointer',
            background: 'var(--bg-input)',
            color: 'var(--text-secondary)',
          }}
        >
          {value ? 'Replace Image' : 'Upload Image'}
        </button>
        {value && (
          <button
            type="button"
            onClick={handleRemove}
            style={{
              padding: '4px 8px',
              fontSize: 9,
              fontWeight: 600,
              border: '1px solid var(--border)',
              borderRadius: 3,
              cursor: 'pointer',
              background: 'var(--bg-input)',
              color: 'var(--text-muted)',
            }}
          >
            Remove
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
    </div>
  );
}
