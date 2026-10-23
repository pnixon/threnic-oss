import { useCallback, useSyncExternalStore } from 'react';

/**
 * Custom hook to detect if a media query matches
 * @param query Media query string (e.g. '(max-width: 768px)')
 * @returns boolean indicating if query matches
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query],
  );

  // The server (and the hydration render) see `false`; the client then syncs.
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
