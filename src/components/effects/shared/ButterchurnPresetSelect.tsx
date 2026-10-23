'use client';

/**
 * ButterchurnPresetSelect — Searchable dropdown for Butterchurn presets.
 * Lazy-loads the preset list from butterchurn-presets on mount.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import styles from './ButterchurnPresetSelect.module.css';

interface ButterchurnPresetSelectProps {
  value: string;
  onChange: (presetName: string) => void;
}

export function ButterchurnPresetSelect({ value, onChange }: ButterchurnPresetSelectProps) {
  const [presetNames, setPresetNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [localValue, setLocalValue] = useState(value);
  const listRef = useRef<HTMLDivElement>(null);

  // Sync local value from prop (but only when prop actually changes from outside)
  const lastPropRef = useRef(value);
  useEffect(() => {
    if (value !== lastPropRef.current) {
      lastPropRef.current = value;
      setLocalValue(value);
    }
  }, [value]);

  // Lazy-load preset names from butterchurn-presets
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('butterchurn-presets');
        const presets = (mod.default || mod).getPresets();
        if (!cancelled) {
          const names = Object.keys(presets).sort();
          setPresetNames(names);
          setLoading(false);
        }
      } catch (err) {
        console.error('[ButterchurnPresetSelect] Failed to load presets:', err);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter presets by search term
  const filtered = useMemo(() => {
    if (!search.trim()) return presetNames;
    const lower = search.toLowerCase();
    return presetNames.filter((n) => n.toLowerCase().includes(lower));
  }, [presetNames, search]);

  const handleSelect = (name: string) => {
    setLocalValue(name);
    lastPropRef.current = name;
    onChange(name);
  };

  // Keyboard navigation on the list container
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const currentIndex = filtered.indexOf(localValue);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(currentIndex + 1, filtered.length - 1);
      handleSelect(filtered[next]);
      scrollToIndex(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(currentIndex - 1, 0);
      handleSelect(filtered[prev]);
      scrollToIndex(prev);
    }
  };

  const scrollToIndex = (index: number) => {
    if (!listRef.current) return;
    const items = listRef.current.children;
    if (items[index]) {
      (items[index] as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  };

  if (loading) {
    return (
      <div className={styles.wrapper}>
        <label className={styles.label}>Preset</label>
        <span className={styles.loading}>Loading presets…</span>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <label className={styles.label}>Preset</label>
      <input
        type="text"
        placeholder="Search presets…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className={styles.searchInput}
      />
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        aria-activedescendant={localValue ? `bc-preset-${localValue}` : undefined}
        className={styles.listbox}
      >
        {filtered.map((name) => (
          <div
            key={name}
            id={`bc-preset-${name}`}
            role="option"
            aria-selected={name === localValue}
            onClick={() => handleSelect(name)}
            className={`${styles.option} ${name === localValue ? styles.optionSelected : ''}`}
          >
            {name}
          </div>
        ))}
      </div>
      <span className={styles.count}>
        {filtered.length} / {presetNames.length} presets
      </span>
      <p className={styles.attribution}>
        Visualizer presets are community MilkDrop presets (Geiss, Rovastar, Flexi, Martin,
        Unchained, and others), bundled via the MIT-licensed <code>butterchurn-presets</code>{' '}
        package. The preset name often includes its author. See{' '}
        <a
          href="https://github.com/pnixon/threnic-oss/blob/main/LEGAL/THIRD_PARTY_NOTICES.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          third-party notices
        </a>
        .
      </p>
    </div>
  );
}
