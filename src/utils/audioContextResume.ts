/**
 * AudioContext resume helpers.
 *
 * Browsers start an AudioContext 'suspended' until a user gesture. iOS Safari
 * additionally parks it in the non-standard 'interrupted' state after a phone
 * call, Siri, another app taking audio, or the tab being backgrounded — and it
 * stays silent until resume() is called again. Treat both as resumable.
 */

/** True when `ctx` is not running but can be resumed (not closed). */
export function needsAudioResume(ctx: BaseAudioContext | null | undefined): boolean {
  // 'interrupted' isn't in the TS AudioContextState union (WebKit-only).
  const state = ctx?.state as string | undefined;
  return state === 'suspended' || state === 'interrupted';
}
