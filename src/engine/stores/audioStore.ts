import { createStore } from 'zustand/vanilla';
import type { AudioSourceType } from '@/types/audioSources';
import type { AudioSourceManager } from '../audio/AudioSourceManager';
import { AudioAnalyzer } from '../export/AudioAnalyzer';

// A freshly-created (never-written) time-domain buffer must represent SILENCE,
// not zeros. AnalyserNode.getByteTimeDomainData encodes the zero-crossing at 128,
// so an all-zeros buffer decodes to a fully-deflected -1.0 line — which makes the
// oscilloscope draw a flat line pinned to the bottom before playback and then
// "snap" up to the live waveform on play. Seeding with 128 keeps the idle line
// flat and centered so there is no jump.
const SILENT_TIME_DOMAIN = () => new Uint8Array(2048).fill(128);

interface AudioState {
  energy: number;
  bass: number;
  mid: number;
  high: number;
  fftData: Uint8Array;
  timeDomainData: Uint8Array;
  globalPeaks: {
    bass: number;
    mid: number;
    high: number;
    hasAnalysis: boolean;
  };
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  sourceNode: MediaElementAudioSourceNode | null;
  gainNode: GainNode | null;
  sourceElement: HTMLAudioElement | null;
  currentSourceType: AudioSourceType;
  sourceManager: AudioSourceManager | null;
  activeStream: MediaStream | null;

  // Actions
  updateBands: (energy: number, bass: number, mid: number, high: number) => void;
  setFFTData: (data: Uint8Array) => void;
  setTimeDomainData: (data: Uint8Array) => void;
  setPeaks: (peaks: { bass: number; mid: number; high: number; hasAnalysis: boolean }) => void;
  setContext: (context: AudioContext | null) => void;
  setAnalyser: (analyser: AnalyserNode | null) => void;
  setSourceNode: (node: MediaElementAudioSourceNode | null) => void;
  setGainNode: (node: GainNode | null) => void;
  setSourceElement: (el: HTMLAudioElement | null) => void;
  setSourceType: (type: AudioSourceType) => void;
  setSourceManager: (manager: AudioSourceManager | null) => void;
  setActiveStream: (stream: MediaStream | null) => void;
  reset: () => void;
}

export const audioStore = createStore<AudioState>((set) => ({
  energy: 0,
  bass: 0,
  mid: 0,
  high: 0,
  fftData: new Uint8Array(2048),
  timeDomainData: SILENT_TIME_DOMAIN(),
  globalPeaks: {
    bass: 1.0,
    mid: 1.0,
    high: 1.0,
    hasAnalysis: false,
  },
  audioContext: null,
  analyser: null,
  sourceNode: null,
  gainNode: null,
  sourceElement: null,
  currentSourceType: 'playlist',
  sourceManager: null,
  activeStream: null,

  updateBands: (energy, bass, mid, high) => set({ energy, bass, mid, high }),
  setFFTData: (fftData) => set({ fftData }),
  setTimeDomainData: (timeDomainData) => set({ timeDomainData }),
  setPeaks: (globalPeaks) => set({ globalPeaks }),
  setContext: (audioContext) => set({ audioContext }),
  setAnalyser: (analyser) => set({ analyser }),
  setSourceNode: (sourceNode) => set({ sourceNode }),
  setGainNode: (gainNode) => set({ gainNode }),
  setSourceElement: (sourceElement) => set({ sourceElement }),
  setSourceType: (currentSourceType) => set({ currentSourceType }),
  setSourceManager: (sourceManager) => set({ sourceManager }),
  setActiveStream: (activeStream) => set({ activeStream }),

  reset: () =>
    set({
      energy: 0,
      bass: 0,
      mid: 0,
      high: 0,
      fftData: new Uint8Array(2048),
      timeDomainData: SILENT_TIME_DOMAIN(),
      globalPeaks: { bass: 1.0, mid: 1.0, high: 1.0, hasAnalysis: false },
    }),
}));

export const getAudioState = () => audioStore.getState();

// ---------------------------------------------------------------------------
// Audio analysis helpers
// ---------------------------------------------------------------------------

/**
 * Analyze an AudioBuffer with per-band peak detection
 * Uses offline FFT analysis to find peak RMS energy in each frequency band
 * This provides professional-grade normalization similar to audio metering tools
 */
export async function analyzeAudioBuffer(buffer: AudioBuffer): Promise<void> {
  try {
    const channelData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;

    const analyzer = new AudioAnalyzer({ fftSize: 2048, smoothing: 0.0 });

    // Sample one 100ms frame in five (two FFTs per second of audio), yielding
    // to the event loop between batches so a long track never blocks the UI.
    const fps = 10;
    const frameStep = 5;
    const framesPerBatch = 40;
    const totalFrames = Math.ceil(buffer.duration * fps);

    let maxBass = 0;
    let maxMid = 0;
    let maxHigh = 0;
    let framesInBatch = 0;

    for (let frame = 0; frame < totalFrames; frame += frameStep) {
      const frameData = analyzer.analyzeFrame(channelData, frame, fps, sampleRate);
      maxBass = Math.max(maxBass, frameData.bass);
      maxMid = Math.max(maxMid, frameData.mid);
      maxHigh = Math.max(maxHigh, frameData.high);

      if (++framesInBatch >= framesPerBatch) {
        framesInBatch = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    audioStore.setState({
      globalPeaks: {
        bass: Math.max(maxBass, 0.05),
        mid: Math.max(maxMid, 0.05),
        high: Math.max(maxHigh, 0.05),
        hasAnalysis: true,
      },
    });
  } catch (error) {
    console.error('Failed to analyze audio buffer:', error);
    // Fallback to simple time-domain analysis
    analyzeAudioBufferSimple(buffer);
  }
}

/**
 * Simple fallback analysis using time-domain peak detection
 * Used when FFT analysis fails
 */
function analyzeAudioBufferSimple(buffer: AudioBuffer): void {
  let maxPeak = 0;
  const channels = buffer.numberOfChannels;
  const step = 100;

  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += step) {
      const abs = Math.abs(data[i]);
      if (abs > maxPeak) maxPeak = abs;
    }
  }

  const effectivePeak = Math.max(maxPeak, 0.1);

  audioStore.setState({
    globalPeaks: {
      bass: effectivePeak,
      mid: effectivePeak,
      high: effectivePeak,
      hasAnalysis: true,
    },
  });
}

/**
 * Reset audio peaks (call when changing songs)
 */
export function resetAudioPeaks(): void {
  audioStore.setState({
    globalPeaks: {
      bass: 1.0,
      mid: 1.0,
      high: 1.0,
      hasAnalysis: false,
    },
  });
}
