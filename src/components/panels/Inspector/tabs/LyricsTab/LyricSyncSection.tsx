'use client';

import React from 'react';
import { Type, Upload, Music, FileText } from 'lucide-react';
import { CollapsibleSection } from '../../CollapsibleSection';
import styles from '../../Inspector.module.css';

interface LyricSyncSectionProps {
  hasLyrics: boolean;
  onImportLyrics?: () => void;
  onSyncLyrics?: () => void;
  trackName?: string;
  forceOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
}

export function LyricSyncSection({
  hasLyrics,
  onImportLyrics,
  onSyncLyrics,
  trackName,
  forceOpen,
  open,
  onToggle,
}: LyricSyncSectionProps) {
  return (
    <CollapsibleSection
      title="Lyrics Content & Sync"
      icon={<Type size={14} />}
      defaultOpen={true}
      maxHeight={500}
      forceOpen={forceOpen}
      open={open}
      onToggle={onToggle}
    >
      <div className="flex flex-col gap-4 p-4 items-center justify-center min-h-[160px] text-center">
        {!hasLyrics ? (
          <>
            <div className="w-12 h-12 rounded-full bg-[var(--bg-hover)] flex items-center justify-center mb-2">
              <Music size={24} className="text-[var(--text-muted)] opacity-50" />
            </div>
            <div className="text-sm text-[var(--text-secondary)] font-medium">No Lyrics Found</div>
            <div className="text-xs text-[var(--text-muted)] max-w-[200px] leading-relaxed mb-2">
              Import a lyrics file or open the sync editor to create them for{' '}
              {trackName || 'this track'}.
            </div>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-full bg-[var(--bg-hover)] flex items-center justify-center mb-2">
              <FileText size={24} className="text-[var(--accent-main)] opacity-70" />
            </div>
            <div className="text-sm text-[var(--text-secondary)] font-medium">Lyrics Loaded</div>
            <div className="text-xs text-[var(--text-muted)] max-w-[200px] leading-relaxed mb-2">
              Lyrics are synced and ready. You can re-sync or import a new file below.
            </div>
          </>
        )}

        <div className="flex flex-col gap-3 w-full">
          <button
            className={styles.actionBtn}
            onClick={onImportLyrics}
            style={{
              justifyContent: 'center',
              gap: 8,
              padding: '10px',
              background: 'var(--bg-hover)',
              border: '1px solid var(--border-subtle)',
              transition: 'all 0.2s',
            }}
          >
            <Upload size={14} />
            <span>Import Lyrics File</span>
          </button>
          <button
            className={styles.actionBtn}
            onClick={onSyncLyrics}
            style={{
              justifyContent: 'center',
              gap: 8,
              padding: '10px',
              background: 'var(--accent-muted)',
              color: 'var(--accent-main)',
              border: '1px solid var(--accent-glow)',
              transition: 'all 0.2s',
            }}
          >
            <Music size={14} />
            <span>Open Sync Editor</span>
          </button>
        </div>
      </div>
    </CollapsibleSection>
  );
}
