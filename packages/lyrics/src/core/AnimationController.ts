/**
 * AnimationController — Pure animation state & transform calculations.
 *
 * Framework-agnostic (no React, no Three.js). Moved from the Threnic app
 * (src/engine/lyrics/AnimationController.ts) with the only change being the
 * type import repointed to the package's own types.
 */

import type { LyricAnimationType, LyricAnimationConfig } from '../types/core';

export type AnimationPhase = 'entering' | 'visible' | 'exiting' | 'hidden';

export interface AnimationState {
  phase: AnimationPhase;
  /** Progress within current phase (0-1) */
  progress: number;
  /** Entry animation progress (0-1, 1 = fully entered) */
  entryProgress: number;
  /** Exit animation progress (0-1, 1 = fully exited) */
  exitProgress: number;
}

export interface AnimationTransform {
  /** Scale factor */
  scale: number;
  /** X offset */
  offsetX: number;
  /** Y offset */
  offsetY: number;
  /** Opacity (0-1) */
  opacity: number;
}

// ─── Easing Functions ────────────────────────────────────────

export function easeBackOut(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function easeElasticOut(t: number): number {
  if (t === 0 || t === 1) return t;
  return 1.0 + Math.sin(t * Math.PI * 2.5) * (1 - t) * 0.3;
}

export function smoothstep(t: number, min = 0, max = 1): number {
  const x = Math.min(1, Math.max(0, (t - min) / (max - min)));
  return x * x * (3 - 2 * x);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ─── Animation State ─────────────────────────────────────────

export interface AnimationTimingParams {
  currentTime: number;
  itemStart: number;
  itemEnd: number;
  entryConfig: LyricAnimationConfig;
  exitConfig: LyricAnimationConfig;
  staggerIndex: number;
  /** Optional separate stagger index for exit phase. Falls back to staggerIndex if unset. */
  exitStaggerIndex?: number;
  totalItems: number;
}

export function calculateAnimationState(params: AnimationTimingParams): AnimationState {
  const { currentTime, itemStart, itemEnd, entryConfig, exitConfig, staggerIndex } = params;

  const entryDuration = entryConfig.duration ?? 0.5;
  const exitDuration = exitConfig.duration ?? 0.5;
  const entryStagger = entryConfig.stagger ?? 0.05;
  const exitStagger = exitConfig.stagger ?? 0.05;

  const staggeredEntryStart = itemStart - entryDuration + entryStagger * staggerIndex;
  const staggeredEntryEnd = staggeredEntryStart + entryDuration;
  const effectiveExitStaggerIndex = params.exitStaggerIndex ?? staggerIndex;
  const staggeredExitStart = itemEnd + exitStagger * effectiveExitStaggerIndex;
  const staggeredExitEnd = staggeredExitStart + exitDuration;

  let phase: AnimationPhase;
  let entryProgress = 1;
  let exitProgress = 0;

  if (currentTime < staggeredEntryStart) {
    phase = 'hidden';
    entryProgress = 0;
  } else if (currentTime < staggeredEntryEnd) {
    phase = 'entering';
    entryProgress = (currentTime - staggeredEntryStart) / entryDuration;
  } else if (currentTime < staggeredExitStart) {
    phase = 'visible';
    entryProgress = 1;
  } else if (currentTime < staggeredExitEnd) {
    phase = 'exiting';
    exitProgress = (currentTime - staggeredExitStart) / exitDuration;
  } else {
    phase = 'hidden';
    exitProgress = 1;
  }

  return {
    phase,
    progress: phase === 'entering' ? entryProgress : phase === 'exiting' ? exitProgress : 0,
    entryProgress: clamp(entryProgress, 0, 1),
    exitProgress: clamp(exitProgress, 0, 1),
  };
}

// ─── Entry / Exit Transforms ────────────────────────────────

export function calculateEntryTransform(
  animType: LyricAnimationType,
  progress: number,
  config: LyricAnimationConfig,
): AnimationTransform {
  const result: AnimationTransform = { scale: 1, offsetX: 0, offsetY: 0, opacity: 1 };
  if (progress >= 1) return result;

  switch (animType) {
    case 'pop':
      if (progress > 0) {
        result.scale = easeBackOut(progress);
        result.opacity = result.scale > 0 ? 1 : 0;
      } else {
        result.scale = 0;
        result.opacity = 0;
      }
      break;
    case 'fade':
      result.opacity = smoothstep(progress);
      break;
    case 'fly': {
      result.opacity = smoothstep(progress);
      const distance = config.distance ?? 0.5;
      result.offsetY = (1 - smoothstep(progress)) * distance;
      break;
    }
    case 'slide': {
      result.opacity = smoothstep(progress);
      const distance = config.distance ?? 0.5;
      result.offsetX = (1 - smoothstep(progress)) * distance;
      break;
    }
    case 'typewriter':
      result.opacity = progress > 0 ? 1 : 0;
      break;
  }
  return result;
}

export function calculateExitTransform(
  animType: LyricAnimationType,
  progress: number,
  config: LyricAnimationConfig,
): AnimationTransform {
  const result: AnimationTransform = { scale: 1, offsetX: 0, offsetY: 0, opacity: 1 };
  if (progress <= 0) return result;

  const inv = 1 - progress;

  switch (animType) {
    case 'pop':
      result.scale = inv;
      result.opacity = inv;
      break;
    case 'fade':
      result.opacity = smoothstep(inv);
      break;
    case 'fly': {
      result.opacity = smoothstep(inv);
      const distance = config.distance ?? -0.5;
      result.offsetY = smoothstep(progress) * distance;
      break;
    }
    case 'slide': {
      result.opacity = smoothstep(inv);
      const distance = config.distance ?? -0.5;
      result.offsetX = smoothstep(progress) * distance;
      break;
    }
    case 'typewriter':
      result.opacity = progress < 1 ? 1 : 0;
      break;
  }
  return result;
}

export function combineTransforms(
  entry: AnimationTransform,
  exit: AnimationTransform,
): AnimationTransform {
  return {
    scale: entry.scale * exit.scale,
    offsetX: entry.offsetX + exit.offsetX,
    offsetY: entry.offsetY + exit.offsetY,
    opacity: entry.opacity * exit.opacity,
  };
}

// ─── Word Animation (extracted from useWordAnimation) ────────

/** Floor for the fade-in window, so words in fast passages still fade rather
 *  than pop in when the timing data puts them almost on top of each other. */
const MIN_ENTRY_LEAD_IN = 0.12;

/** Max share of the fade-in window that character stagger may consume. */
const MAX_STAGGER_SHARE = 0.6;

export interface WordAnimationParams {
  currentTime: number;
  wordStart?: number;
  wordEnd?: number;
  prevWordEnd?: number;
  /** Start time of the previous word in the same lane. Bounds this word's
   *  fade-in so it cannot begin before the previous word's fade-in began,
   *  which keeps the reveal order identical to the reading order. */
  prevWordStart?: number;
  /** End time of the previous line (in the same lane). When set, bounds the
   *  first word's fade-in so it cannot begin before the previous line ended. */
  prevLineEnd?: number;
  lineStart: number;
  lineEnd: number;
  animationIn: LyricAnimationConfig;
  animationOut: LyricAnimationConfig;
  staggerIndex: number;
  totalItems: number;
  highlightFadeIn?: number;
  highlightFadeOut?: number;
}

export interface WordAnimationResult extends AnimationTransform {
  isVisible: boolean;
  highlightAlpha: number;
}

export function calculateWordAnimation(params: WordAnimationParams): WordAnimationResult {
  const { currentTime, lineStart, lineEnd, animationIn, animationOut, staggerIndex, totalItems } =
    params;

  // Use staggerIndex for 'char' granularity (letters within a word share the same anchor);
  // For 'word' granularity: each word already has its own wordStart anchor, so no stagger needed.
  // For 'line': all words enter together, no stagger.
  const entryStaggerIndex = animationIn.granularity === 'char' ? staggerIndex : 0;
  const activeEntryStart =
    (animationIn.granularity === 'word' || animationIn.granularity === 'char') &&
    params.wordStart !== undefined
      ? params.wordStart
      : lineStart;

  // For 'char': stagger letters within the word using char index (they share the same word.end anchor)
  // For 'word': each word is already anchored to its own word.end, so no extra stagger index needed
  // For 'line': all words exit together at lineEnd, no stagger
  const exitStaggerIndex = animationOut.granularity === 'char' ? staggerIndex : 0;
  const activeExitEnd =
    (animationOut.granularity === 'word' || animationOut.granularity === 'char') &&
    params.wordEnd !== undefined
      ? params.wordEnd
      : lineEnd;

  // ─── Entry window ──────────────────────────────────────────
  // One rule for every item, so that what the viewer sees can never depend on
  // word length or on the size of a gap in the timing data:
  //
  //   • The entry animation ENDS exactly at the anchor (wordStart), so a word
  //     is never still fading in once it is being sung.
  //   • The window is `duration` long, shortened only if the previous word
  //     started less than that ago. Bounding against the previous word's START
  //     (not its end) keeps onsets strictly ordered — a later word can never
  //     appear before an earlier one, which is what produced holes in the line.
  //   • Character stagger is distributed INSIDE that window instead of
  //     extending it backwards, so "cathedral" and "door" begin fading at the
  //     same lead-in rather than 0.4s apart.
  let effectiveAnimIn = animationIn;
  let effectiveEntryStart = activeEntryStart;

  if (
    (animationIn.granularity === 'word' || animationIn.granularity === 'char') &&
    params.wordStart !== undefined
  ) {
    const wordStart = params.wordStart;
    const configuredDuration = animationIn.duration ?? 0.5;
    const configuredStagger = animationIn.stagger ?? 0.05;

    let leadIn = configuredDuration;
    if (params.prevWordStart !== undefined) {
      const spacing = wordStart - params.prevWordStart;
      if (spacing > 0) leadIn = Math.min(leadIn, Math.max(MIN_ENTRY_LEAD_IN, spacing));
    } else if (params.prevLineEnd !== undefined) {
      // First word of a line: clamp so fade-in cannot begin before the
      // previous line ended. This prevents the next line's first word from
      // fading in while the previous line is still being sung.
      const gapFromPrevLine = wordStart - params.prevLineEnd;
      if (gapFromPrevLine > 0) {
        leadIn = Math.min(leadIn, Math.max(MIN_ENTRY_LEAD_IN, gapFromPrevLine));
      } else {
        // Lines overlap or are flush — use minimum lead-in
        leadIn = MIN_ENTRY_LEAD_IN;
      }
    }

    // Only 'char' granularity staggers multiple items against one anchor.
    const staggerCount = animationIn.granularity === 'char' ? Math.max(1, totalItems) : 1;
    let stagger = configuredStagger;
    let spread = stagger * (staggerCount - 1);

    // Reserve at least (1 - MAX_STAGGER_SHARE) of the window for each item's own
    // fade, otherwise a long word degenerates into an instant left-to-right wipe.
    const maxSpread = leadIn * MAX_STAGGER_SHARE;
    if (spread > maxSpread) {
      stagger = staggerCount > 1 ? maxSpread / (staggerCount - 1) : 0;
      spread = stagger * (staggerCount - 1);
    }

    effectiveEntryStart = wordStart - spread;
    effectiveAnimIn = { ...animationIn, duration: leadIn - spread, stagger };
  }

  const entryState = calculateAnimationState({
    currentTime,
    itemStart: effectiveEntryStart,
    itemEnd: activeExitEnd,
    entryConfig: effectiveAnimIn,
    exitConfig: animationOut,
    staggerIndex: entryStaggerIndex,
    exitStaggerIndex: exitStaggerIndex,
    totalItems,
  });

  const entryTransform = calculateEntryTransform(
    effectiveAnimIn.type,
    entryState.entryProgress,
    effectiveAnimIn,
  );
  const exitTransform = calculateExitTransform(
    animationOut.type,
    entryState.exitProgress,
    animationOut,
  );
  const combined = combineTransforms(entryTransform, exitTransform);

  // ─── Highlight Alpha ───────────────────────────────────────
  let highlightAlpha = 0;
  if (params.wordStart !== undefined && params.wordEnd !== undefined) {
    const wStart = params.wordStart;
    const wEnd = params.wordEnd;
    highlightAlpha = currentTime >= wStart && currentTime <= wEnd ? 1 : 0;
  }

  return {
    ...combined,
    isVisible: combined.opacity > 0.01,
    highlightAlpha,
  };
}
