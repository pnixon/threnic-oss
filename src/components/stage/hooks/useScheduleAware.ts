/**
 * Re-export barrel — all hooks have been split into focused modules.
 * This file exists for backward compatibility with existing import paths.
 *
 * Canonical imports live in:
 *   ./useScheduleAwareEffects.ts
 *   ./useScheduleAwareTheme.ts
 *   ./useScheduleAwareBackground.ts
 */
export {
  useScheduleAwareEffectsConfig,
  useScheduleAwareEffectsConfigUI,
} from './useScheduleAwareEffects';

export { useScheduleAwareThemeUI } from './useScheduleAwareTheme';

export { useScheduleAwareBackgroundUrl } from './useScheduleAwareBackground';
