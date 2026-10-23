/**
 * trackStore — Vanilla Zustand store for the currently-selected track's
 * rendering-relevant state.
 *
 * GPUCanvas reads from this store directly instead of receiving props from
 * AppContent. This eliminates the React re-render chain: AppContent →
 * CenterStage → GPUCanvas that was triggered every time effectsConfig changed.
 *
 * AppContent writes to this store imperatively (no re-render needed on its side)
 * whenever the selected track or effectsConfig changes.
 */

import { createStore } from 'zustand/vanilla';
import type { EffectsConfig } from '@/types/effects';
import type { VideoClip } from '@/types/video-clips';

export interface TrackStoreState {
  /** Currently selected track ID */
  trackId: string | null;
  /** Track-level default background image URL (blob URL or null) */
  backgroundImageUrl: string | null;
  /** Current effective effects config (base + keyframe overrides from AppContent) */
  effectsConfig: EffectsConfig | null;
  /** Background timeline NLE clips */
  videoClips: VideoClip[];
  /** Whether export is in progress */
  isExporting: boolean;

  // Actions
  setTrack: (
    trackId: string | null,
    backgroundImageUrl: string | null,
    videoClips?: VideoClip[],
  ) => void;
  setEffectsConfig: (config: EffectsConfig | null) => void;
  setVideoClips: (clips: VideoClip[]) => void;
  setIsExporting: (value: boolean) => void;
}

export const trackStore = createStore<TrackStoreState>((set) => ({
  trackId: null,
  backgroundImageUrl: null,
  effectsConfig: null,
  videoClips: [],
  isExporting: false,

  setTrack: (trackId, backgroundImageUrl, videoClips) =>
    set({ trackId, backgroundImageUrl, videoClips: videoClips ?? [] }),
  setEffectsConfig: (effectsConfig) => set({ effectsConfig }),
  setVideoClips: (videoClips) => set({ videoClips }),
  setIsExporting: (isExporting) => set({ isExporting }),
}));

if (typeof window !== 'undefined') {
  (window as unknown as { trackStore: typeof trackStore }).trackStore = trackStore;
}
