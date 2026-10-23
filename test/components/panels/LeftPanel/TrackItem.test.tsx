import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TrackItem } from '@/components/panels/PlaylistBrowser/TrackItem';
import React from 'react';

// Mock pragmatic-drag-and-drop
vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: vi.fn(() => () => {}),
  dropTargetForElements: vi.fn(() => () => {}),
}));
vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine: vi.fn(() => () => {}),
}));
vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
  attachClosestEdge: vi.fn(),
  extractClosestEdge: vi.fn(),
}));

describe('TrackItem', () => {
  const defaultProps = {
    track: { id: '1', name: 'Test Track', duration: 120, audioUrl: 'test.mp3' },
    index: 0,
    isSelected: false,
    isEditing: false,
    editName: '',
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onEditNameChange: vi.fn(),
    onEditFinish: vi.fn(),
    onEditCancel: vi.fn(),
    onAddLyrics: vi.fn(),
    dragOverEdge: null,
    setDragOverInfo: vi.fn(),
  };

  it('renders track name and duration', () => {
    render(<TrackItem {...defaultProps} />);

    expect(screen.getByText('Test Track')).toBeInTheDocument();
    expect(screen.getByText('2:00')).toBeInTheDocument();
  });

  it('calls onSelect when clicked', () => {
    render(<TrackItem {...defaultProps} />);

    fireEvent.click(screen.getByText('Test Track'));
    expect(defaultProps.onSelect).toHaveBeenCalled();
  });

  it('shows input when editing', () => {
    render(<TrackItem {...defaultProps} isEditing={true} editName="New Name" />);

    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('New Name');
  });

  it('calls onAddLyrics when add lyrics button clicked', () => {
    render(<TrackItem {...defaultProps} />);

    const addLyricsBtn = screen.getByTitle('Add Lyrics');
    fireEvent.click(addLyricsBtn);

    expect(defaultProps.onAddLyrics).toHaveBeenCalled();
  });
});
