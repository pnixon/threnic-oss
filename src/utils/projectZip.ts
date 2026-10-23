/**
 * ZIP-based project export/import
 *
 * Bundles a .thren manifest + all binary assets (audio, images, videos)
 * into a single .thren ZIP archive that can be uploaded to the headless
 * render API or shared between machines.
 *
 * Layout inside the ZIP:
 *   project.thren          – JSON manifest (the same format as a bare .thren)
 *   assets/
 *     <trackId>/
 *       audio.<ext>         – track audio file
 *       background.<ext>    – track background image
 *       lyrics.json         – track lyrics (if present)
 *       kf_<index>.<ext>    – per-keyframe scene images
 */

import JSZip from 'jszip';
import type { Track } from '@/contexts/types';
import type { ThrenicProject } from '@/types/project';
import { serializeProject } from './project';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Guess a file extension from a MIME type */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  };
  return map[mime] || mime.split('/')[1] || 'bin';
}

/** Fetch a blob: or data: URL and return the actual Blob */
async function fetchBlob(url: string): Promise<Blob | null> {
  if (!url) return null;
  try {
    if (url.startsWith('blob:')) {
      return await new Promise<Blob | null>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'blob';
        xhr.onload = () => {
          if (xhr.status === 200 || xhr.status === 0) {
            resolve(xhr.response);
          } else {
            resolve(null);
          }
        };
        xhr.onerror = () => resolve(null);
        xhr.send();
      });
    }
    const res = await fetch(url);
    if (res.ok) return await res.blob();
  } catch {
    // url may be a plain filename or inaccessible path – skip
  }
  return null;
}

/** Derive an extension from a Blob (or from a filename fallback) */
function blobExt(blob: Blob, fallbackName?: string): string {
  if (blob.type) return extFromMime(blob.type);
  if (fallbackName) {
    const dot = fallbackName.lastIndexOf('.');
    if (dot !== -1) return fallbackName.slice(dot + 1);
  }
  return 'bin';
}

// ─── EXPORT ─────────────────────────────────────────────────────────────────

interface ZipExportOptions {
  /** The fully-assembled ThrenicProject (already built by Header save logic) */
  project: ThrenicProject;
  /** The live Track[] from React state (has blob URLs & File refs) */
  tracks: Track[];
}

/**
 * Build a ZIP containing the project manifest + all binary assets.
 * Returns a Blob ready for download or upload.
 */
export async function exportProjectToZip({ project, tracks }: ZipExportOptions): Promise<Blob> {
  const zip = new JSZip();
  const assetsFolder = zip.folder('assets')!;

  // We will mutate a *deep clone* of the project to rewrite paths
  const projClone: ThrenicProject = structuredClone(project);

  // Process each track
  for (const track of tracks) {
    const trackFolder = assetsFolder.folder(track.id)!;
    const playlistEntry = projClone.playlist?.find((t) => t.id === track.id);

    // ── Audio ──────────────────────────────────────────────────────────────
    const audioBlob =
      track.audioFile instanceof Blob ? track.audioFile : await fetchBlob(track.audioUrl);

    if (audioBlob) {
      const ext = blobExt(audioBlob, track.audioFilePath || track.name);
      const assetPath = `assets/${track.id}/audio.${ext}`;
      trackFolder.file(`audio.${ext}`, audioBlob);

      // Rewrite the manifest path
      if (playlistEntry) playlistEntry.audioFilePath = assetPath;
      if (projClone.audio?.filePath && projClone.playlist?.indexOf(playlistEntry!) === 0) {
        projClone.audio.filePath = assetPath;
      }
    }

    // ── Background Image ──────────────────────────────────────────────────
    const bgBlob =
      track.backgroundImageFile instanceof Blob
        ? track.backgroundImageFile
        : await fetchBlob(track.backgroundImage || '');

    if (bgBlob) {
      const ext = blobExt(bgBlob, track.backgroundImageFilePath);
      const assetPath = `assets/${track.id}/background.${ext}`;
      trackFolder.file(`background.${ext}`, bgBlob);

      if (playlistEntry) playlistEntry.backgroundImageFilePath = assetPath;
      if (
        projClone.backgroundImage?.filePath &&
        projClone.playlist?.indexOf(playlistEntry!) === 0
      ) {
        projClone.backgroundImage.filePath = assetPath;
      }
    }

    // ── Lyrics (inline JSON) ──────────────────────────────────────────────
    if (track.lyricsData && track.lyricsData.length > 0) {
      const lyricsJson = JSON.stringify(track.lyricsData, null, 2);
      const assetPath = `assets/${track.id}/lyrics.json`;
      trackFolder.file('lyrics.json', lyricsJson);
      if (playlistEntry) playlistEntry.lyricsFilePath = assetPath;
    }

    // ── Keyframe scene images ─────────────────────────────────────────────
    if (track.keyframes && track.keyframes.length > 0) {
      const urlToZipPath: Record<string, string> = {};
      let kfIdx = 0;

      for (const kf of track.keyframes) {
        const assetUrl = kf.properties?.['scene.assetUrl'] as string | undefined;
        if (!assetUrl) continue;

        // Already processed this URL (shared across keyframes)
        if (assetUrl in urlToZipPath) continue;

        const blob = await fetchBlob(assetUrl);
        if (!blob) continue;

        const ext = blobExt(blob);
        const filename = `kf_${kfIdx}.${ext}`;
        const assetPath = `assets/${track.id}/${filename}`;
        trackFolder.file(filename, blob);
        urlToZipPath[assetUrl] = assetPath;
        kfIdx++;
      }

      // Rewrite keyframe asset URLs in the manifest
      if (playlistEntry?.keyframes) {
        for (const kf of playlistEntry.keyframes) {
          const origUrl = kf.properties?.['scene.assetUrl'] as string | undefined;
          if (origUrl && origUrl in urlToZipPath) {
            kf.properties!['scene.assetUrl'] = urlToZipPath[origUrl];
          }
          // Also clean up assetFilePath if it leaked through
          if (kf.properties?.['scene.assetFilePath']) {
            delete kf.properties['scene.assetFilePath'];
          }
        }
      }
    }

    // ── Video background ──────────────────────────────────────────────────
    if (track.effectsConfig?.video?.url) {
      const videoBlob = await fetchBlob(track.effectsConfig.video.url);
      if (videoBlob) {
        const ext = blobExt(videoBlob);
        const assetPath = `assets/${track.id}/video.${ext}`;
        trackFolder.file(`video.${ext}`, videoBlob);

        if (playlistEntry?.effectsConfig?.video) {
          playlistEntry.effectsConfig.video = {
            ...playlistEntry.effectsConfig.video,
            url: assetPath,
          };
        }
      }
    }

    // ── Slideshow items (images + videos) ─────────────────────────────────
    // The slideshow config stores an array of media items with URLs that may
    // point to remote or blob: URLs. We fetch each one and bundle it.
    const slideshowItems = track.effectsConfig?.slideshow?.items;
    if (
      slideshowItems &&
      slideshowItems.length > 0 &&
      playlistEntry?.effectsConfig?.slideshow?.items
    ) {
      const urlToZipPath: Record<string, string> = {};
      let ssIdx = 0;

      for (const item of slideshowItems) {
        if (!item.url || item.url in urlToZipPath) continue;

        // Resolve server-absolute paths to full URLs for fetching
        let fetchUrl = item.url;
        if (fetchUrl.startsWith('/') && typeof window !== 'undefined') {
          fetchUrl = `${window.location.origin}${fetchUrl}`;
        }

        const blob = await fetchBlob(fetchUrl);
        if (!blob) {
          console.warn(`[projectZip] Failed to fetch slideshow item: ${item.url}`);
          continue;
        }

        const ext = blobExt(blob, item.url);
        const filename = `slideshow_${ssIdx}.${ext}`;
        const assetPath = `assets/${track.id}/${filename}`;
        trackFolder.file(filename, blob);
        urlToZipPath[item.url] = assetPath;
        ssIdx++;
      }

      // Rewrite URLs in the manifest
      for (const manifestItem of playlistEntry.effectsConfig.slideshow.items) {
        if (manifestItem.url && manifestItem.url in urlToZipPath) {
          manifestItem.url = urlToZipPath[manifestItem.url];
        }
      }
    }
  }

  // Serialize the rewritten manifest
  const manifestJson = serializeProject(projClone);
  zip.file('project.thren', manifestJson);

  return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

// ─── IMPORT ─────────────────────────────────────────────────────────────────

interface ZipImportResult {
  /** The parsed project manifest */
  project: ThrenicProject;
  /** Asset blobs keyed in the format expected by loadProjectFromManifest:
   *  - `audio_<trackId>`
   *  - `background_<trackId>`
   *  - `kfImage_<trackId>_<zipPath>`
   */
  assets: Map<string, Blob>;
  warnings: string[];
}

/**
 * Parse a ZIP blob (or File) and extract the project + assets.
 */
export async function importProjectFromZip(zipBlob: Blob): Promise<ZipImportResult> {
  const zip = await JSZip.loadAsync(zipBlob);
  const warnings: string[] = [];
  const assets = new Map<string, Blob>();

  // 1. Find and parse the manifest
  const manifestFile = zip.file('project.thren');
  if (!manifestFile) {
    throw new Error('Invalid project ZIP: missing project.thren manifest');
  }
  const manifestJson = await manifestFile.async('string');

  // Use the existing deserializer
  const { deserializeProject } = await import('./project');
  const { project, warnings: parseWarnings } = deserializeProject(manifestJson);
  warnings.push(...parseWarnings);

  // 2. Walk each track and extract referenced assets
  if (project.playlist) {
    for (const track of project.playlist) {
      // Audio
      if (track.audioFilePath) {
        const audioFile = zip.file(track.audioFilePath);
        if (audioFile) {
          const blob = await audioFile.async('blob');
          assets.set(`audio_${track.id}`, blob);
        } else {
          warnings.push(`Missing audio file in ZIP: ${track.audioFilePath}`);
        }
      }

      // Background
      if (track.backgroundImageFilePath) {
        const bgFile = zip.file(track.backgroundImageFilePath);
        if (bgFile) {
          const blob = await bgFile.async('blob');
          assets.set(`background_${track.id}`, blob);
        } else {
          warnings.push(`Missing background image in ZIP: ${track.backgroundImageFilePath}`);
        }
      }

      // Lyrics (JSON file inside ZIP)
      if (track.lyricsFilePath) {
        const lyricsFile = zip.file(track.lyricsFilePath);
        if (lyricsFile) {
          try {
            const lyricsJson = await lyricsFile.async('string');
            track.lyrics = JSON.parse(lyricsJson);
          } catch {
            warnings.push(`Failed to parse lyrics JSON: ${track.lyricsFilePath}`);
          }
        }
      }

      // Keyframe images
      if (track.keyframes) {
        for (const kf of track.keyframes) {
          const assetUrl = kf.properties?.['scene.assetUrl'] as string | undefined;
          if (
            typeof assetUrl === 'string' &&
            assetUrl.startsWith('assets/') &&
            !assets.has(`kfImage_${track.id}_${assetUrl}`)
          ) {
            const kfFile = zip.file(assetUrl);
            if (kfFile) {
              const blob = await kfFile.async('blob');
              assets.set(`kfImage_${track.id}_${assetUrl}`, blob);
            } else {
              warnings.push(`Missing keyframe image in ZIP: ${assetUrl}`);
            }
          }
        }
      }

      // Video background
      if (track.effectsConfig?.video?.url?.startsWith('assets/')) {
        const videoFile = zip.file(track.effectsConfig.video.url);
        if (videoFile) {
          const blob = await videoFile.async('blob');
          // Store as a generic asset; loadProjectFromManifest handles video.url conversion
          // We'll put the blob URL back into the config below
          const blobUrl = URL.createObjectURL(blob);
          track.effectsConfig.video = {
            ...track.effectsConfig.video,
            url: blobUrl,
          };
        } else {
          warnings.push(`Missing video file in ZIP: ${track.effectsConfig.video.url}`);
        }
      }

      // Slideshow items
      if (track.effectsConfig?.slideshow?.items) {
        for (const item of track.effectsConfig.slideshow.items) {
          if (typeof item.url === 'string' && item.url.startsWith('assets/')) {
            const itemFile = zip.file(item.url);
            if (itemFile) {
              const blob = await itemFile.async('blob');
              item.url = URL.createObjectURL(blob);
            } else {
              warnings.push(`Missing slideshow item in ZIP: ${item.url}`);
            }
          }
        }
      }
    }
  }

  return { project, assets, warnings };
}

// ─── FILE PICKER HELPERS ────────────────────────────────────────────────────

/** Trigger a save dialog for the ZIP blob */
export async function saveProjectZip(zipBlob: Blob, projectName: string): Promise<void> {
  const filename = `${projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}.thren`;

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (
        window as unknown as {
          showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'Threnic Project Archive',
            accept: { 'application/zip': ['.thren'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(zipBlob);
      await writable.close();
      return;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
    }
  }

  // Fallback download
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Open a file picker for .thren ZIPs, returns null if cancelled */
export async function openProjectZip(): Promise<File | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (
        window as unknown as {
          showOpenFilePicker: (opts: unknown) => Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker({
        types: [
          {
            description: 'Threnic Project Archive',
            accept: { 'application/zip': ['.thren', '.zip'] },
          },
        ],
        multiple: false,
      });
      return await handle.getFile();
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return null;
      throw e;
    }
  }

  // Fallback: hidden file input
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.thren,.zip';
    input.onchange = () => {
      resolve(input.files?.[0] || null);
    };
    input.click();
  });
}
