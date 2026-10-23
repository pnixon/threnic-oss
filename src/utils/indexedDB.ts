import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { ThrenicProject } from '@/types/project';
import type { Track } from '@/contexts/types';

const DB_NAME = 'ThrenicDB';
const STORE_NAME = 'projects';
const SETTINGS_STORE = 'settings';
const DB_VERSION = 2; // Incremented version

/** Stored slideshow media item: blob + metadata for reconstruction */
interface StoredSlideshowItem {
  id: string;
  type: 'image' | 'video';
  label?: string;
  blob: Blob;
  originalUrl?: string;
}

interface TrackAssets {
  audioFile?: File | Blob;
  backgroundImageFile?: File | Blob;
  lyricsFile?: File | Blob;
  /** Custom grain patterns (SVGs/Images) */
  grainBundle?: Blob[];
  /**
   * Keyframe image blobs: each entry corresponds to a unique scene.assetUrl blob.
   * Use keyframeImageUrlMap to look up which stored index a URL maps to.
   */
  keyframeImages?: Blob[];
  /**
   * Maps the original blob URL to an index in keyframeImages[].
   * Allows remapping scene.assetUrl values on restore.
   */
  keyframeImageUrlMap?: Record<string, number>;
  /** Slideshow media items (images/videos) stored as blobs with metadata */
  slideshowMedia?: StoredSlideshowItem[];
}

interface ThrenicDB extends DBSchema {
  projects: {
    key: string;
    value: {
      project: ThrenicProject;
      assets?: {
        [trackId: string]: TrackAssets;
      };
    };
  };
  settings: {
    key: string;
    value: unknown;
  };
}

let dbPromise: Promise<IDBPDatabase<ThrenicDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<ThrenicDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ThrenicDB>(DB_NAME, DB_VERSION, {
      upgrade(db): void {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE);
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Get a setting from IndexedDB
 */
export async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const db = await getDB();
    const value = await db.get(SETTINGS_STORE, key);
    return value !== undefined ? (value as T) : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Save a setting to IndexedDB
 */
export async function saveSetting(key: string, value: unknown): Promise<void> {
  try {
    const db = await getDB();
    await db.put(SETTINGS_STORE, value, key);
  } catch (e) {
    console.warn('Failed to save setting to IndexedDB', e);
  }
}

/**
 * Helper to fetch a Blob from a URL, using XHR as a fallback for blob: URLs
 * when fetch is globally intercepted or sandboxed.
 */
async function fetchBlob(url: string): Promise<Blob> {
  try {
    const response = await fetch(url);
    if (response.ok) {
      return await response.blob();
    }
  } catch {
    // If standard fetch fails, fall back to XHR below
  }

  return new Promise<Blob>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 0) {
        resolve(xhr.response);
      } else {
        reject(new Error(`XHR status ${xhr.status} for ${url}`));
      }
    };
    xhr.onerror = () => reject(new Error(`XHR network error for ${url}`));
    xhr.send();
  });
}

/**
 * Save project to IndexedDB
 */
export async function saveProjectToIDB(project: ThrenicProject, tracks: Track[]): Promise<void> {
  const db = await getDB();

  // Create an asset map to store actual files
  const assets: { [trackId: string]: TrackAssets } = {};

  // 1. Save Track Assets
  for (const track of tracks) {
    const trackAssets: TrackAssets = {};
    let hasAssets = false;

    // Audio Handling
    if (track.audioFile) {
      trackAssets.audioFile = track.audioFile;
      hasAssets = true;
    } else if (track.audioUrl?.startsWith('blob:')) {
      try {
        trackAssets.audioFile = await fetchBlob(track.audioUrl);
        hasAssets = true;
      } catch (e) {
        console.warn('Failed to fetch audio blob for IDB save', e);
      }
    }

    // Background Image Handling
    if (track.backgroundImageFile) {
      trackAssets.backgroundImageFile = track.backgroundImageFile;
      hasAssets = true;
    } else if (track.backgroundImage?.startsWith('blob:')) {
      try {
        trackAssets.backgroundImageFile = await fetchBlob(track.backgroundImage);
        hasAssets = true;
      } catch (e) {
        console.warn('Failed to fetch background blob for IDB save', e);
      }
    }

    // Grain Bundle Handling (Per Track)
    const oldFilmBundle = track.effectsConfig?.postProcessing?.oldFilm?.grainBundle || [];
    const noiseBundle = track.effectsConfig?.postProcessing?.noiseOverlay?.grainBundle || [];
    const trackGrainUrls = [...new Set([...oldFilmBundle, ...noiseBundle])];

    if (trackGrainUrls.length > 0) {
      const blobs: Blob[] = [];
      for (const url of trackGrainUrls) {
        if (url.startsWith('blob:')) {
          try {
            blobs.push(await fetchBlob(url));
          } catch (e) {
            console.warn(`Failed to fetch grain blob from ${url}`, e);
          }
        }
      }
      if (blobs.length > 0) {
        trackAssets.grainBundle = blobs;
        hasAssets = true;
      }
    }

    // Keyframe Image Handling: persist unique blob URLs found in scene.assetUrl properties
    if (track.keyframes && track.keyframes.length > 0) {
      const urlToIndex: Record<string, number> = {};
      const keyframeBlobs: Blob[] = [];

      for (const kf of track.keyframes) {
        const assetUrl = kf.properties?.['scene.assetUrl'];
        if (
          typeof assetUrl === 'string' &&
          assetUrl.startsWith('blob:') &&
          !(assetUrl in urlToIndex)
        ) {
          try {
            const blob = await fetchBlob(assetUrl);
            urlToIndex[assetUrl] = keyframeBlobs.length;
            keyframeBlobs.push(blob);
          } catch (e) {
            console.warn(`Failed to fetch keyframe image blob from ${assetUrl}`, e);
          }
        }
      }

      if (keyframeBlobs.length > 0) {
        trackAssets.keyframeImages = keyframeBlobs;
        trackAssets.keyframeImageUrlMap = urlToIndex;
        hasAssets = true;
      }
    }

    // Lyrics File Handling
    const trackWithOptionalLyrics = track as Track & {
      lyricsFile?: File | Blob;
      lyricsUrl?: string;
    };
    if (trackWithOptionalLyrics.lyricsFile) {
      trackAssets.lyricsFile = trackWithOptionalLyrics.lyricsFile;
      hasAssets = true;
    } else if (trackWithOptionalLyrics.lyricsUrl?.startsWith('blob:')) {
      try {
        trackAssets.lyricsFile = await fetchBlob(trackWithOptionalLyrics.lyricsUrl);
        hasAssets = true;
      } catch (e) {
        console.warn(`Failed to fetch lyrics blob from ${trackWithOptionalLyrics.lyricsUrl}`, e);
      }
    }

    // Per-track slideshow media from videoClips (single source of truth in Threnic Redux)
    const trackVideoClips = track.videoClips || [];
    if (trackVideoClips.length > 0) {
      const stored: StoredSlideshowItem[] = [];
      for (const clip of trackVideoClips) {
        if (clip.url?.startsWith('blob:')) {
          try {
            const blob = await fetchBlob(clip.url);
            const isVideo =
              /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(clip.url) ||
              /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(clip.name) ||
              clip.url.startsWith('data:video/');
            stored.push({
              id: clip.id,
              type: isVideo ? ('video' as const) : ('image' as const),
              label: clip.name,
              blob,
              originalUrl: clip.url,
            });
          } catch (e) {
            // A revoked/dead blob URL is expected (e.g. stale carry-over); the
            // clip is simply skipped for persistence. Debug-level so it does not
            // spam console.warn on every auto-persist tick.
            console.warn(`Skipping unfetchable videoClip blob ${clip.url}`, e);
          }
        }
      }
      if (stored.length > 0) {
        trackAssets.slideshowMedia = stored;
        hasAssets = true;
      }
    }

    if (hasAssets || track.lyricsData) {
      assets[track.id] = trackAssets;
    }
  }

  // 2. Save Global Assets
  const globalAssets: TrackAssets = {};
  let hasGlobalAssets = false;

  // Pixi Background
  if (project.effects?.pixi?.image?.startsWith('blob:')) {
    try {
      globalAssets.backgroundImageFile = await fetchBlob(project.effects.pixi.image);
      hasGlobalAssets = true;
    } catch (e) {
      console.warn('Failed to fetch global background blob for IDB save', e);
    }
  }

  // Global Grain Bundles
  const globalOldFilmBundle = project.effects?.postProcessing?.oldFilm?.grainBundle || [];
  const globalNoiseBundle = project.effects?.postProcessing?.noiseOverlay?.grainBundle || [];
  const globalCombinedBundle = [...new Set([...globalOldFilmBundle, ...globalNoiseBundle])];

  if (globalCombinedBundle.length > 0) {
    const blobs: Blob[] = [];
    for (const url of globalCombinedBundle) {
      if (url.startsWith('blob:')) {
        try {
          blobs.push(await fetchBlob(url));
        } catch (e) {
          console.warn(`Failed to fetch global grain blob from ${url}`, e);
        }
      }
    }
    if (blobs.length > 0) {
      globalAssets.grainBundle = blobs;
      hasGlobalAssets = true;
    }
  }

  // Global slideshow media
  const globalSlideshow = project.effects?.slideshow?.items || [];
  if (globalSlideshow.length > 0) {
    const stored: StoredSlideshowItem[] = [];
    for (const item of globalSlideshow) {
      if (item.url?.startsWith('blob:')) {
        try {
          const blob = await fetchBlob(item.url);
          stored.push({
            id: item.id,
            type: item.type,
            label: item.label,
            blob,
            originalUrl: item.url,
          });
        } catch (e) {
          console.warn(`Failed to fetch global slideshow blob from ${item.url}`, e);
        }
      }
    }
    if (stored.length > 0) {
      globalAssets.slideshowMedia = stored;
      hasGlobalAssets = true;
    }
  }

  if (hasGlobalAssets) {
    assets['__GLOBAL__'] = globalAssets;
  }

  await db.put(
    STORE_NAME,
    {
      project,
      assets,
    },
    'current_project',
  );
}

/**
 * Load project from IndexedDB
 */
export async function loadProjectFromIDB(): Promise<{
  project: ThrenicProject;
  assets?: { [trackId: string]: TrackAssets };
} | null> {
  const db = await getDB();
  const data = await db.get(STORE_NAME, 'current_project');
  if (!data) {
    return null;
  }

  return data as { project: ThrenicProject; assets?: { [trackId: string]: TrackAssets } };
}
