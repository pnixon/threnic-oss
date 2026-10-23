/**
 * SlideshowDriver — Unified slot manager for slideshow transitions.
 *
 * Wraps SlideshowStateMachine and tracks which URLs should be loaded
 * in each rendering slot, producing a renderer-agnostic RenderState
 * that both preview and export consume.
 *
 * This is the SINGLE source of truth for:
 *   - Which URL goes in slot 1 (current) and slot 2 (next)
 *   - When slot URLs change (so consumers can load/unload textures)
 *   - Visual state per slot (opacity, offset, scale)
 *   - Video playback timing per slot (relative start times)
 *   - GPU blend mode for the active transition type
 *
 * Consumers are responsible for:
 *   - Actually loading textures (GPU bitmaps, React textures, etc.)
 *   - Rendering with the provided visual state
 *   - Managing video playback (HTMLVideoElement, VideoFrameExtractor, etc.)
 */

import type { SlideshowConfig, SlideshowMediaItem } from '@/types/effects/background';
import {
  SlideshowStateMachine,
  type SlideshowFrame,
  type TickSignals,
} from '@/engine/SlideshowStateMachine';
import { type ConcreteTransition, type SlotVisuals, HIDDEN_VISUALS } from './core';

// ─── Public types ────────────────────────────────────────────

/** State of a single rendering slot. */
interface SlotState {
  /** URL to render in this slot (null = empty) */
  url: string | null;
  /** Media type of the item in this slot */
  type: 'image' | 'video';
  /** Visual properties (opacity, offsetX, offsetY, scale) */
  visuals: SlotVisuals;
  /**
   * For video items: seconds elapsed since this video first appeared
   * in this slot. Use this to look up the correct decoded frame.
   * Always 0 for images.
   */
  videoRelativeTime: number;
  /**
   * True when this slot's URL changed this tick.
   * Consumer should load a new texture / media source.
   */
  urlChanged: boolean;
}

/** Complete render state produced by a single tick. */
interface SlideshowRenderState {
  /** Primary slot (the "current" image) */
  slot1: SlotState;
  /** Secondary slot (the "next" image during transitions, empty when idle) */
  slot2: SlotState;
  /**
   * GPU blend mode for the shader:
   *   0 = over-compositing (slide, zoom — slot 2 covers slot 1)
   *   1 = additive crossfade (crossfade, cut, fadeBlack — both blend)
   */
  blendMode: number;
  /** Whether a transition is currently in progress */
  transitioning: boolean;
  /** The concrete transition type active this tick */
  activeTransition: ConcreteTransition;
  /**
   * True when slot 2 was just cleared (transition completed this tick).
   * Consumer should unload slot 2's texture.
   */
  slot2Cleared: boolean;
}

// Transitions that use additive blending in the GPU shader
const ADDITIVE_TRANSITIONS = new Set<ConcreteTransition>(['crossfade', 'cut', 'fadeBlack']);

// ─── Driver class ───────────────────────────────────────────

export class SlideshowDriver {
  private machine = new SlideshowStateMachine();
  private items: SlideshowMediaItem[] = [];

  // Slot tracking
  private _slot1Url: string | null = null;
  private _slot2Url: string | null = null;
  /** Absolute time when slot 1's current video first appeared */
  private _slot1StartTime = 0;
  /** Absolute time when slot 2's current video first appeared */
  private _slot2StartTime = 0;
  /** Whether slot 2 was populated on the previous tick */
  private _slot2WasActive = false;
  /** Current wall clock (for video relative time) */
  private _currentTime = 0;

  /**
   * Initialise (or reinitialise) the driver for a set of items.
   * Resets all slot tracking state.
   */
  init(items: SlideshowMediaItem[], config: SlideshowConfig): void {
    this.items = items;
    this.machine.init(items.length, config);
    this._slot1Url = items[0]?.url ?? null;
    this._slot2Url = null;
    this._slot1StartTime = 0;
    this._slot2StartTime = 0;
    this._slot2WasActive = false;
    this._currentTime = 0;
  }

  /**
   * Full reset (e.g. on seek / track switch).
   */
  reset(): void {
    this.machine.reset();
    this._slot1Url = null;
    this._slot2Url = null;
    this._slot1StartTime = 0;
    this._slot2StartTime = 0;
    this._slot2WasActive = false;
    this._currentTime = 0;
  }

  /** Current wall-clock time of the internal state machine. */
  get time(): number {
    return this._currentTime;
  }

  /** Current item index (read-only). */
  get currentIndex(): number {
    return this.machine.currentIndex;
  }

  /**
   * Advance by delta seconds (preview path — wall-clock delta from rAF).
   * Returns the render state for this tick.
   */
  tick(delta: number, config: SlideshowConfig, signals?: TickSignals): SlideshowRenderState {
    this.items = config.items;
    const frame = this.machine.tick(delta, config, signals);
    this._currentTime = this.machine.time;
    return this._processFrame(frame);
  }

  /**
   * Advance to an absolute time (export path — avoids FP drift).
   * Returns the render state for this tick.
   */
  tickAt(
    absoluteTime: number,
    config: SlideshowConfig,
    signals?: TickSignals,
  ): SlideshowRenderState {
    this.items = config.items;
    const frame = this.machine.tickAt(absoluteTime, config, signals);
    this._currentTime = absoluteTime;
    return this._processFrame(frame);
  }

  // ─── Private ──────────────────────────────────────────────

  /**
   * Process a SlideshowFrame from the state machine into a
   * renderer-agnostic SlideshowRenderState with slot tracking.
   */
  private _processFrame(frame: SlideshowFrame): SlideshowRenderState {
    const time = this._currentTime;

    // Resolve URLs from indices
    const currentUrl = this.items[frame.currentIndex]?.url ?? null;
    const currentType = this.items[frame.currentIndex]?.type ?? 'image';
    const nextUrl = frame.transitioning ? (this.items[frame.nextIndex]?.url ?? null) : null;
    const nextType = frame.transitioning ? (this.items[frame.nextIndex]?.type ?? 'image') : 'image';

    // ── Slot 1 (current) URL tracking ──
    let slot1UrlChanged = false;
    if (currentUrl !== this._slot1Url) {
      // If promoted from slot 2 (was the "next" item), inherit its
      // video start time so the video continues seamlessly.
      if (currentUrl === this._slot2Url) {
        this._slot1StartTime = this._slot2StartTime;
      } else {
        this._slot1StartTime = time;
      }
      this._slot1Url = currentUrl;
      slot1UrlChanged = true;
    }

    // ── Slot 2 (next) URL tracking ──
    let slot2UrlChanged = false;
    let slot2Cleared = false;

    if (frame.transitioning && nextUrl) {
      // Transition in progress — slot 2 should have the next item
      if (nextUrl !== this._slot2Url) {
        this._slot2StartTime = time;
        this._slot2Url = nextUrl;
        slot2UrlChanged = true;
      }
      this._slot2WasActive = true;
    } else if (this._slot2WasActive) {
      // Transition just ended — clear slot 2
      this._slot2Url = null;
      this._slot2WasActive = false;
      slot2Cleared = true;
    }

    // ── Blend mode ──
    const blendMode = ADDITIVE_TRANSITIONS.has(frame.activeTransition) ? 1.0 : 0.0;

    // ── Video relative times ──
    const slot1VideoRelTime =
      currentType === 'video' ? Math.max(0, time - this._slot1StartTime) : 0;
    const slot2VideoRelTime =
      nextType === 'video' && frame.transitioning ? Math.max(0, time - this._slot2StartTime) : 0;

    // ── Build render state ──
    return {
      slot1: {
        url: currentUrl,
        type: currentType,
        visuals: frame.current,
        videoRelativeTime: slot1VideoRelTime,
        urlChanged: slot1UrlChanged,
      },
      slot2: frame.transitioning
        ? {
            url: nextUrl,
            type: nextType,
            visuals: frame.next,
            videoRelativeTime: slot2VideoRelTime,
            urlChanged: slot2UrlChanged,
          }
        : {
            url: null,
            type: 'image',
            visuals: HIDDEN_VISUALS,
            videoRelativeTime: 0,
            urlChanged: false,
          },
      blendMode,
      transitioning: frame.transitioning,
      activeTransition: frame.activeTransition,
      slot2Cleared,
    };
  }
}
