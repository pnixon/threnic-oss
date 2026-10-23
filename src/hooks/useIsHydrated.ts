import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * Returns `false` on the server and during the very first client render,
 * then `true` after the component has mounted on the client.
 *
 * Use this to gate any UI whose output depends on values that differ between
 * the server and the first client paint — e.g. `window.matchMedia`
 * (responsive branches) or Zustand stores that rehydrate synchronously from
 * localStorage at module init (persisted export prefs). Rendering the same
 * SSR-consistent output on the first client render, then switching to the
 * real values after mount, avoids React hydration mismatches
 * ("a tree hydrated but some attributes ... didn't match").
 */
export function useIsHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
