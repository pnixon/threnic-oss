/**
 * ActiveRangeFilter — Filters effect instances by their active time range.
 *
 * This module handles effect lifecycle management, ensuring effects are only
 * active during their defined time ranges. Effects without an activeRange
 * are treated as always-active (spanning the entire track duration).
 *
 * Usage:
 *   import { applyActiveRanges } from '@/engine/keyframes/ActiveRangeFilter';
 *
 *   const ranged = applyActiveRanges(instances, currentTime);
 *   // Instances outside their active range come back with enabled: false
 */
import type { EffectInstance } from '@/types/effects/effect-instances';

/**
 * Check if an effect instance is active at the given time.
 *
 * Rules:
 * - No activeRange → always active
 * - Time within [start, end] → active
 * - Time outside range → inactive
 */
function isInstanceActive(instance: EffectInstance, time: number): boolean {
  if (!instance.activeRange) return true;
  return time >= instance.activeRange.start && time <= instance.activeRange.end;
}

/**
 * Filter a list of effect instances to only those active at the given time.
 * Inactive instances are returned with `enabled: false` to ensure clean teardown
 * rather than being removed entirely (which would cause React component unmounting).
 */
export function applyActiveRanges(instances: EffectInstance[], time: number): EffectInstance[] {
  return instances.map((instance) => {
    if (isInstanceActive(instance, time)) {
      return instance;
    }
    // Outside active range → force disabled
    return {
      ...instance,
      config: { ...instance.config, enabled: false },
    } as EffectInstance;
  });
}
