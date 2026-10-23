'use client';

import React, { useRef, useEffect, forwardRef, useCallback } from 'react';
import { audioStore, analyzeAudioBuffer, resetAudioPeaks } from '@/engine/stores/audioStore';
import { timeStore } from '@/engine/stores/timeStore';
import { createLogger } from '@/utils/logger';
import { needsAudioResume } from '@/utils/audioContextResume';

const logger = createLogger({ enabled: true, prefix: 'AudioPlayer' });

interface AudioPlayerProps {
  /** Audio source URL */
  src?: string;
  /** Whether playback is active */
  isPlaying: boolean;
  /** Playback rate (0.25 - 2) */
  playbackRate?: number;
  /** Callback when duration is available */
  onDurationChange?: (duration: number) => void;
  /** Callback when audio ends */
  onEnded?: () => void;
  /** Callback when audio error occurs */
  onError?: () => void;
  /** Callback when AudioBuffer is decoded (for export) */
  onAudioBuffer?: (buffer: AudioBuffer | null) => void;
}

/**
 * AudioPlayer - HTML5 Audio element wrapper with real-time FFT analysis
 *
 * Provides both playback and real-time audio analysis for audio-reactive effects.
 */
export const AudioPlayer = forwardRef<HTMLAudioElement, AudioPlayerProps>(function AudioPlayer(
  { src, isPlaying, playbackRate = 1, onDurationChange, onEnded, onError, onAudioBuffer },
  ref,
) {
  const internalRef = useRef<HTMLAudioElement>(null);
  const audioRef = (ref as React.RefObject<HTMLAudioElement>) || internalRef;
  const lastDecodedSrcRef = useRef<string | undefined>(undefined);
  const lastPlaySrcRef = useRef<string | undefined>(undefined);
  /** AbortController for in-flight audio decode — cancelled on src change to prevent stale buffers lingering */
  const decodeAbortRef = useRef<AbortController | null>(null);

  // Web Audio API refs for real-time FFT analysis
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const animationFrameRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAnalyzerInitializedRef = useRef(false);
  const frameCounterRef = useRef(0);
  /** Monotonically increasing generation — prevents stacked analysis loops */
  const analysisGenRef = useRef(0);

  /**
   * Tracks whether the audio element is currently in a seek operation.
   * When the browser processes a seek (currentTime assignment), it fires
   * 'seeking' then 'seeked'. We must NOT call play() until 'seeked' fires,
   * otherwise the play promise is rejected (AbortError) and audio stays silent.
   */
  const isSeekingRef = useRef(false);
  /** Tracks whether a play promise is currently in-flight. */
  const isPlayInProgressRef = useRef(false);
  /**
   * Ref mirror of isPlaying to avoid stale closures inside setTimeout/event
   * callbacks that capture `isPlaying` from a previous render cycle.
   */
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Initialize Web Audio API analyzer once when audio element is ready
  const initAnalyzer = useCallback(
    function (): void {
      const audio = audioRef.current;
      if (!audio || !src) return;

      // Re-check refs in case they were set by a parallel call
      if (
        isAnalyzerInitializedRef.current &&
        analyserRef.current &&
        dataArrayRef.current &&
        audioStore.getState().sourceElement === audio
      ) {
        return;
      }

      try {
        // 1. Get or Create AudioContext
        let ctx = audioStore.getState().audioContext;
        const contextIsValid = ctx && ctx.state !== 'closed';

        if (!contextIsValid) {
          const AudioContextClass =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          ctx = new AudioContextClass();
          audioStore.setState({ audioContext: ctx });
        }
        audioContextRef.current = ctx;

        // 2. Get or Create Analyser
        let analyser = audioStore.getState().analyser;
        if (!analyser || analyser.context !== ctx) {
          analyser = ctx!.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.7;
          audioStore.setState({ analyser });
        }
        analyserRef.current = analyser;

        // Initialize local data array
        dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);

        // 3. Get or Create GainNode for normalization
        let gainNode = audioStore.getState().gainNode;
        if (!gainNode || gainNode.context !== ctx) {
          gainNode = ctx!.createGain();
          audioStore.setState({ gainNode });
        }
        gainNodeRef.current = gainNode;

        // 4. Connect Audio Element (SourceNode)
        const audioStoreState = audioStore.getState();
        let source = audioStoreState.sourceNode;
        if (audioStoreState.sourceElement !== audio || !source || source.context !== ctx) {
          try {
            source = ctx!.createMediaElementSource(audio);
            audioStore.setState({ sourceNode: source, sourceElement: audio });
          } catch (e) {
            logger.warn(
              'createMediaElementSource failed (likely already connected). Attempting to recover...',
              e as Error,
            );
            const current = audioStore.getState();
            if (current.sourceElement === audio && current.sourceNode) {
              source = current.sourceNode;
            } else {
              throw e;
            }
          }
        }

        // 5. Finalize Graph Connections
        source!.disconnect();
        source!.connect(gainNode!);

        gainNode!.disconnect();
        gainNode!.connect(analyser);

        analyser.disconnect();
        analyser.connect(ctx!.destination);

        isAnalyzerInitializedRef.current = true;

        // Ensure context is running
        if (needsAudioResume(ctx)) {
          ctx!.resume().then(function (): void {
            logger.debug('AudioContext resumed during init');
          });
        }

        // Notify listeners that graph is ready
        window.dispatchEvent(new Event('audio-graph-ready'));

        logger.debug('Audio Graph Fully Connected.');
      } catch (err) {
        logger.error('Analyzer Setup Failed:', err as Error);
      }
    },
    [src, audioRef],
  );

  // Initialize Web Audio API analyzer once when audio element is ready
  useEffect(
    function (): () => void {
      const audio = audioRef.current;
      if (!audio || !src) return function (): void {};

      // Resume from 'suspended' (autoplay policy) or 'interrupted' (iOS: call,
      // Siri, backgrounding). Touch devices may never emit mousedown/click on
      // the first gesture, so also listen for pointerdown/touchend, and retry
      // when the tab becomes visible again.
      const handleInteraction = function (): void {
        const ctx = audioContextRef.current;
        if (ctx && needsAudioResume(ctx)) {
          ctx
            .resume()
            .then(function (): void {
              logger.debug('AudioContext resumed via interaction');
            })
            .catch(function (): void {
              /* needs a real gesture — a later interaction will retry */
            });
        }
      };
      const handleVisibility = function (): void {
        if (document.visibilityState === 'visible') handleInteraction();
      };

      window.addEventListener('mousedown', handleInteraction);
      window.addEventListener('keydown', handleInteraction);
      window.addEventListener('click', handleInteraction);
      window.addEventListener('pointerdown', handleInteraction);
      window.addEventListener('touchend', handleInteraction);
      document.addEventListener('visibilitychange', handleVisibility);
      audio.addEventListener('play', handleInteraction);

      // Force unmuted and full volume for the engine
      audio.muted = false;
      audio.volume = 1.0;

      const handleReady = function (): void {
        initAnalyzer();
      };
      audio.addEventListener('loadedmetadata', handleReady);
      audio.addEventListener('canplay', handleReady);

      // Try immediately if already loaded
      if (audio.readyState >= 1) {
        initAnalyzer();
      }

      return function (): void {
        window.removeEventListener('mousedown', handleInteraction);
        window.removeEventListener('keydown', handleInteraction);
        window.removeEventListener('click', handleInteraction);
        window.removeEventListener('pointerdown', handleInteraction);
        window.removeEventListener('touchend', handleInteraction);
        document.removeEventListener('visibilitychange', handleVisibility);
        audio.removeEventListener('play', handleInteraction);
        audio.removeEventListener('loadedmetadata', handleReady);
        audio.removeEventListener('canplay', handleReady);
      };
    },
    [src, initAnalyzer, audioRef],
  );

  // Real-time FFT analysis loop
  // NOTE: deps intentionally exclude onError/onTimeUpdate — they are not used inside
  // the loop, and including them caused spurious teardown/restart cycles on every track switch.
  useEffect(
    function (): () => void {
      // Bump generation so any prior loop iteration self-terminates
      const gen = ++analysisGenRef.current;

      const analyze = function (): void {
        // Guard: if a newer effect has started, this loop is stale — bail out
        if (gen !== analysisGenRef.current) return;

        if (!isPlaying) {
          const DRAIN_FACTOR = 0.15;
          const prev = audioStore.getState();

          const newBass = lerp(prev.bass, 0, DRAIN_FACTOR);
          const newMid = lerp(prev.mid, 0, DRAIN_FACTOR);
          const newHigh = lerp(prev.high, 0, DRAIN_FACTOR);
          const newEnergy = lerp(prev.energy, 0, DRAIN_FACTOR);
          audioStore.setState({ bass: newBass, mid: newMid, high: newHigh, energy: newEnergy });

          // Decay FFT data
          const fftDest = prev.fftData;
          if (fftDest) {
            for (let i = 0; i < fftDest.length; i++) {
              fftDest[i] = Math.floor(fftDest[i] * (1 - DRAIN_FACTOR));
            }
          }

          // Continue loop if values are still significant to ensure they hit absolute zero
          if (newEnergy > 0.001 || (fftDest && fftDest[0] > 0)) {
            animationFrameRef.current = setTimeout(analyze, 33);
          }
          return;
        }

        // 1. Diagnostic - Analyser status
        const analyser = analyserRef.current;
        const dataArray = dataArrayRef.current;
        frameCounterRef.current++;

        if (!analyser || !dataArray) {
          animationFrameRef.current = setTimeout(analyze, 33);
          return;
        }

        // 2. Get frequency data
        analyser.getByteFrequencyData(dataArray);

        // 3. Get time domain data
        const timeDomainDest = audioStore.getState().timeDomainData;
        if (timeDomainDest) {
          analyser.getByteTimeDomainData(timeDomainDest as Uint8Array<ArrayBuffer>);
        }

        // Bass: 20Hz - 250Hz (Bins 1 - 12)
        let bassSum = 0;
        for (let i = 1; i < 12; i++) bassSum += dataArray[i];
        bassSum /= 11;

        // Mids: 250Hz - 4kHz (Bins 12 - 186)
        let midSum = 0;
        for (let i = 12; i < 186; i++) midSum += dataArray[i];
        midSum /= 174;

        // Highs: 4kHz - 14kHz (Bins 186 - 650)
        let highSum = 0;
        for (let i = 186; i < 650; i++) highSum += dataArray[i];
        highSum /= 464;

        const bassRaw = bassSum / 255;
        const midRaw = Math.min((midSum / 255) * 1.5, 1.0);
        const highRaw = Math.min((highSum / 255) * 2.5, 1.0);

        const bassNormalized = bassRaw;
        const midNormalized = midRaw;
        const highNormalized = highRaw;

        const SMOOTHING = 0.2;
        const prevState = audioStore.getState();
        const smoothBass = lerp(prevState.bass, bassNormalized, SMOOTHING);
        const smoothMid = lerp(prevState.mid, midNormalized, SMOOTHING);
        const smoothHigh = lerp(prevState.high, highNormalized, SMOOTHING);
        const smoothEnergy = smoothBass * 0.6 + smoothMid * 0.3 + smoothHigh * 0.1;

        audioStore.setState({
          bass: smoothBass,
          mid: smoothMid,
          high: smoothHigh,
          energy: smoothEnergy,
        });

        const fftDest = prevState.fftData;
        if (fftDest && dataArray) {
          fftDest.set(dataArray);
        }

        animationFrameRef.current = setTimeout(analyze, 33);
      };

      if (needsAudioResume(audioContextRef.current) && isPlaying) {
        audioContextRef.current?.resume().catch(() => {});
      }

      // Start analysis loop
      analyze();

      return () => {
        if (animationFrameRef.current) {
          clearTimeout(animationFrameRef.current);
        }
      };
    },
    [isPlaying, audioRef],
  );

  // Cleanup on unmount
  useEffect(function (): () => void {
    return function (): void {
      // Cancel animation delay
      if (animationFrameRef.current) {
        clearTimeout(animationFrameRef.current);
      }

      // Disconnect and clean up Web Audio API nodes
      try {
        const audioNodes = audioStore.getState();
        if (audioNodes.sourceNode) {
          audioNodes.sourceNode.disconnect();
        }
        if (audioNodes.gainNode) {
          audioNodes.gainNode.disconnect();
        }
        if (audioNodes.analyser) {
          audioNodes.analyser.disconnect();
        }
        // Note: We don't close the AudioContext as it's shared globally
        // and may be reused. The browser will clean it up when the page unloads.
      } catch {
        // Ignore errors during cleanup
      }

      isAnalyzerInitializedRef.current = false;
    };
  }, []);

  // Decode audio to AudioBuffer for export when source changes.
  // Uses an AbortController so that when the user switches tracks rapidly,
  // the previous fetch+decode is cancelled — preventing stale AudioBuffers
  // (each ~40 MB of raw PCM) from accumulating in memory.
  useEffect(
    function (): () => void {
      // Abort any previous in-flight decode
      decodeAbortRef.current?.abort();
      decodeAbortRef.current = null;

      if (!src) {
        if (lastDecodedSrcRef.current) {
          lastDecodedSrcRef.current = undefined;
          onAudioBuffer?.(null);
          onDurationChange?.(0);
          resetAudioPeaks();
        }
        return function (): void {};
      }

      if (src === lastDecodedSrcRef.current) return function (): void {};
      lastDecodedSrcRef.current = src;

      resetAudioPeaks();
      onAudioBuffer?.(null);

      const controller = new AbortController();
      decodeAbortRef.current = controller;

      const decodeAudio = async function (): Promise<void> {
        let decodeCtx: AudioContext | null = null;
        try {
          const response = await fetch(src, { signal: controller.signal });
          const arrayBuffer = await response.arrayBuffer();

          // Check abort after expensive operations
          if (controller.signal.aborted) return;

          decodeCtx = new AudioContext();
          const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
          await decodeCtx.close();
          decodeCtx = null;

          // Check abort after decode — src may have changed while decoding
          if (controller.signal.aborted) return;

          await analyzeAudioBuffer(audioBuffer);

          if (controller.signal.aborted) return;

          if (gainNodeRef.current && audioContextRef.current) {
            const peaks = audioStore.getState().globalPeaks;
            const targetGain = peaks.hasAnalysis ? 1 / peaks.bass : 1.0;
            gainNodeRef.current.gain.setValueAtTime(
              targetGain,
              audioContextRef.current.currentTime,
            );
          }

          onAudioBuffer?.(audioBuffer);
        } catch (err) {
          // Close decode context if it was left open
          if (decodeCtx) {
            try {
              await decodeCtx.close();
            } catch {
              /* ignore */
            }
          }
          if ((err as DOMException)?.name === 'AbortError') {
            logger.debug('Audio decode aborted (src changed)');
            return;
          }
          logger.error('Failed to decode audio buffer:', err as Error);
          onAudioBuffer?.(null);
        }
      };

      decodeAudio();

      return function (): void {
        controller.abort();
      };
    },
    [src, onAudioBuffer, onDurationChange],
  );

  // Handle duration change
  useEffect(
    function (): () => void {
      const audio = audioRef.current;
      if (!audio) return function (): void {};

      const handleLoadedMetadata = function (): void {
        if (audio.duration && isFinite(audio.duration)) {
          onDurationChange?.(audio.duration);
        }
      };

      audio.addEventListener('loadedmetadata', handleLoadedMetadata);
      audio.addEventListener('durationchange', handleLoadedMetadata);

      return function (): void {
        audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
        audio.removeEventListener('durationchange', handleLoadedMetadata);
      };
    },
    [onDurationChange, audioRef],
  );

  /* onTimeUpdate is synced via handleTimeUpdate in usePlaybackManager — no native event listener needed */

  // Handle ended
  useEffect(
    function (): () => void {
      const audio = audioRef.current;
      if (!audio || !onEnded) return function (): void {};

      const handleEnded = function (): void {
        logger.debug('ended event received');
        onEnded();
      };

      audio.addEventListener('ended', handleEnded);
      return function (): void {
        audio.removeEventListener('ended', handleEnded);
      };
    },
    [onEnded, audioRef],
  );

  // Handle error
  useEffect(
    function (): () => void {
      const audio = audioRef.current;
      if (!audio || !onError) return function (): void {};

      const handleErrorInternal = function (_e: Event): void {
        const error = (_e.currentTarget as HTMLAudioElement).error;
        logger.error('Audio playback error', error as unknown as Error);
        onError();
      };

      audio.addEventListener('error', handleErrorInternal);
      return function (): void {
        audio.removeEventListener('error', handleErrorInternal);
      };
    },
    [onError, audioRef],
  );
  /**
   * Attempt to start audio playback, resuming the AudioContext first if it is
   * in a suspended state (this is common on first user interaction or after
   * a long pause in some browsers).
   *
   * Awaiting the resume before play() prevents a silent failure where the
   * HTMLMediaElement starts "playing" according to its `paused` flag but no
   * audio is actually output because the Web Audio graph is still suspended.
   */
  const tryPlay = useCallback(async function (audio: HTMLAudioElement): Promise<void> {
    if (isPlayInProgressRef.current) {
      logger.debug('[tryPlay] play() already in progress, skipping redundant call');
      return;
    }
    if (!audio.paused) {
      logger.debug('[tryPlay] audio already playing, skipping play()');
      return;
    }

    // ── Diagnostic snapshot ──────────────────────────────────────────────
    const ctx = audioContextRef.current;
    logger.debug(
      '[tryPlay] attempting play ►',
      `audio.paused=${audio.paused}`,
      `audio.currentTime=${audio.currentTime.toFixed(3)}s`,
      `audio.readyState=${audio.readyState}`,
      `audio.networkState=${audio.networkState}`,
      `audio.src=${audio.src ? '✓' : '✗'}`,
      `audioCtx.state=${ctx?.state ?? 'none'}`,
      `isSeekingRef=${isSeekingRef.current}`,
    );
    // ────────────────────────────────────────────────────────────────────
    isPlayInProgressRef.current = true;
    try {
      if (ctx && needsAudioResume(ctx)) {
        logger.debug('[tryPlay] AudioContext suspended — resuming before play()');
        await ctx.resume();
        logger.debug('[tryPlay] AudioContext resumed, state now:', ctx.state);
      }
      await audio.play();
      logger.debug('[tryPlay] play() resolved — audio.paused:', audio.paused);
    } catch (err) {
      const e = err as DOMException | Error;
      if (e.name === 'AbortError') {
        logger.debug('[tryPlay] play() AbortError (expected during fast seek/pause cycles)');
      } else {
        logger.warn('[tryPlay] play() FAILED unexpectedly:', e.name, e.message);
      }
    } finally {
      isPlayInProgressRef.current = false;
    }
  }, []);

  // Sync play/pause with minimal anti-pop fade
  useEffect(
    function (): void {
      const audio = audioRef.current;
      if (!audio || !src) return;

      // Detect if src changed (track switch) and reset playhead immediately
      // before attempting to play to avoid race conditions and playhead glitches.
      const srcChanged = lastPlaySrcRef.current !== undefined && lastPlaySrcRef.current !== src;
      lastPlaySrcRef.current = src;

      if (srcChanged) {
        logger.debug('[play-effect] src changed → resetting audio.currentTime to 0');
        // A new track is a fresh seek context. Any in-flight seek flag left over
        // from the previous src is irrelevant now — clear it so a "seeking" event
        // that never got a matching "seeked" (e.g. a no-op currentTime=0 seek on a
        // fresh element) can't wedge every future play() into the defer branch.
        isSeekingRef.current = false;
        audio.currentTime = 0;
        timeStore.getState().setCurrentTime(0, true);
      }

      const fadeTime = 0.05;

      if (isPlaying) {
        if (gainNodeRef.current && audioContextRef.current) {
          const now = audioContextRef.current.currentTime;
          const gainParam = gainNodeRef.current.gain;

          const peaks = audioStore.getState().globalPeaks;
          const targetGain = peaks.hasAnalysis ? 1 / peaks.bass : 1.0;

          gainParam.cancelScheduledValues(now);
          gainParam.setValueAtTime(targetGain, now);
        }

        // If the browser is currently processing a seek, defer play() until
        // the 'seeked' event fires. Calling play() mid-seek causes an AbortError
        // and the audio silently stops. We use { once: true } to auto-remove
        // the listener and avoid a memory leak.
        if (isSeekingRef.current) {
          // The ref can go stale: a no-op seek (currentTime set to its current
          // value) or a metadata race can fire "seeking" with no matching
          // "seeked", leaving this ref stuck true forever so every play() defers.
          // The native `audio.seeking` property is the browser's source of truth
          // and cannot go stale. If it says we are NOT actually mid-seek and the
          // element is ready, the ref is stale — clear it and play now.
          if (!audio.seeking && audio.readyState >= 2) {
            logger.debug(
              '[play-effect] isSeekingRef stale (audio.seeking=false, readyState>=2) → clearing and playing.',
              `audio.currentTime=${audio.currentTime.toFixed(3)}`,
            );
            isSeekingRef.current = false;
            tryPlay(audio);
            return;
          }
          logger.debug(
            '[play-effect] isPlaying=true but seek in-flight — deferring play() until seeked.',
            `audio.currentTime=${audio.currentTime.toFixed(3)}`,
          );
          const fallback: { timer?: number } = {};
          const onSeeked = function (): void {
            // Only play if we are still supposed to be playing when seeked fires.
            // Use the ref (not the closure value) to avoid stale-closure bugs.
            if (fallback.timer !== undefined) clearTimeout(fallback.timer);
            isSeekingRef.current = false;
            if (isPlayingRef.current) {
              logger.debug('[play-effect] seeked fired, isPlayingRef=true → calling tryPlay()');
              tryPlay(audio);
            } else {
              logger.debug('[play-effect] seeked fired, but isPlayingRef=false — skipping play()');
            }
          };
          audio.addEventListener('seeked', onSeeked, { once: true });
          // Safety net: if the browser never fires "seeked" (some no-op / rapid
          // seeks don't), don't hang forever. After a short grace period, drop
          // the listener, clear the flag, and play if we still should be.
          fallback.timer = window.setTimeout(function (): void {
            audio.removeEventListener('seeked', onSeeked);
            isSeekingRef.current = false;
            if (isPlayingRef.current && audio.paused) {
              logger.debug(
                '[play-effect] seeked never fired within grace window → recovering play().',
                `audio.currentTime=${audio.currentTime.toFixed(3)}`,
              );
              tryPlay(audio);
            }
          }, 300);
          return;
        }

        tryPlay(audio);
      } else {
        if (gainNodeRef.current && audioContextRef.current) {
          const now = audioContextRef.current.currentTime;
          const gainParam = gainNodeRef.current.gain;

          gainParam.cancelScheduledValues(now);
          gainParam.setValueAtTime(gainParam.value, now);
          gainParam.exponentialRampToValueAtTime(0.001, now + fadeTime);

          // Use isPlayingRef (not the captured isPlaying) to avoid stale-closure
          // bugs where a pause timeout fires after the user has resumed playback.
          setTimeout(function (): void {
            const currentAudio = audioRef.current;
            if (currentAudio && !isPlayingRef.current) {
              currentAudio.pause();
            }
          }, fadeTime * 1000);
        } else {
          audio.pause();
        }
      }
    },
    [isPlaying, src, audioRef, tryPlay],
  );

  // Track native seeking/seeked events to gate play() calls
  useEffect(
    function (): () => void {
      const audio = audioRef.current;
      if (!audio) return function (): void {};

      const onSeeking = function (): void {
        isSeekingRef.current = true;
        logger.debug(
          '[native:seeking] seek started →',
          `audio.currentTime=${audio.currentTime.toFixed(3)}s`,
          `isPlaying(ref)=${isPlayingRef.current}`,
          `audio.paused=${audio.paused}`,
        );
      };
      const onSeeked = function (): void {
        isSeekingRef.current = false;
        logger.debug(
          '[native:seeked] seek complete →',
          `audio.currentTime=${audio.currentTime.toFixed(3)}s`,
          `isPlaying(ref)=${isPlayingRef.current}`,
          `audio.paused=${audio.paused}`,
        );
      };

      audio.addEventListener('seeking', onSeeking);
      audio.addEventListener('seeked', onSeeked);

      return function (): void {
        audio.removeEventListener('seeking', onSeeking);
        audio.removeEventListener('seeked', onSeeked);
      };
    },
    [audioRef],
  );

  // ── Seek Recovery ────────────────────────────────────────────────────────
  // NOTE: We do NOT set audio.currentTime here from the React `currentTime`
  // prop. All seeking is done directly by handleSeek() in usePlaybackManager
  // via `audioPlayerRef.current.currentTime = targetTime`.
  //
  // Setting audio.currentTime from this effect caused a "ping-pong" bug:
  // The RAF sync loop constantly enqueues stale setTime() calls, so React
  // renders with old `currentTime` values AFTER a seek, causing this effect
  // to seek BACKWARD to the stale value — breaking playback entirely.
  //
  // Instead, after every `seeked` event we check for recovery: if we are
  // supposed to be playing but the element ended up paused (rapid seeks can
  // abort an in-flight play() promise), we call tryPlay() to recover.
  useEffect(
    function (): () => void {
      const audio = audioRef.current;
      if (!audio) return function (): void {};

      const onSeeked = function (): void {
        if (isPlayingRef.current && audio.paused) {
          logger.debug(
            '[seek-recovery] audio paused after seeked but isPlaying=true → calling tryPlay()',
            `audio.currentTime=${audio.currentTime.toFixed(3)}s`,
          );
          tryPlay(audio);
        }
      };

      audio.addEventListener('seeked', onSeeked);
      return function (): void {
        audio.removeEventListener('seeked', onSeeked);
      };
    },
    [audioRef, tryPlay],
  );
  // Playback recovery when source becomes playable
  useEffect(
    function (): () => void {
      const audio = audioRef.current;
      if (!audio || !src) return function (): void {};

      const handlePlayable = function (): void {
        if (isPlayingRef.current && audio.paused) {
          logger.debug(
            '[playable-recovery] source is now playable, isPlayingRef=true → calling tryPlay()',
          );
          tryPlay(audio);
        }
      };

      audio.addEventListener('canplay', handlePlayable);
      audio.addEventListener('loadedmetadata', handlePlayable);

      // Try immediately in case it's already ready
      if (audio.readyState >= 2 && isPlayingRef.current && audio.paused) {
        tryPlay(audio);
      }

      return function (): void {
        audio.removeEventListener('canplay', handlePlayable);
        audio.removeEventListener('loadedmetadata', handlePlayable);
      };
    },
    [src, audioRef, tryPlay],
  );
  // Sync playback rate
  useEffect(
    function (): void {
      const audio = audioRef.current;
      if (!audio) return;
      audio.playbackRate = playbackRate;
    },
    [playbackRate, audioRef],
  );

  return (
    <audio
      id="main-audio-engine"
      ref={audioRef}
      src={src}
      preload="auto"
      crossOrigin="anonymous"
      style={{ display: 'none' }}
      onEnded={onEnded}
      onError={onError}
    />
  );
});

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export default AudioPlayer;
