/**
 * KeyframeSlotAssignment.test.ts
 *
 * Tests for the slot-assignment logic used by SlideshowBackgroundPlane's
 * keyframe mode. This validates that during a crossfade transition:
 *
 *   1. The OUTGOING video stays in its current slot (no remount/restart).
 *   2. The INCOMING video goes into the OTHER slot.
 *   3. After transition completes, roles swap correctly.
 *   4. Idle state respects the current role mapping.
 *
 * These tests exercise the pure algorithm extracted from the React component
 * to verify correctness without needing R3F/DOM.
 */

import { describe, it, expect } from 'vitest';

// ─── Types mirroring the component ──────────────────────────────
interface MediaItem {
  id: string;
  url: string;
}

type SlotRole = 'a-is-current' | 'b-is-current';

interface SlotItems {
  a: MediaItem | null;
  b: MediaItem | null;
}

interface TransitionState {
  isActive: boolean;
  progress: number;
}

/**
 * Pure function that mirrors the keyframe-mode slot assignment logic
 * from SlideshowBackgroundPlane.tsx. This is the algorithm we fixed
 * to prevent video restart during crossfade.
 */
function computeKeyframeSlotAssignment(
  role: SlotRole,
  prevSlotItems: SlotItems,
  targetItem: MediaItem,
  prevItem: MediaItem,
  transition: TransitionState,
  globalOpacity: number,
): {
  slotItems: SlotItems;
  slotAOpacity: number;
  slotBOpacity: number;
  newRole: SlotRole;
} {
  let slotItems = { ...prevSlotItems };
  let slotAOpacity = 0;
  let slotBOpacity = 0;
  let newRole = role;

  if (transition.isActive) {
    const progress = transition.progress;

    // Outgoing stays in its current slot; incoming goes to the other
    const outgoingOpacity = (1.0 - progress) * globalOpacity;
    const incomingOpacity = progress * globalOpacity;

    if (role === 'a-is-current') {
      // A = outgoing (prevItem stays), B = incoming (targetItem)
      slotAOpacity = outgoingOpacity;
      slotBOpacity = incomingOpacity;
      if (prevSlotItems.a?.id !== prevItem?.id || prevSlotItems.b?.id !== targetItem?.id) {
        slotItems = { a: prevItem, b: targetItem };
      }
    } else {
      // B = outgoing (prevItem stays), A = incoming (targetItem)
      slotAOpacity = incomingOpacity;
      slotBOpacity = outgoingOpacity;
      if (prevSlotItems.b?.id !== prevItem?.id || prevSlotItems.a?.id !== targetItem?.id) {
        slotItems = { a: targetItem, b: prevItem };
      }
    }

    // Swap roles when transition completes
    if (progress >= 0.99) {
      newRole = role === 'a-is-current' ? 'b-is-current' : 'a-is-current';
    }
  } else {
    // Idle — show only the current item in the "current" slot
    if (role === 'a-is-current') {
      slotItems = { a: targetItem, b: null };
      slotAOpacity = globalOpacity;
      slotBOpacity = 0;
    } else {
      slotItems = { a: null, b: targetItem };
      slotAOpacity = 0;
      slotBOpacity = globalOpacity;
    }
  }

  return { slotItems, slotAOpacity, slotBOpacity, newRole };
}

// ─── Test fixtures ──────────────────────────────────────────────

const videoA: MediaItem = { id: 'clip-a', url: '/a.mp4' };
const videoB: MediaItem = { id: 'clip-b', url: '/b.mp4' };
const videoC: MediaItem = { id: 'clip-c', url: '/c.mp4' };

describe('Keyframe mode slot assignment — crossfade video continuity', () => {
  // ─── Core invariant: outgoing stays in its slot ───────────────

  describe('outgoing video stays in its current slot', () => {
    it('when A is current: outgoing stays in A, incoming goes to B', () => {
      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        { a: videoA, b: null }, // A was playing videoA
        videoB, // incoming
        videoA, // outgoing
        { isActive: true, progress: 0.0 },
        1.0,
      );

      // videoA must remain in slot A (no remount = no restart)
      expect(result.slotItems.a?.id).toBe('clip-a');
      // videoB goes to slot B
      expect(result.slotItems.b?.id).toBe('clip-b');
    });

    it('when B is current: outgoing stays in B, incoming goes to A', () => {
      const result = computeKeyframeSlotAssignment(
        'b-is-current',
        { a: null, b: videoA }, // B was playing videoA
        videoB, // incoming
        videoA, // outgoing
        { isActive: true, progress: 0.0 },
        1.0,
      );

      // videoA must remain in slot B
      expect(result.slotItems.b?.id).toBe('clip-a');
      // videoB goes to slot A
      expect(result.slotItems.a?.id).toBe('clip-b');
    });
  });

  // ─── Opacity ramp ─────────────────────────────────────────────

  describe('opacity during transition', () => {
    it('at start (progress=0): outgoing is fully visible, incoming is invisible', () => {
      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        { a: videoA, b: null },
        videoB,
        videoA,
        { isActive: true, progress: 0.0 },
        1.0,
      );

      // A is outgoing → fully visible
      expect(result.slotAOpacity).toBeCloseTo(1.0);
      // B is incoming → invisible
      expect(result.slotBOpacity).toBeCloseTo(0.0);
    });

    it('at midpoint (progress=0.5): both half visible', () => {
      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        { a: videoA, b: videoB },
        videoB,
        videoA,
        { isActive: true, progress: 0.5 },
        1.0,
      );

      expect(result.slotAOpacity).toBeCloseTo(0.5);
      expect(result.slotBOpacity).toBeCloseTo(0.5);
    });

    it('at end (progress=1.0): outgoing invisible, incoming fully visible', () => {
      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        { a: videoA, b: videoB },
        videoB,
        videoA,
        { isActive: true, progress: 1.0 },
        1.0,
      );

      // A is outgoing → invisible
      expect(result.slotAOpacity).toBeCloseTo(0.0);
      // B is incoming → fully visible
      expect(result.slotBOpacity).toBeCloseTo(1.0);
    });

    it('respects globalOpacity multiplier', () => {
      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        { a: videoA, b: videoB },
        videoB,
        videoA,
        { isActive: true, progress: 0.5 },
        0.6, // globalOpacity
      );

      expect(result.slotAOpacity).toBeCloseTo(0.3); // 0.5 * 0.6
      expect(result.slotBOpacity).toBeCloseTo(0.3);
    });
  });

  // ─── Role swapping ────────────────────────────────────────────

  describe('role swapping on transition completion', () => {
    it('swaps role when progress >= 0.99', () => {
      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        { a: videoA, b: videoB },
        videoB,
        videoA,
        { isActive: true, progress: 0.99 },
        1.0,
      );

      expect(result.newRole).toBe('b-is-current');
    });

    it('does NOT swap role when progress < 0.99', () => {
      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        { a: videoA, b: videoB },
        videoB,
        videoA,
        { isActive: true, progress: 0.5 },
        1.0,
      );

      expect(result.newRole).toBe('a-is-current');
    });

    it('B→A role swap works symmetrically', () => {
      const result = computeKeyframeSlotAssignment(
        'b-is-current',
        { a: videoB, b: videoA },
        videoB,
        videoA,
        { isActive: true, progress: 1.0 },
        1.0,
      );

      expect(result.newRole).toBe('a-is-current');
    });
  });

  // ─── Idle state ───────────────────────────────────────────────

  describe('idle state respects current role', () => {
    it('a-is-current idle: target in A, B is null', () => {
      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        { a: videoA, b: null },
        videoA,
        videoA,
        { isActive: false, progress: 0 },
        1.0,
      );

      expect(result.slotItems.a?.id).toBe('clip-a');
      expect(result.slotItems.b).toBeNull();
      expect(result.slotAOpacity).toBe(1.0);
      expect(result.slotBOpacity).toBe(0);
    });

    it('b-is-current idle: target in B, A is null', () => {
      const result = computeKeyframeSlotAssignment(
        'b-is-current',
        { a: null, b: videoB },
        videoB,
        videoB,
        { isActive: false, progress: 0 },
        1.0,
      );

      expect(result.slotItems.a).toBeNull();
      expect(result.slotItems.b?.id).toBe('clip-b');
      expect(result.slotAOpacity).toBe(0);
      expect(result.slotBOpacity).toBe(1.0);
    });
  });

  // ─── Multi-transition sequence ────────────────────────────────

  describe('consecutive transitions maintain slot stability', () => {
    it('A→B→C: each outgoing stays in its slot through the full sequence', () => {
      // Initial: A is current, playing videoA
      let role: SlotRole = 'a-is-current';
      let slotItems: SlotItems = { a: videoA, b: null };

      // ── Transition 1: A → B ──
      // Midway
      let r = computeKeyframeSlotAssignment(
        role,
        slotItems,
        videoB,
        videoA,
        { isActive: true, progress: 0.5 },
        1.0,
      );
      // videoA still in slot A (outgoing)
      expect(r.slotItems.a?.id).toBe('clip-a');
      expect(r.slotItems.b?.id).toBe('clip-b');

      // Complete
      r = computeKeyframeSlotAssignment(
        role,
        r.slotItems,
        videoB,
        videoA,
        { isActive: true, progress: 1.0 },
        1.0,
      );
      role = r.newRole; // should now be 'b-is-current'
      expect(role).toBe('b-is-current');

      // Idle after transition 1
      r = computeKeyframeSlotAssignment(
        role,
        r.slotItems,
        videoB,
        videoB,
        { isActive: false, progress: 0 },
        1.0,
      );
      slotItems = r.slotItems;
      // B is current → videoB in slot B
      expect(slotItems.b?.id).toBe('clip-b');

      // ── Transition 2: B → C ──
      r = computeKeyframeSlotAssignment(
        role,
        slotItems,
        videoC,
        videoB,
        { isActive: true, progress: 0.5 },
        1.0,
      );
      // videoB still in slot B (outgoing) — NO restart
      expect(r.slotItems.b?.id).toBe('clip-b');
      // videoC in slot A (incoming)
      expect(r.slotItems.a?.id).toBe('clip-c');

      // Complete
      r = computeKeyframeSlotAssignment(
        role,
        r.slotItems,
        videoC,
        videoB,
        { isActive: true, progress: 1.0 },
        1.0,
      );
      role = r.newRole;
      expect(role).toBe('a-is-current'); // swapped back
    });
  });

  // ─── Regression: the original bug ─────────────────────────────

  describe('regression: outgoing video must NOT be moved to a different slot', () => {
    it('BUG FIX: when transition starts, outgoing item id must match its pre-transition slot', () => {
      // Before fix: when role='a-is-current', the code put targetItem (incoming)
      // in slot A and prevItem (outgoing) in slot B — causing videoA to be
      // destroyed from slot A and recreated in slot B (restart!).
      //
      // After fix: outgoing stays in A, incoming goes to B.

      const priorSlots: SlotItems = { a: videoA, b: null };

      const result = computeKeyframeSlotAssignment(
        'a-is-current',
        priorSlots,
        videoB, // incoming (target)
        videoA, // outgoing (prev)
        { isActive: true, progress: 0.1 },
        1.0,
      );

      // The CRITICAL assertion: videoA must still be in slot A
      expect(result.slotItems.a?.id).toBe(priorSlots.a?.id);
      // And videoB must be in the other slot (B)
      expect(result.slotItems.b?.id).toBe('clip-b');
    });
  });
});
