import React from 'react';
import { createPortal } from 'react-dom';
import { Edit3, Upload, FileText, Timer, Trash2 } from 'lucide-react';
import { DropdownPanel, DropdownItem, DropdownDivider } from '@/components/shared/DropdownMenu';
import type { Track } from '@/contexts/types';

interface PlaylistContextMenuProps {
  x: number;
  y: number;
  trackId: string;
  tracks: Track[];
  onStartRename: (track: Track) => void;
  onTriggerAudioReplace: (trackId: string) => void;
  onTriggerLyricsPicker: (trackId: string) => void;
  onOpenSyncModal: (trackId: string) => void;
  onRemoveTrack: (trackId: string) => void;
  onClose: () => void;
}

export function PlaylistContextMenu({
  x,
  y,
  trackId,
  tracks,
  onStartRename,
  onTriggerAudioReplace,
  onTriggerLyricsPicker,
  onOpenSyncModal,
  onRemoveTrack,
  onClose,
}: PlaylistContextMenuProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Measure the panel's real size, then clamp it fully inside the viewport.
  // Runs in a layout effect (before paint) and re-runs until a real width is
  // reported, so the menu is never shown at an unclamped position and can't
  // overflow the right/bottom edges (notably the mobile drawer + bottom nav).
  React.useLayoutEffect(() => {
    if (!mounted) return;

    const place = () => {
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // If the browser hasn't laid the portal out yet (width 0), retry next frame.
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(place);
        return;
      }

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isMobile = vw <= 768;
      const bottomInset = isMobile ? 80 : 8; // mobile bottom nav ≈ 56px + safe area
      const margin = 8;

      let nx = x;
      let ny = y;
      // Keep the whole menu on-screen horizontally; flip to the left of the
      // anchor if it would run off the right edge.
      if (nx + rect.width + margin > vw) nx = Math.max(margin, x - rect.width);
      if (nx + rect.width + margin > vw) nx = vw - rect.width - margin;
      // Vertically: clamp above the bottom nav; flip up if needed.
      if (ny + rect.height + margin > vh - bottomInset) {
        ny = vh - bottomInset - rect.height - margin;
      }
      if (nx < margin) nx = margin;
      if (ny < margin) ny = margin;

      setPosition({ x: nx, y: ny });
    };

    place();
  }, [x, y, mounted]);

  if (!mounted) return null;

  return createPortal(
    <DropdownPanel
      ref={panelRef}
      data-testid="playlist-context-menu"
      style={{
        position: 'fixed',
        left: position ? position.x : x,
        top: position ? position.y : y,
        zIndex: 10000,
        // Hidden until measured+clamped so it never flashes off-screen.
        visibility: position ? 'visible' : 'hidden',
        // Never let the menu exceed the viewport width on small screens.
        maxWidth: 'calc(100vw - 16px)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <>
        <DropdownItem
          icon={<Edit3 size={14} />}
          onClick={() => {
            const track = tracks.find((t) => t.id === trackId);
            if (track) onStartRename(track);
          }}
        >
          Rename
        </DropdownItem>
        <DropdownItem icon={<Upload size={14} />} onClick={() => onTriggerAudioReplace(trackId)}>
          Replace Audio
        </DropdownItem>
        <DropdownItem icon={<FileText size={14} />} onClick={() => onTriggerLyricsPicker(trackId)}>
          Load Lyrics
        </DropdownItem>
        <DropdownItem icon={<Timer size={14} />} onClick={() => onOpenSyncModal(trackId)}>
          Sync Lyrics
        </DropdownItem>
        <DropdownDivider />
        <DropdownItem
          icon={<Trash2 size={14} />}
          danger
          onClick={() => {
            onRemoveTrack(trackId);
            onClose();
          }}
        >
          Delete
        </DropdownItem>
      </>
    </DropdownPanel>,
    document.body,
  );
}
