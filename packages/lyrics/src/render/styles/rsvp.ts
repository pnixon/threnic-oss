/**
 * Style: RSVP (Rapid Serial Visual Presentation).
 *
 * One word at a time, dead centre, huge — only the currently-sung word is
 * visible. This is a genuine LAYOUT-OVERRIDE: the word/line modifier seam can
 * only express relative em-offsets + multiplicative scale, which cannot place a
 * word at an absolute canvas position. So RSVP implements `layout(ctx, words,
 * frame)`, takes over the entire lyric draw, and paints exactly one word at
 * (width/2, height/2).
 *
 * Word selection (see `pickActiveWord`): the active word is the one whose
 * [start, end] contains the current time. In a gap between words (or before the
 * first word's start once we're past a prior word), the most recent word whose
 * start <= time is held on screen, so the presentation never flickers to blank
 * mid-verse. Before the very first word starts, nothing is drawn.
 *
 * Sizing is `frame.fontSizePx * RSVP_SCALE`, with an optional audio.energy pulse
 * so the word breathes with the mix. `modifyWord` returns the identity modifier
 * (required by LyricStyle) — it is never consulted because the renderer skips
 * its normal per-word path when `layout` is present.
 */
import type {
  LyricStyle,
  StyleCanvasContext,
  StyleFrameContext,
  StyleLaidOutWord,
  StyleWordModifier,
} from '../StyleRegistry';

/** Base multiplier applied to frame.fontSizePx for the single centred word. */
export const RSVP_SCALE = 3;
/** Extra scale contributed at full energy (audio.energy = 1). */
export const RSVP_ENERGY_PULSE = 0.15;
/** Fill colour for the word. */
export const RSVP_FILL = '#ffffff';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Pick the word to display at `time`.
 *
 * Rules:
 *  - If `time` is within some word's [start, end], that word is active.
 *  - Otherwise (a gap, or after the last word ended), hold the most recent word
 *    whose `start <= time` — the last word that has begun.
 *  - Before the first word's start, return null (draw nothing).
 *
 * When words overlap or share a start, the LAST matching word in iteration
 * order wins, which keeps behaviour deterministic for a monotonic list.
 */
export function pickActiveWord(
  words: readonly StyleLaidOutWord[],
  time: number,
): StyleLaidOutWord | null {
  let active: StyleLaidOutWord | null = null;
  let held: StyleLaidOutWord | null = null;

  for (const w of words) {
    if (time >= w.start && time <= w.end) {
      active = w;
    }
    if (w.start <= time) {
      held = w;
    }
  }

  return active ?? held;
}

export function drawRsvp(
  ctx: StyleCanvasContext,
  words: readonly StyleLaidOutWord[],
  frame: StyleFrameContext,
): void {
  const word = pickActiveWord(words, frame.time);
  if (!word) return; // before the first word — draw nothing

  const energy = clamp01(frame.audio?.energy ?? 0);
  const scale = RSVP_SCALE + energy * RSVP_ENERGY_PULSE;
  const fontPx = frame.fontSizePx * scale;

  ctx.save();
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = RSVP_FILL;
  ctx.fillText(word.text, frame.width / 2, frame.height / 2);
  ctx.restore();
}

export const rsvpStyle: LyricStyle = {
  id: 'rsvp',
  name: 'RSVP',
  // Layout-override style: the per-word delta is never consulted, but the
  // interface requires it — return the identity modifier.
  modifyWord: (): StyleWordModifier => ({}),
  layout: drawRsvp,
};
