import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Inspector as RightPanel } from '@/components/panels/Inspector/Inspector';
import { describe, it, expect, vi } from 'vitest';
import { HelpProvider } from '@/contexts/HelpContext';
import { PanelProvider } from '@/contexts/PanelContext';

// Mock child components
vi.mock('@/components/panels/Inspector/scene/SceneSettingsSection', () => ({
  SceneSettingsSection: () => <div data-testid="scene-settings">SceneSettings</div>,
}));
vi.mock('@/components/panels/Inspector/tabs/LyricsTab/TrackTitleSection', () => ({
  TrackTitleSection: () => <div data-testid="track-title-settings">TrackTitleSettings</div>,
}));
vi.mock('@/components/panels/Inspector/tabs/LyricsTab/LyricSettingsSection', () => ({
  LyricSettingsSection: () => <div data-testid="lyric-settings">LyricSettings</div>,
}));
vi.mock('@/components/panels/Inspector/tabs/EffectsTab/EffectsSettingsSection', () => ({
  EffectsSettingsSection: () => <div data-testid="effects-settings">EffectsSettings</div>,
}));
vi.mock('@/components/panels/Inspector/BandMeterWidget', () => ({
  BandMeterWidget: () => <div data-testid="band-meter">BandMeter</div>,
}));
vi.mock('@/components/panels/Inspector/tabs/ExportTab/ExportTab', () => ({
  ExportTab: () => <div data-testid="export-tab">ExportTab</div>,
}));
vi.mock('@/components/panels/Inspector/tabs/LyricsTab/LyricSyncSection', () => ({
  LyricSyncSection: () => <div data-testid="lyric-sync">LyricSyncSection</div>,
}));
vi.mock('@/components/panels/Inspector/tabs/ExportTab/ProjectStateSection', () => ({
  ProjectStateSection: () => <div data-testid="project-state">ProjectState</div>,
}));
vi.mock('@/components/panels/Inspector/KeyframeDropdown', () => ({
  KeyframeDropdown: () => <div data-testid="keyframe-dropdown">KeyframeDropdown</div>,
}));
vi.mock('@/components/lyrics-sync/LyricSyncPanel', () => ({
  LyricSyncPanel: () => <div data-testid="lyric-sync-panel">LyricSyncPanel</div>,
}));

vi.mock('@/contexts/KeyframeSelectionContext', () => ({
  useKeyframeSelection: () => ({
    selectedKeyframeId: 'default',
    setSelectedKeyframeId: vi.fn(),
    getSelectedKeyframe: vi.fn(),
    setKeyframes: vi.fn(),
    clearSelection: vi.fn(),
    isManualSelection: false,
    activeLane: 'effects',
    setActiveLane: vi.fn(),
  }),
}));

vi.mock('@/contexts/PlaylistContext', () => ({
  usePlaylistState: () => ({
    selectedTrackId: '1',
    tracks: [{ id: '1' }],
    isLoading: false,
  }),
  useTrackManagementAPI: () => ({
    getSelectedTrack: vi.fn(() => ({ id: '1' })),
  }),
  useTrackConfigAPI: () => ({
    updateTrackBackground: vi.fn(),
    applyBackgroundToAll: vi.fn(),
    updateTrackLyrics: vi.fn(),
    updateTrackProperty: vi.fn(),
    updateTrackEffectInstance: vi.fn(),
    addTrackKeyframe: vi.fn(),
  }),
  usePlaylistSettingsAPI: () => ({
    settings: {},
    applyBackgroundToAll: vi.fn(),
    applyEffectsToAll: vi.fn(),
    applyThemeToAll: vi.fn(),
    applyTrackTitleToAll: vi.fn(),
  }),
  useProjectIOAPI: () => ({
    exportCurrentProject: vi.fn(),
  }),
}));

vi.mock('@/components/stage/hooks/useScheduleAware', () => ({
  useScheduleAwareEffectsConfigUI: (cfg: any) => cfg,
  useScheduleAwareThemeUI: (theme: any) => theme,
}));

vi.mock('@/engine/EngineState', () => ({
  EngineState: { currentTime: 0 },
}));

describe('RightPanel', () => {
  it('renders effects tab by default and allows switching to other tabs', async () => {
    await act(async () => {
      render(
        <PanelProvider>
          <HelpProvider>
            <RightPanel />
          </HelpProvider>
        </PanelProvider>,
      );
    });

    // Default view is the effects tab
    expect(screen.getByTestId('effects-settings')).toBeInTheDocument();

    // Switch to tab "Lyrics"
    const lyricsTab = screen.getByTestId('tab-lyrics');
    await act(async () => {
      fireEvent.click(lyricsTab);
    });
    expect(screen.getByTestId('track-title-settings')).toBeInTheDocument();
    expect(screen.getByTestId('lyric-sync')).toBeInTheDocument();
  });
});
