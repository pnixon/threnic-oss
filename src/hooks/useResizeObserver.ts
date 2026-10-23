import { useEffect, useRef, RefObject } from 'react';

/**
 * Observe an element's size via ResizeObserver.
 *
 * The callback is stored in a ref so changes to it never tear down /
 * re-create the observer.  The observer is created once per element
 * mount and disconnected on unmount.
 */
export function useResizeObserver(
  ref: RefObject<HTMLElement>,
  callback: (entry: ResizeObserverEntry) => void,
) {
  const callbackRef = useRef(callback);
  // eslint-disable-next-line react-hooks/refs -- latest-value ref, only read from callbacks/effects
  callbackRef.current = callback;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      if (entries.length > 0) {
        callbackRef.current(entries[0]);
      }
    });

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
    // Only re-create when the actual element changes (ref identity)
  }, [ref]);
}
