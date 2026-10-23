/**
 * deadBlobUrls — pure helpers for detecting and stripping dead `blob:` URLs
 * during project restore.
 *
 * ─── WHY THIS EXISTS (regression this protects against) ──────────────────────
 *
 * A `blob:` URL (from `URL.createObjectURL`) is scoped to the DOCUMENT that
 * created it. It dies the instant that document is torn down — i.e. on every
 * page reload. Threnic persists project data (slideshow items, video clips,
 * background images) to IndexedDB, and that data can contain `blob:` URL
 * STRINGS left over from a previous session. On restore those strings are
 * already dead: nothing can load them.
 *
 * When such a dead URL reached the R3F texture path (`useTexture` /
 * `THREE.TextureLoader`), it threw
 *   "Could not load blob:http://localhost:3000/<uuid>: undefined"
 * and — with no Suspense/error boundary around the cache-warmer — crashed the
 * ENTIRE background render tree. See:
 *   - src/components/stage/background/SlideshowBackgroundPlane.tsx (ImageCacheWarmer)
 *   - src/components/stage/background/ImageSlide.tsx
 *
 * The consuming components were hardened to fail gracefully, but the DURABLE
 * fix is to never hand a dead URL to the renderer in the first place: strip
 * stale `blob:` strings at restore time. This module is that strip, isolated as
 * pure functions so the behavior is unit-testable and PROTECTED against future
 * regressions — restore-path refactors must keep these tests green.
 *
 * ─── THE DISCRIMINATOR ───────────────────────────────────────────────────────
 *
 * During restore we re-mint blob URLs from the persisted Blobs
 * (`URL.createObjectURL`). Those FRESH URLs are alive this session. So the test
 * for "dead" is precise and cheap:
 *
 *     a URL is dead  ⇔  it starts with "blob:"  AND  we did not mint it this
 *                       session (it is not in the live set)
 *
 * `data:` and `http(s):` URLs are content-addressable / network-backed and are
 * never treated as dead here (a 404 http URL is a separate concern the network
 * layer handles). An empty / missing URL is treated as dead — there is nothing
 * to render.
 */

/** Anything with a `url` string field — slideshow items, video clips, etc. */
export interface HasUrl {
  url?: string;
}

/**
 * True when `url` is a `blob:` URL that was NOT minted this session (a stale
 * carry-over from a prior session, dead after reload), or is empty/missing.
 *
 * @param url          the URL to classify
 * @param liveBlobUrls the set of blob URLs minted this session via
 *                     `URL.createObjectURL`; a blob URL present here is alive
 */
export function isDeadBlobUrl(url: string | undefined | null, liveBlobUrls: Set<string>): boolean {
  if (!url) return true;
  if (!url.startsWith('blob:')) return false;
  return !liveBlobUrls.has(url);
}

/**
 * Return a new array with every item whose `url` is a dead blob removed.
 * Non-mutating: the input array and its items are never modified. Preserves the
 * order of surviving items.
 */
export function stripDeadBlobItems<T extends HasUrl>(items: T[], liveBlobUrls: Set<string>): T[] {
  return items.filter((it) => !isDeadBlobUrl(it.url, liveBlobUrls));
}
