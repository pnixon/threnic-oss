import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PlaylistContextMenu } from '@/components/panels/PlaylistBrowser/PlaylistContextMenu';
import React from 'react';

import { Track } from '@/contexts/PlaylistContext';

describe('PlaylistContextMenu', () => {
  const defaultProps = {
    x: 100,
    y: 100,
    trackId: '1',
    tracks: [{ id: '1', name: 'Track 1' } as unknown as Track],
    onStartRename: vi.fn(),
    onTriggerAudioReplace: vi.fn(),
    onTriggerLyricsPicker: vi.fn(),
    onOpenSyncModal: vi.fn(),
    onRemoveTrack: vi.fn(),
    onClose: vi.fn(),
  };

  it('renders menu options', () => {
    render(<PlaylistContextMenu {...defaultProps} />);

    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('Replace Audio')).toBeInTheDocument();
    expect(screen.getByText('Load Lyrics')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('calls handlers when options clicked', () => {
    render(<PlaylistContextMenu {...defaultProps} />);

    fireEvent.click(screen.getByText('Rename'));
    expect(defaultProps.onStartRename).toHaveBeenCalledWith(defaultProps.tracks[0]);

    fireEvent.click(screen.getByText('Delete'));
    expect(defaultProps.onRemoveTrack).toHaveBeenCalledWith('1');
    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});
