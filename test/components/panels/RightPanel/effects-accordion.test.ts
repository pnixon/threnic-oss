import { describe, it, expect } from 'vitest';

/**
 * Regression guard for the recurring "opening Shader FX expands every other
 * effect" bug in the Effects tab (DraggableEffectList).
 *
 * Root cause history: the accordion used an OPT-OUT model — a `collapsedIds`
 * map where a row was considered expanded whenever its id was NOT present
 * (`isExpanded = !collapsedIds[id]`, i.e. `!undefined === true`). Rows that had
 * not been tracked yet therefore defaulted to EXPANDED. That untracked window
 * happens constantly: on first paint before the init effect runs, for
 * synthesized `fx-<type>` rows that have no saved instance, and immediately
 * after toggling an effect on (which mints a brand-new random instance id).
 * The result: expanding one effect visually flashed all the others open.
 *
 * The fix models the accordion as a single `expandedId` (OPT-IN): a row is
 * expanded only when it IS the tracked id, so every untracked row is collapsed
 * by construction. These tests lock in that opt-in semantic and the
 * single-open / toggle-closed behavior independent of React rendering.
 */

// Mirror of the component's expanded-state derivation and toggle reducer.
// Keep these in lockstep with DraggableEffectList.tsx.
const isExpanded = (expandedId: string | null, rowId: string): boolean => expandedId === rowId;

const toggleExpand = (expandedId: string | null, rowId: string): string | null =>
  expandedId === rowId ? null : rowId;

describe('Effects tab accordion (expandedId model)', () => {
  const rows = ['fx-shaderFx', 'fx-particles', 'fx-bloom', 'chromatic-123'];

  it('defaults every row to COLLAPSED when nothing is tracked (first paint)', () => {
    const expandedId: string | null = null;
    for (const id of rows) {
      expect(isExpanded(expandedId, id)).toBe(false);
    }
  });

  it('expanding one row leaves ALL other rows collapsed', () => {
    const expandedId = toggleExpand(null, 'fx-shaderFx');
    expect(isExpanded(expandedId, 'fx-shaderFx')).toBe(true);
    for (const id of rows.filter((r) => r !== 'fx-shaderFx')) {
      expect(isExpanded(expandedId, id)).toBe(false);
    }
  });

  it('an untracked/never-seen row id reads collapsed even while another is open', () => {
    const expandedId = toggleExpand(null, 'fx-shaderFx');
    // A freshly synthesized or freshly materialized row (new random id) that
    // the accordion has never tracked must NOT inherit the open state.
    expect(isExpanded(expandedId, 'shaderFx-1700000000000-a1b2')).toBe(false);
  });

  it('opening a second row closes the first (single-open)', () => {
    let expandedId = toggleExpand(null, 'fx-shaderFx');
    expandedId = toggleExpand(expandedId, 'fx-particles');
    expect(isExpanded(expandedId, 'fx-particles')).toBe(true);
    expect(isExpanded(expandedId, 'fx-shaderFx')).toBe(false);
  });

  it('clicking the open row again collapses everything', () => {
    let expandedId = toggleExpand(null, 'fx-shaderFx');
    expandedId = toggleExpand(expandedId, 'fx-shaderFx');
    expect(expandedId).toBeNull();
    for (const id of rows) {
      expect(isExpanded(expandedId, id)).toBe(false);
    }
  });
});
