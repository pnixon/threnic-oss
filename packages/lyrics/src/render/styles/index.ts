/**
 * Built-in package-native lyric styles + the default registry.
 * New styles are added here as pure registration (import + append to the array).
 */
import { createStyleRegistry } from '../StyleRegistry';
import type { LyricStyle } from '../StyleRegistry';
import { variableBreathingStyle } from './variableBreathing';
import { depthStackStyle } from './depthStack';
import { rsvpStyle } from './rsvp';
import { cinemaSubtitleStyle } from './cinemaSubtitle';
import { terminalBootLogStyle } from './terminalBootLog';
import { offsetMisregistrationStyle } from './offsetMisregistration';
import { creditsRollStyle } from './creditsRoll';
import { swissKineticGridStyle } from './swissKineticGrid';
import { pullQuoteStyle } from './pullQuote';

export * from './variableBreathing';
export * from './depthStack';
// Newer styles export their own tuning constants (some names collide across
// styles, e.g. WDTH_MIN / MIN_OPACITY); the barrel surfaces only the style
// objects to avoid `export *` ambiguity. Import a style's module directly for
// its constants/helpers (as the style's own tests do).
export {
  rsvpStyle,
  pickActiveWord,
  drawRsvp,
  RSVP_SCALE,
  RSVP_ENERGY_PULSE,
  RSVP_FILL,
} from './rsvp';
export { cinemaSubtitleStyle, computeBars, grainValueAt, BAR_FRACTION } from './cinemaSubtitle';
export {
  terminalBootLogStyle,
  computeTypeOn,
  scanlineRows,
  scanlineStepPx,
} from './terminalBootLog';
export {
  offsetMisregistrationStyle,
  computeOffset,
  DRIFT_HZ,
  MAX_OFFSET_EM,
  SNAP_THRESHOLD,
} from './offsetMisregistration';
export { creditsRollStyle, computeCreditsRoll, SETTLE_SCALE } from './creditsRoll';
export {
  swissKineticGridStyle,
  computeSwissGrid,
  BASE_SCALE,
  BIG_SCALE,
  GRID_STEP_EM,
} from './swissKineticGrid';
export { pullQuoteStyle, computePullQuote, computeOpen, SUSTAIN_REF_SEC } from './pullQuote';

/** All built-in styles, in registration order. */
export const BUILT_IN_STYLES: readonly LyricStyle[] = [
  variableBreathingStyle,
  depthStackStyle,
  rsvpStyle,
  cinemaSubtitleStyle,
  terminalBootLogStyle,
  offsetMisregistrationStyle,
  creditsRollStyle,
  swissKineticGridStyle,
  pullQuoteStyle,
];

/** A registry pre-populated with every built-in style. */
export const defaultStyleRegistry = createStyleRegistry(BUILT_IN_STYLES);
