/**
 * Slideshow Core — Pure helper functions for slideshow transition logic.
 *
 * Shared by both `SlideshowStateMachine` (class-based, used by headless
 * export pipeline) and `slideshowStore` (Zustand store, used by React
 * preview).
 *
 * By centralising these functions we guarantee visual parity: if a
 * transition type behaves one way in preview it MUST behave the same
 * way in the headless export.
 */

import type {
  SlideshowTransition,
  SlideshowOrder,
  SlideshowTimingMode,
} from '@/types/effects/background';

// ─── Concrete transition types (excludes 'random') ───────────────────────────

export const CONCRETE_TRANSITIONS: ConcreteTransition[] = [
  'cut',
  'crossfade',
  'fadeBlack',
  'slideLeft',
  'slideRight',
  'slideUp',
  'slideDown',
  'zoom',
];

// ─── Public types ────────────────────────────────────────────────────────────

export type ConcreteTransition = Exclude<SlideshowTransition, 'random'>;

/** Visual state for a single slot (current or next slide). */
export interface SlotVisuals {
  opacity: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

/**
 * The complete output of a single tick.
 * Consumers use this to drive rendering.
 */
export interface SlideshowFrame {
  /** Index of the currently displayed item */
  currentIndex: number;
  /** Index of the item being transitioned to (may equal currentIndex when idle) */
  nextIndex: number;
  /** Whether a transition is currently in progress */
  transitioning: boolean;
  /** Transition progress 0..1 (0 means start, 1 means complete) */
  progress: number;
  /** The concrete transition type being used for this transition */
  activeTransition: ConcreteTransition;
  /** Visual state for the current slot */
  current: SlotVisuals;
  /** Visual state for the next slot */
  next: SlotVisuals;
  /**
   * True when the set of displayed indices changed this tick
   * (transition started or ended). Consumers that need to swap
   * mounted components (e.g. React setState) should check this.
   */
  indicesChanged: boolean;
}

/** Sentinel visual states. */
export const DEFAULT_VISUALS: SlotVisuals = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1 };
export const HIDDEN_VISUALS: SlotVisuals = { opacity: 0, offsetX: 0, offsetY: 0, scale: 1 };

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Resolve 'random' preference to a concrete transition type. */
export function pickTransition(pref: SlideshowTransition): ConcreteTransition {
  if (pref === 'random') {
    return CONCRETE_TRANSITIONS[Math.floor(Math.random() * CONCRETE_TRANSITIONS.length)];
  }
  return pref;
}

/** Determine how long the next slide should be displayed. */
export function getNextDuration(
  timingMode: SlideshowTimingMode,
  staticDuration: number,
  randomMin: number,
  randomMax: number,
): number {
  if (timingMode === 'random') {
    const min = Math.max(0.1, randomMin);
    const max = Math.max(min, randomMax);
    return min + Math.random() * (max - min);
  }
  return Math.max(0.1, staticDuration);
}

/** Calculate the next slide index based on ordering. */
export function getNextIndex(current: number, total: number, order: SlideshowOrder): number {
  if (total <= 1) return 0;
  if (order === 'random') {
    let next = Math.floor(Math.random() * (total - 1));
    if (next >= current) next++;
    return next;
  }
  return (current + 1) % total;
}

/**
 * Compute per-slot visuals for a given transition type and progress.
 * progress `p` ranges from 0 (start) to 1 (complete).
 */
export function computeVisuals(
  transition: ConcreteTransition,
  p: number,
): { current: SlotVisuals; next: SlotVisuals } {
  let curOp = 1.0,
    nxtOp = 0.0;
  let curOffX = 0,
    curOffY = 0;
  let nxtOffX = 0,
    nxtOffY = 0;
  let curScale = 1.0,
    nxtScale = 1.0;

  switch (transition) {
    case 'cut':
      curOp = p < 1.0 ? 1.0 : 0.0;
      nxtOp = p >= 1.0 ? 1.0 : 0.0;
      break;
    case 'crossfade':
      curOp = 1.0 - p;
      nxtOp = p;
      break;
    case 'fadeBlack':
      if (p < 0.5) {
        curOp = 1.0 - p * 2;
        nxtOp = 0;
      } else {
        curOp = 0;
        nxtOp = (p - 0.5) * 2;
      }
      break;
    case 'slideLeft':
      curOffX = -p * 2;
      nxtOffX = (1 - p) * 2;
      curOp = 1.0;
      nxtOp = 1.0;
      break;
    case 'slideRight':
      curOffX = p * 2;
      nxtOffX = -(1 - p) * 2;
      curOp = 1.0;
      nxtOp = 1.0;
      break;
    case 'slideUp':
      curOffY = p * 2;
      nxtOffY = -(1 - p) * 2;
      curOp = 1.0;
      nxtOp = 1.0;
      break;
    case 'slideDown':
      curOffY = -p * 2;
      nxtOffY = (1 - p) * 2;
      curOp = 1.0;
      nxtOp = 1.0;
      break;
    case 'zoom':
      curOp = 1.0 - p;
      nxtOp = p;
      curScale = 1.0 + p * 0.3;
      nxtScale = 0.7 + p * 0.3;
      break;
  }

  return {
    current: { opacity: curOp, offsetX: curOffX || 0, offsetY: curOffY || 0, scale: curScale },
    next: { opacity: nxtOp, offsetX: nxtOffX || 0, offsetY: nxtOffY || 0, scale: nxtScale },
  };
}
