/**
 * Regression tests for dead-blob URL detection and stripping on project restore.
 *
 * ─── WHAT THESE TESTS PROTECT, AND WHY THEY MUST NEVER BE DELETED ────────────
 *
 * A `blob:` URL created by `URL.createObjectURL` is bound to the document that
 * created it and dies on page reload. Threnic persists project data (slideshow
 * items, video clips, background images) to IndexedDB, so a restored project
 * can carry `blob:` URL STRINGS that were minted in a PREVIOUS session and are
 * already dead. When one of those dead URLs reached the R3F texture loader it
 * threw "Could not load blob:...: undefined" and, lacking a Suspense/error
 * boundary around the cache-warmer, crashed the WHOLE background render tree
 * (observed live at localhost:3000).
 *
 * `isDeadBlobUrl` / `stripDeadBlobItems` (src/utils/deadBlobUrls.ts) are the
 * durable fix: they remove stale blob strings at restore time so the renderer
 * is never handed a dead URL. These tests pin the exact classification rules.
 * If a future refactor of the restore path (src/hooks/useProjectRestore.ts) or
 * of this helper changes the behavior asserted below, that is a REGRESSION that
 * reintroduces the crash — the tests failing is the intended alarm, not a
 * signal to relax the assertions.
 *
 * Key invariants encoded here:
 *   1. A blob URL NOT minted this session is dead (the crash cause).
 *   2. A blob URL minted this session (present in the live set) is alive and
 *      MUST be kept — over-stripping would blank out valid backgrounds.
 *   3. data: and http(s): URLs are never classified dead here (a network 404 is
 *      a different layer's problem; we must not silently drop the user's remote
 *      assets).
 *   4. Empty / missing URLs are dead (nothing to render).
 *   5. Stripping is non-mutating and order-preserving.
 */
import { describe, it, expect } from 'vitest';
import { isDeadBlobUrl, stripDeadBlobItems, type HasUrl } from '../deadBlobUrls';

describe('isDeadBlobUrl', () => {
  it('classifies a blob: URL NOT in the live set as dead — this is the exact crash cause', () => {
    // A blob URL string persisted by a prior session. Nothing minted it this
    // session, so it is not in the live set. Loading it would throw
    // "Could not load blob:...", so it must be reported dead and stripped.
    const live = new Set<string>();
    expect(
      isDeadBlobUrl('blob:http://localhost:3000/09819d60-a1bf-45b0-a621-4e49ba3cac47', live),
    ).toBe(true);
  });

  it('classifies a blob: URL that IS in the live set as alive — must not over-strip valid data', () => {
    // A blob URL freshly minted this session via URL.createObjectURL is alive.
    // Reporting it dead would blank out a background the user actually has.
    const url = 'blob:http://localhost:3000/fresh-this-session';
    const live = new Set<string>([url]);
    expect(isDeadBlobUrl(url, live)).toBe(false);
  });

  it('never classifies a data: URL as dead — inline assets are self-contained', () => {
    const live = new Set<string>();
    expect(isDeadBlobUrl('data:image/png;base64,iVBORw0KGgo=', live)).toBe(false);
  });

  it('never classifies an http(s): URL as dead — remote assets survive restore', () => {
    // A remote URL that happens to 404 is the network layer's concern, not this
    // helper's. Dropping remote URLs here would silently delete the user's remote
    // assets from their project, which is worse than a broken image.
    const live = new Set<string>();
    expect(isDeadBlobUrl('https://cdn.example.com/bg.jpg', live)).toBe(false);
    expect(isDeadBlobUrl('http://example.com/bg.jpg', live)).toBe(false);
  });

  it('treats an empty or missing URL as dead — there is nothing to render', () => {
    const live = new Set<string>();
    expect(isDeadBlobUrl('', live)).toBe(true);
    expect(isDeadBlobUrl(undefined, live)).toBe(true);
    expect(isDeadBlobUrl(null, live)).toBe(true);
  });

  it('only treats "blob:"-prefixed strings as candidates (a URL merely CONTAINING "blob" is not a blob URL)', () => {
    // Guards against a naive `url.includes("blob")` implementation that would
    // wrongly drop a legitimate remote asset whose path contains the substring.
    const live = new Set<string>();
    expect(isDeadBlobUrl('https://cdn.example.com/blobfish.jpg', live)).toBe(false);
  });
});

describe('stripDeadBlobItems', () => {
  const liveUrl = 'blob:http://localhost:3000/alive';
  const deadUrl = 'blob:http://localhost:3000/dead-from-last-session';
  const live = new Set<string>([liveUrl]);

  it('removes only the dead-blob items and keeps everything else', () => {
    const items: HasUrl[] = [
      { url: liveUrl }, // minted this session — keep
      { url: deadUrl }, // stale blob — the crash trigger — strip
      { url: 'https://cdn.example.com/remote.jpg' }, // remote — keep
      { url: 'data:image/png;base64,AAAA' }, // inline — keep
      { url: '' }, // empty — strip
    ];
    const result = stripDeadBlobItems(items, live);
    expect(result.map((i) => i.url)).toEqual([
      liveUrl,
      'https://cdn.example.com/remote.jpg',
      'data:image/png;base64,AAAA',
    ]);
  });

  it('preserves the order of surviving items (slide order must not shuffle on restore)', () => {
    const items: HasUrl[] = [
      { url: 'https://a.com/1.jpg' },
      { url: deadUrl },
      { url: 'https://b.com/2.jpg' },
      { url: deadUrl },
      { url: 'https://c.com/3.jpg' },
    ];
    const result = stripDeadBlobItems(items, live);
    expect(result.map((i) => i.url)).toEqual([
      'https://a.com/1.jpg',
      'https://b.com/2.jpg',
      'https://c.com/3.jpg',
    ]);
  });

  it('does not mutate the input array or its items (restore must stay side-effect free)', () => {
    const items: HasUrl[] = [{ url: liveUrl }, { url: deadUrl }];
    const snapshot = JSON.parse(JSON.stringify(items));
    const result = stripDeadBlobItems(items, live);
    expect(items).toEqual(snapshot); // original untouched
    expect(result).not.toBe(items); // new array returned
    expect(items.length).toBe(2); // nothing removed in place
  });

  it('returns an empty array when every item is a dead blob (all-dead project restores clean, not crashed)', () => {
    const items: HasUrl[] = [{ url: deadUrl }, { url: deadUrl }, { url: '' }];
    expect(stripDeadBlobItems(items, live)).toEqual([]);
  });

  it('returns all items unchanged when none are dead', () => {
    const items: HasUrl[] = [{ url: liveUrl }, { url: 'https://x.com/y.jpg' }];
    expect(stripDeadBlobItems(items, live)).toEqual(items);
  });

  it('works for video-clip-shaped objects too (the videoClips restore path uses the same guard)', () => {
    // The restore path folds this same check into the videoClips filter, so the
    // helper is generic over anything with a `url`. This documents that contract.
    interface Clip extends HasUrl {
      id: string;
      name: string;
    }
    const clips: Clip[] = [
      { id: '1', name: 'good', url: liveUrl },
      { id: '2', name: 'stale', url: deadUrl },
    ];
    const result = stripDeadBlobItems(clips, live);
    expect(result).toEqual([{ id: '1', name: 'good', url: liveUrl }]);
  });
});
