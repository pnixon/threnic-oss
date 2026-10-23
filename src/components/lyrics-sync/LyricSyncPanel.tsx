'use client';

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  startTransition,
  useLayoutEffect,
  useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { X, Play, Pause, RotateCcw, Check, Keyboard, Square, AlertTriangle } from 'lucide-react';
import { useLyricSync } from './useLyricSync';
import type { ThrenicWord, LyricLineData } from '@/types/lyrics';
import { threnicWordsToLyricLines, reconcileWordTimings } from '@/types/lyrics';
import styles from './LyricSyncPanel.module.css';

/** Default maximum duration (seconds) a single word stays highlighted */
const DEFAULT_MAX_HIGHLIGHT_DURATION = 1.0;

/** Must match the CSS line-height for the left editor textarea */
const EDITOR_LINE_HEIGHT = 29; // px

interface LyricSyncPanelProps {
  isOpen: boolean;
  onClose: () => void;
  audioElementRef?: React.RefObject<HTMLAudioElement | null>;
  onSyncComplete?: (lyrics: LyricLineData[]) => void;
  trackName?: string;
  words?: ThrenicWord[];
  setWords?: React.Dispatch<React.SetStateAction<ThrenicWord[]>>;
}

/**
 * Line component that measures its natural width and scales down to fit the container.
 * Each line is rendered as a single non-wrapping row.
 */
function ShrinkToFitLine({
  children,
  className,
  maxWidth,
}: {
  children: React.ReactNode;
  className: string;
  maxWidth: number;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || maxWidth <= 0) return;

    const naturalWidth = el.scrollWidth;
    if (naturalWidth > maxWidth) {
      setScale(maxWidth / naturalWidth);
    } else {
      setScale(1);
    }
  }, [maxWidth, children]);

  return (
    <div className={className} style={{ height: `calc(3.2rem * ${scale})` }}>
      <div
        ref={innerRef}
        className={styles.lineInner}
        style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Fullscreen lyric syncing panel with a three-panel layout:
 *   LEFT  – Always-editable lyrics text editor
 *   CENTER – Visual sync display (focus here to use keyboard shortcuts)
 *   RIGHT  – Controls, sliders, shortcuts
 */
export function LyricSyncPanel({
  isOpen,
  onClose,
  audioElementRef,
  onSyncComplete,
  trackName,
  words: propWords,
  setWords: propSetWords,
}: LyricSyncPanelProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [isAudioReady, setIsAudioReady] = useState(false);
  const [rawLyrics, setRawLyrics] = useState('');
  const [maxHighlightDuration, setMaxHighlightDuration] = useState(DEFAULT_MAX_HIGHLIGHT_DURATION);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [centerFocused, setCenterFocused] = useState(false);
  const [audioTime, setAudioTime] = useState(0);

  // ── Dynamic Mobile Layout Detection & Size Guard ──
  const [isMobile, setIsMobile] = useState(false);
  const [windowSize, setWindowSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const screenTooSmall = isMobile && (windowSize.width < 320 || windowSize.height < 500);

  // Preview line transition tracking
  type PreviewLineData = {
    words: (ThrenicWord & { relativeIndex: number; absoluteIndex: number })[];
  } | null;
  const [exitingLine, setExitingLine] = useState<PreviewLineData>(null);
  const prevPreviewKeyRef = useRef<string>('');
  const prevPreviewDataRef = useRef<PreviewLineData>(null);
  const exitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const wordDisplayRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [wordDisplayWidth, setWordDisplayWidth] = useState(0);
  const [textareaScrollTop, setTextareaScrollTop] = useState(0);

  // ── Internal word state (used when parent doesn't supply it) ──
  const [internalWords, setInternalWords] = useState<ThrenicWord[]>([]);
  const words = propWords ?? internalWords;
  const setWords = propSetWords ?? setInternalWords;

  // ── Mount & audio readiness ──
  useEffect(() => {
    startTransition(() => setIsMounted(true));
  }, []);

  useEffect(() => {
    if (audioElementRef?.current) {
      startTransition(() => setIsAudioReady(true));
    }
  }, [audioElementRef]);

  // ── Populate rawLyrics from words when panel opens ──
  useEffect(() => {
    if (!isOpen) return;

    const newRawText = words.reduce((acc, word, i) => {
      const prefix = i > 0 ? (word.isLineStart ? '\n' : ' ') : '';
      return acc + prefix + word.text;
    }, '');

    startTransition(() => setRawLyrics(newRawText));
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- only on open

  const handleSyncCompleteInternal = useCallback(
    (syncedWords: ThrenicWord[]) => {
      setWords(syncedWords);
      const lines = threnicWordsToLyricLines(syncedWords);
      onSyncComplete?.(lines);
      onClose();
    },
    [setWords, onSyncComplete, onClose],
  );

  const syncOptions = useMemo(
    () => ({
      maxHighlightDuration,
      onComplete: handleSyncCompleteInternal,
    }),
    [maxHighlightDuration, handleSyncCompleteInternal],
  );

  // ── Sync hook ──
  const {
    words: syncWords,
    currentIndex,
    isSyncing,
    isPlaying,
    isComplete,
    startSync,
    stopSync,
    togglePause,
    registerHit,
    setWords: setSyncWords,
    replaceWords,
    undo,
    canUndo,
    seekBackAndClear,
    finalizeSync,
  } = useLyricSync(words, audioElementRef ?? { current: null }, syncOptions);

  // ── Measure center panel width for shrink-to-fit ──
  useEffect(() => {
    const el = wordDisplayRef.current;
    if (!el) return;

    const measure = () => {
      const width = el.clientWidth - 32;
      setWordDisplayWidth(Math.max(0, width));
    };

    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [isMounted, isSyncing]);

  // ── Keep playback rate in sync ──
  useEffect(() => {
    if (audioElementRef?.current) {
      audioElementRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioElementRef]);

  // Push prop-words into hook when not syncing
  useEffect(() => {
    if (!isSyncing && words.length > 0) {
      setSyncWords(words);
    }
  }, [words, isSyncing, setSyncWords]);

  // ── Live text editing handler ──
  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      setRawLyrics(newText);

      const newWords: ThrenicWord[] = [];
      newText.split('\n').forEach((lineText) => {
        const trimmed = lineText.trim();
        if (!trimmed) return;

        trimmed.split(/\s+/).forEach((text, lineWordIndex) => {
          newWords.push({
            id: crypto.randomUUID(),
            text,
            startTime: 0,
            endTime: 0,
            isLineStart: lineWordIndex === 0,
          });
        });
      });

      const sourceWords = isSyncing ? syncWords : words;
      const reconciled = reconcileWordTimings(sourceWords, newWords);

      if (isSyncing) {
        replaceWords(reconciled);
      } else {
        setWords(reconciled);
      }
    },
    [isSyncing, syncWords, words, setWords, replaceWords],
  );

  // ── Determine which text line the current word belongs to ──
  const getCurrentLineNumber = useCallback(() => {
    if (!isSyncing) return -1;
    let lineNum = 0;
    for (let i = 0; i < currentIndex && i < syncWords.length; i++) {
      if (syncWords[i].isLineStart && i > 0) lineNum++;
    }
    return lineNum;
  }, [isSyncing, syncWords, currentIndex]);

  const currentLineNumber = getCurrentLineNumber();

  // ── Track textarea scroll position for highlight sync ──
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleScroll = () => {
      setTextareaScrollTop(textarea.scrollTop);
    };

    textarea.addEventListener('scroll', handleScroll);
    // Initialize with current scroll position
    setTextareaScrollTop(textarea.scrollTop);
    return () => textarea.removeEventListener('scroll', handleScroll);
  }, [isMounted]);

  // ── Auto-scroll the left textarea to track the current line ──
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !isSyncing || currentLineNumber < 0) return;

    const targetScroll = currentLineNumber * EDITOR_LINE_HEIGHT - textarea.clientHeight / 2;
    textarea.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
  }, [currentLineNumber, isSyncing]);

  // ── Stop sync and return to editor ──
  const handleStopSync = useCallback(() => {
    const newRawText = syncWords.reduce((acc, word, i) => {
      const isFirst = i === 0;
      const prefix = !isFirst && word.isLineStart ? '\n' : !isFirst ? ' ' : '';
      return acc + prefix + word.text;
    }, '');

    setRawLyrics(newRawText);
    setWords(syncWords);
    stopSync();
  }, [syncWords, stopSync, setWords]);

  // ── Center panel keyboard handler (only when focused) ──
  const handleCenterKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isSyncing) return;

      // When sync is complete, any key finalizes
      if (isComplete) {
        e.preventDefault();
        finalizeSync();
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

      if (e.code === 'KeyZ' && ctrlKey) {
        e.preventDefault();
        undo();
        return;
      }

      if (e.code === 'Backspace') {
        e.preventDefault();
        if (ctrlKey) {
          seekBackAndClear(5);
        } else {
          undo();
        }
        return;
      }

      if (e.code.startsWith('Key')) {
        e.preventDefault();
        registerHit('WORD');
      } else if (e.code === 'Enter') {
        e.preventDefault();
        registerHit('LINE');
      } else if (e.code === 'Space') {
        e.preventDefault();
        togglePause();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        handleStopSync();
      }
    },
    [
      isSyncing,
      isComplete,
      finalizeSync,
      registerHit,
      undo,
      seekBackAndClear,
      togglePause,
      handleStopSync,
    ],
  );

  // ── Center panel click ──
  const handleCenterClick = useCallback(
    (e: React.MouseEvent) => {
      if (!isSyncing) return;
      e.preventDefault();

      if (isComplete) {
        finalizeSync();
        return;
      }

      registerHit('WORD');
    },
    [isSyncing, isComplete, finalizeSync, registerHit],
  );

  // ── Auto-focus center when sync starts ──
  useEffect(() => {
    if (isSyncing && centerRef.current) {
      centerRef.current.focus();
    }
  }, [isSyncing]);

  // ── Sync lifecycle ──
  const handleStartSync = useCallback(() => {
    const hasContent = rawLyrics.trim().length > 0 || words.length > 0;
    if (!hasContent) return;

    // If rawLyrics has content but words are empty, parse first
    if (words.length === 0 && rawLyrics.trim().length > 0) {
      const newWords: ThrenicWord[] = [];
      rawLyrics.split('\n').forEach((lineText) => {
        const trimmed = lineText.trim();
        if (!trimmed) return;
        trimmed.split(/\s+/).forEach((text, lineWordIndex) => {
          newWords.push({
            id: crypto.randomUUID(),
            text,
            startTime: 0,
            endTime: 0,
            isLineStart: lineWordIndex === 0,
          });
        });
      });
      setWords(newWords);
    }

    setTimeout(() => startSync(), 100);
  }, [words, rawLyrics, startSync, setWords]);

  useEffect(() => {
    if (isSyncing && audioElementRef?.current) {
      const audio = audioElementRef.current;
      audio.currentTime = 0;
      audio.playbackRate = playbackRate;
    }
  }, [isSyncing, audioElementRef, playbackRate]);

  const handleFinalClose = useCallback(() => {
    const wordsToSave = isSyncing ? syncWords : words;
    const lines = threnicWordsToLyricLines(wordsToSave);

    onSyncComplete?.(lines);
    setWords(wordsToSave);

    if (isSyncing) stopSync();
    onClose();
  }, [isSyncing, syncWords, words, onSyncComplete, onClose, setWords, stopSync]);

  // Global Escape when not syncing
  useEffect(() => {
    if (!isOpen || isSyncing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleFinalClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSyncing, handleFinalClose]);

  // ── Preview transition detection (must be before early return) ──
  // Compute the preview line key from syncWords to track line changes
  const previewLineKeyForEffect = (() => {
    if (!isSyncing) return '';
    // Find which line contains currentIndex
    let lineFirstWordId = '';
    let lineStart = 0;
    for (let i = 0; i <= currentIndex && i < syncWords.length; i++) {
      if (syncWords[i].isLineStart || i === 0) {
        lineStart = i;
      }
    }
    lineFirstWordId = syncWords[lineStart]?.id ?? '';
    return lineFirstWordId;
  })();

  useEffect(() => {
    if (!previewLineKeyForEffect || previewLineKeyForEffect === prevPreviewKeyRef.current) {
      return;
    }

    // Line changed — push old line into exiting state (deep copy)
    if (prevPreviewKeyRef.current && prevPreviewDataRef.current) {
      const snapshot: PreviewLineData = {
        words: prevPreviewDataRef.current.words.map((w) => ({ ...w })),
      };
      setExitingLine(snapshot);

      if (exitTimeoutRef.current) clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = setTimeout(() => setExitingLine(null), 500);
    }

    prevPreviewKeyRef.current = previewLineKeyForEffect;
  }, [previewLineKeyForEffect]);

  // Poll audio currentTime via rAF for real-time preview highlighting
  useEffect(() => {
    if (!isSyncing || !audioElementRef?.current) return;

    let rafId: number;
    const tick = () => {
      const t = audioElementRef.current?.currentTime ?? 0;
      setAudioTime(t);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isSyncing, audioElementRef]);

  // ── Bail early ──
  // Moved after hooks to comply with Rules of Hooks
  const shouldRender = isOpen && isMounted;

  // ── Derived state ──
  const displayWords = isSyncing ? syncWords : words;
  const progress = displayWords.length > 0 ? (currentIndex / displayWords.length) * 100 : 0;
  const hasContent = displayWords.length > 0 || rawLyrics.trim().length > 0;

  /** Build ALL line groups from displayWords */
  const getAllLines = () => {
    const lineGroups: {
      words: (ThrenicWord & { relativeIndex: number; absoluteIndex: number })[];
    }[] = [];
    let currentLine: (ThrenicWord & { relativeIndex: number; absoluteIndex: number })[] = [];

    displayWords.forEach((word, idx) => {
      if (word.isLineStart && currentLine.length > 0) {
        lineGroups.push({ words: currentLine });
        currentLine = [];
      }
      currentLine.push({ ...word, relativeIndex: idx - currentIndex, absoluteIndex: idx });
    });

    if (currentLine.length > 0) lineGroups.push({ words: currentLine });
    return lineGroups;
  };

  /** Context lines for the center display (window around current) */
  const getContextLines = () => {
    const lineGroups = getAllLines();
    const currentLineIdx = lineGroups.findIndex((line) =>
      line.words.some((w) => w.relativeIndex === 0),
    );

    const validIdx =
      currentLineIdx === -1 && lineGroups.length > 0 ? lineGroups.length - 1 : currentLineIdx;

    const start = Math.max(0, validIdx - 1);
    const end = Math.min(lineGroups.length, validIdx + 4);
    return lineGroups.slice(start, end);
  };

  const contextLines = isSyncing ? getContextLines() : [];

  /** Current + previous line for the 2-line preview */
  const getPreviewLines = () => {
    const lineGroups = getAllLines();
    const currentLineIdx = lineGroups.findIndex((line) =>
      line.words.some((w) => w.relativeIndex === 0),
    );
    if (currentLineIdx === -1) return { current: null, prev: null };
    return {
      current: lineGroups[currentLineIdx],
      prev: currentLineIdx > 0 ? lineGroups[currentLineIdx - 1] : null,
    };
  };

  const { current: previewLine, prev: prevPreviewLine } = isSyncing
    ? getPreviewLines()
    : { current: null, prev: null };

  // Update the data ref for the exiting-line effect
  useLayoutEffect(() => {
    if (previewLine) {
      prevPreviewDataRef.current = previewLine;
    }
  }, [previewLine]);

  /**
   * Preview word state uses real audio time to mirror canvas rendering.
   * A small grace period ensures the last word of a line stays highlighted
   * briefly even when endTime is set very close to audioTime (fast tapping).
   */
  const MIN_VISUAL_HIGHLIGHT = 0.3; // 300ms minimum visual active time
  const getPreviewWordClass = (word: ThrenicWord) => {
    if (word.startTime === 0) return styles.previewUpcoming;
    if (word.endTime > 0 && audioTime >= word.endTime) {
      // Grace period: keep word active for at least MIN_VISUAL_HIGHLIGHT after startTime
      const minEnd = word.startTime + MIN_VISUAL_HIGHLIGHT;
      if (audioTime < minEnd) return styles.previewActive;
      return styles.previewPast;
    }
    if (audioTime >= word.startTime) return styles.previewActive;
    return styles.previewUpcoming;
  };

  // ── Render ──
  // ── Render ──
  const modalContent = (
    <div className={styles.overlay} onClick={handleFinalClose}>
      <div className={styles.panel} ref={containerRef} onClick={(e) => e.stopPropagation()}>
        {/* ── Screen Size Guard Overlay ── */}
        {screenTooSmall ? (
          <div className={styles.unsupportedOverlay}>
            <div className={styles.unsupportedCard}>
              <AlertTriangle className={styles.unsupportedIcon} size={32} />
              <h3 className={styles.unsupportedTitle}>Screen Size Unsupported</h3>
              <p className={styles.unsupportedText}>
                We can&apos;t support such a small screen with the functionality required to work on
                the app.
              </p>
              <div className={styles.unsupportedDiagnostics}>
                <span>Required: 320x500+</span>
                <span>
                  Current: {windowSize.width}x{windowSize.height}
                </span>
              </div>
            </div>
          </div>
        ) : isMobile ? (
          /* ════════════════════════════════════════
             MOBILE VIEWPORT (isMobile = true)
             ════════════════════════════════════════ */
          <div className={styles.mobileMainContainer}>
            {/* Header */}
            <div className={styles.header}>
              <div className={styles.trackInfo}>
                <span className={styles.label}>SYNC LYRICS</span>
                {trackName && <span className={styles.trackName}>{trackName}</span>}
              </div>
              <button className={styles.closeBtn} onClick={handleFinalClose}>
                <X size={20} />
              </button>
            </div>

            {isSyncing ? (
              /* ACTIVE MOBILE SYNC */
              <>
                <div className={styles.mobileVisualStage}>
                  {isComplete ? (
                    <div className={styles.syncCompleteCard}>
                      <div className={styles.syncCompleteIcon}>
                        <Check size={32} />
                      </div>
                      <h3 className={styles.syncCompleteTitle}>All Lyrics Synced!</h3>
                      <button
                        className={styles.syncCompleteBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          finalizeSync();
                        }}
                      >
                        <Check size={16} />
                        End Lyric Sync
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* Active display scrolling lines */}
                      <div className={styles.wordDisplay} ref={wordDisplayRef}>
                        {contextLines.map((line, lineIdx) => {
                          const isCurrentLine = line.words.some((w) => w.relativeIndex === 0);
                          const lineKey = line.words[0]?.id || `line-${lineIdx}`;

                          return (
                            <ShrinkToFitLine
                              key={lineKey}
                              className={`${styles.line} ${isCurrentLine ? styles.activeLine : ''}`}
                              maxWidth={wordDisplayWidth}
                            >
                              {line.words.map((word) => (
                                <span
                                  key={word.id}
                                  className={`
                                    ${styles.word}
                                    ${word.relativeIndex === 0 ? styles.current : ''}
                                    ${word.relativeIndex < 0 ? styles.past : ''}
                                    ${word.relativeIndex > 0 ? styles.upcoming : ''}
                                  `}
                                >
                                  {word.text}
                                </span>
                              ))}
                            </ShrinkToFitLine>
                          );
                        })}
                      </div>

                      {/* Progress bar */}
                      <div className={styles.progressContainer}>
                        <div className={styles.progressBar}>
                          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                        </div>
                        <span className={styles.progressText}>
                          {currentIndex + 1} / {displayWords.length}
                        </span>
                      </div>

                      {/* Dual-line preview */}
                      {previewLine && (
                        <div className={styles.preview}>
                          <span className={styles.previewLabel}>PREVIEW</span>
                          <div className={styles.previewContent}>
                            {prevPreviewLine && (
                              <div className={styles.previewLine + ' ' + styles.previewPrevLine}>
                                {prevPreviewLine.words.map((word) => (
                                  <span
                                    key={word.id}
                                    className={`${styles.previewWord} ${getPreviewWordClass(word)}`}
                                  >
                                    {word.text}
                                  </span>
                                ))}
                              </div>
                            )}
                            {exitingLine && (
                              <div
                                key={`exit-${exitingLine.words[0]?.id}`}
                                className={`${styles.previewLine} ${styles.previewExiting}`}
                              >
                                {exitingLine.words.map((word) => (
                                  <span
                                    key={word.id}
                                    className={`${styles.previewWord} ${getPreviewWordClass(word)}`}
                                  >
                                    {word.text}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div
                              key={`cur-${previewLineKeyForEffect}`}
                              className={`${styles.previewLine} ${exitingLine ? styles.previewEntering : ''}`}
                            >
                              {previewLine.words.map((word) => (
                                <span
                                  key={word.id}
                                  className={`${styles.previewWord} ${getPreviewWordClass(word)}`}
                                >
                                  {word.text}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Bottom Touch-First Control Deck */}
                {!isComplete && (
                  <div className={styles.mobileControlDeck}>
                    {/* Giant Hit Actions Row */}
                    <div className={styles.hitRow}>
                      <button
                        className={styles.giantLineBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          registerHit('LINE');
                        }}
                      >
                        TAP LINE
                      </button>
                      <button
                        className={styles.giantWordBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          registerHit('WORD');
                        }}
                      >
                        TAP WORD
                      </button>
                    </div>

                    {/* Tactile transport & utility Row */}
                    <div className={styles.utilityRow}>
                      <button
                        className={styles.utilityBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePause();
                        }}
                      >
                        {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                        <span>{isPlaying ? 'Pause' : 'Resume'}</span>
                      </button>

                      <button
                        className={styles.utilityBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          undo();
                        }}
                        disabled={!canUndo}
                      >
                        <RotateCcw size={18} />
                        <span>Undo</span>
                      </button>

                      <button
                        className={styles.utilityBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          seekBackAndClear(5);
                        }}
                      >
                        <RotateCcw size={18} />
                        <span>Undo 5s</span>
                      </button>

                      <button
                        className={`${styles.utilityBtn} ${styles.mobileDoneBtn}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStopSync();
                        }}
                      >
                        <Square size={14} fill="currentColor" />
                        <span>Done</span>
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* MOBILE STANDBY */
              <div className={styles.mobileStandbyContainer}>
                <div className={styles.mobileEditorWrapper}>
                  <span className={styles.panelTitle}>LYRICS TEXT</span>
                  <textarea
                    ref={textareaRef}
                    className={styles.mobileEditorTextarea}
                    value={rawLyrics}
                    onChange={handleTextChange}
                    placeholder={
                      'Paste or type lyrics here…\n\nEach line becomes a line in the video.'
                    }
                    spellCheck={false}
                  />
                </div>

                <div className={styles.mobileSettingsSection}>
                  <div className={styles.mobileSettingGroup}>
                    <div className={styles.mobileSettingLabelRow}>
                      <span className={styles.settingLabel}>Max Highlight</span>
                      <span className={styles.settingValue}>
                        {maxHighlightDuration.toFixed(1)}s
                      </span>
                    </div>
                    <input
                      type="range"
                      className={styles.settingSlider}
                      min={0.3}
                      max={3.0}
                      step={0.1}
                      value={maxHighlightDuration}
                      onChange={(e) => setMaxHighlightDuration(parseFloat(e.target.value))}
                    />
                  </div>

                  <div className={styles.mobileSettingGroup}>
                    <div className={styles.mobileSettingLabelRow}>
                      <span className={styles.settingLabel}>Playback Speed</span>
                      <span className={styles.settingValue}>{playbackRate.toFixed(2)}x</span>
                    </div>
                    <input
                      type="range"
                      className={styles.settingSlider}
                      min={0.25}
                      max={1.0}
                      step={0.05}
                      value={playbackRate}
                      onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
                    />
                  </div>
                </div>

                <div className={styles.mobileStandbyButtons}>
                  <button
                    className={styles.mobilePrimaryBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartSync();
                    }}
                    disabled={!hasContent || !isAudioReady}
                  >
                    <Play size={16} fill="currentColor" />
                    Start Sync
                  </button>

                  {displayWords.some((w) => w.startTime > 0) && (
                    <button
                      className={styles.mobileSaveBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleFinalClose();
                      }}
                    >
                      <Check size={16} />
                      Save &amp; Close
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ════════════════════════════════════════
             DESKTOP VIEWPORT (isMobile = false)
             ════════════════════════════════════════ */
          <>
            {/* ── Header ── */}
            <div className={styles.header}>
              <div className={styles.trackInfo}>
                <span className={styles.label}>SYNC LYRICS</span>
                {trackName && <span className={styles.trackName}>{trackName}</span>}
              </div>
              <button className={styles.closeBtn} onClick={handleFinalClose}>
                <X size={20} />
              </button>
            </div>

            {/* ── Three-panel layout ── */}
            <div className={styles.threePanel}>
              {/* ═══ LEFT — Lyrics Editor ═══ */}
              <div className={styles.leftPanel}>
                <span className={styles.panelTitle}>LYRICS</span>
                <div className={styles.editorContainer}>
                  {isSyncing && currentLineNumber >= 0 && (
                    <div
                      className={styles.lineHighlight}
                      style={{
                        top: `${currentLineNumber * EDITOR_LINE_HEIGHT + 12 - textareaScrollTop}px`,
                        height: `${EDITOR_LINE_HEIGHT}px`,
                      }}
                    />
                  )}
                  <textarea
                    ref={textareaRef}
                    className={styles.editorTextarea}
                    value={rawLyrics}
                    onChange={handleTextChange}
                    placeholder={
                      'Paste or type lyrics here…\n\nEach line becomes a line in the video.'
                    }
                    spellCheck={false}
                  />
                </div>
              </div>

              {/* ═══ CENTER — Sync Display ═══ */}
              <div
                ref={centerRef}
                className={`${styles.centerPanel} ${centerFocused ? styles.centerFocused : ''}`}
                tabIndex={0}
                onFocus={() => setCenterFocused(true)}
                onBlur={() => setCenterFocused(false)}
                onClick={isSyncing ? handleCenterClick : undefined}
                onKeyDown={handleCenterKeyDown}
              >
                {isSyncing ? (
                  <>
                    {!centerFocused && (
                      <div className={styles.focusHint}>
                        {isComplete ? 'Click to finish' : 'Click here to sync'}
                      </div>
                    )}

                    <div className={styles.wordDisplay} ref={wordDisplayRef}>
                      {isComplete ? (
                        <div className={styles.syncCompleteCard}>
                          <div className={styles.syncCompleteIcon}>
                            <Check size={32} />
                          </div>
                          <h3 className={styles.syncCompleteTitle}>All Lyrics Synced!</h3>
                          <p className={styles.syncCompleteHint}>
                            Press <kbd>any key</kbd> or <kbd>click</kbd> to save &amp; return to
                            preview
                          </p>
                          <button
                            className={styles.syncCompleteBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              finalizeSync();
                            }}
                          >
                            <Check size={16} />
                            End Lyric Sync
                          </button>
                        </div>
                      ) : (
                        contextLines.map((line, lineIdx) => {
                          const isCurrentLine = line.words.some((w) => w.relativeIndex === 0);
                          const lineKey = line.words[0]?.id || `line-${lineIdx}`;

                          return (
                            <ShrinkToFitLine
                              key={lineKey}
                              className={`${styles.line} ${isCurrentLine ? styles.activeLine : ''}`}
                              maxWidth={wordDisplayWidth}
                            >
                              {line.words.map((word) => (
                                <span
                                  key={word.id}
                                  className={`
                                    ${styles.word}
                                    ${word.relativeIndex === 0 ? styles.current : ''}
                                    ${word.relativeIndex < 0 ? styles.past : ''}
                                    ${word.relativeIndex > 0 ? styles.upcoming : ''}
                                  `}
                                >
                                  {word.text}
                                </span>
                              ))}
                            </ShrinkToFitLine>
                          );
                        })
                      )}
                    </div>

                    <div className={styles.progressContainer}>
                      <div className={styles.progressBar}>
                        <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                      </div>
                      <span className={styles.progressText}>
                        {currentIndex + 1} / {displayWords.length}
                      </span>
                    </div>

                    {previewLine && (
                      <div className={styles.preview}>
                        <span className={styles.previewLabel}>PREVIEW</span>
                        <div className={styles.previewContent}>
                          {prevPreviewLine && (
                            <div className={styles.previewLine + ' ' + styles.previewPrevLine}>
                              {prevPreviewLine.words.map((word) => (
                                <span
                                  key={word.id}
                                  className={`${styles.previewWord} ${getPreviewWordClass(word)}`}
                                >
                                  {word.text}
                                </span>
                              ))}
                            </div>
                          )}
                          {exitingLine && (
                            <div
                              key={`exit-${exitingLine.words[0]?.id}`}
                              className={`${styles.previewLine} ${styles.previewExiting}`}
                            >
                              {exitingLine.words.map((word) => (
                                <span
                                  key={word.id}
                                  className={`${styles.previewWord} ${getPreviewWordClass(word)}`}
                                >
                                  {word.text}
                                </span>
                              ))}
                            </div>
                          )}
                          <div
                            key={`cur-${previewLineKeyForEffect}`}
                            className={`${styles.previewLine} ${exitingLine ? styles.previewEntering : ''}`}
                          >
                            {previewLine.words.map((word) => (
                              <span
                                key={word.id}
                                className={`${styles.previewWord} ${getPreviewWordClass(word)}`}
                              >
                                {word.text}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className={styles.standby}>
                    <Keyboard size={32} />
                    <p className={styles.standbyTitle}>Ready to Sync</p>
                    <div className={styles.standbyInstructions}>
                      <p>
                        Type or paste lyrics in the left panel, then press{' '}
                        <strong>Start Sync</strong>.
                      </p>
                      <p>
                        Tap <kbd>A-Z</kbd> to mark words · <kbd>Enter</kbd> for new lines ·{' '}
                        <kbd>Space</kbd> to pause
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* ═══ RIGHT — Controls & Settings ═══ */}
              <div className={styles.rightPanel} onClick={(e) => e.stopPropagation()}>
                <span className={styles.panelTitle}>CONTROLS</span>

                <div className={styles.controlGroup}>
                  {isSyncing ? (
                    <>
                      <button
                        className={styles.controlBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePause();
                          setTimeout(() => centerRef.current?.focus(), 50);
                        }}
                      >
                        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                        {isPlaying ? 'Pause' : 'Resume'}
                      </button>

                      <button
                        className={styles.controlBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          undo();
                          centerRef.current?.focus();
                        }}
                        disabled={!canUndo}
                      >
                        <RotateCcw size={14} />
                        Undo
                      </button>

                      <button
                        className={styles.controlBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          seekBackAndClear(5);
                          centerRef.current?.focus();
                        }}
                      >
                        <RotateCcw size={14} />
                        Undo 5s
                      </button>

                      <div className={styles.controlDivider} />

                      <button
                        className={`${styles.controlBtn} ${styles.doneBtn}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStopSync();
                        }}
                      >
                        <Square size={14} fill="currentColor" />
                        Done
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className={styles.primaryBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartSync();
                        }}
                        disabled={!hasContent || !isAudioReady}
                      >
                        <Play size={14} />
                        Start Sync
                      </button>

                      {displayWords.some((w) => w.startTime > 0) && (
                        <button
                          className={styles.saveBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleFinalClose();
                          }}
                        >
                          <Check size={14} />
                          Save &amp; Close
                        </button>
                      )}
                    </>
                  )}
                </div>

                <div className={styles.controlDivider} />
                <span className={styles.panelTitle}>SETTINGS</span>

                <div className={styles.settingGroup}>
                  <label className={styles.settingLabel}>
                    Max Highlight
                    <span className={styles.settingValue}>{maxHighlightDuration.toFixed(1)}s</span>
                  </label>
                  <input
                    type="range"
                    className={styles.settingSlider}
                    min={0.3}
                    max={3.0}
                    step={0.1}
                    value={maxHighlightDuration}
                    onChange={(e) => setMaxHighlightDuration(parseFloat(e.target.value))}
                  />
                  <div className={styles.sliderLabels}>
                    <span>0.3s</span>
                    <span>3.0s</span>
                  </div>
                </div>

                <div className={styles.settingGroup}>
                  <label className={styles.settingLabel}>
                    Speed
                    <span className={styles.settingValue}>{playbackRate.toFixed(2)}x</span>
                  </label>
                  <input
                    type="range"
                    className={styles.settingSlider}
                    min={0.25}
                    max={1.0}
                    step={0.05}
                    value={playbackRate}
                    onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
                  />
                  <div className={styles.sliderLabels}>
                    <span>0.25x</span>
                    <span>1.0x</span>
                  </div>
                </div>

                <div className={styles.controlDivider} />
                <span className={styles.panelTitle}>SHORTCUTS</span>

                <div className={styles.shortcutList}>
                  {[
                    ['A-Z', 'Next Word'],
                    ['Enter', 'Next Line'],
                    ['BS', 'Undo Word'],
                    ['Ctrl+BS', 'Undo 5s'],
                    ['Space', 'Play/Pause'],
                    ['Esc', 'Stop Sync'],
                  ].map(([key, action]) => (
                    <div key={key} className={styles.shortcutRow}>
                      <kbd className={styles.kbdSmall}>{key}</kbd>
                      <span className={styles.shortcutLabel}>{action}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (!shouldRender) return null;

  return createPortal(modalContent, document.body);
}
