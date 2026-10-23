import { createStore } from 'zustand/vanilla';

interface TimeState {
  currentTime: number;
  isPlaying: boolean;
  duration: number;
  mode: 'preview' | 'export';
  exportFps: number;
  lastSeekTime: number;

  // Actions
  setCurrentTime: (time: number, isSeek?: boolean) => void;
  setIsPlaying: (playing: boolean) => void;
  setDuration: (duration: number) => void;
  setMode: (mode: 'preview' | 'export') => void;
  stepFrame: () => void;
  reset: () => void;
}

export const timeStore = createStore<TimeState>((set) => ({
  currentTime: 0,
  isPlaying: false,
  duration: Infinity,
  mode: 'preview',
  exportFps: 60,
  lastSeekTime: -1,

  setCurrentTime: (time, isSeek = false) =>
    set((state) => ({
      currentTime: Math.max(0, Math.min(time, state.duration)),
      lastSeekTime: isSeek ? time : state.lastSeekTime,
    })),

  setIsPlaying: (playing) => set({ isPlaying: playing }),

  setDuration: (duration) => set({ duration }),

  setMode: (mode) => set({ mode }),

  stepFrame: () =>
    set((state) => ({
      currentTime: state.currentTime + 1 / state.exportFps,
    })),

  reset: () =>
    set({
      currentTime: 0,
      isPlaying: false,
      mode: 'preview',
      duration: Infinity,
      lastSeekTime: -1,
    }),
}));

if (typeof window !== 'undefined') {
  (window as unknown as { timeStore: typeof timeStore }).timeStore = timeStore;
}
