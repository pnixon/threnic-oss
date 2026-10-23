/**
 * Stores barrel export
 *
 * Non-engine Zustand vanilla stores for application-level state.
 * Engine-specific stores remain in src/engine/stores/.
 */

// Auto-persist middleware
export { pauseAutoSave, resumeAutoSave } from './autoPersist';
