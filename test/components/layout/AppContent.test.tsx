import { render, screen, fireEvent, act } from '@testing-library/react';
import { AppContent } from '@/components/layout/AppContent';
import { expect, vi, it, describe, beforeEach } from 'vitest';
import React from 'react';

// Mock Lucide icons
vi.mock('lucide-react', () => ({
  Smartphone: () => null,
  Monitor: () => null,
  Square: () => null,
  ChevronDown: () => null,
}));

// Mock sub-components
vi.mock('@/components/layout', () => ({
  AppShell: ({
    header,
    leftPanel,
    rightPanel,
    centerStage,
    timeline,
    overlays,
  }: {
    header: React.ReactNode;
    leftPanel: React.ReactNode;
    rightPanel: React.ReactNode;
    centerStage: React.ReactNode;
    timeline: React.ReactNode;
    overlays: React.ReactNode;
  }) => (
    <div data-testid="app-shell">
      {header}
      {leftPanel}
      {rightPanel}
      {centerStage}
      {timeline}
      {overlays}
    </div>
  ),
  Header: () => <div data-testid="header" />,
}));

vi.mock('@/components/panels', () => ({
  PlaylistBrowser: () => <div data-testid="left-panel" />,
  Inspector: () => <div data-testid="right-panel" />,
  Timeline: () => <div data-testid="timeline" />,
  ExportSettings: () => <div data-testid="export-settings" />,
}));

vi.mock('@/components/panels/BottomPanel/BottomPanel', () => ({
  BottomPanel: ({ onPlayPause }: { onPlayPause: () => void }) => (
    <div data-testid="bottom-panel">
      <button data-testid="play-pause-btn" onClick={onPlayPause}>
        Play/Pause
      </button>
    </div>
  ),
}));

vi.mock('@/components/layout/ViewportControls', () => ({
  ViewportControls: () => <div data-testid="viewport-controls" />,
}));

vi.mock('@/components/stage/CenterStage', () => ({
  CenterStage: () => <div data-testid="center-stage" />,
}));

vi.mock('@/components/stage/GPUCanvas', () => ({
  GPUCanvas: () => <div data-testid="gpu-canvas" />,
}));

vi.mock('@/components/stage/LyricsCanvas', () => ({
  LyricsCanvas: () => <div data-testid="lyrics-canvas" />,
}));

vi.mock('@/components/audio', () => ({
  // Use a plain function that handles ref instead of React.forwardRef to avoid hoisting issues
  AudioPlayer: () => <div data-testid="audio-player" />,
}));

vi.mock('@/engine/stores/timeStore', () => ({
  timeStore: {
    getState: vi.fn().mockReturnValue({
      currentTime: 0,
      mode: 'preview',
      setCurrentTime: vi.fn(),
      setIsPlaying: vi.fn(),
      setDuration: vi.fn(),
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('@/engine/export', () => ({
  useExportMode: () => ({
    isExporting: false,
    progress: { percentage: 0 },
    startExport: vi.fn(),
    cancelExport: vi.fn(),
    isSupported: true,
    config: { mode: 'full' },
    setConfig: vi.fn(),
  }),
}));

// Mock Contexts
vi.mock('@/contexts/PlaylistContext', () => {
  return {
    usePlaylist: () => ({
      getSelectedTrack: () => ({
        id: 'test-track',
        name: 'Test Track',
        audioUrl: 'test.mp3',
        lyricsData: [],
        backgroundImage: null,
      }),
      selectedTrackId: 'test-track',
      updateTrackBackground: vi.fn(),
      updateTrackEffects: vi.fn(),
      updateTrackLyrics: vi.fn(),
      selectNextTrack: vi.fn(),
      selectPreviousTrack: vi.fn(),
      selectTrack: vi.fn(),
      restorePlaylist: vi.fn(),
      tracks: [],
      isLoading: false,
      settings: { autoNext: true },
      updateSettings: vi.fn(),
    }),
    usePlaylistState: () => ({
      selectedTrackId: 'test-track',
      tracks: [
        {
          id: 'test-track',
          name: 'Test Track',
          audioUrl: 'test.mp3',
          lyricsData: [],
          backgroundImage: null,
        },
      ],
      isLoading: false,
      settings: { autoNext: true },
    }),
    usePlaylistSettingsAPI: () => ({
      settings: { autoNext: true },
      updateSettings: vi.fn(),
    }),
    useTrackManagementAPI: () => ({
      getSelectedTrack: () => ({
        id: 'test-track',
        name: 'Test Track',
        audioUrl: 'test.mp3',
        lyricsData: [],
        backgroundImage: null,
      }),
      selectNextTrack: vi.fn(),
      selectPreviousTrack: vi.fn(),
      selectTrack: vi.fn(),
    }),
    useTrackConfigAPI: () => ({
      updateTrackBackground: vi.fn(),
      updateTrackEffects: vi.fn(),
      updateTrackLyrics: vi.fn(),
    }),
    useProjectIOAPI: () => ({
      restorePlaylist: vi.fn(),
      importProject: vi.fn(),
      exportCurrentProject: vi.fn(),
    }),
  };
});

vi.mock('@/contexts/KeyframeSelectionContext', () => ({
  useKeyframeSelection: () => ({
    selectedKeyframeId: 'default',
    setSelectedKeyframeId: vi.fn(),
    getSelectedKeyframe: vi.fn(() => null),
    setKeyframes: vi.fn(),
    clearSelection: vi.fn(),
    isManualSelection: false,
  }),
}));

// Mock Hooks
vi.mock('@/hooks', () => ({
  useGlobalKeyboardShortcuts: vi.fn(),
  useDebounce: <T,>(val: T) => val,
  useMediaQuery: vi.fn(() => false),
}));

// Mock Utils
vi.mock('@/utils', () => ({
  collectProjectState: vi.fn(() => ({})),
  loadProject: vi.fn(),
  safeStringify: vi.fn((val) => JSON.stringify(val)),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/utils/indexedDB', () => ({
  saveProjectToIDB: vi.fn(),
  loadProjectFromIDB: vi.fn(() => Promise.resolve(null)),
}));

// Mock Constants and types
vi.mock('@/constants/fonts', () => ({
  getFontUrl: vi.fn(),
  FONTS: [{ id: 'roboto', defaultWordSpacing: 1.0, charWidthMultiplier: 0.6 }],
}));

vi.mock('@/types/lyrics', () => ({
  lyricLinesToThrenicWords: vi.fn(() => []),
  threnicWordsToLyricLines: vi.fn(() => []),
  reconcileWordTimings: vi.fn(),
  DEFAULT_LYRICS_THEME: {
    fontSize: 48,
    fontId: 'roboto',
    verticalPosition: 50,
    lyricColors: { pre: '#888', active: '#fff', post: '#888' },
    wordSpacing: 1,
    glowEnabled: false,
    glowColor: '#ffffff',
    glowIntensity: 0.5,
    outlineColor: 'transparent',
    fadeInDuration: 0.3,
    fadeOutDuration: 0.3,
    highlightFadeIn: 0.15,
    highlightFadeOut: 0.3,
    animationType: 'none',
    animationStagger: 0.05,
    activeScaleEnabled: false,
    effectScope: 'word',
  },
}));

vi.mock('@/types/effects', () => ({
  DEFAULT_EFFECTS_CONFIG: {
    postProcessing: {},
    particles: { enabled: false, audioReactive: { count: { enabled: false } } },
    rain: { enabled: false },
  },
}));

vi.mock('@/types/export', () => ({
  QUALITY_TIERS: { High: { label: 'High', baseHeight: 1080 } },
  ASPECT_RATIOS: { Landscape: { label: 'Landscape', ratio: 16 / 9 } },
  calcDimensions: vi.fn(() => ({ width: 1920, height: 1080 })),
}));

vi.mock('@/types/exportConstants', () => ({
  ASPECT_RATIOS: { Landscape: { label: 'Landscape', ratio: 16 / 9 } },
  calcDimensions: vi.fn(() => ({ width: 1920, height: 1080 })),
}));

// Mock Zustand-backed hooks
vi.mock('@/hooks/useLyricsThemeState', () => ({
  useLyricsThemeState: () => ({
    verticalPosition: 50,
    fontSize: 48,
    selectedFontId: 'roboto',
    lyricColors: { pre: '#888', active: '#fff', post: '#888' },
    wordSpacing: 1,
    glowEnabled: false,
    glowColor: '#ffffff',
    glowIntensity: 0.5,
    outlineColor: 'transparent',
    fadeInDuration: 0.3,
    fadeOutDuration: 0.3,
    highlightFadeIn: 0.15,
    highlightFadeOut: 0.3,
    animationType: 'none',
    animationStagger: 0.05,
    activeScaleEnabled: false,
    effectScope: 'word',
    setVerticalPosition: vi.fn(),
    setFontSize: vi.fn(),
    setSelectedFontId: vi.fn(),
    setLyricColors: vi.fn(),
    setWordSpacing: vi.fn(),
    setGlowEnabled: vi.fn(),
    setGlowColor: vi.fn(),
    setGlowIntensity: vi.fn(),
    setOutlineColor: vi.fn(),
    setFadeInDuration: vi.fn(),
    setFadeOutDuration: vi.fn(),
    setHighlightFadeIn: vi.fn(),
    setHighlightFadeOut: vi.fn(),
    setAnimationType: vi.fn(),
    setAnimationStagger: vi.fn(),
    setActiveScaleEnabled: vi.fn(),
    setEffectScope: vi.fn(),
    handleFontChange: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTrackEffectsState', () => ({
  useTrackEffectsState: () => ({
    effectsConfig: {
      postProcessing: {},
      particles: { enabled: false },
      rain: { enabled: false },
    },
    keyframes: [],
    videoClips: [],
    backgroundImage: null,
    effectiveBackground: null,
    handleEffectsChange: vi.fn(),
    handleBackgroundChange: vi.fn(),
    handleVideoClipsUpdate: vi.fn(),
    setKeyframes: vi.fn(),
    setVideoClips: vi.fn(),
    setLocalBackgroundUrl: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTrackLyricsState', () => ({
  useTrackLyricsState: () => ({
    words: [],
    setWords: vi.fn(),
    wordsRef: { current: [] },
  }),
}));

vi.mock('@/engine/stores/exportUIStore', () => ({
  exportUIStore: {
    getState: vi.fn().mockReturnValue({
      exportQuality: 'High',
      exportAspect: 'Landscape',
      selectionRange: null,
      previewRatio: 16 / 9,
      exportWidth: 1920,
      exportHeight: 1080,
    }),
    subscribe: vi.fn(() => () => {}),
    setState: vi.fn(),
  },
  useExportUIStore: (selector?: (s: any) => any) => {
    const state = {
      exportQuality: 'High',
      exportAspect: 'Landscape',
      selectionRange: null,
      previewRatio: 16 / 9,
      exportWidth: 1920,
      exportHeight: 1080,
      setExportQuality: vi.fn(),
      setExportAspect: vi.fn(),
      setSelectionRange: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('AppContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all main components', async () => {
    // Wrap in act because of usePlaylist restore logic and other effects
    await act(async () => {
      render(<AppContent />);
    });

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('audio-player')).toBeInTheDocument();
  });

  it('handles play/pause button click', async () => {
    await act(async () => {
      render(<AppContent />);
    });

    const playBtn = screen.getByTestId('play-pause-btn');
    fireEvent.click(playBtn);

    const { timeStore } = await import('@/engine/stores/timeStore');
    expect(timeStore.getState().setIsPlaying).toHaveBeenCalled();
  });
});
