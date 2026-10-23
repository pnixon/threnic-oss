import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AudioMonitorSection } from '@/components/panels/PlaylistBrowser/AudioMonitorSection';
import React from 'react';
import { PanelProvider } from '@/contexts/PanelContext';

// Mock AudioMonitor
vi.mock('@/components/panels/PlaylistBrowser/AudioMonitor', () => ({
  default: () => <div data-testid="audio-monitor" />,
}));

describe('AudioMonitorSection', () => {
  const defaultProps = {
    isMonitorExpanded: true,
    setIsMonitorExpanded: vi.fn(),
  };

  it('renders audio monitor when expanded', () => {
    render(
      <PanelProvider>
        <AudioMonitorSection {...defaultProps} />
      </PanelProvider>,
    );

    expect(screen.getByText('Audio Monitor')).toBeInTheDocument();
    expect(screen.getByTestId('audio-monitor')).toBeInTheDocument();
  });
});
