import React from 'react';
import { FolderSync, CheckCircle2 } from 'lucide-react';

interface ApplyToAllButtonProps {
  /** Whether the action has been applied */
  applied: boolean;
  /** Click handler */
  onClick: () => void;
  /** Button label text */
  label: string;
  /** Applied state label text */
  appliedLabel?: string;
  /** Tooltip text */
  title?: string;
  /** Additional CSS class */
  className?: string;
}

/**
 * ApplyToAllButton - Reusable button for applying settings to all tracks
 */
export function ApplyToAllButton({
  applied,
  onClick,
  label,
  appliedLabel,
  title,
  className = '',
}: ApplyToAllButtonProps) {
  return (
    <button
      className={className}
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
        padding: '6px 0',
        fontSize: '11px',
        borderRadius: 4,
        background: applied ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.05)',
        color: applied ? '#4ade80' : 'rgba(255,255,255,0.6)',
        border: 'none',
        cursor: 'pointer',
        transition: 'all 0.2s',
      }}
      title={title}
    >
      {applied ? <CheckCircle2 size={12} /> : <FolderSync size={12} />}
      <span>{applied ? appliedLabel || 'Applied to All' : label}</span>
    </button>
  );
}
